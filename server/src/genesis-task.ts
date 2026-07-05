import { getAgentDir } from "@earendil-works/pi-coding-agent"
import { Data, Effect } from "effect"
import { randomUUID } from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"

// Durable, resumable state for one multi-prompt feature-authoring effort
// ("unlimited genesis iterations"). Own reimplementation of the pi-task
// pattern (stage pipeline + crash-safe task files) — not a dependency on the
// npm package, just its shape.
//
// research/grill collapse into refine: this is a single-developer local loop
// authoring one small feature at a time, not an open-ended multi-agent spec
// negotiation — a rough prompt plus one clarifying pass is enough context
// for compose to start from. Splitting refine further would just add
// stage-transition bookkeeping with nothing using the extra stages yet.
//
// Stored on PI_CODING_AGENT_DIR (same /pi-agent mount session state uses),
// NOT userspace: this is orchestration metadata about a genesis run, not
// feature data the agent authors — same split pi-tuning.md #4 draws for
// session JSONL.

export type GenesisStage = "refine" | "compose" | "critique"
export type GenesisStatus = "in_progress" | "done" | "failed"

export interface GenesisStageEntry {
  readonly stage: GenesisStage
  readonly prompt: string
  readonly resultSummary: string
  readonly timestamp: string
}

export interface GenesisTask {
  readonly taskId: string
  readonly goalPrompt: string
  readonly stage: GenesisStage
  readonly status: GenesisStatus
  readonly log: ReadonlyArray<GenesisStageEntry>
  readonly createdAt: string
  readonly updatedAt: string
}

export class GenesisTaskError extends Data.TaggedError("GenesisTaskError")<{
  readonly message: string
}> {}

const tasksDir = () => path.join(getAgentDir(), "tasks")

const taskFile = (taskId: string) => path.join(tasksDir(), `${taskId}.json`)

const readTaskFile = async (taskId: string): Promise<GenesisTask> => {
  const raw = await fs.readFile(taskFile(taskId), "utf8")
  return JSON.parse(raw) as GenesisTask
}

// write-temp-then-rename: rename is atomic on the same filesystem, so a crash
// mid-write leaves either the old file or the new one, never a half-written one.
const writeTaskFile = async (task: GenesisTask): Promise<void> => {
  const dir = tasksDir()
  await fs.mkdir(dir, { recursive: true })
  const tmp = path.join(dir, `.${task.taskId}.${randomUUID()}.tmp`)
  await fs.writeFile(tmp, JSON.stringify(task, null, 2), "utf8")
  await fs.rename(tmp, taskFile(task.taskId))
}

const wrap = <A>(op: string, thunk: () => Promise<A>) =>
  Effect.tryPromise({
    try: thunk,
    catch: (e) => new GenesisTaskError({ message: `${op} failed: ${String(e)}` })
  })

// Per-taskId lock: appendStageResult/advanceStage are read-modify-write (read
// task, compute next, write task) — without this, two concurrent calls for
// the same taskId (SSE-reconnect retry, double-submit) both read the same
// base and the later write silently clobbers the earlier one. Chains onto
// whatever's already pending for taskId, then drops the entry once settled
// so the map only holds currently in-flight tasks.
const taskLocks = new Map<string, Promise<void>>()

const withTaskLock = <A>(taskId: string, thunk: () => Promise<A>): Promise<A> => {
  const prior = taskLocks.get(taskId) ?? Promise.resolve()
  const result = prior.then(thunk, thunk)
  const settled = result.then(
    () => undefined,
    () => undefined
  )
  taskLocks.set(taskId, settled)
  settled.then(() => {
    if (taskLocks.get(taskId) === settled) taskLocks.delete(taskId)
  })
  return result
}

export const createTask = (goalPrompt: string) =>
  wrap("createTask", async () => {
    const now = new Date().toISOString()
    const task: GenesisTask = {
      taskId: randomUUID(),
      goalPrompt,
      stage: "refine",
      status: "in_progress",
      log: [],
      createdAt: now,
      updatedAt: now
    }
    await writeTaskFile(task)
    return task
  })

export const loadTask = (taskId: string) => wrap("loadTask", () => readTaskFile(taskId))

export const appendStageResult = (
  taskId: string,
  stage: GenesisStage,
  entry: { readonly prompt: string; readonly resultSummary: string }
) =>
  wrap("appendStageResult", () =>
    withTaskLock(taskId, async () => {
      const task = await readTaskFile(taskId)
      const stageEntry: GenesisStageEntry = { stage, ...entry, timestamp: new Date().toISOString() }
      const updated: GenesisTask = {
        ...task,
        log: [...task.log, stageEntry],
        updatedAt: stageEntry.timestamp
      }
      await writeTaskFile(updated)
      return updated
    }))

/** Move the task's current stage forward (and/or flip its terminal status). */
export const advanceStage = (
  taskId: string,
  nextStage: GenesisStage,
  status: GenesisStatus = "in_progress"
) =>
  wrap("advanceStage", () =>
    withTaskLock(taskId, async () => {
      const task = await readTaskFile(taskId)
      const updated: GenesisTask = {
        ...task,
        stage: nextStage,
        status,
        updatedAt: new Date().toISOString()
      }
      await writeTaskFile(updated)
      return updated
    }))

export const listTasks = () =>
  wrap("listTasks", async () => {
    const dir = tasksDir()
    const files = await fs.readdir(dir).catch((e) => {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return []
      throw e
    })
    const ids = files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -".json".length))
    const tasks = await Promise.all(ids.map(readTaskFile))
    return tasks.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  })
