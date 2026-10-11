import { Plugin } from "@opencode/plugin"
import { spawn } from "node:child_process"
import { readFileSync, writeFileSync, appendFileSync } from "node:fs"
import { createServer } from "node:http"
import { fileURLToPath } from "node:url"

// ===========================================================================
// OpenCode Token HUD
//
// A tiny local HTTP server, owned by one plugin instance, that streams the
// token-relevant session events to a chromeless Chromium window (Edge/Chrome)
// opened by the `/hud` command.  The window renders live tok/s and totals.
//
// Why an HTTP server: the desktop GUI has no runtime extension slot, but a
// server-side plugin can open its own local window.  One instance binds PORT;
// the rest just register the command and open the same window.
//
// Only Node built-ins are used (node:http, node:child_process, node:fs), so it
// runs on either the Bun or the Node plugin host, on Windows/macOS/Linux.
// ===========================================================================

const PORT = 7788
const DIR = fileURLToPath(new URL(".", import.meta.url))
const LOG = DIR + "hud.log"
const PAGE = DIR + "page.html"

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

// Open a chromeless app window, trying the platform's likely Chromium browsers.
function openWindow(url) {
  const app = "--app=" + url
  const size = "--window-size=380,270"
  const options = { detached: true, stdio: "ignore" }
  const attempts = []
  if (process.platform === "win32") {
    attempts.push(["cmd", ["/c", "start", "", "msedge", app, size]])
    attempts.push(["cmd", ["/c", "start", "", "chrome", app, size]])
  } else if (process.platform === "darwin") {
    attempts.push(["open", ["-na", "Microsoft Edge", "--args", app, size]])
    attempts.push(["open", ["-na", "Google Chrome", "--args", app, size]])
  } else {
    for (const bin of [
      "microsoft-edge",
      "microsoft-edge-stable",
      "google-chrome",
      "google-chrome-stable",
      "chromium",
      "chromium-browser",
    ]) {
      attempts.push([bin, [app, size]])
    }
  }
  const tryOne = (index) => {
    if (index >= attempts.length) {
      log("no Chromium browser found; open " + url + " manually")
      return
    }
    const [command, args] = attempts[index]
    const child = spawn(command, args, options)
    child.once("error", () => tryOne(index + 1))
    child.unref()
  }
  tryOne(0)
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
          openWindow(`http://127.0.0.1:${PORT}/?session=${encodeURIComponent(sessionID)}&seed=${encodeURIComponent(seed)}`)
          log("opened window for " + sessionID)
        },
      })
    })

    const clients = new Set()
    const abort = new AbortController()
    let relayed = 0

    function handle(req, res) {
      const url = new URL(req.url, "http://127.0.0.1")
      if (url.pathname === "/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        })
        res.write(": connected\n\n")
        clients.add(res)
        req.on("close", () => clients.delete(res))
        return
      }
      if (url.pathname === "/ping") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end(JSON.stringify({ relayed, clients: clients.size }))
        return
      }
      if (url.pathname === "/") {
        let html = ""
        try {
          html = readFileSync(PAGE, "utf8")
        } catch (error) {
          html = "<pre>page.html missing: " + String(error) + "</pre>"
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
        res.end(html)
        return
      }
      res.writeHead(404)
      res.end("not found")
    }

    const server = createServer(handle)
    const bindError = await new Promise((resolve) => {
      server.once("error", resolve)
      server.listen(PORT, "127.0.0.1", () => resolve(null))
    })
    if (bindError) {
      // Another instance already owns the HUD; this one only opens windows.
      log("port busy; non-owner instance: " + String(bindError).slice(0, 90))
      server.close()
      return async () => {
        await commandReg?.dispose?.()
      }
    }
    server.on("error", (error) => log("server error: " + String(error).slice(0, 120)))

    try {
      writeFileSync(LOG, "")
    } catch {}
    log("owner bound http://127.0.0.1:" + PORT + "/")

    ;(async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
          if (!RELAY.has(event.type)) continue
          relayed += 1
          const chunk = "data: " + JSON.stringify({ type: event.type, data: event.data }) + "\n\n"
          for (const client of clients) {
            try {
              client.write(chunk)
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
      for (const client of clients) {
        try {
          client.end()
        } catch {}
      }
      clients.clear()
      server.close()
      await commandReg?.dispose?.()
      log("owner stopped")
    }
  },
})
