# Userspace authoring guide

You are editing `userspace/` only. Read this once per session; it is the whole contract.

## Capability contract

A feature lives at `userspace/features/<name>/{shared.ts,server.ts,app.tsx}`.

- `shared.ts` — an Effect `HttpApi` (`HttpApi.make`/`HttpApiGroup`/`HttpApiEndpoint` + `Schema`). Both sides import this same definition. Nothing else goes here.
- `server.ts` — default-exports `ServerCapability[]`, one `HttpCapability`: `{ kind: "http", name, api, live }`. Build `live` with `HttpApiBuilder.group(api, "<group>", (handlers) => handlers.handle(...))` against the shared `api`. Mounted by core at `/api/features/<name>/`.
- `app.tsx` — default-exports `AppCapability[]`, one `AppTabCapability`: `{ kind: "app-tab", name, title, icon, Component }`. Shows up as a tab in the app.

## Import allowlist — nothing outside this list

Both files may always import their own feature's `./shared.js` (the `api` definition) — that's not an exception, every feature needs it.

`server.ts`: `effect`, `@effect/platform`, `node:*` builtins, `./shared.js`, `@assistant/capabilities-server/persistence` (see Persistence below), and TYPE-ONLY imports from `@assistant/capabilities-server`.

`app.tsx`: `effect`, `@effect/platform` (for `HttpApiClient`), `react`, `react-native`, `expo-location`, `expo-constants` (already-baked native modules only — OTA can't ship new native modules), `@assistant/capabilities-ui` and `@assistant/capabilities-ui/kit`, `./shared`, and TYPE-ONLY imports from `@assistant/capabilities-server`.

## UI kit — `@assistant/capabilities-ui/kit`

`Screen, Title, Body, Caption, Button, TextField, Form, List, Spacer`. Compose these; do not hand-roll `StyleSheet`/`TextInput`/etc.

Worked example — `Form` wired to a typed `HttpApiClient` call (core config isn't importable from userspace, so every feature duplicates this base-url/token setup):

```tsx
import type { AppCapability } from "@assistant/capabilities-ui/app"
import { Screen, Title, Form } from "@assistant/capabilities-ui/kit"
import { FetchHttpClient, HttpApiClient, HttpClient, HttpClientRequest } from "@effect/platform"
import { Effect } from "effect"
import Constants from "expo-constants"
import { api } from "./shared"

const BASE_URL = "https://assistant.wire.mattjewell.co.uk"
const API_TOKEN: string = Constants.expoConfig?.extra?.["apiToken"] ?? ""

const clientEffect = HttpApiClient.make(api, {
  baseUrl: `${BASE_URL}/api/features/<name>`,
  transformClient: HttpClient.mapRequest(HttpClientRequest.bearerToken(API_TOKEN))
}).pipe(Effect.provide(FetchHttpClient.layer))

let clientP: Promise<Effect.Effect.Success<typeof clientEffect>> | undefined
const getClient = () => (clientP ??= Effect.runPromise(clientEffect))

function MyScreen() {
  return (
    <Screen>
      <Title>My feature</Title>
      <Form
        fields={[{ key: "note", label: "Note" }]}
        onSubmit={async (values) => {
          const client = await getClient()
          await Effect.runPromise(client.<group>.<endpoint>({ payload: values }))
        }}
      />
    </Screen>
  )
}

export default [
  { kind: "app-tab", name: "<name>", title: "<Name>", icon: "star", Component: MyScreen }
] satisfies ReadonlyArray<AppCapability>
```

## Persistence — `@assistant/capabilities-server/persistence`

For small structured state (settings, counters, last-seen values — not files), use `Persistence` instead of raw `node:fs`. It's a namespaced key-value store: your feature only ever sees its own keys, automatically scoped by your feature name — you cannot read or write another feature's data, and you don't need to think about the file layout.

```ts
import { Persistence } from "@assistant/capabilities-server/persistence"
import { HttpApiBuilder } from "@effect/platform"
import { Effect } from "effect"
import { api } from "./shared.js"

const live = HttpApiBuilder.group(api, "<group>", (handlers) =>
  handlers.handle("<endpoint>", () =>
    Effect.gen(function* () {
      const kv = yield* Persistence
      yield* kv.set("lastRunAt", new Date().toISOString())
      const previous = yield* kv.get("lastRunAt")
      return { previous }
    })
  )
)
```

Values must be JSON-serializable. Prefer this over vault files for anything you'll read back and update — vault is for durable, human-readable output (reports, exports), not feature state.

## Vault convention

Durable output goes under `<USERSPACE_DIR>/vault/<feature-name>/` — use your own feature name as the subdirectory:

```ts
const vaultDir = () => path.join(process.env.USERSPACE_DIR ?? "/repo/userspace", "vault", "<your-feature-name>")
```

## The gate

Your code is typechecked before it ships (`scripts/uscheck/{server,app}.json`, against the shared capability types) — if you're shown a type error after a run, fix exactly that error on your next turn. Don't rewrite unrelated code.

## Write surface

File writes are confined to the userspace directory tree. There is no bash tool.
