import {
  FileSystem,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse
} from "@effect/platform"
import { PiClient, type PiRunOptions } from "@assistant/capabilities-server/pi"
import { Task, TaskList, type TaskEvent } from "@assistant/platform-api/tasks"
import { Config, Effect, Option, Schema, Stream } from "effect"
import { Redacted } from "effect"
import * as path from "node:path"
import { codingEnv, commitUserspace, resetAllState } from "./code.js"
import { getTask, legacyStatusOf, listTasks, startCodeTask, taskEventStream, toLegacyFrame } from "./tasks.js"
import { journal, searchVault } from "./vault.js"

const OpsdUrl = Config.string("OPSD_URL").pipe(Config.withDefault("http://host.orb.internal:9876"))
const OpsdToken = Config.redacted("OPSD_TOKEN")
const RepoDir = Config.string("REPO_DIR").pipe(Config.withDefault("/repo"))

// Proxy a request body through to the host-side ops daemon.
const proxy = (opsdPath: string) =>
  Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest
    const body = yield* req.text
    const url = yield* OpsdUrl
    const token = yield* OpsdToken
    const client = yield* HttpClient.HttpClient
    const resp = yield* HttpClientRequest.post(`${url}${opsdPath}`).pipe(
      HttpClientRequest.setHeader("authorization", `Bearer ${Redacted.value(token)}`),
      HttpClientRequest.bodyText(body === "" ? "{}" : body, "application/json"),
      client.execute,
      Effect.timeout("15 minutes")
    )
    const text = yield* resp.text
    return yield* HttpServerResponse.text(text, {
      status: resp.status,
      headers: { "content-type": "application/json" }
    })
  })

// Live read from the userspace config on the repo hostPath — the E2 demo
// target: the agent edits this file, the API reflects it with no restart.
const motd = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const repo = yield* RepoDir
  const file = path.join(repo, "userspace", "config", "motd.json")
  const raw = yield* fs
    .readFileString(file)
    .pipe(Effect.orElseSucceed(() => JSON.stringify({ motd: "no userspace motd yet" })))
  return yield* HttpServerResponse.text(raw, { headers: { "content-type": "application/json" } })
})

const parsePiRun = (body: string): PiRunOptions | undefined => {
  try {
    const json = JSON.parse(body)
    const prompt = json.prompt ?? json.message
    if (typeof prompt !== "string" || prompt === "") return undefined
    return {
      prompt,
      routing: json.routing === "private" ? "private" : "default",
      ...(typeof json.model === "string" ? { model: json.model } : {}),
      tools: json.tools === "coding" ? "coding" : "none"
    }
  } catch {
    return undefined
  }
}

const piRun = (fixed?: Partial<PiRunOptions>) =>
  Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest
    const body = yield* req.text
    const parsed = parsePiRun(body)
    if (parsed === undefined) {
      return yield* HttpServerResponse.json({ error: "prompt required" }, { status: 400 })
    }
    // A capability this route doesn't offer must be a loud 4xx, not a silent
    // downgrade: a caller asking for coding tools would otherwise get a
    // plausible 200 reply with nothing written and nothing committed.
    if (fixed?.tools === "none" && parsed.tools === "coding") {
      return yield* HttpServerResponse.json(
        { error: "coding tools are not available on this endpoint — use POST /api/system/code" },
        { status: 400 }
      )
    }
    const options = { ...parsed, ...fixed }
    const pi = yield* PiClient
    return yield* pi.run(options).pipe(
      Effect.flatMap((result) =>
        options.tools === "coding"
          ? Effect.map(commitUserspace(options.prompt), (commit) => ({ ...result, commit }))
          : Effect.succeed(result)
      ),
      Effect.flatMap((result) => HttpServerResponse.json({ ok: true, ...result })),
      Effect.catchTag("PiError", (e) =>
        HttpServerResponse.json({ error: e.message }, { status: e.message === "busy" ? 409 : 500 })
      )
    )
  })

