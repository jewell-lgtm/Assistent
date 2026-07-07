import * as SecureStore from "expo-secure-store"
import * as Updates from "expo-updates"

// Device-side binding to a per-user server instance, in the keystore-backed
// secure store. Module-level cache so PiProxy/SSE can read synchronously —
// App.tsx awaits loadPairing() before rendering anything that fires a request.
export type Pairing = {
  readonly serverUrl: string
  readonly token: string
  readonly user?: string
}

const KEY = "pairing.v1"

let current: Pairing | null = null

const normalize = (p: Pairing): Pairing => {
  const url = new URL(p.serverUrl.trim())
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`bad protocol ${url.protocol}`)
  return {
    serverUrl: url.origin + url.pathname.replace(/\/+$/, ""),
    token: p.token.trim(),
    ...(p.user !== undefined ? { user: p.user } : {})
  }
}

// The OTA target lives in native SharedPreferences (persists across cold
// starts, effective immediately — verified in expo-updates 57.0.6 source).
// Re-asserted on every load to self-heal divergence between the two stores.
const applyOtaOverride = (p: Pairing | null) => {
  if (__DEV__) return // throws in dev client; OTA is release-only anyway
  try {
    Updates.setUpdateURLAndRequestHeadersOverride(
      p === null
        ? null
        : {
            updateUrl: `${p.serverUrl}/ota/api/manifest`,
            requestHeaders: { authorization: `Bearer ${p.token}` }
          }
    )
  } catch {
    // updates disabled (e.g. emulator debug) — API/SSE still work unpaired-OTA
  }
}

export const loadPairing = async (): Promise<Pairing | null> => {
  const raw = await SecureStore.getItemAsync(KEY)
  if (raw === null) return null
  current = JSON.parse(raw) as Pairing
  applyOtaOverride(current)
  return current
}

export const isPaired = (): boolean => current !== null
export const getPairing = (): Pairing | null => current
export const getBaseUrl = (): string => current?.serverUrl ?? ""
export const getToken = (): string => current?.token ?? ""

export const setPairing = async (p: Pairing): Promise<Pairing> => {
  const next = normalize(p)
  await SecureStore.setItemAsync(KEY, JSON.stringify(next))
  current = next
  applyOtaOverride(next)
  return next
}

export const clearPairing = async (): Promise<void> => {
  await SecureStore.deleteItemAsync(KEY)
  current = null
  applyOtaOverride(null) // fall back to the dead baked URL, never another user's server
}
