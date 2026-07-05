import type { HttpApi, HttpRouter } from "@effect/platform"
import type { Layer } from "effect"
import type { PiClient, PiRouting } from "./pi.js"

// Capabilities the server userspace may export. The loader consumes these with
// failure isolation (a broken module is skipped + reported, never crashes core).

/** Services core provides to userspace server modules. Extend as more land. */
export type UserspaceServices = PiClient

/**
 * An HTTP surface. Define the api with Effect `HttpApi` in the module's shared/
 * file — the SAME definition gives the UI userspace a typed client via
 * `HttpApiClient.make(api, ...)`. Mounted under /api/features/<name>/.
 */
export interface HttpCapability {
  readonly kind: "http"
  readonly name: string
  readonly api: HttpApi.HttpApi.Any
  readonly live: Layer.Layer<never, never, UserspaceServices>
}

/** Simpler escape hatch: a raw Effect router (no derived client). */
export interface HttpRouterCapability {
  readonly kind: "http-router"
  readonly name: string
  readonly router: HttpRouter.HttpRouter<unknown, UserspaceServices>
}

/** Contributes task types (system prompt + routing) to the chat registry. */
export interface ChatCapability {
  readonly kind: "chat"
  readonly name: string
  readonly taskTypes: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly systemPrompt: string
    readonly routing: PiRouting
    readonly model?: string
  }>
}

export type ServerCapability = HttpCapability | HttpRouterCapability | ChatCapability
