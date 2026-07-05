import {
  FileSystem,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse
} from "@effect/platform"
import { Config, Effect, Redacted } from "effect"
import * as path from "node:path"

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

export const systemRoutes = <E, R>(router: HttpRouter.HttpRouter<E, R>) =>
  router.pipe(
    HttpRouter.post("/api/system/redeploy", proxy("/redeploy")),
    HttpRouter.post("/api/system/publish-ota", proxy("/publish-ota")),
    HttpRouter.post("/api/system/code", proxy("/code")),
    HttpRouter.get("/api/motd", motd)
  )
