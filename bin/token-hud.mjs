#!/usr/bin/env node
// ===========================================================================
// token-hud — CLI
//
// Makes sure the shared core is running, then opens the window. Works with no
// agent at all: the /ingest endpoint is usable on its own.
//
//   token-hud              start the core and open the window
//   token-hud --no-open    start the core only, print the URL
//   token-hud --port 9000  use a different port
//   token-hud --status     report whether a core is already running
// ===========================================================================

import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const args = process.argv.slice(2)

if (args.includes("--help") || args.includes("-h")) {
  console.log(
    [
      "token-hud — live tok/s and token usage in a small always-visible window",
      "",
      "  token-hud              start the core and open the window",
      "  token-hud --no-open    start the core only, print the URL",
      "  token-hud --port 9000  use a different port (env: HUD_PORT)",
      "  token-hud --status     report whether a core is already running",
      "",
      "Push your own numbers in from anywhere:",
      '  curl -X POST http://127.0.0.1:7788/ingest \\',
      '    -H "Content-Type: application/json" \\',
      '    -d \'{"type":"session.step.ended","data":{"tokens":{"input":1200,"output":340}}}\'',
    ].join("\n"),
  )
  process.exit(0)
}

const at = args.indexOf("--port")
const PORT = Number((at !== -1 ? args[at + 1] : undefined) || process.env.HUD_PORT || 7788)
const BASE = "http://127.0.0.1:" + PORT
const CORE = fileURLToPath(new URL("../core.js", import.meta.url))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function alive() {
  try {
    const response = await fetch(BASE + "/ping", { signal: AbortSignal.timeout(500) })
    return response.ok ? await response.json() : null
  } catch {
    return null
  }
}

const before = await alive()

if (args.includes("--status")) {
  console.log(before ? `running on ${BASE} — ${JSON.stringify(before)}` : `not running on ${BASE}`)
  process.exit(before ? 0 : 1)
}

if (!before) {
  spawn(process.execPath, [CORE, "--port", String(PORT)], { detached: true, stdio: "ignore" }).unref()
  for (let i = 0; i < 60; i++) {
    if (await alive()) break
    await sleep(50)
  }
}

const status = await alive()
if (!status) {
  console.error("token-hud: core did not come up on " + BASE)
  console.error("try: node " + CORE + " --port " + PORT)
  process.exit(1)
}

console.log(before ? "token-hud already running: " + BASE : "token-hud started: " + BASE)

if (!args.includes("--no-open")) {
  try {
    await fetch(BASE + "/open")
  } catch {}
}
