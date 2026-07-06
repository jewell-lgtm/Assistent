import { PiError, type PiRunOptions } from "@assistant/capabilities-server/pi"
import {
  Task,
  TaskResult,
  TaskStep,
  type StepName,
  type StepStatus,
  type TaskEvent,
  type TaskStatus
} from "@assistant/platform-api/tasks"
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent"
import { HttpClient, HttpClientRequest } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import {
  Config,
  Context,
  Data,
  Effect,
  Either,
  Layer,
  Option,
  Redacted,
  Schedule,
  Schema,
  Stream
} from "effect"
import { randomUUID } from "node:crypto"
import {
  changedFeatures,
  commitUserspace,
  releaseEngine,
  runPi,
  stashUserspaceResidue,
  tryAcquireEngine
} from "./code.js"
import { journal, upsertAppPage } from "./vault.js"

// The async task engine: a coding prompt is accepted as a TASK, the whole
// agent → publish → reload pipeline runs server-side, and every state
// transition is persisted to the appspace sqlite db. The phone can go offline
// the moment it has the taskId; foregrounding later reads the durable row.
//
// Two layers of state, deliberately split:
//  - sqlite row (TaskRepo): the durable truth — status, per-step status,
//    result, error. Survives pod restarts; what GET /api/tasks serves.
//  - in-memory live entry: the token/tool event buffer + SSE listeners for
//    tasks started by THIS process. A live VIEW only (same replay-buffer
//    design as the old coding-runs.ts); losing it loses nothing durable.
//
// Step order is agent → publish → reload because reload RESTARTS THIS POD:
// the orchestrating fiber dies mid-step by design. The publish (OTA bundle
// export) is pod-independent (opsd writes ~/assistant-data/updates on the
// host), so it must come first; reload is last, persisted as "running"
// BEFORE the opsd call, and completed by reconcileOnBoot() in the next
// process generation — a fresh healthy boot IS the evidence the reload
// landed (userspace is hostPath-mounted, so any post-gate restart serves
// the new code; a failed uscheck gate fails the opsd call while this pod
// is still alive to record it).

const MAX_LIVE = 5
const MAX_BUFFERED_EVENTS = 2000
const HEARTBEAT_MS = 15_000
const OPSD_TIMEOUT = "20 minutes" as const

const OpsdUrl = Config.string("OPSD_URL").pipe(Config.withDefault("http://host.orb.internal:9876"))
const OpsdToken = Config.redacted("OPSD_TOKEN")

export class TaskDbError extends Data.TaggedError("TaskDbError")<{ readonly message: string }> {}
class StepError extends Data.TaggedError("StepError")<{ readonly message: string }> {}
class OpsdBusy extends Data.TaggedError("OpsdBusy")<{}> {}

// ---------------------------------------------------------------------------
// TaskRepo: sqlite-backed persistence
// ---------------------------------------------------------------------------

export class TaskRepo extends Context.Tag("TaskRepo")<
  TaskRepo,
  {
    readonly insert: (task: Task) => Effect.Effect<void, TaskDbError>
    readonly save: (task: Task) => Effect.Effect<void, TaskDbError>
    readonly get: (id: string) => Effect.Effect<Option.Option<Task>, TaskDbError>
    readonly listRecent: (limit: number) => Effect.Effect<ReadonlyArray<Task>, TaskDbError>
  }
>() {}

const StepsJson = Schema.parseJson(Schema.Array(TaskStep))
const ResultJson = Schema.parseJson(TaskResult)
const encodeSteps = Schema.encodeSync(StepsJson)
const decodeSteps = Schema.decodeSync(StepsJson)
const encodeResult = Schema.encodeSync(ResultJson)
const decodeResult = Schema.decodeSync(ResultJson)

interface TaskRow {
  readonly id: string
  readonly kind: string
  readonly prompt: string
  readonly status: string
  readonly steps: string
  readonly result: string | null
  readonly error: string | null
  readonly created_at: string
  readonly updated_at: string
}

