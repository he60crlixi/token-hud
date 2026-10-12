#!/usr/bin/env node
// ===========================================================================
// Codex CLI -> Token HUD adapter
//
// STATUS: UNVERIFIED. Field names below are taken from the public Codex docs
// and issue tracker, but this was never run against a real Codex install.
// Run `node adapters/codex.mjs --probe` first; it prints exactly what it sees.
//
// Three modes:
//
//   notify (default)   ~/.codex/config.toml:
//                        notify = ["node", "<repo>/adapters/codex.mjs"]
//                      Codex calls this with the event JSON as argv[2] when a
//                      turn completes. The payload carries no usage, so the
//                      adapter reads the newest rollout transcript instead and
//                      reports its cumulative totals.
//
//   --watch            Tails the newest rollout transcript and streams updates
//                      live. This is the mode that actually moves.
//
//   --probe            Print the newest rollout path and the raw shape of the
//                      events inside it, then exit. Use this to confirm the
//                      field names before trusting the other two modes.
//
// Sources:
//   total/last token usage  ~/.codex/sessions/**/rollout-*.jsonl
//     {"type":"event_msg","payload":{"type":"token_count","info":{
//        "total_token_usage":{input_tokens,cached_input_tokens,
//                             output_tokens,reasoning_output_tokens,total_tokens},
//        "last_token_usage":{...}}}}
//
// LIMITATION: `codex exec --json` emits item.completed, not per-token deltas,
// so even --watch cannot give a perfectly smooth tok/s line. Deltas appear
// only if the rollout happens to contain *_delta events; --probe shows whether
// yours does.
// ===========================================================================

import { join } from "node:path"
import { homedir } from "node:os"
import { existsSync, statSync, openSync, readSync, closeSync } from "node:fs"
import { ingest, newestFile, parseLines, emptyTokens } from "./lib.mjs"

const PROBE = process.argv.includes("--probe")
const WATCH = process.argv.includes("--watch")
const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), ".codex")
const SESSIONS = join(CODEX_HOME, "sessions")

const isRollout = (name) => name.startsWith("rollout-") && name.endsWith(".jsonl")

function newestRollout() {
  return newestFile(SESSIONS, isRollout)
}

// total_token_usage -> the shape the HUD page wants.
function usageToTokens(usage) {
  const tokens = emptyTokens()
  if (!usage) return tokens
  tokens.input = usage.input_tokens || 0
  tokens.output = usage.output_tokens || 0
  tokens.reasoning = usage.reasoning_output_tokens || 0
  tokens.cache.read = usage.cached_input_tokens || 0
  return tokens
}

function tokenCountFrom(row) {
  const payload = row && row.payload
  if (!payload || payload.type !== "token_count") return null
  const info = payload.info || {}
  return info.total_token_usage || info.last_token_usage || null
}

// Any event payload whose name ends in _delta is assumed to carry incremental
// text. --probe tells you if that assumption holds for your Codex version.
function deltaFrom(row) {
  const payload = row && row.payload
  if (!payload || typeof payload.type !== "string") return null
  if (!payload.type.endsWith("_delta")) return null
  const text = payload.delta || payload.text || payload.content
  if (typeof text !== "string" || !text) return null
  const reasoning = payload.type.includes("reason")
  return { text, reasoning }
}

function sessionIDFrom(row, path) {
  const payload = (row && row.payload) || {}
  return payload["thread-id"] || payload.thread_id || path.replace(/[^A-Za-z0-9_-]/g, "").slice(-32)
}

async function probe() {
  const path = newestRollout()
  if (!path) {
    console.error("no rollout transcript found under " + SESSIONS)
    console.error("(set CODEX_HOME if your Codex home is elsewhere)")
    return
  }
  console.error("rollout : " + path)
  console.error("size    : " + statSync(path).size + " bytes")
  const rows = parseLines(readAll(path))
  const kinds = {}
  let lastUsage = null
  for (const row of rows) {
    const payload = row && row.payload
    const kind = (payload && payload.type) || row.type || "?"
    kinds[kind] = (kinds[kind] || 0) + 1
    const usage = tokenCountFrom(row)
    if (usage) lastUsage = usage
  }
  console.error("payload types seen:")
  for (const [kind, count] of Object.entries(kinds).sort((a, b) => b[1] - a[1])) {
    console.error("  " + String(count).padStart(6) + "  " + kind)
  }
  console.error("last token_count usage: " + JSON.stringify(lastUsage))
  const deltaKinds = Object.keys(kinds).filter((k) => k.endsWith("_delta"))
  console.error(
    deltaKinds.length
      ? "=> delta events present: " + deltaKinds.join(", ")
      : "=> NO delta events in this transcript: tok/s will read 0, totals still work",
  )
}

