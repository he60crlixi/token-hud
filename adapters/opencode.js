// ===========================================================================
// OpenCode -> Token HUD adapter
//
// This is the richest adapter: OpenCode is the only supported agent with a
// real event bus, so it is the only one that gets true per-token deltas and
// therefore a smooth tok/s reading. Every other adapter is a degraded version
// of this shape. See docs/AGENTS.md.
//
// The adapter owns no server. It only:
//   1. makes sure the shared core is running (/ping, else spawn it)
//   2. registers /hud, which asks the core to open the window
//   3. translates ctx.event bus events -> POST /ingest
//
// Because the core is shared, OpenCode and another agent can push into the
// same window instead of fighting over the port.
//
// Install: point the `plugins` array in your opencode config at this folder.
// ===========================================================================

import { Plugin } from "@opencode/plugin"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const PORT = Number(process.env.HUD_PORT || 7788)
const BASE = "http://127.0.0.1:" + PORT
const CORE = fileURLToPath(new URL("../core.js", import.meta.url))

const RELAY = new Set([
  "session.text.delta",
  "session.reasoning.delta",
  "session.step.started",
  "session.step.ended",
  "session.step.failed",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.usage.updated",
])

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function alive() {
  try {
    return (await fetch(BASE + "/ping", { signal: AbortSignal.timeout(500) })).ok
  } catch {
    return false
  }
}

// The core is idempotent: if the port is already bound it exits 0 on its own,
// so spawning unconditionally is safe. We still ping first to skip the spawn.
async function ensureCore() {
  if (await alive()) return true
  try {
    spawn(process.execPath, [CORE], { detached: true, stdio: "ignore" }).unref()
  } catch {
    return false
  }
  for (let i = 0; i < 40; i++) {
    await sleep(50)
    if (await alive()) return true
  }
  return false
}

export default Plugin.define({
  id: "token-hud",
  async setup(ctx) {
    const commandReg = await ctx.command.transform((editor) => {
      editor.add({
        name: "hud",
        description: "Open a live token HUD window (tok/s, totals, cost) for this session",
        execute: async ({ sessionID }) => {
          if (!(await ensureCore())) return
          let seed = ""
          try {
            const session = await ctx.session.get({ sessionID })
            if (session?.tokens) {
              seed = JSON.stringify({ tokens: session.tokens, cost: session.cost ?? 0 })
            }
          } catch {}
          const query = "?session=" + encodeURIComponent(sessionID) + "&seed=" + encodeURIComponent(seed)
          await fetch(BASE + "/open" + query).catch(() => {})
        },
      })
    })

    const abort = new AbortController()

    // Deltas arrive per stream chunk. Fire-and-forget keeps the model stream
    // off the network path; the cap sheds load instead of queueing forever.
    let inflight = 0
    const push = (type, data) => {
      if (inflight > 64) return
      inflight += 1
      fetch(BASE + "/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, data }),
      })
        .catch(() => {})
        .finally(() => {
          inflight -= 1
        })
    }

    ;(async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
          if (!RELAY.has(event.type)) continue
          push(event.type, event.data)
        }
      } catch {}
    })()

    return async () => {
      abort.abort()
      await commandReg?.dispose?.()
    }
  },
})
