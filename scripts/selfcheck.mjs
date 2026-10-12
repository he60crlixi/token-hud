// Self-check for the HUD core. Needs no agent installed.
//
//   node scripts/selfcheck.mjs
//
// Boots the core on a scratch port, subscribes to /events, pushes normalized
// events through /ingest, and asserts what came out the other side. This is
// the check that the adapter contract holds. The browser rendering is upstream
// code and is not covered here.
//
// Exits non-zero on the first failure.

import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const PORT = 7799
const BASE = `http://127.0.0.1:${PORT}`
const CORE = fileURLToPath(new URL("../core.js", import.meta.url))
const CLI = fileURLToPath(new URL("../bin/token-hud.mjs", import.meta.url))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Never throws: a connection reset is a result, not a crash. "status 0" means
// the core dropped the connection, which for an oversized upload is correct.
async function post(path, body, raw) {
  try {
    const response = await fetch(BASE + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw === undefined ? JSON.stringify(body) : raw,
    })
    return { status: response.status, json: await response.json().catch(() => null) }
  } catch (error) {
    return { status: 0, json: null, error: String(error.cause?.code || error.message) }
  }
}

async function waitReady() {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(BASE + "/ping")).ok) return
    } catch {}
    await sleep(50)
  }
  throw new Error("core never became ready on " + BASE)
}

const child = spawn(process.execPath, [CORE, "--port", String(PORT)], {
  stdio: ["ignore", "pipe", "pipe"],
})
let coreLog = ""
child.stdout.on("data", (d) => (coreLog += d))
child.stderr.on("data", (d) => (coreLog += d))

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

try {
  await waitReady()

  // Subscribe first, so nothing relayed mid-test is missed.
  const stream = await fetch(BASE + "/events")
  assert.equal(stream.status, 200)
  assert.match(stream.headers.get("content-type"), /text\/event-stream/)
  const received = []
  const reader = stream.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  ;(async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let cut
        while ((cut = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, cut)
          buffer = buffer.slice(cut + 2)
          for (const line of frame.split("\n")) {
            if (line.startsWith("data: ")) received.push(JSON.parse(line.slice(6)))
          }
        }
      }
    } catch {
      // connection torn down at the end of the run; whatever arrived counts
    }
  })()

  console.log("\ncore: " + BASE)

  // --- the contract: what goes in comes out ------------------------------
  const script = [
    { type: "session.step.started", data: { sessionID: "ses_test", step: 1 } },
    { type: "session.reasoning.delta", data: { sessionID: "ses_test", delta: "thinking..." } },
    { type: "session.text.delta", data: { sessionID: "ses_test", delta: "hello world" } },
    { type: "session.execution.started", data: { sessionID: "ses_test" } },
    { type: "session.text.delta", data: { sessionID: "ses_test", delta: " more" } },
    {
      type: "session.step.ended",
      data: {
        sessionID: "ses_test",
        step: 1,
        cost: 0.0163,
        tokens: { input: 1000, output: 3200, reasoning: 600, cache: { read: 350, write: 0 } },
      },
    },
  ]
  const ingestStatuses = []
  for (const event of script) {
    ingestStatuses.push((await post("/ingest", event)).status)
  }
  await sleep(200)

  // --- everything that needs the network, collected up front -------------
  const unknown = await post("/ingest", { type: "session.nope", data: {} })
  const noType = await post("/ingest", { data: {} })
  const notObject = await post("/ingest", { type: "session.text.delta", data: "nope" })
  const broken = await post("/ingest", null, "{not json")
  const wrongVerb = await fetch(BASE + "/ingest")
  const oversized = await post("/ingest", null, '"' + "x".repeat(70 * 1024) + '"')
  await sleep(50)
  const ping = await (await fetch(BASE + "/ping")).json()
  const html = await (await fetch(BASE + "/")).text()
  const missing = await fetch(BASE + "/nope")

  // The CLI must see the running core rather than starting a second one.
  const cli = spawn(process.execPath, [CLI, "--status"], {
    env: { ...process.env, HUD_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "ignore"],
  })
  let cliOut = ""
  cli.stdout.on("data", (d) => (cliOut += d))
  const cliCode = await new Promise((r) => cli.once("exit", r))

  console.log("\ncontract")
  check("accepts every normalized event with 204", () => {
    assert.deepEqual(ingestStatuses, script.map(() => 204))
  })
  check("relays every event, in order", () => {
    assert.equal(received.length, script.length)
    assert.deepEqual(
      received.map((e) => e.type),
      script.map((e) => e.type),
    )
  })
  check("preserves payloads exactly", () => {
    assert.deepEqual(received[2].data, { sessionID: "ses_test", delta: "hello world" })
    assert.deepEqual(received[5].data.tokens, script[5].data.tokens)
    assert.equal(received[5].data.cost, 0.0163)
  })
  check("counts exactly the accepted events", () => {
    assert.equal(ping.relayed, script.length)
    assert.equal(ping.clients, 1)
  })

  console.log("\ntrust boundary")
  check("rejects an unknown type with 400 + the contract", () => {
    assert.equal(unknown.status, 400)
    assert.match(unknown.json.error, /unknown type/)
    assert.ok(unknown.json.types.includes("session.text.delta"))
  })
  check("rejects a missing type", () => assert.equal(noType.status, 400))
  check("rejects a non-object data field", () => assert.equal(notObject.status, 400))
  check("rejects a non-JSON body", () => assert.equal(broken.status, 400))
  check("rejects GET /ingest", () => assert.equal(wrongVerb.status, 405))
  check("does not accept an oversized body", () => {
    assert.notEqual(oversized.status, 204, "oversized body was accepted")
    assert.ok(oversized.status === 413 || oversized.status === 0, "unexpected status " + oversized.status)
  })

  console.log("\nserving")
  check("serves page.html", () => assert.ok(html.includes("<title>Token HUD</title>")))
  check("page subscribes to /events", () => assert.ok(html.includes('new EventSource("/events")')))
  check("404s unknown paths", () => assert.equal(missing.status, 404))

  console.log("\ncli")
  check("--status finds the running core", () => assert.equal(cliCode, 0))
  check("--status reports the port", () => assert.match(cliOut, new RegExp(String(PORT))))

  console.log("\nlifecycle")
  const second = spawn(process.execPath, [CORE, "--port", String(PORT)], { stdio: "ignore" })
  const secondCode = await new Promise((r) => second.once("exit", r))
  check("a second core exits 0 instead of stealing the port", () => assert.equal(secondCode, 0))
  const stillUp = await fetch(BASE + "/ping")
    .then((r) => r.ok)
    .catch(() => false)
  check("owner still serving", () => assert.equal(stillUp, true))
} finally {
  child.kill()
  await sleep(150)
  if (coreLog.trim()) console.log("\ncore output:\n" + coreLog.trim())
}

console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
