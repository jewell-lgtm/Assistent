import { PiClient, PiError, type PiRunOptions } from "@assistant/capabilities-server/pi"
import { Config, Effect, Layer } from "effect"
import { execFile } from "node:child_process"
import { constants as fsConstants, readFileSync } from "node:fs"
import * as fs from "node:fs/promises"
import { createRequire } from "node:module"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import {
  AuthStorage,
  createAgentSession,
  type CreateAgentSessionOptions,
  createEditToolDefinition,
  createWriteToolDefinition,
  DefaultResourceLoader,
  defineTool,
  type ExtensionFactory,
  getAgentDir,
  ModelRegistry,
  SessionManager
} from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"

const execFileP = promisify(execFile)
const require = createRequire(import.meta.url)

// Injected into every coding-mode run's system prompt via the resource
// loader's appendSystemPrompt (real channel, not string-concat into the user
// prompt). Static file baked into the image — read once at module init.
const AUTHORING_GUIDE = readFileSync(new URL("./authoring-guide.md", import.meta.url), "utf8")

const UserspaceDir = Config.string("USERSPACE_DIR").pipe(Config.withDefault("/repo/userspace"))
const OllamaBaseUrl = Config.string("OLLAMA_BASE_URL").pipe(
  Config.withDefault("http://host.orb.internal:11434/v1")
)
const DefaultCodeModel = Config.string("CODE_MODEL").pipe(Config.withDefault("gpt-5.5"))

const RUN_TIMEOUT_MS = 15 * 60 * 1000

// SDK has no native turn cap (verified: no maxTurns/maxSteps anywhere in the type
// defs) — a stuck tool-call loop runs forever unless something else kills it.
// "Unlimited genesis iterations" means unlimited PROMPTS, not one unbounded run.
const RUNAWAY_TURN_CAP = 100

// Routing policy: default = subscription engine, private = never leaves the LAN.
const PROVIDERS = { default: "openai-codex", private: "ollama" } as const

// The write-surface boundary (replaces codex's workspace-write sandbox):
// edit/write tools get operations that refuse any path outside userspace.
// Reads stay unrestricted — same semantics the codex sandbox had. No bash.
const confine = (root: string, p: string) => {
  const resolved = path.resolve(root, p)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`refused: ${p} is outside the userspace write surface`)
  }
  return resolved
}

const guardedTools = (root: string) =>
  [
    createEditToolDefinition(root, {
      operations: {
        readFile: (p) => fs.readFile(confine(root, p)),
        writeFile: (p, content) => fs.writeFile(confine(root, p), content, "utf8"),
        access: (p) => fs.access(confine(root, p), fsConstants.R_OK | fsConstants.W_OK)
      }
    }),
    createWriteToolDefinition(root, {
      operations: {
        writeFile: async (p, content) => {
          const target = confine(root, p)
          await fs.mkdir(path.dirname(target), { recursive: true })
          await fs.writeFile(target, content, "utf8")
        },
        mkdir: async (d) => {
          await fs.mkdir(confine(root, d), { recursive: true })
        }
      }
    })
  ] as NonNullable<CreateAgentSessionOptions["customTools"]>

// Inline extension (not disk-loaded, so it runs regardless of the forced
// untrusted-project state above): counts turns via the real turn_start event
// and hard-aborts a run that blows past the cap, loud not silent.
const runawayGuardExtension: ExtensionFactory = (pi) => {
  pi.on("turn_start", (event, ctx) => {
    if (event.turnIndex < RUNAWAY_TURN_CAP) return
    console.error(`[pi] runaway guard: aborting session after ${event.turnIndex} turns (cap ${RUNAWAY_TURN_CAP})`)
    ctx.abort()
  })
}

