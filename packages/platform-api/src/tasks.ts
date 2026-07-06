import { Schema } from "effect"

// The platform wire contract for async tasks — shared by the server (source
// of truth, sqlite-backed) and the app (decodes every response/SSE frame with
// these schemas; no hand-rolled `any` JSON). A task is the unit of "prompt
// goes up, phone may go offline": the server owns the whole
// agent → publish → reload pipeline and records progress here.

export const TaskKind = Schema.Literal("code")
export type TaskKind = typeof TaskKind.Type

// Pipeline step order is fixed: agent (Pi session + userspace commit),
// publish (OTA bundle export on the host — pod-independent), reload (pod
// restart; deliberately LAST because it kills the orchestrating process —
// the boot reconciler completes it, see server tasks.ts).
export const StepName = Schema.Literal("agent", "publish", "reload")
export type StepName = typeof StepName.Type

export const StepStatus = Schema.Literal(
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped",
  "interrupted"
)
export type StepStatus = typeof StepStatus.Type

export const TaskStatus = Schema.Literal("running", "succeeded", "failed", "interrupted")
export type TaskStatus = typeof TaskStatus.Type

export class TaskStep extends Schema.Class<TaskStep>("TaskStep")({
  name: StepName,
  status: StepStatus,
  detail: Schema.optional(Schema.String)
}) {}

export class TaskResult extends Schema.Class<TaskResult>("TaskResult")({
  text: Schema.String,
  model: Schema.String,
  commit: Schema.optional(Schema.String)
}) {}

export class Task extends Schema.Class<Task>("Task")({
  id: Schema.String,
  kind: TaskKind,
  prompt: Schema.String,
  status: TaskStatus,
  steps: Schema.Array(TaskStep),
  result: Schema.optional(TaskResult),
  error: Schema.optional(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String
}) {}

export const TaskList = Schema.Struct({ tasks: Schema.Array(Task) })
export type TaskList = typeof TaskList.Type

export const TaskAccepted = Schema.Struct({ taskId: Schema.String })
export type TaskAccepted = typeof TaskAccepted.Type

// SSE frames on GET /api/tasks/:id/stream. token/tool mirror the agent's live
// output; step/task are pipeline state transitions. The stream is a live VIEW
// only — the task row is the durable truth, so a dropped stream loses nothing.
export const TaskEvent = Schema.Union(
  Schema.Struct({ type: Schema.Literal("token"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("tool"),
    toolName: Schema.String,
    phase: Schema.Literal("start", "update", "end"),
    error: Schema.optional(Schema.Boolean)
  }),
  Schema.Struct({
    type: Schema.Literal("step"),
    name: StepName,
    status: StepStatus,
    detail: Schema.optional(Schema.String)
  }),
  Schema.Struct({
    type: Schema.Literal("task"),
    status: TaskStatus,
    result: Schema.optional(TaskResult),
    error: Schema.optional(Schema.String)
  })
)
export type TaskEvent = typeof TaskEvent.Type
