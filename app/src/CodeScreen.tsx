import { Body, Button, Caption, Screen, Spacer, TextField, Title } from "@assistant/capabilities-ui/kit"
import { Effect } from "effect"
import * as Updates from "expo-updates"
import { useEffect, useRef, useState } from "react"
import { Alert, AppState, ScrollView, StyleSheet, Text, View } from "react-native"
import { API_TOKEN, apiRequest, BASE_URL } from "./PiProxy"
import { connectSse, type SseFrame } from "./sse"

// Code tab: prompt -> POST /api/system/code ({runId}, near-instant) -> live
// SSE at GET /api/system/code/:runId/stream -> GET /api/system/code/:runId as
// the reconnect backstop (screen lock / SSE drop). Wire format below matches
// server/src/coding-runs.ts as landed (read directly, not guessed): every SSE
// frame is a bare `data: <json>\n\n` with NO `event:` line — the discriminator
// is the JSON payload's own `.type` field (`token`/`tool`/`done`/`error`),
// and GET status uses `status: "running"|"done"|"failed"` (note: "failed",
// not "error") with the result nested under `.result`. Unknown/future
// `.type` values are ignored rather than crashing.
// The server BUFFERS every event per run and REPLAYS the full history on each
// stream connect — so reconnecting rebuilds the transcript from scratch
// (clear-then-replay, never append), and `: hb` comment frames every 15s keep
// the staleness watchdog fed through quiet spells.

interface CodeResult {
  readonly text: string
  readonly model: string
  readonly commit?: string
}

type StartResult =
  | { readonly kind: "accepted"; readonly runId: string }
  | { readonly kind: "busy" }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "error"; readonly message: string }

const startRun = (prompt: string): Promise<StartResult> =>
  Effect.runPromise(
    apiRequest("POST", "/api/system/code", { prompt }).pipe(
      Effect.map(({ status, json }): StartResult => {
        if (status === 401) return { kind: "unauthorized" }
        if (status === 409) return { kind: "busy" }
        if (status >= 200 && status < 300 && typeof json?.runId === "string") {
          return { kind: "accepted", runId: json.runId }
        }
        return { kind: "error", message: json?.error ?? `unexpected response (HTTP ${status})` }
      }),
      Effect.catchAll((e) => Effect.succeed({ kind: "error", message: e.message } as StartResult))
    )
  )

type StatusResult =
  | { readonly kind: "running" }
  | { readonly kind: "done"; readonly result: CodeResult }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "not-found" }

const fetchStatus = (runId: string): Promise<StatusResult> =>
  Effect.runPromise(
    apiRequest("GET", `/api/system/code/${encodeURIComponent(runId)}`).pipe(
      Effect.map(({ status, json }): StatusResult => {
        if (status === 401) return { kind: "unauthorized" }
        if (status === 404) return { kind: "not-found" }
        if (status >= 400) return { kind: "error", message: json?.error ?? `HTTP ${status}` }
        if (json?.status === "failed") return { kind: "error", message: json?.error ?? "run failed" }
        if (json?.status === "done") {
          const result = json?.result ?? {}
          return { kind: "done", result: { text: result.text ?? "", model: result.model ?? "?", commit: result.commit } }
        }
        return { kind: "running" }
      }),
      Effect.catchAll((e) => Effect.succeed({ kind: "error", message: e.message } as StatusResult))
    )
  )

type TranscriptLine = { readonly id: number; readonly kind: "text" | "tool"; readonly text: string }

type Phase =
  | { readonly p: "idle" }
  | { readonly p: "starting" }
  | { readonly p: "busy" }
  | { readonly p: "unauthorized" }
  | { readonly p: "streaming"; readonly runId: string }
  | { readonly p: "disconnected"; readonly runId: string }
  | { readonly p: "lost"; readonly runId: string }
  | { readonly p: "done"; readonly runId: string; readonly result: CodeResult }
  | { readonly p: "error"; readonly runId: string | null; readonly message: string }

