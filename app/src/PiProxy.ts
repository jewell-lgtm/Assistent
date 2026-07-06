import { PiProxy, type PiRunOptions, type PiRunResult } from "@assistant/capabilities-ui/pi"
import Constants from "expo-constants"
import { Data, Effect, Layer } from "effect"

// capabilities-ui re-exports PiError as a type only — structurally identical
// local class so core can construct it without a capabilities-server dep.
class PiError extends Data.TaggedError("PiError")<{ readonly message: string }> {}

// Public https via Caddy on the Lightsail box → wg tunnel → mini:30880, so the
// app works from anywhere, not just the home LAN. (The old LAN URL
// http://192.168.86.118:30880 only worked on home wifi.)
export const BASE_URL = "https://assistant.wire.mattjewell.co.uk"
export const API_TOKEN: string = Constants.expoConfig?.extra?.["apiToken"] ?? ""

export interface ApiResponse {
  readonly status: number
  readonly json: unknown
}

/** Same request core, but surfaces the status code instead of throwing on non-2xx —
 * for endpoints where a non-2xx is a meaningful, distinct state (409 busy) rather
 * than a bare failure. PiError only for actual transport/network failure. */
const request = (method: "GET" | "POST", apiPath: string, body?: unknown) =>
  Effect.tryPromise({
    try: async (): Promise<ApiResponse> => {
      const res = await fetch(`${BASE_URL}${apiPath}`, {
        method,
        headers: { "content-type": "application/json", authorization: `Bearer ${API_TOKEN}` },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      })
      const json: unknown = await res.json().catch(() => ({}))
      return { status: res.status, json }
    },
    catch: (e) => new PiError({ message: e instanceof Error ? e.message : String(e) })
  })

export const apiRequest = request

/** POST json to core server, PiError on non-200/network failure. */
export const apiPost = (apiPath: string, body: unknown): Effect.Effect<unknown, PiError> =>
  request("POST", apiPath, body).pipe(
    Effect.flatMap(({ status, json }) => {
      if (status >= 200 && status < 300) return Effect.succeed(json)
      const error = (json as { readonly error?: unknown } | null)?.error
      return Effect.fail(new PiError({ message: typeof error === "string" ? error : `HTTP ${status}` }))
    })
  )

export const PiProxyLive = Layer.succeed(PiProxy, {
  run: (options: PiRunOptions) =>
    apiPost("/api/pi/run", options).pipe(
      Effect.map((json): PiRunResult => {
        const r = json as { readonly text?: unknown; readonly model?: unknown } | null
        return {
          text: typeof r?.text === "string" ? r.text : "",
          model: typeof r?.model === "string" ? r.model : "?"
        }
      })
    )
})
