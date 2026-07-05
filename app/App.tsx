import { NavigationContainer } from "@react-navigation/native"
import { StatusBar } from "expo-status-bar"
import * as Updates from "expo-updates"
import { useEffect, useState } from "react"
import { StyleSheet, Text, View } from "react-native"
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context"
import { RootTabs } from "./src/RootTabs"

// E1 proof surface: bump this string, publish OTA, expect it on the phone without reinstall.
const OTA_MARKER = "ota-v2"

// The E1 proof surface, shrunk to a header strip so tabs get the screen.
const OtaHeader = ({ status }: { status: string }) => {
  const insets = useSafeAreaInsets()
  return (
    <View style={[styles.header, { paddingTop: insets.top + 4 }]}>
      <Text style={styles.headerText}>
        {OTA_MARKER} · {Updates.updateId?.slice(0, 8) ?? "embedded"} · rt {Updates.runtimeVersion} ·{" "}
        {status}
      </Text>
    </View>
  )
}

export default function App() {
  const [status, setStatus] = useState("checking for update…")

  useEffect(() => {
    ;(async () => {
      if (__DEV__) {
        setStatus("dev mode — updates disabled")
        return
      }
      try {
        const check = await Updates.checkForUpdateAsync()
        if (check.isAvailable) {
          setStatus("downloading update…")
          await Updates.fetchUpdateAsync()
          await Updates.reloadAsync()
        } else {
          setStatus("up to date")
        }
      } catch (e) {
        setStatus(`update check failed: ${String(e)}`)
      }
    })()
  }, [])

  return (
    <SafeAreaProvider>
      <OtaHeader status={status} />
      <NavigationContainer>
        <RootTabs />
      </NavigationContainer>
      <StatusBar style="auto" />
    </SafeAreaProvider>
  )
}

const styles = StyleSheet.create({
  header: { backgroundColor: "#f2f2f2", paddingBottom: 4, paddingHorizontal: 8 },
  headerText: { fontSize: 11, color: "#666", textAlign: "center" }
})
