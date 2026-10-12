// Regression test for the bug that made /hud do nothing.
//
// Inside the OpenCode plugin host, process.execPath is OpenCode.exe, not a JS
// runtime. The adapter used to spawn that, so OpenCode re-launched itself with
// the core's path as a project directory and died with ENOTDIR. The core never
// bound, and /hud was silently inert.
//
//   node scripts/adapter.test.mjs
//
// Exits non-zero on the first failure.

import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { findRuntime } from "../adapters/lib.mjs"

const CORE = fileURLToPath(new URL("../core.js", import.meta.url))
const PORT = 7796
const BASE = "http://127.0.0.1:" + PORT

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failures = 0
function check(name, fn) {
  try {
    fn()
    console.log("  ok    " + name)
  } catch (error) {
    failures++
    console.log("  FAIL  " + name + "\n        " + error.message)
  }
}

// Stand-ins for the real host. The path only has to end in a non-runtime name.
const HOST = "C:\\Users\\x\\AppData\\Local\\Programs\\@opencodedesktop\\OpenCode.exe"
const REAL_NODE = process.execPath // whatever ran this test is a real runtime

console.log("findRuntime")

check("a plain node/bun runtime is used as-is", () => {
  assert.equal(findRuntime("/usr/local/bin/node", null, {}), "/usr/local/bin/node")
  assert.equal(findRuntime("C:\\Program Files\\nodejs\\node.exe", null, {}), "C:\\Program Files\\nodejs\\node.exe")
})

check("never returns the compiled host binary", () => {
  // This is the regression: the host path must not survive as the answer.
  const resolved = findRuntime(HOST, { which: (name) => (name === "node" ? REAL_NODE : null) }, {})
  assert.equal(resolved, REAL_NODE)
  assert.notEqual(resolved, HOST)
})

check("falls back to a real install when the host has no Bun helper", () => {
  const resolved = findRuntime(HOST, null, {})
  assert.notEqual(resolved, HOST)
  assert.equal(existsSync(resolved), true, "fell back to a path that does not exist: " + resolved)
})

check("refuses .cmd/.ps1 shims, which cannot be spawned without a shell", () => {
  const resolved = findRuntime(HOST, { which: () => "C:\\Users\\x\\AppData\\Roaming\\npm\\bun.cmd" }, {})
  assert.notEqual(resolved, "C:\\Users\\x\\AppData\\Roaming\\npm\\bun.cmd")
})

check("HUD_RUNTIME overrides everything", () => {
  assert.equal(findRuntime(HOST, null, { HUD_RUNTIME: "C:\\custom\\bun.exe" }), "C:\\custom\\bun.exe")
})

console.log("\nend to end: the resolved runtime can actually run the core")

const runtime = findRuntime()
if (!runtime) {
  console.log("  FAIL  no runtime resolved on this machine")
  failures++
} else {
  console.log("  using " + runtime)
  const child = spawn(runtime, [CORE, "--port", String(PORT)], { stdio: "ignore" })
  let bound = false
  for (let i = 0; i < 60; i++) {
    await sleep(100)
    try {
      if ((await fetch(BASE + "/ping")).ok) {
        bound = true
        break
      }
    } catch {}
  }
  check("core started by the resolved runtime binds and answers /ping", () => {
    assert.equal(bound, true, "core never bound on " + BASE)
  })
  if (bound) {
    const ping = await (await fetch(BASE + "/ping")).json()
    check("and reports the right port", () => assert.equal(ping.port, PORT))
  }
  child.kill()
  await sleep(150)
}

console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
