import { Context, Data } from "effect"
import type { Effect } from "effect"

// The single agent engine, exposed to userspace as an Effect service. Userland
// modules depend ONLY on this package: `const pi = yield* PiClient`. Core
// provides the implementation (in-process Pi, write-confined to userspace).

/** "default" = subscription engine; "private" = never leaves the LAN (ollama). */
export type PiRouting = "default" | "private"

export interface PiRunOptions {
  readonly prompt: string
  readonly routing?: PiRouting
  /** Override the routed model id. */
  readonly model?: string
  /** "coding" = userspace-confined file tools; "none" = plain LLM turn (default). */
  readonly tools?: "none" | "coding"
}

export interface PiRunResult {
  readonly text: string
  readonly model: string
}

export class PiError extends Data.TaggedError("PiError")<{
  readonly message: string
}> {}

export interface PiService {
  readonly run: (options: PiRunOptions) => Effect.Effect<PiRunResult, PiError>
}

/**
 * Server-side userspace: in-process engine. `const pi = yield* PiClient`
 * (UI-side twin is PiProxy in @assistant/capabilities-ui — same PiService.)
 */
export class PiClient extends Context.Tag("assistant/PiClient")<PiClient, PiService>() {}
