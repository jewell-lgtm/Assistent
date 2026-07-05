// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getDefaultConfig } = require("expo/metro-config")
const fs = require("fs")
const path = require("path")

const config = getDefaultConfig(__dirname)

// userspace/ lives outside app/ (and is gitignored) — watch it so Metro
// picks up private feature modules imported via ../../userspace/features/*.
// Absent on a fresh public clone — watchman errors on a nonexistent root, so
// only add it when present.
const userspaceDir = path.resolve(__dirname, "../userspace")
if (fs.existsSync(userspaceDir)) {
  config.watchFolders = [...config.watchFolders, userspaceDir]
}

// userspace imports (@assistant/capabilities-ui, react, expo-*) must resolve
// to the app's node_modules — fallback there when normal resolution misses.
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, "node_modules"),
  path.resolve(__dirname, "../node_modules")
]
config.resolver.extraNodeModules = new Proxy(
  {},
  { get: (_target, name) => path.resolve(__dirname, "node_modules", String(name)) }
)

module.exports = config