const rowToTask = (row: TaskRow): Task =>
  new Task({
    id: row.id,
    kind: "code",
    prompt: row.prompt,
    status: row.status as TaskStatus,
    steps: decodeSteps(row.steps),
    ...(row.result !== null ? { result: decodeResult(row.result) } : {}),
    ...(row.error !== null ? { error: row.error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  })

const taskToRow = (task: Task) => ({
  id: task.id,
  kind: task.kind,
  prompt: task.prompt,
  status: task.status,
  steps: encodeSteps([...task.steps]),
  result: task.result !== undefined ? encodeResult(task.result) : null,
  error: task.error ?? null,
  created_at: task.createdAt,
  updated_at: task.updatedAt
})

const dbError = (e: unknown) => new TaskDbError({ message: String(e) })

export const TaskRepoLive = Layer.effect(
  TaskRepo,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    // WAL: concurrent readers during the pipeline's writes, and the mode
    // litestream replication (P3) requires.
    yield* sql`PRAGMA journal_mode = WAL`.pipe(Effect.mapError(dbError))
    yield* sql`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        steps TEXT NOT NULL,
        result TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `.pipe(Effect.mapError(dbError))

    const save = (task: Task) => {
      const r = taskToRow(task)
      return sql`
        UPDATE tasks SET status = ${r.status}, steps = ${r.steps}, result = ${r.result},
          error = ${r.error}, updated_at = ${r.updated_at}
        WHERE id = ${r.id}
      `.pipe(Effect.mapError(dbError), Effect.asVoid)
    }

    const repo: Context.Tag.Service<TaskRepo> = {
      insert: (task) => {
        const r = taskToRow(task)
        return sql`
          INSERT INTO tasks (id, kind, prompt, status, steps, result, error, created_at, updated_at)
          VALUES (${r.id}, ${r.kind}, ${r.prompt}, ${r.status}, ${r.steps}, ${r.result}, ${r.error}, ${r.created_at}, ${r.updated_at})
        `.pipe(Effect.mapError(dbError), Effect.asVoid)
      },
      save,
      get: (id) =>
        sql<TaskRow>`SELECT * FROM tasks WHERE id = ${id}`.pipe(
          Effect.mapError(dbError),
          Effect.flatMap((rows) =>
            rows.length === 0
              ? Effect.succeedNone
              : Effect.try({ try: () => Option.some(rowToTask(rows[0]!)), catch: dbError })
          )
        ),
      listRecent: (limit) =>
        sql<TaskRow>`SELECT * FROM tasks ORDER BY created_at DESC LIMIT ${limit}`.pipe(
          Effect.mapError(dbError),
          Effect.flatMap((rows) => Effect.try({ try: () => rows.map(rowToTask), catch: dbError }))
        )
    }

    yield* reconcileOnBoot(repo)
    return repo
  })
)

// Boot reconciliation: this process is the successor of whatever pod wrote
// `running` rows. Two cases:
//  - reload was the in-flight step and everything before it succeeded → this
//    very boot is the reload completing → mark it (and the task) succeeded.
//    (Even a rollout-undo restart serves the new userspace: it's a hostPath,
//    and the typecheck gate ran before the restart was ever attempted.)
//  - anything else in flight (agent, publish) died with the old pod → the
//    task is `interrupted`; surfaced to the user for manual re-prompt, never
//    auto-retried.
const reconcileOnBoot = (repo: Context.Tag.Service<TaskRepo>) =>
  Effect.gen(function* () {
    const running = (yield* repo.listRecent(100)).filter((t) => t.status === "running")
    for (const task of running) {
      const step = (name: StepName) => task.steps.find((s) => s.name === name)
      const reloadInFlight =
        step("agent")?.status === "succeeded" &&
        step("publish")?.status === "succeeded" &&
        step("reload")?.status === "running"
      const patched = reloadInFlight
        ? withTask(task, {
            status: "succeeded",
            steps: patchStep(task.steps, "reload", "succeeded", "completed by boot reconciler")
          })
        : withTask(task, {
            status: "interrupted",
            error: "server restarted mid-task",
            steps: task.steps.map((s) =>
              s.status === "running" || s.status === "pending"
                ? new TaskStep({ name: s.name, status: "interrupted" })
                : s
            )
          })
      yield* repo.save(patched)
      yield* Effect.logInfo(`task ${task.id} reconciled at boot → ${patched.status}`)
    }
  })

const withTask = (
  task: Task,
  patch: Partial<{
    status: TaskStatus
    steps: ReadonlyArray<TaskStep>
    result: TaskResult
    error: string
  }>
): Task =>
  new Task({
    id: task.id,
    kind: task.kind,
    prompt: task.prompt,
    status: patch.status ?? task.status,
    steps: patch.steps ?? task.steps,
    ...((patch.result ?? task.result) !== undefined ? { result: patch.result ?? task.result } : {}),
    ...((patch.error ?? task.error) !== undefined ? { error: patch.error ?? task.error } : {}),
    createdAt: task.createdAt,
    updatedAt: new Date().toISOString()
  })

const patchStep = (
  steps: ReadonlyArray<TaskStep>,
  name: StepName,
  status: StepStatus,
  detail?: string
): ReadonlyArray<TaskStep> =>
  steps.map((s) =>
    s.name === name
      ? new TaskStep({ name, status, ...(detail !== undefined ? { detail } : {}) })
      : s
  )