// Real system-prompt channel (resourceLoader.appendSystemPrompt), not string-
// concat into the user prompt — additive, so it rides alongside the SDK's
// default framing (tool list + guidelines + pi-docs pointers) instead of
// replacing it. `systemPromptOverride`/`systemPrompt` (customPrompt) was
// considered and rejected: system-prompt.js's customPrompt branch skips the
// entire default framing block, including the "Available tools" list that
// promptSnippet/promptGuidelines below rely on to be visible at all — using
// it would silently blind the model to its own tool list for zero extra
// security (appendSystemPrompt is already immune to hijack, see below).
//
// `root` is also where the guarded write tool writes, so a prior coding run
// could have planted files there to hijack the *next* run. Four vectors,
// four closes:
//  - userspace/AGENTS.md or CLAUDE.md: loadProjectContextFiles walks cwd up
//    to fs root and is NOT trust-gated — noContextFiles is the only thing
//    that stops it (resource-loader.js: `noContextFiles ? [] : loadProjectContextFiles(...)`).
//  - userspace/.pi/extensions/*.{js,ts}: gated by trust at the source
//    (package-manager.js: `if (projectTrusted) addResources("extensions", ...)`)
//    so resolveProjectTrust:false already excludes them; noExtensions is a
//    second, independent floor — it hard-clamps the loader's own extension
//    path list to CLI-supplied paths only (none here), regardless of what
//    the package manager resolved. Neither touches extensionFactories
//    (inline, programmatic, always loaded) so runawayGuardExtension is unaffected.
//  - userspace/.pi/SYSTEM.md: discoverSystemPromptFile() only returns the
//    project path `if (settingsManager.isProjectTrusted() && existsSync(...))`
//    — closed by resolveProjectTrust:false. Not touched by noContextFiles/
//    noExtensions at all.
//  - userspace/.pi/APPEND_SYSTEM.md: same isProjectTrusted() gate in
//    discoverAppendSystemPromptFile(), AND moot regardless — passing an
//    explicit appendSystemPrompt source short-circuits discovery entirely
//    (`this.appendSystemPromptSource ?? discoverAppendSystemPromptFile()`).
// SettingsManager.create() defaults projectTrusted:true, so resolveProjectTrust
// stays required (belt-and-braces per pi-tuning.md #6) even with noContextFiles
// + noExtensions set — it's the only thing closing the SYSTEM.md vector.
const codingResourceLoader = async (root: string) => {
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: getAgentDir(),
    noContextFiles: true,
    noExtensions: true,
    appendSystemPrompt: [AUTHORING_GUIDE],
    extensionFactories: [runawayGuardExtension]
  })
  await loader.reload({ resolveProjectTrust: async () => false })
  return loader
}

// Same tsc config the redeploy gate runs (scripts/uscheck/server.json), invoked
// in-process so Pi can self-verify during a genesis run instead of only finding
// out at redeploy. `typescript` must be a real (not dev-only) dependency of
// @assistant/server for this to resolve in the pruned prod image — see report.
const USCHECK_SERVER_CONFIG = fileURLToPath(new URL("../../scripts/uscheck/server.json", import.meta.url))

const typecheckTool = defineTool({
  name: "typecheck",
  label: "Typecheck",
  description:
    "Typecheck all userspace features with the same tsc config the deploy gate runs. Returns tsc's error output, or 'no errors' when clean.",
  promptSnippet: "typecheck userspace feature code before finishing (same check the deploy gate runs)",
  promptGuidelines: [
    "Run typecheck after writing or editing a feature's server.ts/shared.ts and fix every reported error before ending your turn."
  ],
  parameters: Type.Object({}),
  async execute() {
    try {
      await execFileP(process.execPath, [require.resolve("typescript/bin/tsc"), "--noEmit", "-p", USCHECK_SERVER_CONFIG])
      return { content: [{ type: "text" as const, text: "no errors" }], details: {} }
    } catch (e) {
      const { stdout, stderr } = e as { stdout?: string; stderr?: string }
      const output = [stdout, stderr].filter((s) => s && s.trim().length > 0).join("\n").trim()
      return { content: [{ type: "text" as const, text: output || String(e) }], details: {} }
    }
  }
})