const RECONCILE_POLL_MS = 5000
// Watchdog for a silently-stalled SSE connection (carrier NAT/middlebox drops
// the socket with no RST — XHR never fires onerror/onreadystatechange again).
// The server sends a `: hb` comment every 15s, so a healthy-but-quiet stream
// (long tool execution, model thinking) still shows BYTE activity (fed via
// onActivity, not onEvent) — 60s of true byte silence means the connection is
// genuinely dead, not merely idle.
const STREAM_STALL_MS = 60000
const STALL_CHECK_MS = 5000
// Minimum gap between SSE reconnect attempts — beyond it, degrade to polling.
const RECONNECT_MIN_GAP_MS = 5000

// After a coding run finishes, the whole ship-it pipeline runs automatically:
// deploy the new server routes (through the type gate), publish the app bundle,
// then reload into it — no buttons, just churn until the feature is live.
type Pipeline =
  | { readonly step: "idle" }
  | { readonly step: "deploying" }
  | { readonly step: "publishing" }
  | { readonly step: "reloading" }
  | { readonly step: "failed"; readonly at: string; readonly output: string }

export const CodeScreen = () => {
  const [prompt, setPrompt] = useState("")
  const [phase, setPhase] = useState<Phase>({ p: "idle" })
  const [transcript, setTranscript] = useState<ReadonlyArray<TranscriptLine>>([])
  const [pipeline, setPipeline] = useState<Pipeline>({ step: "idle" })
  const [ota, setOta] = useState<{ readonly busy: boolean; readonly status: string | null }>({ busy: false, status: null })
  const [resetStatus, setResetStatus] = useState<string | null>(null)

  const mountedRef = useRef(true)
  const runIdRef = useRef<string | null>(null)
  const terminalRef = useRef(true) // no run in flight yet — AppState reconnect must no-op
  const sseRef = useRef<ReturnType<typeof connectSse> | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const watchdogRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const lastActivityRef = useRef(0)
  const lastReconnectRef = useRef(0)
  const seqRef = useRef(0)
  const scrollRef = useRef<ScrollView>(null)

  const stopPolling = () => {
    if (pollRef.current !== null) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }
  const stopWatchdog = () => {
    if (watchdogRef.current !== null) {
      clearInterval(watchdogRef.current)
      watchdogRef.current = null
    }
  }
  const closeSse = () => {
    sseRef.current?.close()
    sseRef.current = null
  }

  const appendLine = (kind: TranscriptLine["kind"], text: string) => {
    seqRef.current += 1
    const id = seqRef.current
    setTranscript((prev) => {
      if (kind === "text" && prev.length > 0 && prev[prev.length - 1].kind === "text") {
        const last = prev[prev.length - 1]
        return [...prev.slice(0, -1), { ...last, text: last.text + text }]
      }
      return [...prev, { id, kind, text }]
    })
  }

  // Reconnect backstop: GET plain status by runId. Used on SSE drop and on
  // app-focus. While the run is still going: if the SSE stream is alive this
  // is a no-op (never downgrade a healthy stream to "disconnected"); if the
  // stream is dead, try to RECONNECT it (the server replays the full event
  // buffer, so the transcript is rebuilt whole), throttled so a hard-down
  // server degrades to slow polling instead of a reconnect storm.
  const reconcile = async (runId: string) => {
    const status = await fetchStatus(runId)
    if (!mountedRef.current || runIdRef.current !== runId) return
    if (status.kind === "done") {
      terminalRef.current = true
      stopPolling()
      setPhase({ p: "done", runId, result: status.result })
      void runPipeline()
    } else if (status.kind === "error") {
      terminalRef.current = true
      stopPolling()
      setPhase({ p: "error", runId, message: status.message })
    } else if (status.kind === "not-found") {
      terminalRef.current = true
      stopPolling()
      setPhase({ p: "lost", runId })
    } else if (status.kind === "unauthorized") {
      terminalRef.current = true
      stopPolling()
      setPhase({ p: "unauthorized" })
    } else if (sseRef.current !== null) {
      // still running AND the stream is alive — nothing to fix.
      return
    } else if (Date.now() - lastReconnectRef.current > RECONNECT_MIN_GAP_MS) {
      lastReconnectRef.current = Date.now()
      stopPolling()
      setTranscript([]) // server replays the full buffer — rebuild, don't append
      setPhase({ p: "streaming", runId })
      startStream(runId)
    } else {
      setPhase({ p: "disconnected", runId })
      if (pollRef.current === null) {
        pollRef.current = setInterval(() => void reconcile(runId), RECONCILE_POLL_MS)
      }
    }
  }

  const startStream = (runId: string) => {
    lastActivityRef.current = Date.now()
    stopWatchdog()
    watchdogRef.current = setInterval(() => {
      if (terminalRef.current) return
      if (Date.now() - lastActivityRef.current < STREAM_STALL_MS) return
      // no bytes for STREAM_STALL_MS: connection is silently dead (no error,
      // no close event ever fired) — fall back to the GET-status backstop.
      closeSse()
      stopWatchdog()
      void reconcile(runId)
    }, STALL_CHECK_MS)
    const handle = connectSse(
      `${BASE_URL}/api/system/code/${encodeURIComponent(runId)}/stream`,
      { authorization: `Bearer ${API_TOKEN}` },
      {
        // Heartbeat comments (`: hb`) never reach onEvent — feed the watchdog
        // on raw byte activity so quiet-but-alive streams aren't killed.
        onActivity: () => {
          lastActivityRef.current = Date.now()
        },
        onEvent: (frame: SseFrame) => {
          stopPolling() // a live event proves the stream is healthy — drop any parallel poll
          // No `event:` line is ever sent (bare `data: <json>` frames) — the
          // discriminator lives in the JSON payload's own `.type` field.
          let data: any
          try {
            data = JSON.parse(frame.data)
          } catch {
            return
          }
          switch (data?.type) {
            case "token": {
              if (typeof data.text === "string" && data.text.length > 0) appendLine("text", data.text)
              break
            }
            case "tool": {
              const name = typeof data.toolName === "string" ? data.toolName : "tool"
              const mark = data.phase === "start" ? "▸" : data.phase === "update" ? "…" : data.error === true ? "✗" : "✓"
              appendLine("tool", `${mark} ${name}`)
              break
            }
            case "done": {
              terminalRef.current = true
              stopPolling()
              stopWatchdog()
              closeSse()
              const result = data.result ?? {}
              setPhase({
                p: "done",
                runId,
                result: { text: result.text ?? "", model: result.model ?? "?", commit: result.commit ?? undefined }
              })
              void runPipeline()
              break
            }
            case "error": {
              terminalRef.current = true
              stopPolling()
              stopWatchdog()
              closeSse()
              setPhase({ p: "error", runId, message: typeof data.message === "string" ? data.message : "run failed" })
              break
            }
            // any future/unknown type: no UI action, don't crash.
            default:
              break
          }
        },
        onHttpError: (status: number) => {
          closeSse()
          stopWatchdog()
          if (terminalRef.current) return // already resolved via reconcile/another path
          if (status === 401) {
            terminalRef.current = true
            setPhase({ p: "unauthorized" })
            return
          }
          if (status === 404) {
            terminalRef.current = true
            setPhase({ p: "lost", runId })
            return
          }
          // Anything else (5xx, proxy hiccup) is a STREAM problem, not a run
          // problem — the server-side run keeps executing. Fall back to the
          // status poll instead of declaring the run dead.
          void reconcile(runId)
        },
        onNetworkError: () => {
          if (terminalRef.current) return
          closeSse()
          stopWatchdog()
          void reconcile(runId)
        },
        onClose: () => {
          if (terminalRef.current) return // stream ended because WE saw a terminal event and closed it
          stopWatchdog()
          void reconcile(runId)
        }
      }
    )
    sseRef.current = handle
  }

  const onSend = async () => {
    if (phase.p === "starting" || phase.p === "streaming" || phase.p === "disconnected") return
    const text = prompt.trim()
    if (text === "") return
    closeSse()
    stopPolling()
    stopWatchdog()
    setPhase({ p: "starting" })
    const result = await startRun(text)
    if (!mountedRef.current) return
    if (result.kind === "accepted") {
      terminalRef.current = false
      runIdRef.current = result.runId
      seqRef.current = 0
      setTranscript([])
      setPrompt("")
      setPhase({ p: "streaming", runId: result.runId })
      startStream(result.runId)
    } else if (result.kind === "busy") {
      setPhase({ p: "busy" })
    } else if (result.kind === "unauthorized") {
      setPhase({ p: "unauthorized" })
    } else {
      setPhase({ p: "error", runId: null, message: result.message })
    }
  }

  // Reconnect-and-refetch on foreground. No-op when nothing is tracked (idle,
  // or a run that already reached a terminal state) — never fires a request
  // just because the app came back to the foreground.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next !== "active") return
      const runId = runIdRef.current
      if (runId === null || terminalRef.current) return
      void reconcile(runId)
    })
    return () => sub.remove()
  }, [])

  useEffect(
    () => () => {
      mountedRef.current = false
      closeSse()
      stopPolling()
      stopWatchdog()
    },
    []
  )

  const resetting = resetStatus !== null && !resetStatus.startsWith("server reset") && !resetStatus.includes("did not come back")
  const busy =
    phase.p === "starting" ||
    phase.p === "streaming" ||
    phase.p === "disconnected" ||
    (pipeline.step !== "idle" && pipeline.step !== "failed") ||
    resetting

  // POST an opsd-proxied endpoint (real docker build / bundle export, minutes-
  // long). Returns ok + the full response text (gate/tsc errors must survive
  // to the phone verbatim). Retries a transient gateway blip: a deploy restarts
  // the pod, so a follow-up publish can momentarily hit Caddy with no upstream
  // (502/503/504) — that's infra, not a build failure, so retry rather than
  // surface it. A real gate failure comes back 200-from-opsd with error text
  // (opsd always answers) or a 4xx, neither of which we retry.
  const TRANSIENT = new Set([502, 503, 504])
  const postOps = async (path: string, attempts = 1): Promise<{ ok: boolean; text: string }> => {
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch(`${BASE_URL}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${API_TOKEN}` },
          body: "{}"
        })
        const text = await res.text()
        if (TRANSIENT.has(res.status) && i < attempts - 1) {
          await new Promise((r) => setTimeout(r, 5000))
          continue
        }
        return { ok: res.ok, text: text || `(empty response, HTTP ${res.status})` }
      } catch (e) {
        if (i < attempts - 1) {
          await new Promise((r) => setTimeout(r, 5000))
          continue
        }
        return { ok: false, text: `request failed: ${e instanceof Error ? e.message : String(e)}` }
      }
    }
    return { ok: false, text: "gave up after retries" }
  }

  // Auto ship-it pipeline: deploy → publish → reload, no buttons. A failing
  // deploy (type gate) halts before publish and surfaces the errors so the
  // user re-prompts Pi to fix; nothing broken ever gets published or reloaded.
  const runPipeline = async () => {
    setPipeline({ step: "deploying" })
    // Fast path: userspace-only self-mods just need a pod restart (userspace is
    // mounted), not a docker rebuild — /reload is seconds, /redeploy is minutes.
    const deploy = await postOps("/api/system/reload", 5)
    if (!mountedRef.current) return
    if (!deploy.ok) {
      setPipeline({ step: "failed", at: "deploy", output: deploy.text })
      return
    }
    setPipeline({ step: "publishing" })
    const publish = await postOps("/api/system/publish-ota", 5) // ride out the post-deploy pod rollover
    if (!mountedRef.current) return
    if (!publish.ok) {
      setPipeline({ step: "failed", at: "publish", output: publish.text })
      return
    }
    setPipeline({ step: "reloading" })
    if (__DEV__) {
      setPipeline({ step: "failed", at: "reload", output: "dev mode — OTA reload disabled" })
      return
    }
    try {
      const check = await Updates.checkForUpdateAsync()
      if (check.isAvailable) {
        await Updates.fetchUpdateAsync()
        await Updates.reloadAsync() // app reloads into the new feature; nothing after runs
      } else if (mountedRef.current) {
        setPipeline({ step: "failed", at: "reload", output: "published, but no new update offered yet — try refresh" })
      }
    } catch (e) {
      if (mountedRef.current) setPipeline({ step: "failed", at: "reload", output: `reload failed: ${String(e)}` })
    }
  }

  // Manual refresh — for "am I on the latest bundle?" independent of a run.
  const onRefresh = async () => {
    if (__DEV__) {
      setOta({ busy: false, status: "dev mode — updates disabled" })
      return
    }
    setOta({ busy: true, status: "checking for update…" })
    try {
      const check = await Updates.checkForUpdateAsync()
      if (!check.isAvailable) {
        if (mountedRef.current) setOta({ busy: false, status: "no update available yet" })
        return
      }
      await Updates.fetchUpdateAsync()
      await Updates.reloadAsync()
    } catch (e) {
      if (mountedRef.current) setOta({ busy: false, status: `update check failed: ${String(e)}` })
    }
  }

  // Demo hard reset. The subtlety: app features are baked into the PUBLISHED
  // bundle, not fetched live — so wiping the server alone leaves the phone
  // showing the old feature. Full sequence: wipe server (it restarts with an
  // empty registry) → wait for it back up → publish a fresh EMPTY bundle →
  // fetch+reload the phone onto it. Confirmed natively.
  const runReset = async () => {
    setPipeline({ step: "idle" })
    setPhase({ p: "idle" })
    setTranscript([])
    setResetStatus("wiping server state…")
    await postOps("/api/system/reset") // server wipes + exits; response may never arrive — ignore

    setResetStatus("waiting for server to restart…")
    const deadline = Date.now() + 120_000
    let backUp = false
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${BASE_URL}/healthz`, { method: "GET" })
        if (res.ok) {
          backUp = true
          break
        }
      } catch {
        /* still down */
      }
      await new Promise((r) => setTimeout(r, 3000))
    }
    if (!mountedRef.current) return
    if (!backUp) {
      setResetStatus("server did not come back — check the mini")
      return
    }

    setResetStatus("rebuilding a clean app bundle…")
    const publish = await postOps("/api/system/publish-ota", 5)
    if (!mountedRef.current) return
    if (!publish.ok) {
      setResetStatus(`reset done on server, but bundle publish failed: ${publish.text.slice(0, 200)}`)
      return
    }

    setResetStatus("reloading to a clean slate…")
    if (__DEV__) {
      setResetStatus("server reset; dev mode — reload the app manually")
      return
    }
    try {
      const check = await Updates.checkForUpdateAsync()
      if (check.isAvailable) {
        await Updates.fetchUpdateAsync()
        await Updates.reloadAsync() // app reloads clean; nothing after runs
      } else if (mountedRef.current) {
        setResetStatus("server reset; tap Refresh to pull the clean bundle")
      }
    } catch (e) {
      if (mountedRef.current) setResetStatus(`server reset; reload failed: ${String(e)}`)
    }
  }
  const onReset = () => {
    Alert.alert(
      "Reset everything?",
      "Deletes every feature the assistant has built (server userspace, vault, history), rebuilds a clean app, and reloads. Takes a minute. Cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Reset", style: "destructive", onPress: () => void runReset() }
      ]
    )
  }

  return (
    <Screen>
      <ScrollView
        ref={scrollRef}
        style={styles.page}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
      >
        <Title>Code</Title>
        <Caption>self-mod coder — writes userspace, auto-commits</Caption>
        <Spacer />
        <TextField label="Prompt" value={prompt} onChangeText={setPrompt} placeholder="what should Pi change?" />
        <Spacer size={8} />
        <Button title={busy ? "running…" : "Send"} onPress={() => void onSend()} disabled={busy} loading={phase.p === "starting"} />

        {phase.p === "busy" && (
          <>
            <Spacer size={8} />
            <Body>already running a job — your prompt was not sent. Wait for it to finish, then retry.</Body>
          </>
        )}
        {phase.p === "unauthorized" && (
          <>
            <Spacer size={8} />
            <Body>unauthorized — check the app's API token.</Body>
          </>
        )}
        {phase.p === "lost" && (
          <>
            <Spacer size={8} />
            <Body>run lost (server may have restarted). Start a new prompt.</Body>
          </>
        )}
        {(phase.p === "streaming" || phase.p === "disconnected") && (
          <>
            <Spacer size={8} />
            <Caption>{phase.p === "streaming" ? `running (run ${phase.runId.slice(0, 8)}…)` : "connection lost — reconnecting…"}</Caption>
          </>
        )}
        {phase.p === "error" && (
          <>
            <Spacer size={8} />
            <Body>error: {phase.message}</Body>
          </>
        )}

        {transcript.length > 0 && (
          <>
            <Spacer />
            <View style={styles.transcript}>
              {transcript.map((line) =>
                line.kind === "text" ? <Body key={line.id}>{line.text}</Body> : <Caption key={line.id}>{line.text}</Caption>
              )}
            </View>
          </>
        )}

        {phase.p === "done" && (
          <>
            <Spacer />
            <Caption>
              wrote code · {phase.result.model}
              {phase.result.commit !== undefined ? ` · ${phase.result.commit}` : ""}
            </Caption>
            <Body>{phase.result.text}</Body>
          </>
        )}

        {/* Auto ship-it pipeline — churns after the run with no buttons. */}
        {(pipeline.step === "deploying" || pipeline.step === "publishing" || pipeline.step === "reloading") && (
          <>
            <Spacer />
            <Caption>
              {pipeline.step === "deploying"
                ? "① restarting server with your new routes…"
                : pipeline.step === "publishing"
                  ? "② publishing app bundle (~30s)…"
                  : "③ reloading into your new feature…"}
            </Caption>
          </>
        )}
        {pipeline.step === "failed" && (
          <>
            <Spacer />
            <Caption>pipeline halted at {pipeline.at} — nothing broken was shipped. Fix by re-prompting above.</Caption>
            <ScrollView style={styles.logBox} nestedScrollEnabled>
              <Text selectable style={styles.logText}>
                {pipeline.output}
              </Text>
            </ScrollView>
          </>
        )}

        <Spacer size={28} />
        {/* Shows the RUNNING bundle's identity so "am I on the latest?" is
            answerable at a glance; manual refresh independent of a run. */}
        <Caption>
          bundle: {__DEV__ ? "dev" : `${Updates.updateId?.slice(0, 8) ?? "embedded"} · ${Updates.createdAt?.toISOString?.() ?? "APK build"}`}
        </Caption>
        <Spacer size={4} />
        <Button title={ota.busy ? "checking…" : "Refresh (check for update)"} variant="secondary" onPress={() => void onRefresh()} loading={ota.busy} disabled={busy} />
        {ota.status !== null && <Caption>{ota.status}</Caption>}

        <Spacer size={24} />
        <Button title={resetting ? "resetting…" : "Reset everything"} variant="danger" onPress={onReset} disabled={busy} loading={resetting} />
        {resetStatus !== null ? <Caption>{resetStatus}</Caption> : <Caption>wipes all assistant-built state (server + app) — demo reset</Caption>}
        <Spacer size={40} />
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  transcript: { gap: 4 },
  row: { flexDirection: "row", gap: 8 },
  rowItem: { flex: 1 },
  logBox: { maxHeight: 240, borderWidth: 1, borderColor: "#eee", borderRadius: 6, padding: 8 },
  logText: { fontSize: 11, fontFamily: "monospace" }
})
