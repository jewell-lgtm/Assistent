import { PiClient, PiError, type PiRunOptions } from "@assistant/capabilities-server/pi"
import { rememberNote, searchVault } from "./vault.js"
import { Config, Effect, Layer } from "effect"
import { execFile } from "node:child_process"
import { constants as fsConstants, readFileSync } from "node:fs"
import * as fs from "node:fs/promises"
import { createRequire } from "node:module"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import {
  type AgentSessionEvent,
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
// bare repo the userspace history pushes to after every commit (bootstrap
// creates it; empty string disables). Lives on the appspace hostPath so it
// survives a userspace wipe — the disposability restore source.
const UserspaceRemote = Config.string("USERSPACE_REMOTE").pipe(Config.withDefault(""))

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
// and hard-aborts a run that blows past the cap, loud not silent. Factory
// takes an onTrip callback because session.abort() makes prompt() RESOLVE
// normally — without the callback the caller would report a capped run as a
// successful "done" and commit its truncated output (review finding 01:15 #1).
const runawayGuard =
  (onTrip: () => void): ExtensionFactory =>
  (pi) => {
    pi.on("turn_start", (event, ctx) => {
      if (event.turnIndex < RUNAWAY_TURN_CAP) return
      console.error(`[pi] runaway guard: aborting session after ${event.turnIndex} turns (cap ${RUNAWAY_TURN_CAP})`)
      onTrip()
      ctx.abort()
    })
  }

// ONE Pi engine slot process-wide. Coding runs (/api/system/code) and generic
// runs (/api/pi/run) share the same cwd, session storage dir, and provider
// auth — overlapping them is undefined behavior (review finding 01:15 #6).
// Tag records who holds the slot so release can't clobber a foreign owner.
let engineBusy: string | undefined
export const tryAcquireEngine = (tag: string): boolean => {
  if (engineBusy !== undefined) return false
  engineBusy = tag
  return true
}
export const releaseEngine = (tag: string) => {
  if (engineBusy === tag) engineBusy = undefined
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
const codingResourceLoader = async (root: string, onRunaway: () => void) => {
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: getAgentDir(),
    noContextFiles: true,
    noExtensions: true,
    appendSystemPrompt: [AUTHORING_GUIDE],
    extensionFactories: [runawayGuard(onRunaway)]
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

// Chat memory tools (tools:"chat"): let the assistant persist and recall notes
// in the Obsidian vault, scoped to the vault dir — no code editing, no bash.
const vaultTools = (root: string) =>
  [
    defineTool({
      name: "remember",
      label: "Remember",
      description: "Save a note to the user's Obsidian vault so it can be recalled later. Use when the user says to remember something.",
      promptSnippet: "save a note to the vault when asked to remember something",
      parameters: Type.Object({ note: Type.String({ description: "the fact to remember, phrased as a standalone note" }) }),
      async execute(_id, params) {
        const saved = await rememberNote(root, (params as { note: string }).note)
        return { content: [{ type: "text" as const, text: `Remembered: ${saved}` }], details: {} }
      }
    }),
    defineTool({
      name: "recall",
      label: "Recall",
      description: "Search the user's Obsidian vault (memories, journal, app pages) for anything matching a query. Use to answer 'remind me' / 'what did I' / 'do you remember' questions.",
      promptSnippet: "search the vault to answer questions about past notes, apps, or activity",
      parameters: Type.Object({ query: Type.String({ description: "keywords to search for" }) }),
      async execute(_id, params) {
        const hits = await searchVault(root, (params as { query: string }).query)
        const text =
          hits.length === 0
            ? "No matching notes in the vault."
            : hits.map((h) => `- (${h.file}) ${h.line}`).join("\n")
        return { content: [{ type: "text" as const, text }], details: {} }
      }
    })
  ] as NonNullable<CreateAgentSessionOptions["customTools"]>

const CHAT_SYSTEM_PROMPT = `You are the user's personal assistant inside a self-modifying app. You have a memory: an Obsidian vault of markdown notes.
- When the user tells you to remember something, call the "remember" tool.
- When the user asks what they told you, to remind them, or about apps/activity, call the "recall" tool first, then answer from what it returns.
- Keep replies short and direct.`

const chatResourceLoader = async (root: string, onRunaway: () => void) => {
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: getAgentDir(),
    noContextFiles: true,
    noExtensions: true,
    appendSystemPrompt: [CHAT_SYSTEM_PROMPT],
    extensionFactories: [runawayGuard(onRunaway)]
  })
  await loader.reload({ resolveProjectTrust: async () => false })
  return loader
}

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

// onEvent is the SSE bridge's hook (server/src/coding-runs.ts): the generic
// tools:"none" path (PiClientLive below) never passes it, so its behavior is
// unchanged — this param only matters to the async coding-run path.
export const runPi = async (
  env: { root: string; ollamaBaseUrl: string; defaultModel: string },
  options: PiRunOptions,
  onEvent?: (event: AgentSessionEvent) => void
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
  const chat = options.tools === "chat"
  // session.abort() makes the outstanding prompt() resolve normally (not
  // reject) — every abort path (timeout AND runaway guard) records its reason
  // here so an aborted run is reported as a failure, never as a successful
  // "done" with truncated output.
  let abortReason: string | undefined
  const onRunaway = () => {
    abortReason = `run aborted by runaway guard at ${RUNAWAY_TURN_CAP} turns`
  }
  const { session } = await createAgentSession({
    cwd: env.root,
    model,
    tools: coding ? ["read", "edit", "write", "grep", "find", "ls", "typecheck"] : chat ? ["remember", "recall"] : [],
    ...(coding
      ? {
          customTools: [...guardedTools(env.root), typecheckTool],
          resourceLoader: await codingResourceLoader(env.root, onRunaway)
        }
      : chat
        ? {
            customTools: vaultTools(env.root),
            resourceLoader: await chatResourceLoader(env.root, onRunaway)
          }
        : {}),
    sessionManager: SessionManager.create(env.root, piSessionDir())
  })
  const unsubscribe = onEvent !== undefined ? session.subscribe(onEvent) : undefined
  const killer = setTimeout(() => {
    abortReason = `run exceeded ${RUN_TIMEOUT_MS}ms timeout and was aborted`
    void session.abort()
  }, RUN_TIMEOUT_MS)
  try {
    await session.prompt(options.prompt)
    if (abortReason !== undefined) throw new Error(abortReason)
    return {
      text: lastAssistantText(session.state.messages),
      model: `${model.provider}/${model.id}`
    }
  } finally {
    clearTimeout(killer)
    unsubscribe?.()
    session.dispose()
  }
}

/** Same env triple runPi() takes, resolved from Config — shared by PiClientLive and the async coding-run path (coding-runs.ts). */
export const codingEnv = Effect.all({
  root: UserspaceDir,
  ollamaBaseUrl: OllamaBaseUrl,
  defaultModel: DefaultCodeModel
})

export const PiClientLive = Layer.effect(
  PiClient,
  Effect.gen(function* () {
    const root = yield* UserspaceDir
    const ollamaBaseUrl = yield* OllamaBaseUrl
    const defaultModel = yield* DefaultCodeModel
    // single-flight via the PROCESS-WIDE engine slot (shared with the async
    // coding path in coding-runs.ts) — a coding run and a generic run must
    // never overlap: same cwd, same session dir, same provider auth.
    return {
      run: (options: PiRunOptions) =>
        Effect.acquireUseRelease(
          Effect.suspend(() =>
            tryAcquireEngine("generic") ? Effect.void : Effect.fail(new PiError({ message: "busy" }))
          ),
          () =>
            Effect.tryPromise({
              try: () => runPi({ root, ollamaBaseUrl, defaultModel }, options),
              catch: (e) => new PiError({ message: String(e) })
            }),
          () => Effect.sync(() => releaseEngine("generic"))
        )
    }
  })
)

/**
 * Demo/PoC total reset: erase EVERYTHING the assistant has built or remembered
 * — the full userspace contents (features, config, vault, data, its git
 * history) and the engine's session archive. The caller then exits the
 * process; the container restart re-runs bootstrap-userspace + registry
 * regen, so the system rebuilds its skeleton from appspace alone.
 */
export const resetAllState = Effect.gen(function* () {
  const root = yield* UserspaceDir
  const remote = yield* UserspaceRemote
  yield* Effect.tryPromise({
    try: async () => {
      for (const entry of await fs.readdir(root)) {
        await fs.rm(path.join(root, entry), { recursive: true, force: true })
      }
      // the bare remote must die too — otherwise the next boot's bootstrap
      // faithfully restores everything we just erased (reset would no-op)
      if (remote !== "") {
        await fs.rm(remote, { recursive: true, force: true }).catch(() => {})
      }
      await fs.rm(piSessionDir(), { recursive: true, force: true }).catch(() => {})
    },
    catch: (e) => new PiError({ message: `reset failed: ${String(e)}` })
  })
})

/**
 * A failed run must not leave partial edits in the hot-mounted working tree:
 * they'd be live-served immediately AND silently swept into the next run's
 * `git add -A` commit (review finding 01:15 #2). Stash them (with untracked
 * files; vault/ is tracked now so a failed run's vault writes stash with the
 * rest — recoverable, not lost) — via `git stash list` rather than
 * hard-discarded. Returns true if residue existed.
 */
export const stashUserspaceResidue = (label: string) =>
  Effect.gen(function* () {
    const root = yield* UserspaceDir
    return yield* Effect.tryPromise({
      try: async () => {
        const git = (...args: Array<string>) =>
          execFileP("git", ["-C", root, "-c", "user.name=assistant", "-c", "user.email=assistant@local", ...args])
        const { stdout: status } = await git("status", "--porcelain")
        if (status.trim() === "") return false
        await git("stash", "push", "--include-untracked", "-m", `failed-run residue: ${label.slice(0, 120)}`)
        return true
      },
      catch: (e) => new PiError({ message: `failed-run residue stash failed: ${String(e)}` })
    })
  })

/** Feature names touched by a userspace commit (for vault app pages). */
export const changedFeatures = (sha: string) =>
  Effect.gen(function* () {
    const root = yield* UserspaceDir
    return yield* Effect.tryPromise({
      try: async () => {
        const { stdout } = await execFileP("git", ["-C", root, "show", "--name-only", "--format=", sha])
        const names = new Set<string>()
        for (const line of stdout.split("\n")) {
          const m = line.match(/^features\/([^/]+)\//)
          if (m !== null) names.add(m[1]!)
        }
        return [...names]
      },
      catch: () => new PiError({ message: "changedFeatures failed" })
    }).pipe(Effect.orElseSucceed(() => [] as Array<string>))
  })

/** Commit whatever the agent changed in the userspace repo, then push to the
 * bare remote (best-effort: a push failure is logged, never fails the commit —
 * the local history is still the working truth, the remote is durability). */
export const commitUserspace = (message: string) =>
  Effect.gen(function* () {
    const root = yield* UserspaceDir
    const remote = yield* UserspaceRemote
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
        if (remote !== "") {
          await git("push", remote, "HEAD:main").catch((e: unknown) => {
            console.error(`userspace push to ${remote} failed: ${String(e)}`)
          })
        }
        return sha.trim()
      },
      catch: (e) => new PiError({ message: `userspace commit failed: ${String(e)}` })
    })
  })

/** Periodic vault sweep: chat memories / feature-runtime vault writes happen
 * outside coding runs — commit (and thus push) them on an interval so "all
 * userspace files live in git" holds without per-write commit spam. Skipped
 * while the engine is held: a sweep mid-coding-run would commit the agent's
 * half-written files under a "vault sweep" message. */
export const vaultSweep = Effect.suspend(() =>
  engineBusy !== undefined
    ? Effect.void
    : commitUserspace("vault sweep").pipe(
        Effect.asVoid,
        Effect.catchAll((e) => Effect.logWarning(`vault sweep: ${e.message}`))
      )
)
