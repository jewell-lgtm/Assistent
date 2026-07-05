# Userspace authoring guide

You are editing `userspace/` only. Read this once per session; it is the whole contract.

## Capability contract

A feature lives at `userspace/features/<name>/{shared.ts,server.ts,app.tsx}`.

- `shared.ts` — an Effect `HttpApi` (`HttpApi.make`/`HttpApiGroup`/`HttpApiEndpoint` + `Schema`). Both sides import this same definition. Nothing else goes here.
- `server.ts` — default-exports `ServerCapability[]`, one `HttpCapability`: `{ kind: "http", name, api, live }`. Build `live` with `HttpApiBuilder.group(api, "<group>", (handlers) => handlers.handle(...))` against the shared `api`. Mounted by core at `/api/features/<name>/`.
- `app.tsx` — default-exports `AppCapability[]`, one `AppTabCapability`: `{ kind: "app-tab", name, title, icon, Component }`. Shows up as a tab in the app.

## Import allowlist — nothing outside this list

Both files may always import their own feature's `./shared.js` (the `api` definition) — that's not an exception, every feature needs it.

`server.ts`: `effect`, `@effect/platform`, `node:*` builtins, `./shared.js`, and TYPE-ONLY imports from `@assistant/capabilities-server`.

`app.tsx`: `effect`, `@effect/platform` (for `HttpApiClient`), `react`, `react-native`, `expo-location`, `expo-constants` (already-baked native modules only — OTA can't ship new native modules), `@assistant/capabilities-ui` and `@assistant/capabilities-ui/kit`, `./shared`, and TYPE-ONLY imports from `@assistant/capabilities-server`.

## UI kit — `@assistant/capabilities-ui/kit`

`Screen, Title, Body, Caption, Button, TextField, Form, List, Spacer`. Compose these; do not hand-roll `StyleSheet`/`TextInput`/etc.

Worked example — `Form` wired to a typed `HttpApiClient` call (same base-url/token pattern as `userspace/features/run-tracker/app.tsx`; duplicate it, core config isn't importable from userspace):

```tsx
import type { AppCapability } from "@assistant/capabilities-ui/app"
import { Screen, Title, Form } from "@assistant/capabilities-ui/kit"
import { FetchHttpClient, HttpApiClient, HttpClient, HttpClientRequest } from "@effect/platform"
import { Effect } from "effect"
import Constants from "expo-constants"
import { api } from "./shared"

const BASE_URL = "http://192.168.86.118:30880"
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

## Vault convention

Durable output goes under `<USERSPACE_DIR>/vault/<feature-name>/`. See `vaultDir()` in `userspace/features/run-tracker/server.ts`:

```ts
const vaultDir = () => path.join(process.env.USERSPACE_DIR ?? "/repo/userspace", "vault", "runs")
```

Use your own feature name as the subdirectory, not `"runs"`.

## The gate

Your code is typechecked before it ships (`scripts/uscheck/{server,app}.json`, against the shared capability types) — if you're shown a type error after a run, fix exactly that error on your next turn. Don't rewrite unrelated code.

## Write surface

File writes are confined to the userspace directory tree. There is no bash tool.
