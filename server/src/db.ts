import { SqliteClient } from "@effect/sql-sqlite-node"
import { Config, Effect, Layer } from "effect"
import * as fs from "node:fs"
import * as path from "node:path"

// The appspace sqlite db: platform-owned durable state (task history now;
// feature KV moves here in P3). Lives OUTSIDE the userspace tree so a
// userspace wipe never touches it — in the pod it's the /data/appspace
// hostPath (~/assistant-data/appspace on the mini), which is also what
// litestream replicates to MinIO.
const AppspaceDb = Config.string("APPSPACE_DB").pipe(
  Config.withDefault(".DONOTCOMMIT/appspace/appspace.db")
)

export const SqlLive = Layer.unwrapEffect(
  Effect.map(AppspaceDb, (filename) => {
    // sync mkdir at layer build: sqlite open fails on a missing directory
    fs.mkdirSync(path.dirname(filename), { recursive: true })
    return SqliteClient.layer({ filename })
  })
)
