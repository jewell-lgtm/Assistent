import AsyncStorage from "@react-native-async-storage/async-storage"
import Constants from "expo-constants"
import * as Updates from "expo-updates"

// Device-side binding to a per-user server instance. Stored in async-storage
// (NOT secure-store: that native module isn't in already-installed APKs, and
// an OTA bundle importing it would crash them at module load). Module-level
// cache so PiProxy/SSE can read synchronously — App.tsx awaits loadPairing()
// before rendering anything that fires a request.
export type Pairing = {
  readonly serverUrl: string
  readonly token: string
  readonly user?: string
}

const KEY = "pairing.v1"
// Pre-pairing installs bake token+URL; the migration branch in loadPairing()
// adopts them silently so existing devices never see the pairing screen.
const LEGACY_URL = "https://assistant.wire.mattjewell.co.uk"

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
  const raw = await AsyncStorage.getItem(KEY)
  if (raw !== null) {
    current = JSON.parse(raw) as Pairing
    applyOtaOverride(current)
    return current
  }
  const legacyToken = Constants.expoConfig?.extra?.["apiToken"]
  if (typeof legacyToken === "string" && legacyToken !== "") {
    await setPairing({ serverUrl: LEGACY_URL, token: legacyToken })
    return current
  }
  return null
}

export const isPaired = (): boolean => current !== null
export const getPairing = (): Pairing | null => current
export const getBaseUrl = (): string => current?.serverUrl ?? ""
export const getToken = (): string => current?.token ?? ""

export const setPairing = async (p: Pairing): Promise<Pairing> => {
  const next = normalize(p)
  await AsyncStorage.setItem(KEY, JSON.stringify(next))
  current = next
  applyOtaOverride(next)
  return next
}

export const clearPairing = async (): Promise<void> => {
  await AsyncStorage.removeItem(KEY)
  current = null
  applyOtaOverride(null) // fall back to the dead baked URL, never another user's server
}
