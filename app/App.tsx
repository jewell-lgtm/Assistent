import { NavigationContainer } from "@react-navigation/native"
import { StatusBar } from "expo-status-bar"
import * as Updates from "expo-updates"
import { useEffect, useRef, useState } from "react"
import { AppState, Text, View } from "react-native"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { isPaired, loadPairing } from "./src/pairing"
import { RootTabs } from "./src/RootTabs"

// Foreground sync: every time the app comes to the foreground, check for an
// OTA update and apply it (the server may have shipped a feature while the
// phone was in a drawer — tasks run fully server-side). SILENT fail-soft: a
// transient failure during a server rollout must never surface UI (the old
// startup-check froze a scary banner that never re-checked — that stays
// dead). ON_LOAD background download in app.config.ts remains the launch
// path; this hook covers the long-foreground / warm-resume path.

const useForegroundOtaSync = () => {
  const busyRef = useRef(false)
  useEffect(() => {
    const sync = async () => {
      if (busyRef.current || __DEV__ || !isPaired()) return
      busyRef.current = true
      try {
        const check = await Updates.checkForUpdateAsync()
        if (check.isAvailable) {
          await Updates.fetchUpdateAsync()
          await Updates.reloadAsync() // reloads into the new bundle; nothing after runs
        }
      } catch {
        // silent by design — never a banner, next foreground re-checks
      } finally {
        busyRef.current = false
      }
    }
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") void sync()
    })
    return () => sub.remove()
  }, [])
}

export default function App() {
  useForegroundOtaSync()
  // Pairing gate: nothing that fires a request (CodeScreen mounts eagerly)
  // renders until the stored pairing is loaded into the module cache.
  const [phase, setPhase] = useState<"loading" | "unpaired" | "paired">("loading")
  useEffect(() => {
    loadPairing()
      .then((p) => setPhase(p === null ? "unpaired" : "paired"))
      .catch(() => setPhase("unpaired"))
  }, [])
  if (phase === "loading") return null
  return (
    <SafeAreaProvider>
      {phase === "paired" ? (
        <NavigationContainer>
          <RootTabs />
        </NavigationContainer>
      ) : (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24 }}>
          <Text>Not paired to a server.</Text>
        </View>
      )}
      <StatusBar style="auto" />
    </SafeAreaProvider>
  )
}
