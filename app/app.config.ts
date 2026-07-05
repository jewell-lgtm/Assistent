import type { ExpoConfig } from "expo/config"

// Embedded at prebuild time into AndroidManifest (OTA request headers).
// build-apk.sh sources .DONOTCOMMIT/secrets.env before running prebuild.
const apiToken = process.env.API_TOKEN ?? ""

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
  // runtime-readable via expo-constants (embedded at prebuild/publish time)
  extra: { apiToken },
  runtimeVersion: "1",
  updates: {
    enabled: true,
    url: "https://assistant.wire.mattjewell.co.uk/ota/api/manifest",
    checkAutomatically: "ON_LOAD",
    fallbackToCacheTimeout: 0,
    requestHeaders: {
      authorization: `Bearer ${apiToken}`
    },
    // allow the runtime setUpdateURLAndRequestHeadersOverride() in App.tsx to
    // repoint the *installed* APK's OTA check (baked with the old LAN URL) at
    // the public https URL without a reinstall.
    disableAntiBrickingMeasures: true
  },
  plugins: [
    ["expo-location", { isAndroidBackgroundLocationEnabled: true }],
    "expo-background-task",
    "expo-sqlite",
    "expo-notifications",
    ["expo-build-properties", { android: { usesCleartextTraffic: true } }]
  ]
}

export default config
