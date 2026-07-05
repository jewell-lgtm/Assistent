#!/usr/bin/env node
// Appspace-owned userspace bootstrap. Idempotently recreates the userspace
// skeleton when it's missing, so `rm -rf userspace && <boot>` fully restores a
// working, writable, self-mod-ready surface from NOTHING — the "userspace is
// reconstructible from appspace alone" thesis. Runs at pod boot (Dockerfile
// CMD) before gen-userspace + server start; a no-op on an already-populated
// userspace (every step checks-before-writing, never clobbers Pi's work).
//
// What it guarantees exists:
//  - the userspace dir itself (the /repo/userspace hostPath, symlinked to
//    ./userspace in the image) + an empty features/ dir
//  - package.json {type:"module"} — WITHOUT this, tsx/esbuild transforms
//    userspace files as CJS while core is ESM, splitting the @effect/platform
//    module instance so features load but every route 404s (the bug that bit
//    the AC10 deploy). This file is load-bearing, not cosmetic.
//  - .gitignore (node_modules, data/, vault/) — data/ is the persistence
//    backing store, vault/ is durable feature output; neither is committed
//  - a git repo with an initial commit — commitUserspace() does `git -C
//    <userspace> commit` after every self-mod, which needs a real repo + HEAD
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

// The REAL mount path, matching the server's default (code.ts/system.ts default
// USERSPACE_DIR to /repo/userspace). Deliberately NOT the image's ./userspace
// symlink: after a wipe that symlink dangles, and mkdir through a dangling
// symlink is a silent no-op (EEXIST swallowed by recursive:true) — the target
// would never get created. Writing the real path creates the actual mounted dir.
const root = process.env.USERSPACE_DIR ?? "/repo/userspace"

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

ensureDir(root)
ensureDir(join(root, "features"))
ensureFile("package.json", `${JSON.stringify({ name: "userspace", private: true, type: "module" }, null, 2)}\n`)
ensureFile(".gitignore", "node_modules\ndata/\nvault/\n")

if (!existsSync(join(root, ".git"))) {
  // pod has no gitconfig — identity inline, same pattern commitUserspace uses.
  const git = (...args) =>
    execFileSync("git", ["-C", root, "-c", "user.name=assistant", "-c", "user.email=assistant@local", ...args], {
      stdio: "pipe"
    })
  git("init", "-b", "main")
  git("add", "-A")
  git("commit", "-m", "bootstrap: initialize userspace skeleton")
  console.log(`bootstrap-userspace: git-initialized ${root}`)
}
