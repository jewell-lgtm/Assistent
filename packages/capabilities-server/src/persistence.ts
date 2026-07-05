import { Context, Data } from "effect"
import type { Effect, Option } from "effect"

// Namespaced KV, exposed to userspace as an Effect service. Userland modules
// depend ONLY on this package: `const kv = yield* Persistence`. Core provides
// the implementation, scoped per-feature so no cross-feature reads/writes are
// possible (see server/src/persistence.ts's persistenceLive factory).

export class PersistenceError extends Data.TaggedError("PersistenceError")<{
  readonly message: string
}> {}

export interface PersistenceService {
  readonly get: (key: string) => Effect.Effect<Option.Option<unknown>, PersistenceError>
  readonly set: (key: string, value: unknown) => Effect.Effect<void, PersistenceError>
  readonly delete: (key: string) => Effect.Effect<void, PersistenceError>
  readonly list: () => Effect.Effect<ReadonlyArray<string>, PersistenceError>
}

/**
 * Server-side userspace: namespaced-per-feature KV. `const kv = yield* Persistence`.
 * Values must be JSON-serializable.
 */
export class Persistence extends Context.Tag("assistant/Persistence")<Persistence, PersistenceService>() {}