// ---------------------------------------------------------------------------
// In-memory live entries: SSE replay buffer for tasks running in this process
// ---------------------------------------------------------------------------

interface LiveEntry {
  readonly id: string
  task: Task
  readonly events: Array<TaskEvent>
  truncated: boolean
  readonly listeners: Set<(event: TaskEvent) => void>
}

const live = new Map<string, LiveEntry>()

const notify = (entry: LiveEntry, event: TaskEvent) => {
  entry.events.push(event)
  // batch-drop the oldest quarter when over cap (O(1) amortized, not O(n²))
  if (entry.events.length > MAX_BUFFERED_EVENTS) {
    entry.events.splice(0, Math.floor(MAX_BUFFERED_EVENTS / 4))
    entry.truncated = true
  }
  for (const listener of entry.listeners) listener(event)
}

const evictOldIfNeeded = () => {
  if (live.size <= MAX_LIVE) return
  for (const [id, entry] of live) {
    if (entry.task.status === "running") continue
    live.delete(id)
    return
  }
}

const toAgentFrame = (event: AgentSessionEvent): TaskEvent | undefined => {
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
      // terminal frames are synthesized from the pipeline itself, not the
      // SDK's lifecycle events (single source of truth for status)
      return undefined
  }
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

const opsdCall = (
  opsdPath: string,
  message: string
): Effect.Effect<void, StepError | OpsdBusy, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const url = yield* OpsdUrl
    const token = yield* OpsdToken
    const client = yield* HttpClient.HttpClient
    const resp = yield* HttpClientRequest.post(`${url}${opsdPath}`).pipe(
      HttpClientRequest.setHeader("authorization", `Bearer ${Redacted.value(token)}`),
      HttpClientRequest.bodyText(JSON.stringify({ message }), "application/json"),
      client.execute,
      Effect.timeout(OPSD_TIMEOUT)
    )
    const text = yield* resp.text
    if (resp.status === 409) return yield* new OpsdBusy()
    if (resp.status !== 200) {
      let tail = text.slice(-1000)
      try {
        tail = String(JSON.parse(text).logTail ?? tail).slice(-1000)
      } catch {}
      return yield* new StepError({ message: `${opsdPath} exited non-zero: ${tail}` })
    }
  }).pipe(
    Effect.mapError((e) =>
      e._tag === "StepError" || e._tag === "OpsdBusy" ? e : new StepError({ message: String(e) })
    )
  )

// opsd is single-flight for ALL callers (manual redeploys included), so a
// 409 just means "someone else's script is running" — wait it out briefly
// instead of failing the whole task.
const opsdStep = (opsdPath: string, message: string) =>
  opsdCall(opsdPath, message).pipe(
    Effect.retry({
      while: (e) => e._tag === "OpsdBusy",
      schedule: Schedule.spaced("15 seconds"),
      times: 8
    }),
    Effect.mapError((e) =>
      e._tag === "OpsdBusy" ? new StepError({ message: `${opsdPath}: opsd busy, gave up after 2m` }) : e
    )
  )

const setStep = (entry: LiveEntry, name: StepName, status: StepStatus, detail?: string) => {
  entry.task = withTask(entry.task, { steps: patchStep(entry.task.steps, name, status, detail) })
  notify(entry, { type: "step", name, status, ...(detail !== undefined ? { detail } : {}) })
}

const finish = (
  entry: LiveEntry,
  status: TaskStatus,
  opts: { result?: TaskResult; error?: string } = {}
) => {
  entry.task = withTask(entry.task, {
    status,
    ...(opts.result !== undefined ? { result: opts.result } : {}),
    ...(opts.error !== undefined ? { error: opts.error } : {})
  })
  notify(entry, {
    type: "task",
    status,
    ...(opts.result !== undefined ? { result: opts.result } : {}),
    ...(opts.error !== undefined ? { error: opts.error } : {})
  })
}

const persist = (repo: Context.Tag.Service<TaskRepo>, entry: LiveEntry) =>
  // a db write failing must not kill the pipeline mid-flight — log and carry
  // on; the terminal persist is retried once since losing THAT loses the task
  repo.save(entry.task).pipe(
    Effect.tapError((e) => Effect.logError(`task ${entry.id} persist failed: ${e.message}`)),
    Effect.ignore
  )

