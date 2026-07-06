import type { AppTabCapability } from "@assistant/capabilities-ui/app"
import { Ionicons } from "@expo/vector-icons"
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs"
import { Effect } from "effect"
import * as Updates from "expo-updates"
import { useState, type ComponentType, type PropsWithChildren } from "react"
import { RefreshControl, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native"
import { useSafeAreaInsets } from "react-native-safe-area-context"
import { CodeScreen } from "./CodeScreen"
import { ErrorBoundary } from "./ErrorBoundary"
import { apiPost } from "./PiProxy"
import { userspaceApp } from "./userspace.gen"

// Chat has memory: /api/chat runs the LLM with vault remember/recall tools, so
// "remember I like BLTs" persists and "remind me what I like" searches back.
const runChat = (message: string) =>
  Effect.runPromise(
    apiPost("/api/chat", { message }).pipe(
      Effect.map((r: any) => String(r.text ?? "")),
      Effect.catchAll((e) => Effect.succeed(`error: ${e.message}`))
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
  <PromptScreen note="Ask me anything. Say “remember …” to save a note, or “remind me …” to recall." submit={runChat} />
)

type Feature = {
  readonly name: string
  readonly title: string
  readonly Component: ComponentType
}

const brokenFeature = (name: string, error: unknown): Feature => ({
  name,
  title: name,
  Component: () => (
    <View style={[styles.screen, { alignItems: "center", justifyContent: "center" }]}>
      <Text style={{ fontWeight: "700" }}>module “{name}” failed to load</Text>
      <Text style={{ color: "#c00" }}>{String(error)}</Text>
    </View>
  )
})

// Userspace features: a throwing load() yields a broken screen, never a crash.
const userFeatures: ReadonlyArray<Feature> = userspaceApp.flatMap((entry) => {
  try {
    return entry
      .load()
      .filter((c): c is AppTabCapability => c.kind === "app-tab")
      .map((c) => ({ name: c.name, title: c.title, Component: c.Component }))
  } catch (e) {
    return [brokenFeature(entry.name, e)]
  }
})

// Master→detail: every assistant-created feature lives under ONE "Apps" tab
// (a list you drill into), not a bottom tab each — so N generated apps don't
// overflow the tab bar. Per-feature ErrorBoundary still isolates a bad one.
const AppsScreen = () => {
  const [selected, setSelected] = useState<number | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  // The list is baked into the running bundle — so "refresh" means pull the
  // latest published bundle (a just-built app, or a reset's clean bundle) and
  // reload onto it. No new bundle → just stop the spinner.
  const onPullRefresh = async () => {
    setRefreshing(true)
    try {
      if (__DEV__) return
      const check = await Updates.checkForUpdateAsync()
      if (check.isAvailable) {
        await Updates.fetchUpdateAsync()
        await Updates.reloadAsync() // reloads; nothing after runs
      }
    } catch {
      /* transient — leave the current list, user can pull again */
    } finally {
      setRefreshing(false)
    }
  }

  if (selected !== null && userFeatures[selected] !== undefined) {
    const feature = userFeatures[selected]
    return (
      <View style={styles.screen}>
        <TouchableOpacity style={styles.backRow} onPress={() => setSelected(null)}>
          <Ionicons name="chevron-back" size={20} color="#0a7" />
          <Text style={styles.backText}>Apps</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <ErrorBoundary name={feature.name}>
            <feature.Component />
          </ErrorBoundary>
        </View>
      </View>
    )
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={userFeatures.length === 0 ? { flexGrow: 1 } : { paddingVertical: 8 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onPullRefresh()} />}
    >
      {userFeatures.length === 0 ? (
        <View style={{ alignItems: "center", paddingTop: 48, gap: 8 }}>
          <Ionicons name="sparkles-outline" size={40} color="#bbb" />
          <Text style={{ fontWeight: "700", fontSize: 16 }}>No apps yet</Text>
          <Text style={{ color: "#666", textAlign: "center", paddingHorizontal: 24 }}>
            Go to the Code tab and describe an app you want. It’ll appear here once it’s built. Pull down to refresh.
          </Text>
        </View>
      ) : (
        userFeatures.map((feature, i) => (
          // key by index, not name: two generated features could collide on a
          // name, and a duplicate React key would silently drop one from the list.
          <TouchableOpacity key={i} style={styles.listRow} onPress={() => setSelected(i)}>
            <Ionicons name="cube-outline" size={22} color="#0a7" />
            <Text style={styles.listTitle}>{feature.title}</Text>
            <Ionicons name="chevron-forward" size={18} color="#bbb" />
          </TouchableOpacity>
        ))
      )}
    </ScrollView>
  )
}

type CoreTab = { readonly name: string; readonly title: string; readonly icon: string; readonly Component: ComponentType }
const coreTabs: ReadonlyArray<CoreTab> = [
  { name: "chat", title: "Chat", icon: "chatbubble-ellipses", Component: ChatScreen },
  { name: "code", title: "Code", icon: "code-slash", Component: CodeScreen },
  { name: "apps", title: "Apps", icon: "apps", Component: AppsScreen }
]

// Tabs have no nav header (headerShown:false), so nothing provides the top
// safe-area inset — without this, content renders under the status bar/notch.
const SafeTop = ({ children }: PropsWithChildren) => {
  const insets = useSafeAreaInsets()
  return <View style={{ flex: 1, paddingTop: insets.top }}>{children}</View>
}

const Tabs = createBottomTabNavigator()

export const RootTabs = () => (
  <Tabs.Navigator screenOptions={{ headerShown: false }}>
    {coreTabs.map(({ name, title, icon, Component }) => (
      <Tabs.Screen
        key={name}
        name={name}
        options={{
          title,
          tabBarIcon: ({ color, size }) => <Ionicons name={icon as any} size={size} color={color} />
        }}
      >
        {() => (
          <SafeTop>
            <ErrorBoundary name={name}>
              <Component />
            </ErrorBoundary>
          </SafeTop>
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
  outputText: { fontSize: 12, fontFamily: "monospace" },
  listRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#eee"
  },
  listTitle: { flex: 1, fontSize: 16, fontWeight: "600" },
  backRow: { flexDirection: "row", alignItems: "center", paddingVertical: 6 },
  backText: { color: "#0a7", fontSize: 16, fontWeight: "600" }
})