function readAll(path) {
  let fd
  try {
    fd = openSync(path, "r")
  } catch {
    return ""
  }
  try {
    const size = statSync(fd).size
    const buffer = Buffer.allocUnsafe(size)
    let read = 0
    while (read < size) {
      const n = readSync(fd, buffer, read, size - read, read)
      if (n <= 0) break
      read += n
    }
    return buffer.toString("utf8", 0, read)
  } catch {
    return ""
  } finally {
    closeSync(fd)
  }
}

// Read from a byte offset, complete lines only.
function readFrom(path, offset) {
  let fd
  try {
    fd = openSync(path, "r")
  } catch {
    return { text: "", offset }
  }
  try {
    const size = statSync(fd).size
    if (size < offset) return { text: "", offset: 0 }
    if (size === offset) return { text: "", offset }
    const buffer = Buffer.allocUnsafe(size - offset)
    readSync(fd, buffer, 0, buffer.length, offset)
    const text = buffer.toString("utf8")
    const cut = text.lastIndexOf("\n")
    if (cut === -1) return { text: "", offset }
    const complete = text.slice(0, cut)
    return { text: complete, offset: offset + Buffer.byteLength(complete + "\n", "utf8") }
  } catch {
    return { text: "", offset }
  } finally {
    closeSync(fd)
  }
}

// --- notify mode: one shot, cumulative totals -----------------------------
async function notify() {
  let event = {}
  try {
    event = JSON.parse(process.argv[2] || "{}")
  } catch {}
  const path = newestRollout()
  if (!path) return
  const rows = parseLines(readAll(path))
  let last = null
  let lastRow = null
  for (const row of rows) {
    const usage = tokenCountFrom(row)
    if (usage) {
      last = usage
      lastRow = row
    }
  }
  const sessionID = sessionIDFrom(lastRow, path)
  if (last) await ingest("session.usage.updated", { sessionID, tokens: usageToTokens(last) })
  await ingest("session.step.ended", { sessionID })
  if (event && event.type) await ingest("session.execution.succeeded", { sessionID })
}

// --- watch mode: follow the newest rollout live ---------------------------
async function watch() {
  let path = null
  let offset = 0
  let sessionID = "codex"
  let sawDelta = false

  const tick = async () => {
    if (!path || !existsSync(path)) {
      const found = newestRollout()
      if (found && found !== path) {
        path = found
        offset = 0
        sawDelta = false
      }
      if (!path) return
    }
    const { text, offset: next } = readFrom(path, offset)
    offset = next
    if (!text) return

    for (const row of parseLines(text)) {
      sessionID = sessionIDFrom(row, path)
      const delta = deltaFrom(row)
      if (delta) {
        sawDelta = true
        await ingest(delta.reasoning ? "session.reasoning.delta" : "session.text.delta", {
          sessionID,
          delta: delta.text,
        })
        continue
      }
      const usage = tokenCountFrom(row)
      if (usage) {
        await ingest("session.usage.updated", { sessionID, tokens: usageToTokens(usage) })
        await ingest("session.step.ended", { sessionID })
      }
    }
  }

  await tick()
  console.error("watching " + SESSIONS + " (newest rollout), HUD on " + (process.env.HUD_PORT || 7788))
  setInterval(() => {
    tick().catch(() => {})
  }, 250)
  if (!WATCH) return
  void sawDelta
}

async function main() {
  if (PROBE) return probe()
  if (WATCH) return watch()
  return notify()
}

main()
  .catch(() => {})
  .finally(() => {
    if (!WATCH) process.exit(0)
  })
