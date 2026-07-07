import { Body, Button, Caption, Screen, Spacer, TextField, Title } from "@assistant/capabilities-ui/kit"
import * as Updates from "expo-updates"
import { useState } from "react"
import { ScrollView } from "react-native"
import { setPairing, type Pairing } from "./pairing"

// First-launch (and re-pair) gate. Nothing is committed to storage until the
// server answered both probes: /healthz unauthenticated (reachability), then
// /api/whoami with the token (auth + display name). Payload format printed by
// scripts/user-add.sh: {"v":1,"u":<url>,"t":<token>,"n":<name>}
type Props = {
  readonly initial?: Pairing | null
  readonly onPaired: () => void
  readonly onCancel?: () => void
}

const fetchWithTimeout = async (url: string, init: RequestInit, ms = 8000): Promise<Response> => {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url, { ...init, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

export const PairingScreen = ({ initial, onPaired, onCancel }: Props) => {
  const [serverUrl, setServerUrl] = useState(initial?.serverUrl ?? "")
  const [token, setToken] = useState(initial?.token ?? "")
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onCode = (raw: string) => {
    setCode(raw)
    try {
      const p = JSON.parse(raw) as { u?: unknown; t?: unknown }
      if (typeof p.u === "string" && typeof p.t === "string") {
        setServerUrl(p.u)
        setToken(p.t)
        setError(null)
      }
    } catch {
      // partial paste — ignore until it parses
    }
  }

  const onConnect = async () => {
    setBusy(true)
    setError(null)
    try {
      let base: string
      try {
        const u = new URL(serverUrl.trim())
        base = u.origin + u.pathname.replace(/\/+$/, "")
      } catch {
        setError("that's not a URL — expected e.g. https://you.assistant.example.com")
        return
      }
      let health: Response
      try {
        health = await fetchWithTimeout(`${base}/healthz`, { method: "GET" })
      } catch {
        setError("server unreachable — check the URL and your connection")
        return
      }
      if (!health.ok) {
        setError(`server answered ${health.status} on /healthz — wrong URL?`)
        return
      }
      const who = await fetchWithTimeout(`${base}/api/whoami`, {
        method: "GET",
        headers: { authorization: `Bearer ${token.trim()}` }
      }).catch(() => null)
      if (who === null || who.status === 401) {
        setError("server found, but the token was rejected — re-check the setup code")
        return
      }
      if (!who.ok) {
        setError(`unexpected ${who.status} from /api/whoami`)
        return
      }
      const user = ((await who.json().catch(() => ({}))) as { user?: unknown }).user
      await setPairing({ serverUrl: base, token, ...(typeof user === "string" ? { user } : {}) })
      // pull the paired server's current bundle immediately; a fresh instance
      // may have no update yet ("no update"/404) — that's fine, embedded runs.
      if (!__DEV__) {
        try {
          const check = await Updates.checkForUpdateAsync()
          if (check.isAvailable) {
            await Updates.fetchUpdateAsync()
            await Updates.reloadAsync() // nothing after this runs
          }
        } catch {
          // fail-soft: foreground sync retries later
        }
      }
      onPaired()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Screen>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 4 }}>
        <Title>Pair with your server</Title>
        <Caption>paste the setup code your admin gave you, or type the details</Caption>
        <Spacer />
        <TextField label="Setup code" value={code} onChangeText={onCode} placeholder='{"v":1,"u":"https://…","t":"…"}' />
        <Spacer size={8} />
        <TextField label="Server URL" value={serverUrl} onChangeText={setServerUrl} placeholder="https://you.assistant.example.com" />
        <Spacer size={8} />
        <TextField label="Token" value={token} onChangeText={setToken} placeholder="hex token" />
        <Spacer />
        <Button
          title={busy ? "connecting…" : "Connect"}
          onPress={() => void onConnect()}
          disabled={busy || serverUrl.trim() === "" || token.trim() === ""}
          loading={busy}
        />
        {error !== null && (
          <>
            <Spacer size={8} />
            <Body>{error}</Body>
          </>
        )}
        {onCancel !== undefined && (
          <>
            <Spacer />
            <Button title="Cancel" variant="secondary" onPress={onCancel} disabled={busy} />
          </>
        )}
      </ScrollView>
    </Screen>
  )
}
