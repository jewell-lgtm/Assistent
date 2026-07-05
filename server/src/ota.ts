import { FileSystem, HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Config, Effect } from "effect"
import { createHash } from "node:crypto"
import * as path from "node:path"

// Minimal expo-updates protocol v1 server (JSON manifest responses).
// Updates dir layout: $UPDATES_DIR/<runtimeVersion>/<timestamp>/  = raw `expo export` output.

const UpdatesDir = Config.string("UPDATES_DIR").pipe(Config.withDefault("/data/updates"))

const sha256 = (buf: Uint8Array, encoding: "hex" | "base64url") =>
  createHash("sha256").update(buf).digest(encoding)

// deterministic UUID from update dir identity — same update always same id
const updateUuid = (runtimeVersion: string, timestamp: string) => {
  const h = createHash("sha256").update(`${runtimeVersion}/${timestamp}`).digest("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

const MIME: Record<string, string> = {
  hbc: "application/javascript",
  js: "application/javascript",
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  ttf: "font/ttf",
  otf: "font/otf",
  json: "application/json"
}

interface ExportMetadata {
  fileMetadata: {
    android?: { bundle: string; assets: ReadonlyArray<{ path: string; ext: string }> }
  }
}

const newestUpdate = (runtimeVersion: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const base = yield* UpdatesDir
    const rvDir = path.join(base, runtimeVersion)
    const entries = yield* fs.readDirectory(rvDir)
    const timestamps = entries.filter((e) => /^\d+$/.test(e)).sort()
    const newest = timestamps[timestamps.length - 1]
    if (newest === undefined) return undefined
    return { dir: path.join(rvDir, newest), timestamp: newest }
  })

const assetUrl = (
  origin: string,
  runtimeVersion: string,
  timestamp: string,
  filePath: string
) =>
  `${origin}/ota/assets?rv=${encodeURIComponent(runtimeVersion)}&ts=${encodeURIComponent(timestamp)}&path=${encodeURIComponent(filePath)}`

// Asset URLs are generated from the REQUEST's origin. Behind Caddy the server
// sees plain http, so trust X-Forwarded-Proto (Caddy sets it) — otherwise the
// manifest hands the phone http:// asset URLs whose downloads fail and the
// update never applies. Direct LAN access (no proxy header) stays http.
const requestOrigin = (req: HttpServerRequest.HttpServerRequest) => {
  const host = req.headers["host"] ?? "localhost"
  const proto = req.headers["x-forwarded-proto"] ?? "http"
  return `${proto}://${host}`
}

export const manifestHandler = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest
  const fs = yield* FileSystem.FileSystem

  const platform = req.headers["expo-platform"]
  const runtimeVersion = req.headers["expo-runtime-version"]
  if (platform !== "android" || runtimeVersion === undefined || Array.isArray(runtimeVersion)) {
    return yield* HttpServerResponse.json({ error: "unsupported platform/runtime" }, { status: 400 })
  }

  const update = yield* newestUpdate(runtimeVersion).pipe(Effect.orElseSucceed(() => undefined))
  if (update === undefined) {
    return yield* HttpServerResponse.json({ error: "no update for runtime" }, { status: 404 })
  }

  const metaRaw = yield* fs.readFileString(path.join(update.dir, "metadata.json"))
  const meta = JSON.parse(metaRaw) as ExportMetadata
  const android = meta.fileMetadata.android
  if (android === undefined) {
    return yield* HttpServerResponse.json({ error: "no android bundle in update" }, { status: 500 })
  }

  const origin = requestOrigin(req)
  const stat = yield* fs.stat(update.dir)
  const createdAt = (stat.mtime._tag === "Some" ? stat.mtime.value : new Date()).toISOString()

  const hashOf = (rel: string) =>
    Effect.map(fs.readFile(path.join(update.dir, rel)), (buf) => ({
      hash: sha256(buf, "base64url"),
      key: sha256(buf, "hex").slice(0, 32)
    }))

  // publish scripts drop `expo config --type public` next to the export —
  // without extra.expoClient, OTA-launched apps get Constants.expoConfig=null
  // and the apiToken reads go empty (401s everywhere).
  const expoClient = yield* fs.readFileString(path.join(update.dir, "expoConfig.json")).pipe(
    Effect.map((raw) => JSON.parse(raw) as unknown),
    Effect.orElseSucceed(() => undefined)
  )

  const bundle = yield* hashOf(android.bundle)
  const assets = yield* Effect.forEach(android.assets, (a) =>
    Effect.map(hashOf(a.path), (h) => ({
      hash: h.hash,
      key: h.key,
      contentType: MIME[a.ext] ?? "application/octet-stream",
      fileExtension: `.${a.ext}`,
      url: assetUrl(origin, runtimeVersion, update.timestamp, a.path)
    }))
  )

  const manifest = {
    id: updateUuid(runtimeVersion, update.timestamp),
    createdAt,
    runtimeVersion,
    launchAsset: {
      hash: bundle.hash,
      key: bundle.key,
      contentType: "application/javascript",
      fileExtension: ".bundle",
      url: assetUrl(origin, runtimeVersion, update.timestamp, android.bundle)
    },
    assets,
    metadata: {},
    extra: expoClient === undefined ? {} : { expoClient }
  }

  return yield* HttpServerResponse.json(manifest, {
    headers: {
      "expo-protocol-version": "1",
      "expo-sfv-version": "0",
      "cache-control": "private, max-age=0"
    }
  })
})

export const assetHandler = Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest
  const fs = yield* FileSystem.FileSystem
  const base = yield* UpdatesDir

  const url = new URL(req.url, "http://x")
  const rv = url.searchParams.get("rv")
  const ts = url.searchParams.get("ts")
  const rel = url.searchParams.get("path")
  if (rv === null || ts === null || rel === null) {
    return yield* HttpServerResponse.json({ error: "missing params" }, { status: 400 })
  }
  const full = path.resolve(base, rv, ts, rel)
  if (!full.startsWith(path.resolve(base) + path.sep)) {
    return yield* HttpServerResponse.json({ error: "bad path" }, { status: 400 })
  }
  const exists = yield* fs.exists(full).pipe(Effect.orElseSucceed(() => false))
  if (!exists) {
    return yield* HttpServerResponse.json({ error: "not found" }, { status: 404 })
  }
  const ext = full.split(".").pop() ?? ""
  return yield* HttpServerResponse.file(full, {
    headers: {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "cache-control": "public, max-age=31536000, immutable"
    }
  })
})

export const otaRoutes = <E, R>(router: HttpRouter.HttpRouter<E, R>) =>
  router.pipe(
    HttpRouter.get("/ota/api/manifest", manifestHandler),
    HttpRouter.get("/ota/assets", assetHandler)
  )
