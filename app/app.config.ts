import type { ExpoConfig } from "expo/config"

// GENERIC build: nothing user-specific is baked. The pairing screen stores
// {serverUrl, token} on device and repoints OTA via the native override
// (src/pairing.ts) — one APK serves every user.
const config: ExpoConfig = {
  name: "Assistant",
  slug: "local-assistent",
  version: "1.0.0",
  orientation: "portrait",
  userInterfaceStyle: "automatic",
  platforms: ["android"],
  android: {
    package: "uk.co.mattjewell.assistant",
    permissions: [
      "ACCESS_COARSE_LOCATION",
      "ACCESS_FINE_LOCATION",
      "ACCESS_BACKGROUND_LOCATION",
      "FOREGROUND_SERVICE",
      "FOREGROUND_SERVICE_LOCATION",
      "POST_NOTIFICATIONS"
    ]
  },
  scheme: "assistant",
  runtimeVersion: "1",
  updates: {
    enabled: true,
    // deliberately dead placeholder (RFC 2606): an unpaired install must never
    // fetch anyone's bundle. fallbackToCacheTimeout 0 → launch never blocks on
    // the failing check. Pairing installs the real URL+token via the native
    // override, persisted in SharedPreferences across cold starts.
    url: "https://unpaired.invalid/ota/api/manifest",
    checkAutomatically: "ON_LOAD",
    fallbackToCacheTimeout: 0,
    requestHeaders: {
      // dead value, but the KEY must stay baked: the headers-only override
      // variant validates against build-time-declared keys
      authorization: "Bearer unpaired"
    },
    // REQUIRED for Updates.setUpdateURLAndRequestHeadersOverride (pairing)
    disableAntiBrickingMeasures: true
  },
  plugins: [
    ["expo-location", { isAndroidBackgroundLocationEnabled: true }],
    "expo-background-task",
    "expo-sqlite",
    "expo-notifications",
    // baked-but-unused: native modules are only purchasable at APK-build time —
    // these let QR-scan pairing / secure token storage ship later as pure-JS OTA
    "expo-camera",
    "expo-secure-store",
    ["expo-build-properties", { android: { usesCleartextTraffic: true } }]
  ]
}

export default config
