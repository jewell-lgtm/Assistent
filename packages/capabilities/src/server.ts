import type { HttpApi, HttpRouter } from "@effect/platform"
import type { Layer } from "effect"

// Capabilities the server userspace may export. The loader consumes these with
// failure isolation (a broken module is skipped + reported, never crashes core).

/**
 * An HTTP surface. Define the api with Effect `HttpApi` in the module's shared/
 * file — the SAME definition gives the UI userspace a typed client via
 * `HttpApiClient.make(api, ...)`. Mounted under /api/features/<name>/.
 */
export interface HttpCapability {
  readonly kind: "http"
  readonly name: string
  readonly api: HttpApi.HttpApi.Any
  readonly live: Layer.Layer<never, never, never>
}

/** Simpler escape hatch: a raw Effect router (no derived client). */
export interface HttpRouterCapability {
  readonly kind: "http-router"
  readonly name: string
  readonly router: HttpRouter.HttpRouter<unknown, never>
}

/** Contributes task types (system prompt + engine routing) to the chat registry. */
export interface ChatCapability {
  readonly kind: "chat"
  readonly name: string
  readonly taskTypes: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly systemPrompt: string
    readonly engine: "ollama" | "codex" | "pi"
    readonly model: string
    readonly localOnly: boolean
  }>
}

export type ServerCapability = HttpCapability | HttpRouterCapability | ChatCapability
