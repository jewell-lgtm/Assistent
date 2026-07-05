import { StatusBar } from "expo-status-bar"
import { useEffect, useState } from "react"
import { StyleSheet, Text, View } from "react-native"
import * as Updates from "expo-updates"

// E1 marker: bump this string, publish OTA, expect it on the phone without reinstall.
const OTA_MARKER = "ota-v1"

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
    <View style={styles.container}>
      <Text style={styles.title}>Assistant</Text>
      <Text style={styles.marker}>{OTA_MARKER}</Text>
      <Text style={styles.meta}>updateId: {Updates.updateId ?? "embedded"}</Text>
      <Text style={styles.meta}>runtime: {Updates.runtimeVersion}</Text>
      <Text style={styles.meta}>{status}</Text>
      <StatusBar style="auto" />
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff", alignItems: "center", justifyContent: "center", gap: 8 },
  title: { fontSize: 28, fontWeight: "700" },
  marker: { fontSize: 20, color: "#0a7" },
  meta: { fontSize: 12, color: "#666" }
})
