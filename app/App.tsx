import { NavigationContainer } from "@react-navigation/native"
import { StatusBar } from "expo-status-bar"
import * as Updates from "expo-updates"
import { useEffect, useRef, useState } from "react"
import { AppState } from "react-native"
import { SafeAreaProvider } from "react-native-safe-area-context"
import { getPairing, isPaired, loadPairing } from "./src/pairing"
import { PairingScreen } from "./src/PairingScreen"
import { PairingUiContext } from "./src/PairingUi"
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
  // "repair" = paired but user asked to change server; cancellable.
  const [phase, setPhase] = useState<"loading" | "unpaired" | "paired" | "repair">("loading")
  useEffect(() => {
    loadPairing()
      .then((p) => setPhase(p === null ? "unpaired" : "paired"))
      .catch(() => setPhase("unpaired"))
  }, [])
  if (phase === "loading") return null
  return (
    <SafeAreaProvider>
      {phase === "paired" ? (
        <PairingUiContext.Provider value={{ repair: () => setPhase("repair") }}>
          <NavigationContainer>
            <RootTabs />
          </NavigationContainer>
        </PairingUiContext.Provider>
      ) : (
        <PairingScreen
          initial={phase === "repair" ? getPairing() : null}
          onPaired={() => setPhase("paired")}
          {...(phase === "repair" ? { onCancel: () => setPhase("paired") } : {})}
        />
      )}
      <StatusBar style="auto" />
    </SafeAreaProvider>
  )
}
