import { Persistence, PersistenceError } from "@assistant/capabilities-server/persistence"
import { Effect, Layer, Option } from "effect"
import * as fs from "node:fs/promises"
import * as path from "node:path"

// Backing: one store.json per feature under <root>/data/<feature>/, not
// one-file-per-key. Simpler to get right — no key→filename sanitization or
// path-traversal surface to defend (contrast confine() in code.ts) — and a
// single file already serializes naturally under the per-feature semaphore
// below. Tradeoff: every set/delete rewrites the whole store, so this is
// fine for config-shaped userland KV, not for large values or hot writes.

type Store = Record<string, unknown>

const readStore = async (file: string): Promise<Store> => {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as Store
  } catch (e: any) {
    if (e?.code === "ENOENT") return {}
    throw e
  }
}

const writeStore = async (file: string, store: Store) => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  // write-then-rename: readers never see a half-written store.json
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), "utf8")
  await fs.rename(tmp, file)
}

/** One Persistence instance per feature, its store confined to <root>/data/<featureName>/store.json. */
export const persistenceLive = (root: string, featureName: string): Layer.Layer<Persistence> =>
  Layer.effect(
    Persistence,
    Effect.gen(function* () {
      const file = path.join(root, "data", featureName, "store.json")
      // in-process mutex: serializes this feature's read-modify-write cycles
      const sem = yield* Effect.makeSemaphore(1)
      const withStore = <A>(f: (store: Store) => { readonly next?: Store; readonly result: A }) =>
        sem.withPermits(1)(
          Effect.tryPromise({
            try: async () => {
              const store = await readStore(file)
              const { next, result } = f(store)
              if (next !== undefined) await writeStore(file, next)
              return result
            },
            catch: (e) => new PersistenceError({ message: String(e) })
          })
        )
      return {
        get: (key) => withStore((store) => ({ result: Option.fromNullable(store[key]) })),
        set: (key, value) =>
          withStore((store) => ({ next: { ...store, [key]: value }, result: undefined })),
        delete: (key) =>
          withStore((store) => {
            const { [key]: _, ...rest } = store
            return { next: rest, result: undefined }
          }),
        list: () => withStore((store) => ({ result: Object.keys(store) }))
      }
    })
  )
