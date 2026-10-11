import { Plugin } from "@opencode/plugin"
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"

// ===========================================================================
// OpenCode Token HUD
//
// A tiny local HTTP server, owned by one plugin instance, that streams the
// token-relevant session events to a chromeless Edge window opened by the
// `/hud` command.  The window renders live tok/s and session totals.
//
// Why an HTTP server: the desktop GUI has no runtime extension slot, but a
// server-side plugin can spawn a separate always-local window.  One instance
// binds PORT; the rest just register the command and open the same window.
// ===========================================================================

const PORT = 7788
const DIR = import.meta.dir
const LOG = DIR + "/hud.log"
const PAGE = DIR + "/page.html"

// Event types the window needs; everything else is dropped before relaying.
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

function log(message) {
  try {
    appendFileSync(LOG, new Date().toISOString() + " " + message + "\n")
  } catch {}
}

function openWindow(sessionID, seed) {
  const url =
    `http://127.0.0.1:${PORT}/?session=${encodeURIComponent(sessionID)}` +
    `&seed=${encodeURIComponent(seed)}`
  // Edge app mode gives a chrome-less window with zero extra dependencies.
  return Bun.spawn(["cmd", "/c", "start", "", "msedge", `--app=${url}`, "--window-size=380,270"], {
    stdout: "ignore",
    stderr: "ignore",
  })
}

export default Plugin.define({
  id: "opencode-token-hud",
  async setup(ctx) {
    // Registered in every instance, so `/hud` exists in every location.
    const commandReg = await ctx.command.transform((editor) => {
      editor.add({
        name: "hud",
        description: "Open a live token HUD window (tok/s, totals, cost) for this session",
        execute: async ({ sessionID }) => {
          let seed = ""
          try {
            const session = await ctx.session.get({ sessionID })
            if (session?.tokens) seed = JSON.stringify({ tokens: session.tokens, cost: session.cost ?? 0 })
          } catch (error) {
            log("seed failed: " + String(error))
          }
          try {
            openWindow(sessionID, seed)
            log("opened window for " + sessionID)
          } catch (error) {
            log("spawn failed: " + String(error))
          }
        },
      })
    })

    const clients = new Set()
    const encoder = new TextEncoder()
    const abort = new AbortController()
    let relayed = 0

    let server
    try {
      server = Bun.serve({
        port: PORT,
        hostname: "127.0.0.1",
        fetch: (req) => handle(req),
      })
    } catch (error) {
      // Another instance already owns the HUD; this one only opens windows.
      log("port busy; non-owner instance: " + String(error).slice(0, 90))
      return async () => {
        await commandReg?.dispose?.()
      }
    }

    try {
      writeFileSync(LOG, "")
    } catch {}
    log("owner bound " + server.url)

    function handle(req) {
      const url = new URL(req.url)
      if (url.pathname === "/events") {
        let controller
        const body = new ReadableStream({
          start(c) {
            controller = c
            clients.add(c)
            c.enqueue(encoder.encode(": connected\n\n"))
          },
          cancel() {
            clients.delete(controller)
          },
        })
        return new Response(body, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          },
        })
      }
      if (url.pathname === "/ping") {
        return Response.json({ relayed, clients: clients.size })
      }
      if (url.pathname === "/") {
        let html = ""
        try {
          html = readFileSync(PAGE, "utf8")
        } catch (error) {
          html = "<pre>page.html missing: " + String(error) + "</pre>"
        }
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } })
      }
      return new Response("not found", { status: 404 })
    }

    ;(async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
          if (!RELAY.has(event.type)) continue
          relayed += 1
          const chunk = encoder.encode("data: " + JSON.stringify({ type: event.type, data: event.data }) + "\n\n")
          for (const client of clients) {
            try {
              client.enqueue(chunk)
            } catch {
              clients.delete(client)
            }
          }
        }
      } catch (error) {
        log("event loop ended: " + String(error).slice(0, 200))
      }
    })()

    return async () => {
      abort.abort()
      try {
        server.stop(true)
      } catch {}
      await commandReg?.dispose?.()
      log("owner stopped")
    }
  },
})
