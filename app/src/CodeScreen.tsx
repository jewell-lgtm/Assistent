import { Body, Button, Caption, Screen, Spacer, TextField, Title } from "@assistant/capabilities-ui/kit"
import type { StepName, StepStatus, Task, TaskResult } from "@assistant/platform-api/tasks"
import * as Updates from "expo-updates"
import { useEffect, useRef, useState } from "react"
import { Alert, AppState, ScrollView, StyleSheet, View } from "react-native"
import { getPairing, getBaseUrl, getToken } from "./pairing"
import { usePairingUi } from "./PairingUi"
import { connectSse, type SseFrame } from "./sse"
import { decodeTaskFrame, fetchTask, fetchTasks, startTask } from "./tasks"

// Code tab: prompt -> POST /api/tasks ({taskId}, near-instant) -> the ENTIRE
// pipeline (agent -> OTA publish -> server reload) runs server-side and is
// persisted per-step in the appspace db. This screen is a VIEWER, not an
// orchestrator: close the app mid-run and the feature still ships; foreground
// later and we re-attach to (or replay) the task by id. Live view is SSE at
// GET /api/tasks/:id/stream (Schema-decoded frames; server replays the full
// buffer on connect, so reconnects rebuild the transcript whole — clear-then-
// replay, never append), with GET /api/tasks/:id as the durable backstop that
// works across pod restarts. `: hb` comments every 15s feed the staleness
// watchdog through quiet spells.

type Phase =
  | { readonly p: "idle" }
  | { readonly p: "starting" }
  | { readonly p: "busy" }
  | { readonly p: "unauthorized" }
  | { readonly p: "streaming"; readonly taskId: string }
  | { readonly p: "disconnected"; readonly taskId: string }
  | { readonly p: "lost"; readonly taskId: string }
  | { readonly p: "done"; readonly taskId: string; readonly result: TaskResult | undefined }
  | { readonly p: "error"; readonly taskId: string | null; readonly message: string }

type TranscriptLine = { readonly id: number; readonly kind: "text" | "tool"; readonly text: string }

type Steps = Readonly<Record<StepName, { readonly status: StepStatus; readonly detail?: string }>>

const IDLE_STEPS: Steps = {
  agent: { status: "pending" },
  publish: { status: "pending" },
  reload: { status: "pending" }
}

const RECONCILE_POLL_MS = 5000
// Watchdog for a silently-stalled SSE connection (carrier NAT/middlebox drops
// the socket with no RST — XHR never fires onerror/onreadystatechange again).
const STREAM_STALL_MS = 60000
const STALL_CHECK_MS = 5000
// Minimum gap between SSE reconnect attempts — beyond it, degrade to polling.
const RECONNECT_MIN_GAP_MS = 5000

const STEP_LABEL: Record<StepName, string> = {
  agent: "① writing code",
  publish: "② publishing app bundle",
  reload: "③ restarting server"
}

