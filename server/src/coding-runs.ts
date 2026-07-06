import { PiError, type PiRunOptions } from "@assistant/capabilities-server/pi"
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent"
import { Effect, Stream } from "effect"
import { randomUUID } from "node:crypto"
import { changedFeatures, commitUserspace, releaseEngine, runPi, stashUserspaceResidue, tryAcquireEngine } from "./code.js"
import { journal, upsertAppPage } from "./vault.js"

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
// Every event is also BUFFERED per run (capped): a subscriber that connects
// after the 202 (or reconnects after a drop) replays the full history first,
// then follows live — without this, everything emitted before the stream
// opened was silently lost (review finding 01:15 #3).
//
// Single-flight: coding runs hold the PROCESS-WIDE engine slot (code.ts
// tryAcquireEngine) — shared with /api/pi/run's generic path, because both
// create agent sessions with the same cwd + session dir + provider auth and
// must never overlap (review finding 01:15 #6). activeRunId additionally
// identifies WHICH coding run holds it, for eviction + status.
const MAX_RUNS = 5
const MAX_BUFFERED_EVENTS = 2000
const HEARTBEAT_MS = 15_000

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
  readonly events: Array<CodingRunEvent>
  readonly listeners: Set<(event: CodingRunEvent) => void>
}

const runs = new Map<string, RunState>()
let activeRunId: string | undefined

const notify = (run: RunState, event: CodingRunEvent) => {
  run.events.push(event)
  if (run.events.length > MAX_BUFFERED_EVENTS) run.events.shift()
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
 * PiError("busy") if the engine slot is held (by a coding OR generic run).
 *
 * Wrapped in uninterruptible+suspend so the lock acquire, run registration,
 * and daemon fork are one atomic step from the caller's perspective — an
 * HTTP request fiber interrupted mid-way can no longer leak a permanently
 * "busy" engine (review finding 01:15 #5). All mutation happens at EXECUTION
 * time, not Effect construction time.
 */
export const startCodingRun = (
  env: { root: string; ollamaBaseUrl: string; defaultModel: string },
  options: PiRunOptions
): Effect.Effect<{ runId: string }, PiError> =>
  Effect.uninterruptible(
    Effect.suspend(() => {
      if (!tryAcquireEngine("coding")) return Effect.fail(new PiError({ message: "busy" }))

      const runId = randomUUID()
      const run: RunState = { runId, status: "running", events: [], listeners: new Set() }
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
        // Vault: journal the build and give each touched app a page. Best-effort
        // (vault helpers swallow their own errors) — never fails the run.
        const features = commit === undefined ? [] : yield* changedFeatures(commit)
        yield* Effect.promise(async () => {
          await journal(env.root, "built", `${options.prompt}${commit ? ` → ${commit}` : ""}`)
          for (const name of features) await upsertAppPage(env.root, name, { prompt: options.prompt, commit })
        })
        return { ...piResult, commit }
      }).pipe(
        Effect.matchEffect({
          onSuccess: (result) =>
            Effect.sync(() => {
              run.status = "done"
              run.result = result
              notify(run, { type: "done", result })
            }),
          onFailure: (e) =>
            // A failed run's partial edits are live-served AND would be swept
            // into the next commit — stash them out of the working tree first.
            stashUserspaceResidue(`${run.runId}: ${e.message}`).pipe(
              Effect.catchAll((stashErr) =>
                Effect.sync(() => {
                  console.error(`[coding-run ${run.runId}] ${stashErr.message}`)
                }).pipe(Effect.as(false))
              ),
              Effect.flatMap((stashed) =>
                Effect.sync(() => {
                  run.status = "failed"
                  run.error = stashed ? `${e.message} (partial edits stashed, see git stash list)` : e.message
                  notify(run, { type: "error", message: run.error })
                })
              )
            )
        }),
        Effect.ensuring(
          Effect.sync(() => {
            releaseEngine("coding")
            if (activeRunId === run.runId) activeRunId = undefined
          })
        )
      )

      return Effect.as(Effect.forkDaemon(finish), { runId })
    })
  )

/** Plain JSON status/result — the SSE-reconnect backstop. Independent of whether anyone ever opened the stream. */
export const getCodingRunStatus = (runId: string): CodingRunStatus | undefined => {
  const run = runs.get(runId)
  if (run === undefined) return undefined
  return { status: run.status, result: run.result, error: run.error }
}

const encoder = new TextEncoder()
const sseChunk = (event: CodingRunEvent): Uint8Array => encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
// SSE comment frame — ignored by any spec-compliant parser, but its BYTES
// keep the client's staleness watchdog fed through legitimately quiet spells
// (a single tool execution can exceed a minute with zero events).
const HEARTBEAT = encoder.encode(`: hb\n\n`)

/**
 * SSE event stream for a run. Returns undefined if runId is unknown (caller
 * 404s before upgrading to SSE). Replays the run's full buffered history
 * first (late subscribers and reconnects see everything), then follows live
 * with a heartbeat comment every HEARTBEAT_MS. If the run already finished,
 * the replayed buffer ends with the terminal event and the stream closes.
 */
export const codingRunEventStream = (runId: string): Stream.Stream<Uint8Array> | undefined => {
  const run = runs.get(runId)
  if (run === undefined) return undefined

  return Stream.asyncPush<Uint8Array>((emit) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        // Replay + listener-attach happen in one synchronous block, so no
        // event can slip between the snapshot and the subscription.
        for (const event of run.events) void emit.single(sseChunk(event))
        if (run.status !== "running") {
          void emit.end()
          return undefined
        }
        const listener = (event: CodingRunEvent) => {
          void emit.single(sseChunk(event))
          if (event.type === "done" || event.type === "error") void emit.end()
        }
        run.listeners.add(listener)
        const heartbeat = setInterval(() => void emit.single(HEARTBEAT), HEARTBEAT_MS)
        return { listener, heartbeat }
      }),
      (sub) =>
        Effect.sync(() => {
          if (sub !== undefined) {
            run.listeners.delete(sub.listener)
            clearInterval(sub.heartbeat)
          }
        })
    )
  )
}