// Durable session storage on the rw /pi-agent mount (PI_CODING_AGENT_DIR), NOT
// userspace — session JSONL is engine bookkeeping, not feature data. getAgentDir()
// falls back to ~/.pi/agent when PI_CODING_AGENT_DIR is unset (local dev), so this
// resolves fine either way; SessionManager.create() mkdir's it if missing.
const piSessionDir = () => path.join(getAgentDir(), "sessions")

const lastAssistantText = (messages: ReadonlyArray<any>): string => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== "assistant") continue
    if (typeof m.content === "string") return m.content
    if (Array.isArray(m.content)) {
      return m.content
        .filter((c: any) => c?.type === "text")
        .map((c: any) => c.text)
        .join("\n")
    }
  }
  return ""
}

const runPi = async (
  env: { root: string; ollamaBaseUrl: string; defaultModel: string },
  options: PiRunOptions
) => {
  const routing = options.routing ?? "default"
  const provider = PROVIDERS[routing]
  const registry = ModelRegistry.create(AuthStorage.create())
  const wantedId = options.model ?? (routing === "default" ? env.defaultModel : undefined)
  let model =
    (wantedId !== undefined ? registry.find(provider, wantedId) : undefined) ??
    registry.getAvailable().find((m) => m.provider === provider)
  if (model === undefined) throw new Error(`no model available for provider ${provider}`)
  if (provider === "ollama") model = { ...model, baseUrl: env.ollamaBaseUrl }

  const coding = options.tools === "coding"
  const { session } = await createAgentSession({
    cwd: env.root,
    model,
    tools: coding ? ["read", "edit", "write", "grep", "find", "ls", "typecheck"] : [],
    ...(coding
      ? {
          customTools: [...guardedTools(env.root), typecheckTool],
          resourceLoader: await codingResourceLoader(env.root)
        }
      : {}),
    sessionManager: SessionManager.create(env.root, piSessionDir())
  })
  const killer = setTimeout(() => void session.abort(), RUN_TIMEOUT_MS)
  try {
    await session.prompt(options.prompt)
    return {
      text: lastAssistantText(session.state.messages),
      model: `${model.provider}/${model.id}`
    }
  } finally {
    clearTimeout(killer)
    session.dispose()
  }
}

export const PiClientLive = Layer.effect(
  PiClient,
  Effect.gen(function* () {
    const root = yield* UserspaceDir
    const ollamaBaseUrl = yield* OllamaBaseUrl
    const defaultModel = yield* DefaultCodeModel
    // single-flight: one run at a time, mirrors opsd's old busy semantics
    let busy = false
    return {
      run: (options: PiRunOptions) =>
        Effect.acquireUseRelease(
          Effect.suspend(() =>
            busy
              ? Effect.fail(new PiError({ message: "busy" }))
              : Effect.sync(() => {
                  busy = true
                })
          ),
          () =>
            Effect.tryPromise({
              try: () => runPi({ root, ollamaBaseUrl, defaultModel }, options),
              catch: (e) => new PiError({ message: String(e) })
            }),
          () => Effect.sync(() => (busy = false))
        )
    }
  })
)

/** Commit whatever the agent changed in the userspace repo. */
export const commitUserspace = (message: string) =>
  Effect.gen(function* () {
    const root = yield* UserspaceDir
    return yield* Effect.tryPromise({
      try: async () => {
        // pod has no gitconfig — identity inline, not baked into the image
        const git = (...args: Array<string>) =>
          execFileP("git", ["-C", root, "-c", "user.name=assistant", "-c", "user.email=assistant@local", ...args])
        const { stdout: status } = await git("status", "--porcelain")
        if (status.trim() === "") return undefined
        await git("add", "-A")
        await git("commit", "-m", `self-mod: ${message.slice(0, 72)}`)
        const { stdout: sha } = await git("rev-parse", "--short", "HEAD")
        return sha.trim()
      },
      catch: (e) => new PiError({ message: `userspace commit failed: ${String(e)}` })
    })
  })
