import { NavigationContainer } from "@react-navigation/native"
import { StatusBar } from "expo-status-bar"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { RootTabs } from "./src/RootTabs"

// Background OTA is handled natively (app.config.ts: checkAutomatically ON_LOAD,
// fallbackToCacheTimeout 0) — updates download in the background and apply on the
// next launch, silently. Explicit "apply now" lives in the Code tab (Refresh +
// the post-build auto-pipeline reload). No startup check here: a transient
// failure during a server rollout used to freeze a scary banner that never
// re-checked.

export default function App() {
  return (
    <SafeAreaProvider>
      <NavigationContainer>
        <RootTabs />
      </NavigationContainer>
      <StatusBar style="auto" />
    </SafeAreaProvider>
  )
}
