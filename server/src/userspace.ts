import { HttpApiBuilder, HttpRouter, HttpServerResponse } from "@effect/platform"
import { PiClient } from "@assistant/capabilities-server/pi"
import type { ChatCapability, ServerCapability, UserspaceServices } from "@assistant/capabilities-server/server"
import { SqlClient } from "@effect/sql"
import { Cause, Config, Effect, Exit, Layer } from "effect"
import { persistenceLive } from "./persistence.js"
import { userspaceServer } from "./userspace.gen.js"

// Failure-isolated userspace loader: a module that throws at import or mount
// time is skipped + recorded, never crashes core. Http surfaces mount under
// /api/features/<name>/; chat capabilities collect into a registry (chat = E4).

export const chatCapabilities: Array<ChatCapability> = []

type AnyRouter = HttpRouter.HttpRouter<any, any>

const UserspaceDir = Config.string("USERSPACE_DIR").pipe(Config.withDefault("/repo/userspace"))

const buildModule = (
  root: string,
  piLayer: Layer.Layer<PiClient>,
  sqlLayer: Layer.Layer<SqlClient.SqlClient>,
  featureName: string,
  caps: ReadonlyArray<ServerCapability>
) =>
  Effect.gen(function* () {
    let router: AnyRouter = HttpRouter.empty
    const chats: Array<ChatCapability> = []
    for (const cap of caps) {
      if (cap.kind === "chat") {
        chats.push(cap)
        continue
      }
      // per-feature namespace: keyed by featureName (the SAFE_NAME-sanitized
      // userspace/features/<dir> name), NEVER cap.name — cap.name is a string
      // the feature's own server.ts declares and is not validated, so keying
      // on it would let a feature read/write another feature's store (or
      // mount over another feature's route prefix) just by naming it.
      const featureLayer: Layer.Layer<UserspaceServices> = Layer.merge(
        piLayer,
        persistenceLive(root, featureName).pipe(Layer.provide(sqlLayer))
      )
      const prefix = `/api/features/${featureName}` as const
      const app =
        cap.kind === "http"
          ? yield* HttpApiBuilder.httpApp.pipe(
              Effect.provide(
                Layer.mergeAll(
                  HttpApiBuilder.api(cap.api as any).pipe(
                    Layer.provide(cap.live as unknown as Layer.Layer<any, any, any>),
                    Layer.provide(featureLayer)
                  ),
                  HttpApiBuilder.Router.Live,
                  HttpApiBuilder.Middleware.layer
                ) as Layer.Layer<any, any, never>
              )
            )
          : // Resolve featureLayer's services to a Context ONCE here (not via
            // Effect.provide(cap.router, featureLayer) stored unexecuted): a
            // mounted app value is re-interpreted from scratch on every
            // request (HttpRouter's mount dispatch does `Effect.flatMap(route
            // .handler, ...)` on the same stored value each time), so
            // providing a Layer there rebuilds it — and its semaphore — per
            // request, defeating persistence.ts's single-mutex guarantee.
            // Providing an already-built Context is a plain, request-cheap
            // merge, not a rebuild. Layer.build needs a Scope; scope it
            // immediately since neither piLayer nor persistenceLive hold any
            // resource that needs to outlive construction.
            Effect.provide(cap.router, yield* Effect.scoped(Layer.build(featureLayer)))
      router = HttpRouter.mountApp(router, prefix, app as any)
    }
    return { router, chats }
  })

/** Load all userspace modules; returns a router transform (systemRoutes idiom). */
export const userspaceRoutes = Effect.gen(function* () {
  const root = yield* UserspaceDir
  const piLayer = Layer.succeed(PiClient, yield* PiClient)
  // resolve the shared sqlite client ONCE — every feature's Persistence rides
  // the same connection (and the same appspace db file)
  const sqlLayer = Layer.succeed(SqlClient.SqlClient, yield* SqlClient.SqlClient)
  const loaded: Array<string> = []
  const failed: Array<{ name: string; error: string }> = []
  let router: AnyRouter = HttpRouter.empty
  for (const entry of userspaceServer) {
    const exit = yield* Effect.tryPromise({ try: () => entry.load(), catch: String }).pipe(
      Effect.flatMap((caps) => buildModule(root, piLayer, sqlLayer, entry.name, caps)),
      Effect.exit
    )
    if (Exit.isSuccess(exit)) {
      router = HttpRouter.concat(router, exit.value.router)
      chatCapabilities.push(...exit.value.chats)
      loaded.push(entry.name)
    } else {
      failed.push({ name: entry.name, error: String(Cause.squash(exit.cause)) })
    }
  }
  const features = HttpServerResponse.json({
    loaded,
    failed,
    chat: chatCapabilities.map((c) => ({ name: c.name, taskTypes: c.taskTypes }))
  })
  // cast: userspace router is any/any internally, but its real leftovers are
  // Provided-only (PiClient already injected) — serve supplies those.
  return <E, R>(base: HttpRouter.HttpRouter<E, R>) =>
    base.pipe(
      HttpRouter.get("/api/features", features),
      HttpRouter.concat(router)
    ) as HttpRouter.HttpRouter<E, R>
})
