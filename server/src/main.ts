import { HttpMiddleware, HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { NodeContext, NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Config, Effect, Layer, Redacted } from "effect"
import { createServer } from "node:http"
import { FetchHttpClient } from "@effect/platform"
import { otaRoutes } from "./ota.js"
import { systemRoutes } from "./system.js"

const GitSha = Config.string("GIT_SHA").pipe(Config.withDefault("dev"))
const Port = Config.integer("PORT").pipe(Config.withDefault(8080))
const ApiToken = Config.redacted("API_TOKEN")

const healthz = Effect.gen(function* () {
  const sha = yield* GitSha
  return yield* HttpServerResponse.json({ ok: true, sha, startedAt })
})

const startedAt = new Date().toISOString()

// bearer auth on everything except /healthz
const bearerAuth = HttpMiddleware.make((app) =>
  Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest
    if (req.url === "/healthz") return yield* app
    const token = yield* ApiToken
    const header = req.headers["authorization"]
    if (header !== `Bearer ${Redacted.value(token)}`) {
      return yield* HttpServerResponse.json({ error: "unauthorized" }, { status: 401 })
    }
    return yield* app
  })
)

const router = HttpRouter.empty.pipe(
  HttpRouter.get("/healthz", healthz),
  HttpRouter.get(
    "/api/whoami",
    HttpServerResponse.json({ app: "local-assistent", experiment: true })
  ),
  otaRoutes,
  systemRoutes
)

const app = router.pipe(bearerAuth, HttpServer.serve(HttpMiddleware.logger))

const ServerLive = Layer.unwrapEffect(
  Effect.map(Port, (port) => NodeHttpServer.layer(() => createServer(), { port, host: "0.0.0.0" }))
)

NodeRuntime.runMain(
  Layer.launch(
    Layer.provide(app, Layer.mergeAll(ServerLive, NodeContext.layer, FetchHttpClient.layer))
  )
)
