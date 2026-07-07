#!/usr/bin/env node
// Host-side ops daemon, multi-user. Runs ONLY the whitelisted scripts from
// the repo checkout. Installed as a COPY at ~/opsd/ (launchd runs it from
// there), so runtime agents editing the repo can never edit the running
// daemon. Deploy: cp + `launchctl kickstart -k` (same plist, no BTM re-prompt).
//
// AuthZ: bearer == ~/opsd/token -> admin; else matched against opsdToken in
// ~/assistant-users/users.json (read per request — new users need no restart;
// the registry is host-only, no pod mounts it). A user token can only
// reload/publish its OWN stack (user derived from token, body can't override).
// /redeploy is admin-only: it rebuilds the image and rolls EVERY pod — must
// not be a user-triggerable DoS.
import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"

const HOME = homedir()
const ADMIN_TOKEN = readFileSync(`${HOME}/opsd/token`, "utf8").trim()
const USERS_JSON = `${HOME}/assistant-users/users.json`
const CWD = `${HOME}/assistant`
const PATH = `${HOME}/.local/share/mise/shims:/opt/homebrew/bin:/Applications/OrbStack.app/Contents/MacOS/xbin:${process.env.PATH ?? ""}`
const TIMEOUT_MS = 15 * 60 * 1000

// endpoint -> { script, perUser } — per-user scripts get [user, message] argv
const SCRIPTS = {
  "/redeploy": { script: "scripts/redeploy.sh", perUser: false }, // admin-only
  "/reload": { script: "scripts/reload.sh", perUser: true },
  "/publish-ota": { script: "scripts/publish-ota-mini.sh", perUser: true }
}

// admin -> {admin:true}; user token -> {admin:false, user}; null -> 401
const authenticate = (header) => {
  if (header === `Bearer ${ADMIN_TOKEN}`) return { admin: true }
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null
  const token = header.slice("Bearer ".length)
  try {
    const users = JSON.parse(readFileSync(USERS_JSON, "utf8"))
    for (const [user, cfg] of Object.entries(users)) {
      if (typeof cfg?.opsdToken === "string" && cfg.opsdToken.length > 0 && cfg.opsdToken === token) {
        return { admin: false, user }
      }
    }
  } catch {} // no registry yet -> only admin authenticates
  return null
}

// single GLOBAL lock across all users, deliberately: every script mutates
// shared state in ~/assistant (the userspace symlink, generated registries,
// bundler caches). Per-user locks are unsound without per-user checkouts.
let busy = false

createServer((req, res) => {
  const json = (code, obj) => {
    res.writeHead(code, { "content-type": "application/json" })
    res.end(JSON.stringify(obj))
  }
  const auth = authenticate(req.headers.authorization)
  if (auth === null) return json(401, { error: "unauthorized" })
  if (req.method === "GET" && req.url === "/status") return json(200, { ok: true, busy })
  const entry = req.method === "POST" ? SCRIPTS[req.url] : undefined
  if (entry === undefined) return json(404, { error: "unknown endpoint" })
  if (!entry.perUser && !auth.admin) return json(403, { error: "admin only" })
  if (busy) return json(409, { error: "busy" })
  busy = true

  let body = ""
  req.on("data", (c) => (body += c))
  req.on("end", () => {
    let message = "self-mod"
    let bodyUser
    try {
      const parsed = JSON.parse(body)
      message = parsed.message ?? message
      bodyUser = parsed.user
    } catch {}
    let args
    if (entry.perUser) {
      // identity is the token's, never the body's — except for admin, who
      // must name a target
      const user = auth.admin ? bodyUser : auth.user
      if (typeof user !== "string" || user === "") {
        busy = false
        return json(400, { error: "admin must pass {user}" })
      }
      args = [entry.script, user, message]
    } else {
      args = [entry.script, message]
    }
    const child = spawn("sh", args, {
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