const pipeline = (
  repo: Context.Tag.Service<TaskRepo>,
  entry: LiveEntry,
  env: { root: string; ollamaBaseUrl: string; defaultModel: string },
  options: PiRunOptions
) =>
  Effect.gen(function* () {
    // — agent —
    const onEvent = (event: AgentSessionEvent) => {
      const frame = toAgentFrame(event)
      if (frame !== undefined) notify(entry, frame)
    }
    const agentOutcome = yield* Effect.tryPromise({
      try: () => runPi(env, options, onEvent),
      catch: (e) => new PiError({ message: String(e) })
    }).pipe(
      Effect.flatMap((piResult) =>
        Effect.map(commitUserspace(options.prompt), (commit) => ({ piResult, commit }))
      ),
      Effect.either
    )

    if (Either.isLeft(agentOutcome)) {
      const e = agentOutcome.left
      // failed-run partial edits are live-served AND would be swept into the
      // next commit — stash them out of the working tree first
      const stashed = yield* stashUserspaceResidue(`${entry.id}: ${e.message}`).pipe(
        Effect.catchAll((stashErr) =>
          Effect.logError(`task ${entry.id}: ${stashErr.message}`).pipe(Effect.as(false))
        )
      )
      const error = stashed ? `${e.message} (partial edits stashed, see git stash list)` : e.message
      setStep(entry, "agent", "failed", error)
      setStep(entry, "publish", "skipped")
      setStep(entry, "reload", "skipped")
      finish(entry, "failed", { error })
      return yield* persist(repo, entry)
    }

    const { piResult, commit } = agentOutcome.right
    const result = new TaskResult({
      text: piResult.text,
      model: piResult.model,
      ...(commit !== undefined ? { commit } : {})
    })
    entry.task = withTask(entry.task, { result })
    setStep(entry, "agent", "succeeded", commit)
    yield* persist(repo, entry)

    // vault: journal the build + per-app pages. Best-effort (vault helpers
    // swallow their own errors) — never fails the task.
    const features = commit === undefined ? [] : yield* changedFeatures(commit)
    yield* Effect.promise(async () => {
      await journal(env.root, "built", `${options.prompt}${commit !== undefined ? ` → ${commit}` : ""}`)
      for (const name of features) await upsertAppPage(env.root, name, { prompt: options.prompt, commit })
    })

    if (commit === undefined) {
      setStep(entry, "publish", "skipped", "no userspace changes")
      setStep(entry, "reload", "skipped", "no userspace changes")
      finish(entry, "succeeded", { result })
      return yield* persist(repo, entry)
    }

    // — publish (pod-independent: bundle lands in ~/assistant-data/updates) —
    setStep(entry, "publish", "running")
    yield* persist(repo, entry)
    const published = yield* opsdStep("/publish-ota", options.prompt).pipe(Effect.either)
    if (Either.isLeft(published)) {
      setStep(entry, "publish", "failed", published.left.message)
      setStep(entry, "reload", "skipped")
      finish(entry, "failed", { error: published.left.message })
      return yield* persist(repo, entry)
    }
    setStep(entry, "publish", "succeeded")

    // — reload — persist "running" BEFORE the call: this step restarts the
    // pod, so this fiber usually dies inside it and reconcileOnBoot() in the
    // next process turns reload:running into succeeded.
    setStep(entry, "reload", "running")
    yield* persist(repo, entry)
    const reloaded = yield* opsdStep("/reload", options.prompt).pipe(Effect.either)
    if (Either.isLeft(reloaded)) {
      setStep(entry, "reload", "failed", reloaded.left.message)
      finish(entry, "failed", { error: reloaded.left.message })
      return yield* persist(repo, entry)
    }
    // only reached if the old pod outlived the rollout long enough to see
    // the opsd response (grace period) — the normal path is the reconciler
    setStep(entry, "reload", "succeeded")
    finish(entry, "succeeded", { result })
    return yield* persist(repo, entry)
  }).pipe(
    Effect.ensuring(Effect.sync(() => releaseEngine("coding")))
  )

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

const initialTask = (id: string, prompt: string): Task => {
  const now = new Date().toISOString()
  return new Task({
    id,
    kind: "code",
    prompt,
    status: "running",
    steps: [
      new TaskStep({ name: "agent", status: "running" }),
      new TaskStep({ name: "publish", status: "pending" }),
      new TaskStep({ name: "reload", status: "pending" })
    ],
    createdAt: now,
    updatedAt: now
  })
}

/**
 * Accept a coding task: engine slot, durable row, background pipeline.
 * Resolves immediately with the taskId; fails with PiError("busy") when a
 * coding OR generic Pi run already holds the engine.
 */
