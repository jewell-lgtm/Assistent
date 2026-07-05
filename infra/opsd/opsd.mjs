#!/usr/bin/env node
// Host-side ops daemon. Runs ONLY the two whitelisted scripts from the repo
// checkout. Installed as a COPY at ~/opsd/ (launchd runs it from there), so
// runtime agents editing the repo can never edit the running daemon.
import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"

const HOME = homedir()
const TOKEN = readFileSync(`${HOME}/opsd/token`, "utf8").trim()
const CWD = `${HOME}/assistant`
const PATH = `${HOME}/.local/share/mise/shims:/opt/homebrew/bin:/Applications/OrbStack.app/Contents/MacOS/xbin:${process.env.PATH ?? ""}`
const TIMEOUT_MS = 15 * 60 * 1000

const SCRIPTS = {
  "/redeploy": "scripts/redeploy.sh",
  "/publish-ota": "scripts/publish-ota-mini.sh"
}

let busy = false

createServer((req, res) => {
  const json = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" })
    res.end(JSON.stringify(obj))
  }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: "unauthorized" })
  if (req.method === "GET" && req.url === "/status") return json(200, { ok: true, busy })
  const script = req.method === "POST" ? SCRIPTS[req.url] : undefined
  if (script === undefined) return json(404, { error: "unknown endpoint" })
  if (busy) return json(409, { error: "busy" })
  busy = true

  let body = ""
  req.on("data", (c) => (body += c))
  req.on("end", () => {
    let message = "self-mod"
    try {
      message = JSON.parse(body).message ?? message
    } catch {}
    const child = spawn("sh", [script, message], {
      cwd: CWD,
      env: { ...process.env, PATH },
      stdio: ["ignore", "pipe", "pipe"]
    })
    let out = ""
    const cap = (c) => (out = (out + c).slice(-16000))
    child.stdout.on("data", cap)
    child.stderr.on("data", cap)
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS)
    child.on("close", (code) => {
      clearTimeout(timer)
      busy = false
      json(code === 0 ? 200 : 500, { exitCode: code, logTail: out.slice(-4000) })
    })
  })
}).listen(9876, "0.0.0.0", () => console.log("opsd listening on :9876"))
