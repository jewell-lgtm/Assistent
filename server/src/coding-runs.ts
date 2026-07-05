import { PiError, type PiRunOptions } from "@assistant/capabilities-server/pi"
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent"
import { Effect, Stream } from "effect"
import { randomUUID } from "node:crypto"
import { commitUserspace, runPi } from "./code.js"

// Async coding-run tracking for the phone Code tab: POST accepts and returns
// immediately, the Pi session + userspace commit run in a background daemon
// fiber, SSE streams live progress, and status/result stay fetchable by
// runId as the reconnect backstop when a phone screen lock kills the stream.
//
// In-memory only, module-level (this file is a singleton for the pod's
// lifetime) — history is lost on pod restart, which is fine: it's a
// reconnect backstop for the CURRENT run, not an audit log. Keeps only the
// last few runs (MAX_RUNS) so a stale/garbage runId 404s instead of piling
// up forever.
//
// Single-flight is scoped to coding runs only, independent of the generic
// PiClient "busy" flag in code.ts (used by /api/pi/run). Rationale: the
// coding path writes files + commits to the userspace git repo, so two
// concurrent coding runs really would stomp each other — that's what
// single-flight is protecting against. The generic tools:"none" path never
// touches disk, so there's no reason a multi-minute coding run should also
// block a quick unrelated chat call. (Today, before this change, they
// happened to share one lock only because the coding path was synchronous
// end-to-end; that coupling wasn't a deliberate feature.)
const MAX_RUNS = 5

interface RunResult {
  readonly text: string
  readonly model: string
  readonly commit: string | undefined
}

export type CodingRunEvent =
  | { readonly type: "token"; readonly text: string }
  | {
      readonly type: "tool"
      readonly toolName: string
      readonly phase: "start" | "update" | "end"
      readonly error?: boolean | undefined
    }
  | { readonly type: "done"; readonly result: RunResult }
  | { readonly type: "error"; readonly message: string }

export interface CodingRunStatus {
  readonly status: "running" | "done" | "failed"
  readonly result?: RunResult | undefined
  readonly error?: string | undefined
}

interface RunState {
  readonly runId: string
  status: "running" | "done" | "failed"
  result?: RunResult | undefined
  error?: string | undefined
  readonly listeners: Set<(event: CodingRunEvent) => void>
}

const runs = new Map<string, RunState>()
let activeRunId: string | undefined

const notify = (run: RunState, event: CodingRunEvent) => {
  for (const listener of run.listeners) listener(event)
}

const evictOldIfNeeded = () => {
  if (runs.size <= MAX_RUNS) return
  for (const id of runs.keys()) {
    if (id === activeRunId) continue
    runs.delete(id)
    return
  }
}

const toRunEvent = (event: AgentSessionEvent): CodingRunEvent | undefined => {
  switch (event.type) {
    case "message_update":
      return event.assistantMessageEvent.type === "text_delta"
        ? { type: "token", text: event.assistantMessageEvent.delta }
        : undefined
    case "tool_execution_start":
      return { type: "tool", toolName: event.toolName, phase: "start" }
    case "tool_execution_update":
      return { type: "tool", toolName: event.toolName, phase: "update" }
    case "tool_execution_end":
      return { type: "tool", toolName: event.toolName, phase: "end", error: event.isError }
    default:
      // agent_end and everything else: the "done"/"error" terminal event is
      // synthesized below from runPi()'s promise settling (single source of
      // truth for status), not from the SDK's own lifecycle events.
      return undefined
  }
}

/**
 * Accept a coding run and kick it off in the background. Resolves
 * immediately (no awaiting the Pi session) with a runId, or fails with
 * PiError("busy") if a coding run is already in flight — same single-flight
 * shape the old synchronous handler had, just checked without blocking.
 */
export const startCodingRun = (
  env: { root: string; ollamaBaseUrl: string; defaultModel: string },
  options: PiRunOptions
): Effect.Effect<{ runId: string }, PiError> => {
  if (activeRunId !== undefined) return Effect.fail(new PiError({ message: "busy" }))

  const runId = randomUUID()
  const run: RunState = { runId, status: "running", listeners: new Set() }
  runs.set(runId, run)
  activeRunId = runId
  evictOldIfNeeded()

  const onEvent = (event: AgentSessionEvent) => {
    const mapped = toRunEvent(event)
    if (mapped !== undefined) notify(run, mapped)
  }

  const finish = Effect.gen(function* () {
    const piResult = yield* Effect.tryPromise({
      try: () => runPi(env, options, onEvent),
      catch: (e) => new PiError({ message: String(e) })
    })
    const commit = yield* commitUserspace(options.prompt)
    return { ...piResult, commit }
  }).pipe(
    Effect.match({
      onSuccess: (result) => {
        run.status = "done"
        run.result = result
        notify(run, { type: "done", result })
      },
      onFailure: (e) => {
        run.status = "failed"
        run.error = e.message
        notify(run, { type: "error", message: e.message })
      }
    }),
    Effect.ensuring(
      Effect.sync(() => {
        if (activeRunId === run.runId) activeRunId = undefined
      })
    )
  )

  return Effect.as(Effect.forkDaemon(finish), { runId })
}

/** Plain JSON status/result — the SSE-reconnect backstop. Independent of whether anyone ever opened the stream. */
export const getCodingRunStatus = (runId: string): CodingRunStatus | undefined => {
  const run = runs.get(runId)
  if (run === undefined) return undefined
  return { status: run.status, result: run.result, error: run.error }
}

const encoder = new TextEncoder()
const sseChunk = (event: CodingRunEvent): Uint8Array => encoder.encode(`data: ${JSON.stringify(event)}\n\n`)

/**
 * SSE event stream for a run. Returns undefined if runId is unknown (caller
 * 404s before upgrading to SSE). If the run already finished by the time
 * this is called, emits the terminal event once and completes immediately
 * instead of hanging.
 */
export const codingRunEventStream = (runId: string): Stream.Stream<Uint8Array> | undefined => {
  const run = runs.get(runId)
  if (run === undefined) return undefined

  return Stream.asyncPush<Uint8Array>((emit) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        if (run.status !== "running") {
          const terminal: CodingRunEvent =
            run.status === "done"
              ? { type: "done", result: run.result! }
              : { type: "error", message: run.error ?? "unknown error" }
          void emit.single(sseChunk(terminal))
          void emit.end()
          return undefined
        }
        const listener = (event: CodingRunEvent) => {
          void emit.single(sseChunk(event))
          if (event.type === "done" || event.type === "error") void emit.end()
        }
        run.listeners.add(listener)
        return listener
      }),
      (listener) =>
        Effect.sync(() => {
          if (listener !== undefined) run.listeners.delete(listener)
        })
    )
  )
}
