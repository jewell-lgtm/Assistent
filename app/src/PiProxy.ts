import { PiProxy, type PiRunOptions, type PiRunResult } from "@assistant/capabilities-ui/pi"
import Constants from "expo-constants"
import { Data, Effect, Layer } from "effect"

// capabilities-ui re-exports PiError as a type only — structurally identical
// local class so core can construct it without a capabilities-server dep.
class PiError extends Data.TaggedError("PiError")<{ readonly message: string }> {}

export const BASE_URL = "http://192.168.86.118:30880"
export const API_TOKEN: string = Constants.expoConfig?.extra?.["apiToken"] ?? ""

/** POST json to core server, PiError on non-200/network failure. */
export const apiPost = (apiPath: string, body: unknown) =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(`${BASE_URL}${apiPath}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${API_TOKEN}` },
        body: JSON.stringify(body)
      })
      const json: any = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      return json
    },
    catch: (e) => new PiError({ message: e instanceof Error ? e.message : String(e) })
  })

export const PiProxyLive = Layer.succeed(PiProxy, {
  run: (options: PiRunOptions) =>
    apiPost("/api/pi/run", options).pipe(
      Effect.map((json): PiRunResult => ({ text: json.text ?? "", model: json.model ?? "?" }))
    )
})