// Chat with memory: a plain LLM turn PLUS vault remember/recall tools, so
// "remember X" persists to the Obsidian vault and "remind me" searches it.
// Same engine single-flight as coding; journaled for the activity log.
const chat = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest
  const body = yield* req.text
  const parsed = parsePiRun(body)
  if (parsed === undefined) {
    return yield* HttpServerResponse.json({ error: "message required" }, { status: 400 })
  }
  const env = yield* codingEnv
  yield* Effect.promise(() => journal(env.root, "chat", parsed.prompt.slice(0, 200)))
  // RAG-style recall: always search the vault for the user's message and inject
  // the top hits as context, so recall is deterministic instead of hoping the
  // model calls the recall tool. The remember tool still handles saving.
  const hits = yield* Effect.promise(() => searchVault(env.root, parsed.prompt))
  const context =
    hits.length === 0
      ? ""
      : `\n\nRelevant notes from the user's vault (use these to answer):\n${hits.map((h) => `- ${h.line}`).join("\n")}`
  const options: PiRunOptions = { ...parsed, prompt: parsed.prompt + context, tools: "chat" }
  const pi = yield* PiClient
  return yield* pi.run(options).pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, ...result })),
    Effect.catchTag("PiError", (e) =>
      HttpServerResponse.json({ error: e.message }, { status: e.message === "busy" ? 409 : 500 })
    )
  )
})

// the self-mod coder, async: accepts and returns immediately (202) with the
// task id; the WHOLE pipeline (Pi session → commit → OTA publish → reload)
// runs server-side (see tasks.ts). The phone can go offline the moment it
// has the id — foregrounding later reads the durable task row.
const taskStart = (legacy: boolean) =>
  Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest
    const body = yield* req.text
    const parsed = parsePiRun(body)
    if (parsed === undefined) {
      return yield* HttpServerResponse.json({ error: "prompt required" }, { status: 400 })
    }
    const options: PiRunOptions = { ...parsed, tools: "coding" }
    const env = yield* codingEnv
    return yield* startCodeTask(env, options).pipe(
      Effect.flatMap(({ taskId }) =>
        HttpServerResponse.json(legacy ? { runId: taskId } : { taskId }, { status: 202 })
      ),
      Effect.catchTag("PiError", (e) =>
        HttpServerResponse.json({ error: e.message }, { status: e.message === "busy" ? 409 : 500 })
      )
    )
  })

const encodeTask = Schema.encodeSync(Task)
const encodeTaskList = Schema.encodeSync(TaskList)

// Synthesized replay for a task with no live entry in this process (finished
// before a restart): its step history + terminal frame straight from the row,
// so a late/reconnecting stream consumer still converges.
const rowFrames = (task: Task): ReadonlyArray<TaskEvent> => [
  ...task.steps.map(
    (s): TaskEvent => ({
      type: "step",
      name: s.name,
      status: s.status,
      ...(s.detail !== undefined ? { detail: s.detail } : {})
    })
  ),
  ...(task.status !== "running"
    ? [
        {
          type: "task",
          status: task.status,
          ...(task.result !== undefined ? { result: task.result } : {}),
          ...(task.error !== undefined ? { error: task.error } : {})
        } satisfies TaskEvent
      ]
    : [])
]

const sseHeaders = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive"
} as const

const encoder = new TextEncoder()

const taskStream = (legacy: boolean) =>
  Effect.gen(function* () {
    const params = yield* HttpRouter.params
    const id = params[legacy ? "runId" : "taskId"] ?? ""
    const mapFrame = legacy ? toLegacyFrame : (f: TaskEvent) => f
    const stream = taskEventStream(id, mapFrame)
    if (stream !== undefined) {
      return yield* HttpServerResponse.stream(stream, { headers: sseHeaders })
    }
    // no live entry (pre-restart task): replay the durable row and close
    const task = yield* getTask(id).pipe(Effect.catchAll(() => Effect.succeedNone))
    if (Option.isNone(task)) {
      return yield* HttpServerResponse.json({ error: "not found" }, { status: 404 })
    }
    const frames = rowFrames(task.value)
      .map(mapFrame)
      .filter((f): f is object => f !== undefined)
      .map((f) => encoder.encode(`data: ${JSON.stringify(f)}\n\n`))
    return yield* HttpServerResponse.stream(Stream.fromIterable(frames), { headers: sseHeaders })
  })

