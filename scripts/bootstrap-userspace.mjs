#!/usr/bin/env node
// Appspace-owned userspace bootstrap. Idempotently recreates the userspace
// skeleton when it's missing, so `rm -rf userspace && <boot>` fully restores a
// working, writable, self-mod-ready surface — now from the bare REMOTE when
// one exists (full history restore), else from nothing (fresh skeleton). Runs
// at pod boot (Dockerfile CMD) before gen-userspace + server start; a no-op on
// an already-populated userspace (every step checks-before-writing, never
// clobbers Pi's work — except .gitignore, which is appspace-owned policy).
//
// What it guarantees exists:
//  - the userspace dir itself (the /repo/userspace hostPath, symlinked to
//    ./userspace in the image) + an empty features/ dir
//  - package.json {type:"module"} — WITHOUT this, tsx/esbuild transforms
//    userspace files as CJS while core is ESM, splitting the @effect/platform
//    module instance so features load but every route 404s (the bug that bit
//    the AC10 deploy). This file is load-bearing, not cosmetic.
//  - .gitignore (node_modules, data/) — vault/ IS committed now ("all
//    userspace files live in git"); data/ only shields legacy store.json
//    residue (KV moved to the appspace sqlite db)
//  - a git repo with an initial commit — commitUserspace() does `git -C
//    <userspace> commit` after every self-mod, which needs a real repo + HEAD
//  - when USERSPACE_REMOTE is set: the bare remote repo itself (created
//    empty on first boot), and a restore-from-remote when the local checkout
//    has no history — the disposability drill's restore source
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

// The REAL mount path, matching the server's default (code.ts/system.ts default
// USERSPACE_DIR to /repo/userspace). Deliberately NOT the image's ./userspace
// symlink: after a wipe that symlink dangles, and mkdir through a dangling
// symlink is a silent no-op (EEXIST swallowed by recursive:true) — the target
// would never get created. Writing the real path creates the actual mounted dir.
const root = process.env.USERSPACE_DIR ?? "/repo/userspace"
const remote = process.env.USERSPACE_REMOTE ?? ""

// pod has no gitconfig — identity inline, same pattern commitUserspace uses.
const git = (...args) =>
  execFileSync("git", ["-C", root, "-c", "user.name=assistant", "-c", "user.email=assistant@local", ...args], {
    stdio: "pipe"
  })

const ensureDir = (p) => {
  if (!existsSync(p)) {
    mkdirSync(p, { recursive: true })
    console.log(`bootstrap-userspace: created ${p}`)
  }
}

const ensureFile = (rel, content) => {
  const file = join(root, rel)
  if (existsSync(file)) return
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
  console.log(`bootstrap-userspace: wrote ${rel}`)
}

// ---- bare remote: create if configured but missing ------------------------
if (remote !== "" && !existsSync(remote)) {
  mkdirSync(dirname(remote), { recursive: true })
  execFileSync("git", ["init", "--bare", "-b", "main", remote], { stdio: "pipe" })
  console.log(`bootstrap-userspace: created bare remote ${remote}`)
}

const remoteHasCommits = () => {
  if (remote === "" || !existsSync(remote)) return false
  try {
    return execFileSync("git", ["ls-remote", remote, "HEAD"], { stdio: "pipe" }).toString().trim() !== ""
  } catch {
    return false
  }
}

// ---- restore from remote when the local checkout has no history -----------
// fetch+reset instead of clone: root may already exist (hostPath dir, or a
// partially-bootstrapped skeleton) and clone refuses non-empty dirs.
ensureDir(root)
if (!existsSync(join(root, ".git")) && remoteHasCommits()) {
  git("init", "-b", "main")
  git("fetch", remote, "main")
  git("reset", "--hard", "FETCH_HEAD")
  console.log(`bootstrap-userspace: restored userspace from ${remote}`)
}

// ---- skeleton (fills gaps; no-op on a populated userspace) -----------------
ensureDir(join(root, "features"))
ensureFile("package.json", `${JSON.stringify({ name: "userspace", private: true, type: "module" }, null, 2)}\n`)

// .gitignore is appspace POLICY, not Pi's work — overwrite when stale so the
// vault/ un-ignore reaches existing deployments (ensureFile would skip it).
const GITIGNORE = "node_modules\ndata/\n"
const gitignorePath = join(root, ".gitignore")
if (!existsSync(gitignorePath) || readFileSync(gitignorePath, "utf8") !== GITIGNORE) {
  writeFileSync(gitignorePath, GITIGNORE)
  console.log("bootstrap-userspace: wrote .gitignore (vault/ tracked)")
}

if (!existsSync(join(root, ".git"))) {
  git("init", "-b", "main")
  git("add", "-A")
  git("commit", "-m", "bootstrap: initialize userspace skeleton")
  console.log(`bootstrap-userspace: git-initialized ${root}`)
  if (remote !== "" && existsSync(remote)) {
    try {
      git("push", remote, "HEAD:main")
      console.log(`bootstrap-userspace: pushed initial commit to ${remote}`)
    } catch (e) {
      console.error(`bootstrap-userspace: initial push failed: ${String(e)}`)
    }
  }
}
