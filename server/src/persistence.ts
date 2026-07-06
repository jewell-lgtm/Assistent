import { Persistence, PersistenceError } from "@assistant/capabilities-server/persistence"
import { SqlClient } from "@effect/sql"
import { Effect, Layer, Option } from "effect"
import * as fs from "node:fs/promises"
import * as path from "node:path"

// Backing: the appspace sqlite db (kv table, feature-namespaced rows) —
// replaces the per-feature store.json files. Same Persistence interface, so
// userspace features are untouched. Values stored as JSON text. Namespacing
// stays keyed by the loader-sanitized featureName (see userspace.ts on why
// never cap.name). Durability now rides the db's litestream replication
// instead of files inside the (wiped-with-it) userspace tree.

type Row = { readonly value: string }

// One-shot lazy migration: if this feature still has a legacy
// <root>/data/<feature>/store.json, import keys that don't exist yet, then
// rename the file so the import never re-runs (and a rollback to the old
// server build would still find its data under the .migrated name).
const migrateLegacyStore = (
  sql: SqlClient.SqlClient,
  root: string,
  featureName: string
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const file = path.join(root, "data", featureName, "store.json")
    const raw = yield* Effect.tryPromise(() => fs.readFile(file, "utf8")).pipe(
      Effect.option
    )
    if (Option.isNone(raw)) return
    const store = yield* Effect.try(() => JSON.parse(raw.value) as Record<string, unknown>)
    for (const [key, value] of Object.entries(store)) {
      yield* sql`
        INSERT INTO kv (feature, key, value) VALUES (${featureName}, ${key}, ${JSON.stringify(value)})
        ON CONFLICT (feature, key) DO NOTHING
      `
    }
    yield* Effect.tryPromise(() => fs.rename(file, `${file}.migrated`))
    yield* Effect.logInfo(`persistence: migrated ${featureName} store.json → sqlite (${Object.keys(store).length} keys)`)
  }).pipe(
    Effect.catchAll((e) => Effect.logError(`persistence: legacy migration failed for ${featureName}: ${String(e)}`))
  )

/** One Persistence instance per feature, rows confined to its featureName namespace. */
export const persistenceLive = (
  root: string,
  featureName: string
): Layer.Layer<Persistence, never, SqlClient.SqlClient> =>
  Layer.effect(
    Persistence,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* sql`
        CREATE TABLE IF NOT EXISTS kv (
          feature TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          PRIMARY KEY (feature, key)
        )
      `.pipe(Effect.orDie)
      yield* migrateLegacyStore(sql, root, featureName)

      const asPersistenceError = (e: unknown) => new PersistenceError({ message: String(e) })

      return {
        get: (key) =>
          sql<Row>`SELECT value FROM kv WHERE feature = ${featureName} AND key = ${key}`.pipe(
            Effect.mapError(asPersistenceError),
            Effect.flatMap((rows) =>
              rows.length === 0
                ? Effect.succeedNone
                : Effect.try({ try: () => Option.some(JSON.parse(rows[0]!.value) as unknown), catch: asPersistenceError })
            )
          ),
        set: (key, value) =>
          Effect.try({ try: () => JSON.stringify(value), catch: asPersistenceError }).pipe(
            Effect.flatMap(
              (json) => sql`
                INSERT INTO kv (feature, key, value) VALUES (${featureName}, ${key}, ${json})
                ON CONFLICT (feature, key) DO UPDATE SET value = ${json}
              `
            ),
            Effect.mapError(asPersistenceError),
            Effect.asVoid
          ),
        delete: (key) =>
          sql`DELETE FROM kv WHERE feature = ${featureName} AND key = ${key}`.pipe(
            Effect.mapError(asPersistenceError),
            Effect.asVoid
          ),
        list: () =>
          sql<{ readonly key: string }>`SELECT key FROM kv WHERE feature = ${featureName} ORDER BY key`.pipe(
            Effect.mapError(asPersistenceError),
            Effect.map((rows) => rows.map((r) => r.key))
          )
      }
    })
  )
