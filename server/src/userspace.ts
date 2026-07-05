import { HttpApiBuilder, HttpRouter, HttpServerResponse } from "@effect/platform"
import { PiClient } from "@assistant/capabilities-server/pi"
import type { ChatCapability, ServerCapability } from "@assistant/capabilities-server/server"
import { Cause, Effect, Exit, Layer } from "effect"
import { userspaceServer } from "./userspace.gen.js"

// Failure-isolated userspace loader: a module that throws at import or mount
// time is skipped + recorded, never crashes core. Http surfaces mount under
// /api/features/<name>/; chat capabilities collect into a registry (chat = E4).

export const chatCapabilities: Array<ChatCapability> = []

type AnyRouter = HttpRouter.HttpRouter<any, any>

const buildModule = (piLayer: Layer.Layer<PiClient>, caps: ReadonlyArray<ServerCapability>) =>
  Effect.gen(function* () {
    let router: AnyRouter = HttpRouter.empty
    const chats: Array<ChatCapability> = []
    for (const cap of caps) {
      if (cap.kind === "chat") {
        chats.push(cap)
        continue
      }
      const prefix = `/api/features/${cap.name}` as const
      const app =
        cap.kind === "http"
          ? yield* HttpApiBuilder.httpApp.pipe(
              Effect.provide(
                Layer.mergeAll(
                  HttpApiBuilder.api(cap.api as any).pipe(
                    Layer.provide(cap.live as unknown as Layer.Layer<any, any, any>),
                    Layer.provide(piLayer)
                  ),
                  HttpApiBuilder.Router.Live,
                  HttpApiBuilder.Middleware.layer
                ) as Layer.Layer<any, any, never>
              )
            )
          : Effect.provide(cap.router, piLayer)
      router = HttpRouter.mountApp(router, prefix, app as any)
    }
    return { router, chats }
  })

/** Load all userspace modules; returns a router transform (systemRoutes idiom). */
export const userspaceRoutes = Effect.gen(function* () {
  const piLayer = Layer.succeed(PiClient, yield* PiClient)
  const loaded: Array<string> = []
  const failed: Array<{ name: string; error: string }> = []
  let router: AnyRouter = HttpRouter.empty
  for (const entry of userspaceServer) {
    const exit = yield* Effect.tryPromise({ try: () => entry.load(), catch: String }).pipe(
      Effect.flatMap((caps) => buildModule(piLayer, caps)),
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
