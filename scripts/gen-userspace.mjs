#!/usr/bin/env node
// Generates the userspace registries (server/src/userspace.gen.ts + app/src/userspace.gen.ts)
// from userspace/features/*/. Zero deps, deterministic, idempotent. Always writes both
// files — empty literals when userspace/ is absent (public clone builds w/ 0 modules).
// Import specifiers are `as string` so core tsc never follows into userspace TS.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const repo = join(dirname(fileURLToPath(import.meta.url)), "..")
const featuresDir = join(repo, "userspace", "features")

// dir names are agent-controllable and get interpolated into core TS — allowlist hard.
const SAFE_NAME = /^[A-Za-z0-9_-]+$/

const names = existsSync(featuresDir)
  ? readdirSync(featuresDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((n) => {
        if (SAFE_NAME.test(n)) return true
        console.warn(`gen-userspace: SKIPPING unsafe feature dir name ${JSON.stringify(n)}`)
        return false
      })
      .sort()
  : []

const serverNames = names.filter((n) => existsSync(join(featuresDir, n, "server.ts")))
const appNames = names.filter((n) => existsSync(join(featuresDir, n, "app.tsx")))

const list = (entries) => (entries.length === 0 ? "[]" : `[\n${entries.join(",\n")}\n]`)

const serverFile = `// AUTO-GENERATED — do not edit
import type { ServerCapability } from "@assistant/capabilities-server/server"

export const userspaceServer: ReadonlyArray<{
  readonly name: string
  readonly load: () => Promise<ReadonlyArray<ServerCapability>>
}> = ${list(
  serverNames.map(
    (n) =>
      `  {\n    name: ${JSON.stringify(n)},\n    load: () => import(${JSON.stringify(`../../userspace/features/${n}/server.js`)} as string).then((m) => m.default)\n  }`
  )
)}
`

const appFile = `// AUTO-GENERATED — do not edit
import type { AppCapability } from "@assistant/capabilities-ui/app"

export const userspaceApp: ReadonlyArray<{
  readonly name: string
  readonly load: () => ReadonlyArray<AppCapability>
}> = ${list(
  appNames.map(
    (n) =>
      `  {\n    name: ${JSON.stringify(n)},\n    load: () => require(${JSON.stringify(`../../userspace/features/${n}/app`)}).default\n  }`
  )
)}
`

const write = (rel, content) => {
  const file = join(repo, rel)
  mkdirSync(dirname(file), { recursive: true })
  if (existsSync(file) && readFileSync(file, "utf8") === content) return
  writeFileSync(file, content)
  console.log(`gen-userspace: wrote ${rel}`)
}

write("server/src/userspace.gen.ts", serverFile)
write("app/src/userspace.gen.ts", appFile)
