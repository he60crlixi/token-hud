// Shared helpers for the adapters. No dependencies, no abstractions beyond
// what two or more adapters actually use.
//
// The one rule every adapter follows: never block or fail the agent it
// observes. A Claude Code hook that returns non-zero can block a tool call, so
// everything here swallows its own errors and exits fast.

import { readFileSync, writeFileSync, readdirSync, statSync, openSync, readSync, closeSync, existsSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"

export const PORT = Number(process.env.HUD_PORT || 7788)
export const BASE = "http://127.0.0.1:" + PORT

// A compiled Bun binary reports itself as process.execPath, so spawning
// process.execPath re-launches the *host* instead of running the script. That
// is exactly what happens inside the OpenCode plugin host, whose execPath is
// OpenCode.exe: it received the core's path as a project directory and failed
// with ENOTDIR. So resolve a real interpreter instead, and never hand back
// something that is not one.
//
// Arguments exist so the decision can be tested; production calls it bare.
export function findRuntime(execPath = process.execPath, bun = globalThis.Bun, env = process.env) {
  if (env.HUD_RUNTIME) return env.HUD_RUNTIME

  const base = String(execPath || "").split(/[\\/]/).pop().toLowerCase()
  if (/^(node|bun|deno)(\.exe)?$/.test(base)) return execPath

  const candidates = []
  if (bun && typeof bun.which === "function") {
    candidates.push(bun.which("node"), bun.which("bun"))
  }
  if (process.platform === "win32") {
    candidates.push(
      join(env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe"),
      join(env.LOCALAPPDATA || "", "Programs", "nodejs", "node.exe"),
      join(env.APPDATA || "", "npm", "node_modules", "bun", "bin", "bun.exe"),
    )
  } else {
    candidates.push("/usr/local/bin/node", "/usr/bin/node", join(homedir(), ".bun", "bin", "bun"))
  }

  // .cmd/.ps1 shims are not spawnable without a shell, so they do not count.
  return candidates.find((path) => typeof path === "string" && existsSync(path) && !/\.(cmd|bat|ps1)$/i.test(path)) || null
}

export async function ingest(type, data) {
  try {
    await fetch(BASE + "/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, data }),
      signal: AbortSignal.timeout(2000),
    })
  } catch {}
}

export function readStdin() {
  if (process.stdin.isTTY) return ""
  try {
    return readFileSync(0, "utf8")
  } catch {
    return ""
  }
}

export function readState(key) {
  try {
    return JSON.parse(readFileSync(join(tmpdir(), "token-hud-" + key + ".json"), "utf8"))
  } catch {
    return {}
  }
}

export function writeState(key, value) {
  try {
    writeFileSync(join(tmpdir(), "token-hud-" + key + ".json"), JSON.stringify(value))
  } catch {}
}

// Read a file from a byte offset, returning only complete lines plus the new
// offset. Agents append megabytes to these files, so a hook must not re-read
// them whole on every call.
export function readFrom(path, byteOffset) {
  let fd
  try {
    fd = openSync(path, "r")
  } catch {
    return { text: "", offset: byteOffset }
  }
  try {
    const size = statSync(fd).size
    if (size <= byteOffset) return { text: "", offset: size }
    const length = size - byteOffset
    const buffer = Buffer.allocUnsafe(length)
    readSync(fd, buffer, 0, length, byteOffset)
    const text = buffer.toString("utf8")
    const lastNewline = text.lastIndexOf("\n")
    if (lastNewline === -1) return { text: "", offset: byteOffset }
    const complete = text.slice(0, lastNewline)
    return { text: complete, offset: byteOffset + Buffer.byteLength(complete + "\n", "utf8") }
  } catch {
    return { text: "", offset: byteOffset }
  } finally {
    closeSync(fd)
  }
}

export function newestFile(root, test) {
  let best = null
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!test(entry.name)) continue
      let mtime = 0
      try {
        mtime = statSync(full).mtimeMs
      } catch {
        continue
      }
      if (!best || mtime > best.mtime) best = { path: full, mtime }
    }
  }
  walk(root)
  return best ? best.path : null
}

// The token totals the HUD page expects, all zeroed.
export function emptyTokens() {
  return { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
}

export function parseLines(text) {
  const rows = []
  for (const line of text.split("\n")) {
    if (!line.trim()) continue
    try {
      rows.push(JSON.parse(line))
    } catch {}
  }
  return rows
}
