import { PiClient, PiError, type PiRunOptions } from "@assistant/capabilities-server/pi"
import { Config, Effect, Layer } from "effect"
import { execFile } from "node:child_process"
import { constants as fsConstants } from "node:fs"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { promisify } from "node:util"
import {
  AuthStorage,
  createAgentSession,
  type CreateAgentSessionOptions,
  createEditToolDefinition,
  createWriteToolDefinition,
  ModelRegistry,
  SessionManager
} from "@earendil-works/pi-coding-agent"

const execFileP = promisify(execFile)

const UserspaceDir = Config.string("USERSPACE_DIR").pipe(Config.withDefault("/repo/userspace"))
const OllamaBaseUrl = Config.string("OLLAMA_BASE_URL").pipe(
  Config.withDefault("http://host.orb.internal:11434/v1")
)
const DefaultCodeModel = Config.string("CODE_MODEL").pipe(Config.withDefault("gpt-5.5"))

const RUN_TIMEOUT_MS = 15 * 60 * 1000

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
    tools: coding ? ["read", "edit", "write", "grep", "find", "ls"] : [],
    ...(coding ? { customTools: guardedTools(env.root) } : {}),
    sessionManager: SessionManager.inMemory(env.root)
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
        const git = (...args: Array<string>) => execFileP("git", ["-C", root, ...args])
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