export const startCodeTask = (
  env: { root: string; ollamaBaseUrl: string; defaultModel: string },
  options: PiRunOptions
): Effect.Effect<{ taskId: string }, PiError, TaskRepo | HttpClient.HttpClient> =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      const repo = yield* TaskRepo
      if (!tryAcquireEngine("coding")) return yield* new PiError({ message: "busy" })
      const id = randomUUID()
      const entry: LiveEntry = {
        id,
        task: initialTask(id, options.prompt),
        events: [],
        truncated: false,
        listeners: new Set()
      }
      live.set(id, entry)
      evictOldIfNeeded()
      yield* repo.insert(entry.task).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            releaseEngine("coding")
            live.delete(id)
          })
        ),
        Effect.mapError((e) => new PiError({ message: `task insert failed: ${e.message}` }))
      )
      yield* Effect.forkDaemon(pipeline(repo, entry, env, options))
      return { taskId: id }
    })
  )

/** Durable task state — the db row, freshest available (live entry persists every transition). */
export const getTask = (id: string): Effect.Effect<Option.Option<Task>, TaskDbError, TaskRepo> =>
  Effect.flatMap(TaskRepo, (repo) => repo.get(id))

export const listTasks = (limit = 20): Effect.Effect<ReadonlyArray<Task>, TaskDbError, TaskRepo> =>
  Effect.flatMap(TaskRepo, (repo) => repo.listRecent(limit))

const encoder = new TextEncoder()
// frames are serialized structurally; the legacy mapper below emits the old
// wire dialect, hence `object` rather than TaskEvent here
const sseChunk = (frame: object): Uint8Array => encoder.encode(`data: ${JSON.stringify(frame)}\n\n`)
const HEARTBEAT = encoder.encode(`: hb\n\n`)

/**
 * SSE live view of a task running (or recently finished) in this process:
 * replays the buffered history, then follows live with heartbeats. Returns
 * undefined when the task has no live entry here (unknown id, or a pre-restart
 * task) — callers fall back to the durable row.
 */
export const taskEventStream = (
  id: string,
  mapFrame: (frame: TaskEvent) => object | undefined = (f) => f
): Stream.Stream<Uint8Array> | undefined => {
  const entry = live.get(id)
  if (entry === undefined) return undefined

  return Stream.asyncPush<Uint8Array>((emit) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        // replay + listener-attach in one synchronous block: no frame can
        // slip between the snapshot and the subscription
        if (entry.truncated) {
          void emit.single(sseChunk({ type: "token", text: "…[earlier output truncated]\n" }))
        }
        const push = (frame: TaskEvent) => {
          const mapped = mapFrame(frame)
          if (mapped !== undefined) void emit.single(sseChunk(mapped))
        }
        for (const frame of entry.events) push(frame)
        if (entry.task.status !== "running") {
          void emit.end()
          return undefined
        }
        const listener = (frame: TaskEvent) => {
          push(frame)
          if (frame.type === "task") void emit.end()
        }
        entry.listeners.add(listener)
        const heartbeat = setInterval(() => void emit.single(HEARTBEAT), HEARTBEAT_MS)
        return { listener, heartbeat }
      }),
      (sub) =>
        Effect.sync(() => {
          if (sub !== undefined) {
            entry.listeners.delete(sub.listener)
            clearInterval(sub.heartbeat)
          }
        })
    )
  )
}

// ---------------------------------------------------------------------------
// Legacy /api/system/code* compatibility (dropped once the P2 app bundle ships)
// ---------------------------------------------------------------------------

/** Old CodingRunStatus wire shape. */
export const legacyStatusOf = (task: Task) => {
  const base = {
    ...(task.result !== undefined ? { result: task.result } : {}),
    ...(task.error !== undefined ? { error: task.error } : {})
  }
  switch (task.status) {
    case "running":
      return { status: "running" as const, ...base }
    case "succeeded":
      return { status: "done" as const, ...base }
    case "failed":
      return { status: "failed" as const, ...base }
    case "interrupted":
      return { status: "failed" as const, ...base, error: task.error ?? "server restarted mid-task" }
  }
}

/**
 * Old SSE dialect: token/tool pass through, step frames are dropped, the
 * terminal task frame becomes done/error. NOTE the old app reacts to `done`
 * by running reload+publish itself — redundant after this server already did
 * (harmless: reload commits nothing new, publish re-exports), and gone once
 * the P2 bundle lands.
 */
export const toLegacyFrame = (frame: TaskEvent): object | undefined => {
  switch (frame.type) {
    case "token":
    case "tool":
      return frame
    case "step":
      return undefined
    case "task":
      return frame.status === "succeeded"
        ? { type: "done", result: frame.result }
        : { type: "error", message: frame.error ?? "failed" }
  }
}
