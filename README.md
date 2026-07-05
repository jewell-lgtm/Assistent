# local-assistent

A self-modifying AI assistant, running on hardware I own. An experiment, honestly labeled as one.

The idea: a phone app where I can *describe* a feature ("add a run tracker with GPS and start/stop") and the assistant writes it, type-checks it, deploys it to my own server, rebuilds the app bundle, and ships it back to my phone over-the-air — no laptop, no app store, no third-party backend. The core platform ("appspace") is fixed and reviewed; everything the assistant writes lives in a sandboxed "userspace" that is wipeable and fully reconstructible from nothing.

## What actually works today (proven, not aspirational)

- **Self-hosted OTA updates**: an Expo app whose update server is an Effect-TS service on a Mac mini in my house (expo-updates protocol v1, ~150 lines). Publish → phone updates, no reinstall.
- **In-process coding agent**: [`pi-coding-agent`](https://pi.dev) embedded in the server. Writes are path-confined to userspace via guarded tool operations; no shell access; the resource loader is locked down (`noContextFiles`/`noExtensions`/untrusted project) after review found real prompt-injection and in-process-RCE vectors in the defaults.
- **Genesis from a plain-English prompt**: one behavior-only prompt produced a working GPS run-tracker feature — its own API design, UI composed from the shipped kit, typed HTTP routes, files landing in a vault — first try, zero fix iterations. Independently re-verified by an adversarial second agent.
- **The full loop from a phone, over the public internet**: prompt → SSE-streamed agent run → type-gated redeploy → OTA publish → app self-updates with the new feature tab. Server behind Caddy on a VPS, wireguard tunnel to the mini, HTTPS, bearer auth with no-deadlock token rotation.
- **Userspace is disposable**: `rm -rf` it, boot, and an idempotent bootstrap recreates the skeleton; the platform serves an empty registry without complaint. Executed for real, not just designed.
- **Deploy rails with teeth**: health-gated rollouts with auto-undo, separate tsc gates for agent-written code (the root typecheck deliberately can't see it), and a commit trail for every self-modification.

## What this is not

- **Not tested in the conventional sense.** There is no test suite. Verification has been evidence-based smoke testing at every step (documented obsessively), plus adversarial multi-agent code review — which caught, among other things: a deploy pipeline that reported success while shipping nothing, an ESM/CJS split that 404'd every route while claiming "loaded", an OTA pipeline that silently embedded an empty auth token in every published bundle, and a trust default that would have let the agent plant code executing in-process on its next run. All fixed; the class of bug you should expect remains.
- **Not multi-user, not hardened for the open internet.** One user, one phone, one bearer token (rotatable), pass-through edge with no rate limit yet. The `/api/system/*` surface can rebuild and redeploy the server — it is exposed by deliberate choice because roaming self-modification is the point. You should not run this as-is for anything you care about.
- **Not polished.** The UI is intentionally ugly. The run registry is in-memory (pod restart loses live-run tracking; results survive via git). The first OTA fetch after install must happen on the home LAN (the installed APK bakes the old URL; the runtime override only works on APKs built with anti-bricking disabled). Android-only, arm64-only APK.
- **Not stable.** Interfaces (the capability contract, the userland kit, persistence) have existed for roughly a day each.

## Architecture in one paragraph

pnpm/turborepo monorepo. `server/` is Effect-TS (`@effect/platform-node`), one container on OrbStack k8s on a Mac mini, serving the API, the OTA protocol, and the embedded coding agent. `app/` is Expo (SDK 57) with all native modules pre-baked so features ship as pure-JS OTA updates. `packages/capabilities-server` and `packages/capabilities-ui` define the contract userspace code compiles against — server features export typed `HttpApi` routers (the UI derives typed clients from the same schema), app features export tab components composed from a small UI kit; a namespaced KV persistence service and a Pi client are injected as Effect services. `scripts/gen-userspace.mjs` regenerates the feature registry at build, boot, and publish; broken features are isolated (server loader skips them, per-tab ErrorBoundary contains them). A host-side daemon (`opsd`, LAN-only) executes redeploys and OTA publishes; the pod reaches it by proxy, so the phone can trigger both.

## Provenance

Built in roughly a day by Claude agents (a builder and a reviewer/coordinator, later merged into one) directed by a human, communicating through a shared handover document with an evidence-required acceptance protocol. The agent-written feature code in production userspace was written by `pi` (gpt-5.5) from natural-language prompts. Human contributions: direction, taste, permission gates, and the phone.

## Running it

You realistically can't without recreating the environment (a Mac mini with OrbStack k8s, a wireguard mesh, a VPS with Caddy, provider auth for the coding agent, an APK build). There is deliberately no one-command setup — see `infra/` and `scripts/` for the shape of it. This repo is published as a record and a reference, not a product.