export const CodeScreen = () => {
  const pairingUi = usePairingUi()
  const [prompt, setPrompt] = useState("")
  const [phase, setPhase] = useState<Phase>({ p: "idle" })
  const [transcript, setTranscript] = useState<ReadonlyArray<TranscriptLine>>([])
  const [steps, setSteps] = useState<Steps>(IDLE_STEPS)
  const [ota, setOta] = useState<{ readonly busy: boolean; readonly status: string | null }>({ busy: false, status: null })
  const [resetStatus, setResetStatus] = useState<string | null>(null)
  const [resetting, setResetting] = useState(false)

  const mountedRef = useRef(true)
  const taskIdRef = useRef<string | null>(null)
  const terminalRef = useRef(true) // no task tracked yet — AppState reconnect must no-op
  const appliedTaskRef = useRef<string | null>(null) // which succeeded task already triggered the OTA apply (fire once)
  const sseRef = useRef<ReturnType<typeof connectSse> | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const watchdogRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const lastActivityRef = useRef(0)
  const lastReconnectRef = useRef(0)
  const seqRef = useRef(0)
  const scrollRef = useRef<ScrollView>(null)
  const atBottomRef = useRef(true)

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

  const stepsOf = (task: Task): Steps => {
    const next = { ...IDLE_STEPS } as Record<StepName, { status: StepStatus; detail?: string }>
    for (const s of task.steps) next[s.name] = { status: s.status, ...(s.detail !== undefined ? { detail: s.detail } : {}) }
    return next
  }

  // The task succeeded server-side: the new bundle is already published, so
  // the only device action left is APPLYING it — check/fetch/reload. This is
  // "check for updates on a signal", not sequencing: skipping it entirely
  // (phone in a drawer) is fine, the foreground sync in App.tsx catches up.
  const applyUpdate = async (taskId: string) => {
    if (appliedTaskRef.current === taskId) return
    appliedTaskRef.current = taskId
    if (__DEV__) {
      setOta({ busy: false, status: "shipped — dev mode, reload manually" })
      return
    }
    setOta({ busy: true, status: "pulling the new bundle…" })
    try {
      const check = await Updates.checkForUpdateAsync()
      if (check.isAvailable) {
        await Updates.fetchUpdateAsync()
        await Updates.reloadAsync() // app reloads into the new feature; nothing after runs
      } else if (mountedRef.current) {
        setOta({ busy: false, status: "shipped — bundle not offered yet, tap Refresh in a moment" })
      }
    } catch (e) {
      if (mountedRef.current) setOta({ busy: false, status: `shipped, but reload failed: ${String(e)}` })
    }
  }

  const settle = (task: Task) => {
    terminalRef.current = true
    stopPolling()
    stopWatchdog()
    closeSse()
    setSteps(stepsOf(task))
    if (task.status === "succeeded") {
      setPhase({ p: "done", taskId: task.id, result: task.result })
      void applyUpdate(task.id)
    } else {
      const message =
        task.status === "interrupted" ? (task.error ?? "server restarted mid-task") : (task.error ?? "task failed")
      setPhase({ p: "error", taskId: task.id, message })
    }
  }

  // Reconnect backstop: GET the durable task row. Used on SSE drop, on
  // app-focus, and after pod restarts (the row outlives the process that
  // streamed it). While running: a healthy stream makes this a no-op; a dead
  // one is reconnected (full replay), throttled so a hard-down server
  // degrades to slow polling instead of a reconnect storm.
  const reconcile = async (taskId: string) => {
    const fetched = await fetchTask(taskId)
    if (!mountedRef.current || taskIdRef.current !== taskId) return
    if (fetched.kind === "found" && fetched.task.status !== "running") {
      settle(fetched.task)
    } else if (fetched.kind === "not-found") {
      terminalRef.current = true
      stopPolling()
      setPhase({ p: "lost", taskId })
    } else if (fetched.kind === "unauthorized") {
      terminalRef.current = true
      stopPolling()
      setPhase({ p: "unauthorized" })
    } else if (fetched.kind === "error") {
      // transport trouble — keep the poll alive, the task itself is fine
      if (pollRef.current === null) {
        pollRef.current = setInterval(() => void reconcile(taskId), RECONCILE_POLL_MS)
      }
    } else if (sseRef.current !== null) {
      // still running AND the stream is alive — refresh steps, nothing to fix
      setSteps(stepsOf(fetched.task))
    } else if (Date.now() - lastReconnectRef.current > RECONNECT_MIN_GAP_MS) {
      lastReconnectRef.current = Date.now()
      stopPolling()
      setSteps(stepsOf(fetched.task))
      setTranscript([]) // server replays the full buffer — rebuild, don't append
      setPhase({ p: "streaming", taskId })
      startStream(taskId)
    } else {
      setSteps(stepsOf(fetched.task))
      setPhase({ p: "disconnected", taskId })
      if (pollRef.current === null) {
        pollRef.current = setInterval(() => void reconcile(taskId), RECONCILE_POLL_MS)
      }
    }
  }

  const startStream = (taskId: string) => {
    lastActivityRef.current = Date.now()
    stopWatchdog()
    watchdogRef.current = setInterval(() => {
      if (terminalRef.current) return
      if (Date.now() - lastActivityRef.current < STREAM_STALL_MS) return
      // no bytes for STREAM_STALL_MS: connection is silently dead — fall back
      // to the durable-row backstop.
      closeSse()
      stopWatchdog()
      void reconcile(taskId)
    }, STALL_CHECK_MS)
    const handle = connectSse(
      `${getBaseUrl()}/api/tasks/${encodeURIComponent(taskId)}/stream`,
      { authorization: `Bearer ${getToken()}` },
      {
        // Heartbeat comments (`: hb`) never reach onEvent — feed the watchdog
        // on raw byte activity so quiet-but-alive streams aren't killed.
        onActivity: () => {
          lastActivityRef.current = Date.now()
        },
        onEvent: (sse: SseFrame) => {
          stopPolling() // a live event proves the stream is healthy — drop any parallel poll
          const frame = decodeTaskFrame(sse.data) // unknown/future shapes decode to undefined: ignored
          if (frame === undefined) return
          switch (frame.type) {
            case "token": {
              if (frame.text.length > 0) appendLine("text", frame.text)
              break
            }
            case "tool": {
              const mark = frame.phase === "start" ? "▸" : frame.phase === "update" ? "…" : frame.error === true ? "✗" : "✓"
              appendLine("tool", `${mark} ${frame.toolName}`)
              break
            }
            case "step": {
              setSteps((prev) => ({
                ...prev,
                [frame.name]: { status: frame.status, ...(frame.detail !== undefined ? { detail: frame.detail } : {}) }
              }))
              break
            }
            case "task": {
              // terminal — settle from the durable row (single source of
              // truth: it carries the full step list, persisted before this
              // frame was emitted)
              terminalRef.current = true
              stopWatchdog()
              closeSse()
              void reconcile(taskId)
              break
            }
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
            setPhase({ p: "lost", taskId })
            return
          }
          // Anything else (5xx, proxy hiccup) is a STREAM problem, not a task
          // problem — the server-side pipeline keeps executing. NOTE this is
          // routine during the reload step: the pod restarts underneath the
          // stream. The durable row carries us across.
          void reconcile(taskId)
        },
        onNetworkError: () => {
          if (terminalRef.current) return
          closeSse()
          stopWatchdog()
          void reconcile(taskId)
        },
        onClose: () => {
          if (terminalRef.current) return // stream ended because WE saw a terminal event and closed it
          stopWatchdog()
          void reconcile(taskId)
        }
      }
    )
    sseRef.current = handle
  }

  const track = (taskId: string, initial?: Task) => {
    terminalRef.current = false
    taskIdRef.current = taskId
    seqRef.current = 0
    setTranscript([])
    setSteps(initial !== undefined ? stepsOf(initial) : { ...IDLE_STEPS, agent: { status: "running" } })
    setPhase({ p: "streaming", taskId })
    startStream(taskId)
  }

  const onSend = async () => {
    if (phase.p === "starting" || phase.p === "streaming" || phase.p === "disconnected") return
    const text = prompt.trim()
    if (text === "") return
    closeSse()
    stopPolling()
    stopWatchdog()
    setPhase({ p: "starting" })
    const result = await startTask(text)
    if (!mountedRef.current) return
    if (result.kind === "accepted") {
      setPrompt("")
      track(result.taskId)
    } else if (result.kind === "busy") {
      setPhase({ p: "busy" })
    } else if (result.kind === "unauthorized") {
      setPhase({ p: "unauthorized" })
    } else {
      setPhase({ p: "error", taskId: null, message: result.message })
    }
  }

  // Adopt the newest running task — the pipeline survives app restarts and
  // OTA reloads (both routine: the reload step itself replaces this very
  // bundle mid-task), so on mount we re-attach instead of starting blind.
  const adoptLatest = async () => {
    const tasks = await fetchTasks()
    if (!mountedRef.current || tasks === null) return
    if (taskIdRef.current !== null && !terminalRef.current) return // already tracking
    const running = tasks.find((t) => t.status === "running")
    if (running !== undefined) track(running.id, running)
  }

  useEffect(() => {
    void adoptLatest()
    const sub = AppState.addEventListener("change", (next) => {
      if (next !== "active") return
      const taskId = taskIdRef.current
      if (taskId !== null && !terminalRef.current) {
        void reconcile(taskId)
      } else {
        void adoptLatest() // a task started elsewhere (or pre-reload) may be running
      }
    })
    return () => sub.remove()
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const busy = phase.p === "starting" || phase.p === "streaming" || phase.p === "disconnected" || resetting

  // POST an opsd-proxied endpoint — RESET-ONLY now (the prompt pipeline is
  // fully server-side). Retries transient gateway blips (a reset restarts the
  // pod, so a follow-up publish can momentarily hit Caddy with no upstream).
  const TRANSIENT = new Set([502, 503, 504])
  const postOps = async (path: string, attempts = 1): Promise<{ ok: boolean; text: string }> => {
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch(`${getBaseUrl()}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${getToken()}` },
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

  // healthz reports the pod's startedAt — a fresh timestamp proves a restart
  // actually happened (reset confirmation).
  const serverStartedAt = async (): Promise<string | null> => {
    try {
      const res = await fetch(`${getBaseUrl()}/healthz`, { method: "GET" })
      if (!res.ok) return null
      const j: unknown = await res.json()
      const startedAt = (j as { startedAt?: unknown })?.startedAt
      return typeof startedAt === "string" ? startedAt : null
    } catch {
      return null
    }
  }
  const waitForRestart = async (before: string | null, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const now = await serverStartedAt()
      if (now !== null && now !== before) return true
      await new Promise((r) => setTimeout(r, 3000))
    }
    return false
  }

  // Manual refresh — for "am I on the latest bundle?" independent of a task.
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

  // Demo hard reset. App features are baked into the PUBLISHED bundle, not
  // fetched live — so wiping the server alone leaves the phone showing the old
  // feature. Full sequence: wipe server → wait for it back → publish a fresh
  // EMPTY bundle → fetch+reload onto it. Deliberately still device-driven:
  // it's a manual, watched, destructive action — not pipeline sequencing.
  const runReset = async () => {
    setResetting(true)
    try {
      setPhase({ p: "idle" })
      setSteps(IDLE_STEPS)
      setTranscript([])
      taskIdRef.current = null
      terminalRef.current = true
      setResetStatus("wiping server state…")
      const before = await serverStartedAt()
      await postOps("/api/system/reset") // server wipes + exits; response may never arrive — ignore

      setResetStatus("waiting for server to restart…")
      const backUp = await waitForRestart(before, 120_000)
      if (!mountedRef.current) return
      if (!backUp) {
        setResetStatus("server did not come back — check the mini, then try again")
        return
      }

      setResetStatus("rebuilding a clean app bundle…")
      const publish = await postOps("/api/system/publish-ota", 5)
      if (!mountedRef.current) return
      if (!publish.ok) {
        setResetStatus(`server was reset, but the bundle publish failed — tap Reset again or Refresh: ${publish.text.slice(0, 160)}`)
        return
      }

      setResetStatus("reloading to a clean slate…")
      if (__DEV__) {
        setResetStatus("server reset; dev mode — reload the app manually")
        return
      }
      const check = await Updates.checkForUpdateAsync()
      if (check.isAvailable) {
        await Updates.fetchUpdateAsync()
        await Updates.reloadAsync() // app reloads clean; nothing after runs
      } else if (mountedRef.current) {
        setResetStatus("server reset; tap Refresh to pull the clean bundle")
      }
    } catch (e) {
      if (mountedRef.current) setResetStatus(`reset error: ${String(e)}`)
    } finally {
      if (mountedRef.current) setResetting(false)
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

  const pipelineActive = Object.values(steps).some((s) => s.status !== "pending") && phase.p !== "idle"

  return (
    <Screen>
      <ScrollView
        ref={scrollRef}
        style={styles.page}
        keyboardShouldPersistTaps="handled"
        onScroll={(e) => {
          // track whether the user is pinned to the bottom; if they've scrolled
          // up to read, stop auto-scrolling and stop fighting them.
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent
          atBottomRef.current = contentOffset.y + layoutMeasurement.height >= contentSize.height - 40
        }}
        scrollEventThrottle={100}
        onContentSizeChange={() => {
          if (atBottomRef.current) scrollRef.current?.scrollToEnd({ animated: true })
        }}
      >
        <Title>Code</Title>
        <Caption>self-mod coder — the server ships it even if you close the app</Caption>
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
            <Body>unauthorized — the server rejected this token. Use "Change server…" below to re-pair.</Body>
          </>
        )}
        {phase.p === "lost" && (
          <>
            <Spacer size={8} />
            <Body>task not found on the server. Start a new prompt.</Body>
          </>
        )}
        {(phase.p === "streaming" || phase.p === "disconnected") && (
          <>
            <Spacer size={8} />
            <Caption>
              {phase.p === "streaming"
                ? `running (task ${phase.taskId.slice(0, 8)}…) — safe to close the app`
                : "connection lost — the server keeps going; reconnecting…"}
            </Caption>
          </>
        )}
        {phase.p === "error" && (
          <>
            <Spacer size={8} />
            <Body>error: {phase.message}</Body>
          </>
        )}

        {/* Server-side pipeline, rendered from step frames / the durable row. */}
        {pipelineActive && (
          <>
            <Spacer size={8} />
            {(Object.entries(steps) as ReadonlyArray<[StepName, Steps[StepName]]>).map(([name, s]) => (
              <Caption key={name}>
                {STEP_LABEL[name]}:{" "}
                {s.status === "running" ? "…" : s.status}
                {s.status === "failed" && s.detail !== undefined ? ` — ${s.detail.slice(0, 400)}` : ""}
              </Caption>
            ))}
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
              wrote code{phase.result !== undefined ? ` · ${phase.result.model}` : ""}
              {phase.result?.commit !== undefined ? ` · ${phase.result.commit}` : ""}
            </Caption>
            {phase.result !== undefined && <Body>{phase.result.text}</Body>}
          </>
        )}

        <Spacer size={28} />
        {/* Shows the RUNNING bundle's identity so "am I on the latest?" is
            answerable at a glance; manual refresh independent of a task. */}
        <Caption>
          bundle: {__DEV__ ? "dev" : `${Updates.updateId?.slice(0, 8) ?? "embedded"} · ${Updates.createdAt?.toISOString?.() ?? "APK build"}`}
        </Caption>
        <Caption>
          paired as {getPairing()?.user ?? "?"} · {(() => { try { return new URL(getBaseUrl()).host } catch { return getBaseUrl() } })()}
        </Caption>
        <Spacer size={4} />
        <Button title={ota.busy ? "checking…" : "Refresh (check for update)"} variant="secondary" onPress={() => void onRefresh()} loading={ota.busy} disabled={busy} />
        {ota.status !== null && <Caption>{ota.status}</Caption>}

        <Spacer size={8} />
        <Button title="Change server…" variant="secondary" onPress={pairingUi.repair} disabled={busy} />

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
  transcript: { gap: 4 }
})
