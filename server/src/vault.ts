import * as fs from "node:fs/promises"
import * as path from "node:path"

// The Obsidian vault: markdown notes the assistant keeps under userspace/vault.
// Structure:
//   vault/journal/YYYY-MM-DD.md   append-only log of everything (builds, memories)
//   vault/apps/<name>.md          a page per created app
//   vault/memories.md             freeform "remember this" notes
// Wiped by Reset along with the rest of userspace (fresh-start semantics).

const vaultRoot = (root: string) => path.join(root, "vault")

const pad = (n: number) => String(n).padStart(2, "0")
const dayName = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`

const appendFile = async (file: string, header: string, line: string) => {
  await fs.mkdir(path.dirname(file), { recursive: true })
  let existing = ""
  try {
    existing = await fs.readFile(file, "utf8")
  } catch {
    /* new file */
  }
  const body = existing === "" ? header + line : existing + line
  await fs.writeFile(file, body, "utf8")
}

/** Append a timestamped entry to today's journal note. Best-effort; never throws. */
export const journal = async (root: string, kind: string, text: string): Promise<void> => {
  try {
    const d = new Date()
    const file = path.join(vaultRoot(root), "journal", `${dayName(d)}.md`)
    await appendFile(file, `# Journal ${dayName(d)}\n\n`, `- ${hhmm(d)} **${kind}** ${text}\n`)
  } catch (e) {
    console.error(`[vault] journal failed: ${String(e)}`)
  }
}

/** Create or refresh the vault page for an app. Best-effort; never throws. */
export const upsertAppPage = async (
  root: string,
  name: string,
  opts: { readonly prompt?: string | undefined; readonly commit?: string | undefined }
): Promise<void> => {
  try {
    const d = new Date()
    const file = path.join(vaultRoot(root), "apps", `${name}.md`)
    let existing = ""
    try {
      existing = await fs.readFile(file, "utf8")
    } catch {
      /* new page */
    }
    await fs.mkdir(path.dirname(file), { recursive: true })
    if (existing === "") {
      const lines = [
        `# ${name}`,
        "",
        `Created ${dayName(d)} ${hhmm(d)}.`,
        "",
        ...(opts.prompt ? [`**Asked for:** ${opts.prompt}`, ""] : []),
        "## History",
        `- ${dayName(d)} ${hhmm(d)} created${opts.commit ? ` (${opts.commit})` : ""}`,
        ""
      ]
      await fs.writeFile(file, lines.join("\n"), "utf8")
    } else {
      // append a history bullet under the existing page
      await fs.writeFile(
        file,
        `${existing.replace(/\n*$/, "\n")}- ${dayName(d)} ${hhmm(d)} updated${opts.commit ? ` (${opts.commit})` : ""}\n`,
        "utf8"
      )
    }
  } catch (e) {
    console.error(`[vault] app page failed: ${String(e)}`)
  }
}

/** Append a freeform memory. Returns the note text on success. */
export const rememberNote = async (root: string, note: string): Promise<string> => {
  const d = new Date()
  const file = path.join(vaultRoot(root), "memories.md")
  await appendFile(file, `# Memories\n\n`, `- ${dayName(d)} ${hhmm(d)} — ${note.trim()}\n`)
  await journal(root, "memory", note.trim())
  return note.trim()
}

interface VaultHit {
  readonly file: string
  readonly line: string
}

const STOPWORDS = new Set([
  "the","a","an","and","or","but","is","are","was","were","be","been","to","of","in","on","at","for","with","my","me","i","you","your","what","did","do","does","tell","remind","remember","about","that","this","it","was","have","has"
])

const terms = (query: string): ReadonlyArray<string> =>
  [...new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter((w) => w.length >= 3 && !STOPWORDS.has(w))

/**
 * Word-ranked search over every markdown note in the vault. Splits the query
 * into meaningful terms (drops stopwords) and returns lines matching ANY term,
 * ranked by how many distinct terms they contain — so "remind me what my
 * favourite sandwich is" finds "favourite sandwich is a BLT" even though no
 * substring of the question appears verbatim. Plain JS (no rg dependency).
 */
export const searchVault = async (root: string, query: string, cap = 20): Promise<ReadonlyArray<VaultHit>> => {
  const dir = vaultRoot(root)
  const words = terms(query)
  if (words.length === 0) return []
  const scored: Array<{ hit: VaultHit; score: number }> = []
  const walk = async (d: string): Promise<void> => {
    let entries: Array<import("node:fs").Dirent> = []
    try {
      entries = await fs.readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.name.endsWith(".md")) {
        let content = ""
        try {
          content = await fs.readFile(full, "utf8")
        } catch {
          continue
        }
        for (const raw of content.split("\n")) {
          const line = raw.toLowerCase()
          const score = words.reduce((n, w) => (line.includes(w) ? n + 1 : n), 0)
          if (score > 0) scored.push({ hit: { file: path.relative(dir, full), line: raw.trim() }, score })
        }
      }
    }
  }
  await walk(dir)
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, cap)
    .map((s) => s.hit)
}
