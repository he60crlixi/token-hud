// ===========================================================================
// Token HUD — core
//
// Agent-agnostic. Knows nothing about OpenCode, Claude Code, Codex, or any
// other agent; it only knows one normalized event schema (see TYPES below).
// Every adapter is a translator into that schema, which is why adding an agent
// costs a small file and no change here.
//
//   GET  /            the HUD page (page.html)
//   GET  /events      SSE stream of normalized events
//   POST /ingest      <- adapters push normalized events here
//   GET  /open        open the Chromium app window, forwarding ?session=&seed=
//   GET  /ping        { relayed, clients, port }
//
// Node built-ins only, so it runs on either the Bun or the Node host, on
// Windows/macOS/Linux. Idempotent: if the port is already bound, another core
// owns it, so this process logs and exits 0 instead of failing.
//
//   node core.js [--port 7788] [--open]
// ===========================================================================

import { createServer } from "node:http"
import { readFileSync, appendFileSync } from "node:fs"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

const DIR = fileURLToPath(new URL(".", import.meta.url))
const PAGE = DIR + "page.html"
const LOG = DIR + "hud.log"
const MAX_BODY = 64 * 1024

const flag = (name) => {
  const index = process.argv.indexOf(name)
  return index !== -1 ? process.argv[index + 1] : undefined
}
const PORT = Number(flag("--port") || process.env.HUD_PORT || 7788)
const HOST = "127.0.0.1"

// The wire contract. Adapters translate their agent's native telemetry into
// exactly these. Unknown types are rejected so typos surface at once.
const TYPES = new Set([
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

// Chromium's --app= mode: no tabs, no URL bar, no Electron dependency.
// Best effort — if no browser is found the URL is logged for a manual open.
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

const clients = new Set()
let relayed = 0

function broadcast(type, data) {
  relayed += 1
  const chunk = "data: " + JSON.stringify({ type, data }) + "\n\n"
  for (const client of clients) {
    try {
      client.write(chunk)
    } catch {
      clients.delete(client)
    }
  }
}

function json(res, code, body, close) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    ...(close ? { Connection: "close" } : {}),
  })
  res.end(JSON.stringify(body))
}

// Rejects as soon as the cap is passed, but keeps draining so the client is
// not reset mid-upload; the handler answers 413 and closes the connection.
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    let overflow = false
    let parts = []
    req.on("data", (part) => {
      if (overflow) return
      size += part.length
      if (size > MAX_BODY) {
        overflow = true
        parts = []
        reject(new Error("body too large"))
        return
      }
      parts.push(part)
    })
    req.on("end", () => {
      if (!overflow) resolve(Buffer.concat(parts).toString("utf8"))
    })
    req.on("error", reject)
  })
}

function handle(req, res) {
  const url = new URL(req.url, "http://" + HOST)

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

  if (url.pathname === "/ingest") {
    if (req.method !== "POST") return json(res, 405, { error: "use POST" })
    readBody(req)
      .then((raw) => {
        let event
        try {
          event = JSON.parse(raw)
        } catch {
          return json(res, 400, { error: "body is not JSON" })
        }
        if (!event || typeof event.type !== "string") {
          return json(res, 400, { error: "missing string field: type" })
        }
        if (!TYPES.has(event.type)) {
          return json(res, 400, { error: "unknown type: " + event.type, types: [...TYPES] })
        }
        if (event.data != null && typeof event.data !== "object") {
          return json(res, 400, { error: "field data must be an object" })
        }
        broadcast(event.type, event.data || {})
        res.writeHead(204).end()
      })
      .catch((error) => {
        const overflow = error.message === "body too large"
        json(res, overflow ? 413 : 400, { error: String(error.message || error) }, true)
      })
    return
  }

  if (url.pathname === "/open") {
    const query = new URLSearchParams()
    for (const key of ["session", "seed"]) {
      if (url.searchParams.has(key)) query.set(key, url.searchParams.get(key))
    }
    const target = "http://" + HOST + ":" + PORT + "/" + (query.toString() ? "?" + query : "")
    openWindow(target)
    log("opened window for " + (url.searchParams.get("session") || "(no session)"))
    return json(res, 200, { opened: target })
  }

  if (url.pathname === "/ping") {
    return json(res, 200, { relayed, clients: clients.size, port: PORT })
  }

  if (url.pathname === "/") {
    let html
    try {
      html = readFileSync(PAGE, "utf8")
    } catch (error) {
      html = "<pre>page.html missing: " + String(error) + "</pre>"
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(html)
    return
  }

  res.writeHead(404).end("not found")
}

const server = createServer(handle)

server.once("error", (error) => {
  if (error.code === "EADDRINUSE") {
    log("port " + PORT + " busy; another HUD owner is running, exiting")
    process.exit(0)
  }
  log("server error: " + String(error))
  process.exit(1)
})

server.listen(PORT, HOST, () => {
  log("owner bound http://" + HOST + ":" + PORT + "/ pid=" + process.pid)
  process.stdout.write("hud listening on http://" + HOST + ":" + PORT + "/\n")
  if (process.argv.includes("--open")) openWindow("http://" + HOST + ":" + PORT + "/")
})

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    for (const client of clients) {
      try {
        client.end()
      } catch {}
    }
    clients.clear()
    server.close(() => process.exit(0))
  })
}
