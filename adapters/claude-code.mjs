#!/usr/bin/env node
// ===========================================================================
// Claude Code -> Token HUD adapter
//
// STATUS: UNVERIFIED. Written against the documented hook + transcript format
// but never run, because Claude Code is not installed on the author's machine.
// Run `node adapters/claude-code.mjs --probe` first to confirm the shapes.
//
// Register the SAME script for every event you want; it decides what to emit
// from hook_event_name.
//
//   ~/.claude/settings.json
//   {
//     "hooks": {
//       "PreToolUse":  [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node <repo>/adapters/claude-code.mjs" }] }],
//       "PostToolUse": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node <repo>/adapters/claude-code.mjs" }] }],
//       "Stop":        [{ "hooks": [{ "type": "command", "command": "node <repo>/adapters/claude-code.mjs" }] }]
//     }
//   }
//
// HONEST LIMITATION: Claude Code hooks fire at tool boundaries, never per
// token. This adapter therefore cannot produce a smooth tok/s line. It gives
// you tool-level activity plus accurate token totals read from the session
// transcript. See docs/AGENTS.md.
// ===========================================================================

import { readState, writeState, readFrom, ingest, readStdin, emptyTokens, parseLines } from "./lib.mjs"

const PROBE = process.argv.includes("--probe")

function usageToTokens(usage) {
  const tokens = emptyTokens()
  if (!usage) return tokens
  tokens.input += usage.input_tokens || 0
  tokens.output += usage.output_tokens || 0
  tokens.reasoning += usage.reasoning_output_tokens || 0
  tokens.cache.read += usage.cache_read_input_tokens || 0
  tokens.cache.write += usage.cache_creation_input_tokens || 0
  return tokens
}

// Sum the usage of assistant messages appended to the transcript since we last
// looked. Claude writes one entry per completed message.
function deltaFromTranscript(path, sessionID) {
  const key = "claude-" + sessionID.replace(/[^A-Za-z0-9_-]/g, "")
  const state = readState(key)
  const { text, offset } = readFrom(path, state.offset || 0)
  writeState(key, { offset })

  const tokens = emptyTokens()
  let sawUsage = false
  for (const row of parseLines(text)) {
    const usage = row && row.message && row.message.usage
    if (!usage) continue
    sawUsage = true
    const part = usageToTokens(usage)
    tokens.input += part.input
    tokens.output += part.output
    tokens.reasoning += part.reasoning
    tokens.cache.read += part.cache.read
    tokens.cache.write += part.cache.write
  }
  return { tokens, sawUsage, lines: text ? text.split("\n").length : 0 }
}

async function main() {
  const raw = readStdin()
  let hook = {}
  try {
    hook = JSON.parse(raw || "{}")
  } catch {}

  const event = hook.hook_event_name || ""
  const sessionID = hook.session_id || "claude"

  if (PROBE) {
    const result = deltaFromTranscript(hook.transcript_path || "", sessionID)
    console.log("event     :", event || "(none - not run by a hook?)")
    console.log("session   :", sessionID)
    console.log("transcript:", hook.transcript_path || "(missing)")
    console.log("new lines :", result.lines)
    console.log("new usage :", JSON.stringify(result.tokens))
    return
  }

  if (event === "PreToolUse") {
    await ingest("session.step.started", { sessionID })
    await ingest("session.execution.started", { sessionID })
    return
  }

  // PostToolUse / Stop / SubagentStop / SessionEnd all mean "a message or a
  // turn finished; there may be new usage to account for".
  const result = deltaFromTranscript(hook.transcript_path || "", sessionID)
  await ingest("session.step.ended", { sessionID, tokens: result.tokens })
  if (event === "Stop" || event === "SessionEnd") {
    await ingest("session.execution.succeeded", { sessionID })
  }
}

main()
  .catch(() => {})
  .finally(() => process.exit(0))
