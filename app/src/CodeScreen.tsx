import { Body, Button, Caption, Screen, Spacer, TextField, Title } from "@assistant/capabilities-ui/kit"
import { Effect } from "effect"
import * as Updates from "expo-updates"
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react"
import { AppState, ScrollView, StyleSheet, Text, View } from "react-native"
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
// No heartbeat frame exists server-side, so detect staleness client-side: if
// nothing arrives for this long while "streaming", treat it like a network
// drop and fall back to the reconcile-poll backstop.
const STREAM_STALL_MS = 60000
const STALL_CHECK_MS = 5000

interface OpsState {
  readonly busy: boolean
  readonly output: string | null
  readonly ok: boolean
}
const OPS_IDLE: OpsState = { busy: false, output: null, ok: false }

export const CodeScreen = () => {
  const [prompt, setPrompt] = useState("")
  const [phase, setPhase] = useState<Phase>({ p: "idle" })
  const [transcript, setTranscript] = useState<ReadonlyArray<TranscriptLine>>([])
  const [ota, setOta] = useState<{ readonly busy: boolean; readonly status: string | null }>({
    busy: false,
    status: null
  })
  const [deploy, setDeploy] = useState<OpsState>(OPS_IDLE)
  const [publish, setPublish] = useState<OpsState>(OPS_IDLE)

  const mountedRef = useRef(true)
  const runIdRef = useRef<string | null>(null)
  const terminalRef = useRef(true) // no run in flight yet — AppState reconnect must no-op
  const sseRef = useRef<ReturnType<typeof connectSse> | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const watchdogRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const lastActivityRef = useRef(0)
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
  // app-focus. Keeps polling at a low rate while the server still reports
  // "running" so the UI doesn't stay stuck on stale state indefinitely.
  const reconcile = async (runId: string) => {
    const status = await fetchStatus(runId)
    if (!mountedRef.current || runIdRef.current !== runId) return
    if (status.kind === "done") {
      terminalRef.current = true
      stopPolling()
      setPhase({ p: "done", runId, result: status.result })
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
        onEvent: (frame: SseFrame) => {
          lastActivityRef.current = Date.now()
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
        onHttpError: (status: number, body: string) => {
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
          let message = `HTTP ${status}`
          try {
            const parsed = JSON.parse(body)
            if (typeof parsed?.error === "string") message = parsed.error
          } catch {
            // non-JSON body — fall through to generic HTTP status message
          }
          terminalRef.current = true
          setPhase({ p: "error", runId, message })
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

  const busy = phase.p === "starting" || phase.p === "streaming" || phase.p === "disconnected"

  // Slow, synchronous, opsd-proxied endpoints (real docker build, minutes-long) —
  // full response text rendered verbatim, never summarized (gate/tsc errors
  // must be readable on the phone). Not SSE; out of scope to change per spec.
  const runOps = async (path: string, setState: Dispatch<SetStateAction<OpsState>>): Promise<boolean> => {
    setState({ busy: true, output: null, ok: false })
    try {
      const res = await fetch(`${BASE_URL}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${API_TOKEN}` },
        body: "{}"
      })
      const text = await res.text()
      if (!mountedRef.current) return false
      setState({ busy: false, output: text || `(empty response, HTTP ${res.status})`, ok: res.ok })
      return res.ok
    } catch (e) {
      if (!mountedRef.current) return false
      setState({ busy: false, output: `request failed: ${e instanceof Error ? e.message : String(e)}`, ok: false })
      return false
    }
  }

  const onDeploy = () => void runOps("/api/system/redeploy", setDeploy)
  const onPublish = () => void runOps("/api/system/publish-ota", setPublish)

  const onReload = async () => {
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
      if (mountedRef.current) setOta({ busy: true, status: "downloading update…" })
      await Updates.fetchUpdateAsync()
      await Updates.reloadAsync() // app reloads; nothing after this runs
    } catch (e) {
      if (mountedRef.current) setOta({ busy: false, status: `update check failed: ${String(e)}` })
    }
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
              done · {phase.result.model}
              {phase.result.commit !== undefined ? ` · ${phase.result.commit}` : ""}
            </Caption>
            <Body>{phase.result.text}</Body>
          </>
        )}

        <Spacer size={20} />
        <View style={styles.row}>
          <View style={styles.rowItem}>
            <Button
              title="Deploy"
              variant="secondary"
              onPress={onDeploy}
              loading={deploy.busy}
              disabled={deploy.busy || publish.busy}
            />
          </View>
          <View style={styles.rowItem}>
            <Button
              title="Publish OTA"
              variant="secondary"
              onPress={() => void onPublish()}
              loading={publish.busy}
              disabled={deploy.busy || publish.busy}
            />
          </View>
        </View>

        {deploy.output !== null && (
          <>
            <Spacer size={8} />
            <Caption>deploy output{deploy.ok ? "" : " (failed)"}</Caption>
            <ScrollView style={styles.logBox} nestedScrollEnabled>
              <Text selectable style={styles.logText}>
                {deploy.output}
              </Text>
            </ScrollView>
          </>
        )}
        {publish.output !== null && (
          <>
            <Spacer size={8} />
            <Caption>publish output{publish.ok ? "" : " (failed)"}</Caption>
            <ScrollView style={styles.logBox} nestedScrollEnabled>
              <Text selectable style={styles.logText}>
                {publish.output}
              </Text>
            </ScrollView>
          </>
        )}
        {publish.ok && (
          <>
            <Spacer size={8} />
            <Button title={ota.busy ? "checking…" : "Reload app (apply OTA update)"} variant="secondary" onPress={onReload} loading={ota.busy} />
            {ota.status !== null && <Caption>{ota.status}</Caption>}
          </>
        )}
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
