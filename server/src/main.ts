import { HttpMiddleware, HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { NodeContext, NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Config, Effect, Layer, Redacted } from "effect"
import { createServer } from "node:http"
import { FetchHttpClient } from "@effect/platform"
import { PiClientLive } from "./code.js"
import { SqlLive } from "./db.js"
import { otaRoutes } from "./ota.js"
import { systemRoutes } from "./system.js"
import { TaskRepoLive } from "./tasks.js"
import { userspaceRoutes } from "./userspace.js"

const GitSha = Config.string("GIT_SHA").pipe(Config.withDefault("dev"))
const Port = Config.integer("PORT").pipe(Config.withDefault(8080))
const ApiToken = Config.redacted("API_TOKEN")

const healthz = Effect.gen(function* () {
  const sha = yield* GitSha
  return yield* HttpServerResponse.json({ ok: true, sha, startedAt })
})

const startedAt = new Date().toISOString()

// bearer auth on everything except /healthz. API_TOKEN may hold several
// comma-separated tokens during a rotation window — any listed token
// authenticates. Rotation without deadlock: set "new,old" (pod restart),
// publish the OTA bundle carrying "new" (the phone still FETCHES it with the
// old baked token), then drop ",old" once the phone is confirmed on "new".
const bearerAuth = HttpMiddleware.make((app) =>
  Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest
    if (req.url === "/healthz") return yield* app
    const token = yield* ApiToken
    const header = req.headers["authorization"]
    const accepted = Redacted.value(token)
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
    if (header === undefined || !accepted.some((t) => header === `Bearer ${t}`)) {
      return yield* HttpServerResponse.json({ error: "unauthorized" }, { status: 401 })
    }
    return yield* app
  })
)

// userspace loading is async (dynamic imports) → router assembly is an Effect
const router = Effect.map(userspaceRoutes, (withUserspace) =>
  HttpRouter.empty.pipe(
    HttpRouter.get("/healthz", healthz),
    HttpRouter.get(
      "/api/whoami",
      HttpServerResponse.json({ app: "local-assistent", experiment: true })
    ),
    otaRoutes,
    systemRoutes,
    withUserspace
  )
)

const app = Layer.unwrapEffect(
  Effect.map(router, (r) => r.pipe(bearerAuth, HttpServer.serve(HttpMiddleware.logger)))
)

const ServerLive = Layer.unwrapEffect(
  Effect.map(Port, (port) => NodeHttpServer.layer(() => createServer(), { port, host: "0.0.0.0" }))
)

// TaskRepo's layer init runs the sqlite migration AND the boot reconciler
// (tasks orphaned by the previous pod generation) before any route is served.
const TasksLive = TaskRepoLive.pipe(Layer.provide(SqlLive))

NodeRuntime.runMain(
  Layer.launch(
    Layer.provide(
      app,
      Layer.mergeAll(ServerLive, NodeContext.layer, FetchHttpClient.layer, PiClientLive, TasksLive)
    )
  )
)