// Plain JSON status — the durable backstop; works with no stream ever opened
// and across pod restarts.
const taskGet = (legacy: boolean) =>
  Effect.gen(function* () {
    const params = yield* HttpRouter.params
    const id = params[legacy ? "runId" : "taskId"] ?? ""
    const task = yield* getTask(id).pipe(Effect.catchAll(() => Effect.succeedNone))
    if (Option.isNone(task)) {
      return yield* HttpServerResponse.json({ error: "not found" }, { status: 404 })
    }
    return yield* HttpServerResponse.json(legacy ? legacyStatusOf(task.value) : encodeTask(task.value))
  })

const tasksList = Effect.gen(function* () {
  const tasks = yield* listTasks(20).pipe(Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<Task>)))
  return yield* HttpServerResponse.json(encodeTaskList({ tasks }))
})

// Demo/PoC reset: wipe all assistant-built state, then exit — kubernetes
// restarts the container and boot rebuilds the skeleton (bootstrap + regen).
// Demo/PoC hard reset: wipe all assistant-built state, respond, then exit so
// the container restart rebuilds the skeleton from appspace (bootstrap). The
// process.exit is deferred past the response flush. maxUnavailable:0 means the
// replacement pod is up before this one dies, so the client's follow-up
// reconnect lands on a freshly-bootstrapped server.
const systemReset = Effect.gen(function* () {
  yield* resetAllState
  yield* Effect.sync(() => {
    setTimeout(() => process.exit(0), 500)
  })
  return yield* HttpServerResponse.json({ ok: true, message: "state wiped; server restarting" })
}).pipe(
  Effect.catchTag("PiError", (e) => HttpServerResponse.json({ error: e.message }, { status: 500 }))
)

export const systemRoutes = <E, R>(router: HttpRouter.HttpRouter<E, R>) =>
  router.pipe(
    HttpRouter.post("/api/system/redeploy", proxy("/redeploy")),
    HttpRouter.post("/api/system/reload", proxy("/reload")),
    HttpRouter.post("/api/system/publish-ota", proxy("/publish-ota")),
    // tasks: the durable async-pipeline surface (P1 of design-async-tasks.md)
    HttpRouter.post("/api/tasks", taskStart(false)),
    HttpRouter.get("/api/tasks", tasksList),
    HttpRouter.get("/api/tasks/:taskId/stream", taskStream(false)),
    HttpRouter.get("/api/tasks/:taskId", taskGet(false)),
    // legacy dialect for the pre-P2 app bundle — same engine underneath
    HttpRouter.post("/api/system/code", taskStart(true)),
    HttpRouter.get("/api/system/code/:runId/stream", taskStream(true)),
    HttpRouter.get("/api/system/code/:runId", taskGet(true)),
    // generic engine access — the endpoint behind the app-side PiProxy. Forced
    // to tools:"none": coding tools write to + commit the userspace repo,
    // guarded only by /api/system/code's own activeRunId single-flight (see
    // coding-runs.ts) — that lock is disjoint from this route's PiClient
    // "busy" flag, so letting a client request tools:"coding" here would let
    // a coding run bypass single-flight and race a concurrent one.
    HttpRouter.post("/api/pi/run", piRun({ tools: "none" })),
    HttpRouter.post("/api/chat", chat),
    HttpRouter.post("/api/system/reset", systemReset),
    HttpRouter.get("/api/motd", motd)
  )
