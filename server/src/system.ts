import {
  FileSystem,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse
} from "@effect/platform"
import { PiClient, type PiRunOptions } from "@assistant/capabilities-server/pi"
import { Config, Effect, Redacted } from "effect"
import * as path from "node:path"
import { codingEnv, commitUserspace, resetAllState } from "./code.js"
import { codingRunEventStream, getCodingRunStatus, startCodingRun } from "./coding-runs.js"

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

// the self-mod coder, async: accepts and returns {runId} immediately (202),
// the Pi session + userspace commit run in a background fiber (see
// coding-runs.ts). Phone-friendly: a multi-minute run can't hold an HTTP
// request open across a screen lock.
const codeStart = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest
  const body = yield* req.text
  const parsed = parsePiRun(body)
  if (parsed === undefined) {
    return yield* HttpServerResponse.json({ error: "prompt required" }, { status: 400 })
  }
  const options: PiRunOptions = { ...parsed, tools: "coding" }
  const env = yield* codingEnv
  return yield* startCodingRun(env, options).pipe(
    Effect.flatMap(({ runId }) => HttpServerResponse.json({ runId }, { status: 202 })),
    Effect.catchTag("PiError", (e) =>
      HttpServerResponse.json({ error: e.message }, { status: e.message === "busy" ? 409 : 500 })
    )
  )
})

// SSE stream of a run's live events. If the run already finished, emits the
// terminal event once and closes instead of hanging on a reconnect.
const codeStream = Effect.gen(function* () {
  const params = yield* HttpRouter.params
  const stream = codingRunEventStream(params["runId"] ?? "")
  if (stream === undefined) {
    return yield* HttpServerResponse.json({ error: "not found" }, { status: 404 })
  }
  return yield* HttpServerResponse.stream(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" }
  })
})

// Plain JSON status/result — the SSE-reconnect backstop for when a phone's
// stream connection dies (screen lock). Works with no prior stream ever
// having been opened for this runId.
const codeStatus = Effect.gen(function* () {
  const params = yield* HttpRouter.params
  const status = getCodingRunStatus(params["runId"] ?? "")
  if (status === undefined) {
    return yield* HttpServerResponse.json({ error: "not found" }, { status: 404 })
  }
  return yield* HttpServerResponse.json(status)
})

// Demo/PoC reset: wipe all assistant-built state, then exit — kubernetes
// restarts the container and boot rebuilds the skeleton (bootstrap + regen).
// The delayed exit lets the 200 reply flush first. Deliberately no engine-busy
// guard: reset is absolute, and the dying process takes any live run with it.
const resetHandler = Effect.gen(function* () {
  yield* resetAllState
  setTimeout(() => process.exit(0), 750)
  return yield* HttpServerResponse.json({ ok: true, resetting: true })
}).pipe(
  Effect.catchTag("PiError", (e) => HttpServerResponse.json({ error: e.message }, { status: 500 }))
)

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
    HttpRouter.post("/api/system/publish-ota", proxy("/publish-ota")),
    HttpRouter.post("/api/system/code", codeStart),
    HttpRouter.get("/api/system/code/:runId/stream", codeStream),
    HttpRouter.get("/api/system/code/:runId", codeStatus),
    // generic engine access — the endpoint behind the app-side PiProxy. Forced
    // to tools:"none": coding tools write to + commit the userspace repo,
    // guarded only by /api/system/code's own activeRunId single-flight (see
    // coding-runs.ts) — that lock is disjoint from this route's PiClient
    // "busy" flag, so letting a client request tools:"coding" here would let
    // a coding run bypass single-flight and race a concurrent one.
    HttpRouter.post("/api/pi/run", piRun({ tools: "none" })),
    HttpRouter.post("/api/system/reset", systemReset),
    HttpRouter.get("/api/motd", motd)
  )
