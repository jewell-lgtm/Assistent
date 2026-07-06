import { Task, TaskAccepted, TaskEvent, TaskList } from "@assistant/platform-api/tasks"
import { Effect, Schema } from "effect"
import { apiRequest } from "./PiProxy"

// Typed client for the server's task surface (/api/tasks) — every response
// and SSE frame is Schema-decoded against @assistant/platform-api, the same
// definitions the server encodes with. No hand-rolled `any` JSON.

const decodeTask = Schema.decodeUnknownEither(Task)
const decodeTaskList = Schema.decodeUnknownEither(TaskList)
const decodeAccepted = Schema.decodeUnknownEither(TaskAccepted)
const decodeEvent = Schema.decodeUnknownEither(TaskEvent)

export type StartOutcome =
  | { readonly kind: "accepted"; readonly taskId: string }
  | { readonly kind: "busy" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "error"; readonly message: string }

export const startTask = (prompt: string): Promise<StartOutcome> =>
  Effect.runPromise(
    apiRequest("POST", "/api/tasks", { prompt }).pipe(
      Effect.map(({ status, json }): StartOutcome => {
        if (status === 401) return { kind: "unauthorized" }
        if (status === 409) return { kind: "busy" }
        if (status >= 200 && status < 300) {
          const accepted = decodeAccepted(json)
          if (accepted._tag === "Right") return { kind: "accepted", taskId: accepted.right.taskId }
        }
        const message =
          typeof (json as { error?: unknown })?.error === "string"
            ? (json as { error: string }).error
            : `unexpected response (HTTP ${status})`
        return { kind: "error", message }
      }),
      Effect.catchAll((e) => Effect.succeed<StartOutcome>({ kind: "error", message: e.message }))
    )
  )

export type TaskFetch =
  | { readonly kind: "found"; readonly task: Task }
  | { readonly kind: "not-found" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "error"; readonly message: string }

export const fetchTask = (taskId: string): Promise<TaskFetch> =>
  Effect.runPromise(
    apiRequest("GET", `/api/tasks/${encodeURIComponent(taskId)}`).pipe(
      Effect.map(({ status, json }): TaskFetch => {
        if (status === 401) return { kind: "unauthorized" }
        if (status === 404) return { kind: "not-found" }
        if (status >= 400) return { kind: "error", message: `HTTP ${status}` }
        const task = decodeTask(json)
        return task._tag === "Right"
          ? { kind: "found", task: task.right }
          : { kind: "error", message: "malformed task payload" }
      }),
      Effect.catchAll((e) => Effect.succeed<TaskFetch>({ kind: "error", message: e.message }))
    )
  )

/** Recent tasks, newest first; null on any failure (callers treat it as "unknown", never an error state). */
export const fetchTasks = (): Promise<ReadonlyArray<Task> | null> =>
  Effect.runPromise(
    apiRequest("GET", "/api/tasks").pipe(
      Effect.map(({ status, json }) => {
        if (status < 200 || status >= 300) return null
        const list = decodeTaskList(json)
        return list._tag === "Right" ? list.right.tasks : null
      }),
      Effect.catchAll(() => Effect.succeed(null))
    )
  )

/** Decode one SSE `data:` payload; undefined for unknown/future frame shapes (ignore, don't crash). */
export const decodeTaskFrame = (raw: string): TaskEvent | undefined => {
  try {
    const frame = decodeEvent(JSON.parse(raw))
    return frame._tag === "Right" ? frame.right : undefined
  } catch {
    return undefined
  }
}
