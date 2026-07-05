import type { AppTabCapability } from "@assistant/capabilities-ui/app"
import { PiProxy } from "@assistant/capabilities-ui/pi"
import { Ionicons } from "@expo/vector-icons"
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs"
import { Effect } from "effect"
import { useState, type ComponentType } from "react"
import { ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native"
import { ErrorBoundary } from "./ErrorBoundary"
import { apiPost, PiProxyLive } from "./PiProxy"
import { userspaceApp } from "./userspace.gen"

const runPi = (prompt: string) =>
  Effect.runPromise(
    PiProxy.pipe(
      Effect.flatMap((pi) => pi.run({ prompt })),
      Effect.provide(PiProxyLive),
      Effect.map((r) => `[${r.model}]\n${r.text}`),
      Effect.catchAll((e) => Effect.succeed(`PiError: ${e.message}`))
    )
  )

const runCode = (prompt: string) =>
  Effect.runPromise(
    apiPost("/api/system/code", { prompt }).pipe(
      Effect.map((json) => JSON.stringify(json, null, 2)),
      Effect.catchAll((e) => Effect.succeed(`PiError: ${e.message}`))
    )
  )

// Shared ugly prompt→reply screen; real chat lands in E4.
const PromptScreen = ({ note, submit }: { note: string; submit: (prompt: string) => Promise<string> }) => {
  const [prompt, setPrompt] = useState("")
  const [out, setOut] = useState("")
  const [busy, setBusy] = useState(false)
  const send = async () => {
    if (busy || prompt.trim() === "") return
    setBusy(true)
    setOut("running…")
    setOut(await submit(prompt).catch((e) => `error: ${String(e)}`))
    setBusy(false)
  }
  return (
    <View style={styles.screen}>
      <Text style={styles.note}>{note}</Text>
      <TextInput
        style={styles.input}
        value={prompt}
        onChangeText={setPrompt}
        placeholder="prompt"
        multiline
      />
      <TouchableOpacity style={styles.button} onPress={send} disabled={busy}>
        <Text style={styles.buttonText}>{busy ? "running…" : "send"}</Text>
      </TouchableOpacity>
      <ScrollView style={styles.output}>
        <Text selectable style={styles.outputText}>
          {out}
        </Text>
      </ScrollView>
    </View>
  )
}

const ChatScreen = () => (
  <PromptScreen note="chat lands in E4 — this exercises PiProxy → /api/pi/run" submit={runPi} />
)
const CodeScreen = () => (
  <PromptScreen note="self-mod coder → /api/system/code (writes userspace, auto-commits)" submit={runCode} />
)

type Tab = {
  readonly name: string
  readonly title: string
  readonly icon: string
  readonly Component: ComponentType
}

const brokenTab = (name: string, error: unknown): Tab => ({
  name,
  title: name,
  icon: "warning",
  Component: () => (
    <View style={[styles.screen, { alignItems: "center", justifyContent: "center" }]}>
      <Text style={{ fontWeight: "700" }}>module “{name}” failed to load</Text>
      <Text style={{ color: "#c00" }}>{String(error)}</Text>
    </View>
  )
})

// Userspace tabs: a throwing load() yields a broken-tab screen, never a crash.
const loadedUserTabs: ReadonlyArray<Tab> = userspaceApp.flatMap((entry) => {
  try {
    return entry.load().filter((c): c is AppTabCapability => c.kind === "app-tab")
  } catch (e) {
    return [brokenTab(entry.name, e)]
  }
})

const coreTabs: ReadonlyArray<Tab> = [
  { name: "chat", title: "Chat", icon: "chatbubble-ellipses", Component: ChatScreen },
  { name: "code", title: "Code", icon: "code-slash", Component: CodeScreen }
]

// React Navigation crashes the whole navigator on a duplicate screen name —
// a colliding userspace tab (name clash with core or another module) must
// not be able to take down chat/code. Dedupe by first-registered-wins; losers
// become broken tabs under a synthesized unique name (else N collisions on
// the same name would just collide again as broken tabs).
const seenTabNames = new Set(coreTabs.map((t) => t.name))
const userTabs: ReadonlyArray<Tab> = loadedUserTabs.map((tab, i) => {
  if (seenTabNames.has(tab.name)) {
    return brokenTab(`${tab.name}-dup-${i}`, new Error(`duplicate tab name "${tab.name}" — refused to register`))
  }
  seenTabNames.add(tab.name)
  return tab
})

const Tabs = createBottomTabNavigator()

export const RootTabs = () => (
  <Tabs.Navigator screenOptions={{ headerShown: false }}>
    {[...coreTabs, ...userTabs].map(({ name, title, icon, Component }) => (
      <Tabs.Screen
        key={name}
        name={name}
        options={{
          title,
          tabBarIcon: ({ color, size }) => <Ionicons name={icon as any} size={size} color={color} />
        }}
      >
        {() => (
          <ErrorBoundary name={name}>
            <Component />
          </ErrorBoundary>
        )}
      </Tabs.Screen>
    ))}
  </Tabs.Navigator>
)

const styles = StyleSheet.create({
  screen: { flex: 1, padding: 12, gap: 8, backgroundColor: "#fff" },
  note: { fontSize: 12, color: "#666" },
  input: { borderWidth: 1, borderColor: "#ccc", borderRadius: 6, padding: 8, minHeight: 60 },
  button: { backgroundColor: "#0a7", borderRadius: 6, padding: 10, alignItems: "center" },
  buttonText: { color: "#fff", fontWeight: "700" },
  output: { flex: 1, borderWidth: 1, borderColor: "#eee", borderRadius: 6, padding: 8 },
  outputText: { fontSize: 12, fontFamily: "monospace" }
})
