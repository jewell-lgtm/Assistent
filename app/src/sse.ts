// Pure-JS SSE client for React Native. RN's fetch is a whatwg-fetch/XHR
// polyfill (see node_modules/whatwg-fetch, node_modules/react-native/Libraries/
// Network/fetch.js) — it resolves only on XHR `onload`, i.e. `response.body`
// as a streaming ReadableStream does NOT work here, so a fetch-reader-based
// parser (the textbook browser approach) would silently buffer the whole
// response and never yield incremental events. RN's XMLHttpRequest DOES
// support incremental delivery: with an `onreadystatechange`/`onprogress`
// listener attached, native fires repeated LOADING (readyState 3) callbacks
// with `responseText` growing (see XMLHttpRequest.js `_incrementalEvents`,
// `__didReceiveIncrementalData`). That's the same mechanism libraries like
// react-native-sse build on — reimplemented here directly to avoid adding a
// dependency for ~60 lines of parsing.
//
// Also: EventSource can't set custom headers, and every route in this app is
// bearer-authed (server/src/main.ts) — XHR is the only viable transport here
// regardless of the streaming question above.

export interface SseFrame {
  readonly event: string
  readonly data: string
}

export interface SseHandlers {
  /** One parsed `event:`/`data:` frame. Comment-only (`:ping`) and empty frames never reach here. */
  readonly onEvent: (frame: SseFrame) => void
  /** Raw bytes arrived on the connection — fires for heartbeat/comment frames too.
   *  This (not onEvent) is what a staleness watchdog should feed on: the server's
   *  `: hb` comments prove liveness without producing any parsed event. */
  readonly onActivity?: () => void
  /** Response completed with a non-200 status — `body` is the full response text (usually JSON `{error}`). */
  readonly onHttpError: (status: number, body: string) => void
  /** Transport-level failure (no response at all — DNS, connection refused, etc). */
  readonly onNetworkError: (message: string) => void
  /** The (200 OK) stream ended — either the server closed it or the connection dropped mid-run.
   *  Fired for both a clean server-side close and an unexpected drop; the caller can't tell those
   *  apart from here; whether it's "unexpected" is a matter of whether a terminal event was already
   *  seen, which the caller tracks. Never fired after `close()` is called by the caller. */
  readonly onClose: () => void
}

export interface SseHandle {
  readonly close: () => void
}

const splitFrames = (buffer: string): { readonly frames: ReadonlyArray<string>; readonly rest: string } => {
  const frames: Array<string> = []
  let start = 0
  for (;;) {
    const idx = buffer.indexOf("\n\n", start)
    if (idx === -1) break
    frames.push(buffer.slice(start, idx))
    start = idx + 2
  }
  return { frames, rest: buffer.slice(start) }
}

const parseFrame = (frame: string): SseFrame | undefined => {
  let event = "message"
  const dataLines: Array<string> = []
  for (const line of frame.split("\n")) {
    if (line === "" || line.startsWith(":")) continue // comment / blank
    const colonIdx = line.indexOf(":")
    const field = colonIdx === -1 ? line : line.slice(0, colonIdx)
    let value = colonIdx === -1 ? "" : line.slice(colonIdx + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    if (field === "event") event = value
    else if (field === "data") dataLines.push(value)
    // `id`/`retry` fields: no reconnect-with-Last-Event-ID support in this
    // client (out of scope — see CodeScreen.tsx's plain-GET reconnect backstop
    // instead), so they're accepted but ignored rather than erroring.
  }
  if (dataLines.length === 0) return undefined
  return { event, data: dataLines.join("\n") }
}

/** Connect to an SSE endpoint over XHR (see file header for why not fetch/EventSource). */
export const connectSse = (url: string, headers: Record<string, string>, handlers: SseHandlers): SseHandle => {
  const xhr = new XMLHttpRequest()
  let cursor = 0
  let buffer = ""
  let closed = false
  let sawOk = false

  const finish = () => {
    closed = true
    xhr.onreadystatechange = null
    xhr.onerror = null
    xhr.ontimeout = null
  }

  const drain = () => {
    const text = xhr.responseText ?? ""
    if (text.length <= cursor) return
    handlers.onActivity?.()
    // \r\n normalization: RN's XHR delivers whatever bytes the server sent;
    // normalize before buffering so the "\n\n" frame separator matches
    // regardless of server line-ending style.
    const chunk = text.slice(cursor).replace(/\r\n/g, "\n")
    cursor = text.length
    buffer += chunk
    const { frames, rest } = splitFrames(buffer)
    buffer = rest
    for (const raw of frames) {
      const frame = parseFrame(raw)
      if (frame !== undefined) handlers.onEvent(frame)
    }
  }

  xhr.onreadystatechange = () => {
    if (closed) return
    if (xhr.readyState === XMLHttpRequest.HEADERS_RECEIVED && xhr.status === 200) {
      sawOk = true
    }
    if (xhr.readyState === XMLHttpRequest.LOADING && sawOk) {
      drain()
    }
    if (xhr.readyState === XMLHttpRequest.DONE) {
      const wasOk = sawOk
      if (wasOk) {
        // A terminal frame can arrive coalesced with the connection close —
        // RN's XHR may deliver those bytes only at DONE with no final LOADING
        // callback. Drain BEFORE reporting close or the done event is lost.
        drain()
      }
      finish()
      if (wasOk) {
        handlers.onClose()
      } else {
        handlers.onHttpError(xhr.status, xhr.responseText ?? "")
      }
    }
  }

  xhr.onerror = () => {
    if (closed) return
    finish()
    handlers.onNetworkError("network error")
  }
  xhr.ontimeout = () => {
    if (closed) return
    finish()
    handlers.onNetworkError("timed out")
  }

  xhr.open("GET", url, true)
  for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value)
  xhr.setRequestHeader("accept", "text/event-stream")
  xhr.send()

  return {
    close: () => {
      if (closed) return
      finish()
      xhr.abort()
    }
  }
}
