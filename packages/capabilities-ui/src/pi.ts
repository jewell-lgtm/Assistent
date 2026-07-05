import type { PiService } from "@assistant/capabilities-server/pi"
import { Context } from "effect"

// UI-side userspace access to the engine: same interface as the server's
// PiClient, proxied over HTTP to core's POST /api/pi/run. App core provides
// the Live. `const pi = yield* PiProxy`
// (types-only dep on capabilities-server — nothing server-side gets bundled)

export class PiProxy extends Context.Tag("assistant/PiProxy")<PiProxy, PiService>() {}

export type { PiError, PiRouting, PiRunOptions, PiRunResult, PiService } from "@assistant/capabilities-server/pi"
