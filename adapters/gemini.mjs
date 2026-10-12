#!/usr/bin/env node
// ===========================================================================
// Gemini CLI -> Token HUD adapter
//
// STATUS: UNVERIFIED, and the least certain adapter here. The hook config and
// event names are from the official docs, but the exact token-usage field
// names inside the AfterModel payload could not be confirmed. So this adapter
// deliberately does not hardcode a path: it walks the payload and maps any
// object that looks like token usage.
//
// Run it by hand first and read stderr:
//   echo '{}' | node adapters/gemini.mjs --probe
//
// Config, ~/.gemini/settings.json:
//   { "hooks": {
//       "BeforeAgent": [{ "hooks": [{ "type": "command", "name": "token-hud",
//           "command": "node /abs/path/adapters/gemini.mjs", "timeout": 5000 }] }],
//       "AfterModel":  [{ "matcher": "*", "hooks": [{ "type": "command", "name": "token-hud",
//           "command": "node /abs/path/adapters/gemini.mjs", "timeout": 5000 }] }],
//       "AfterAgent":  [{ "hooks": [{ "type": "command", "name": "token-hud",
//           "command": "node /abs/path/adapters/gemini.mjs", "timeout": 5000 }] }]
//   } }
//
// CRITICAL: Gemini CLI parses this process's stdout as JSON. Writing anything
// else there breaks the hook. This script therefore prints ONLY to stderr.
//
// NOTE: Google replaced Gemini CLI with Antigravity CLI on 2026-06-18 for
// unpaid and Google One users. If you are on Antigravity, this adapter is for
// the older surface and may not apply.
// ===========================================================================

import { ingest, readStdin, emptyTokens } from "./lib.mjs"

const PROBE = process.argv.includes("--probe")

const KEYS = {
  input: ["input_tokens", "inputTokens", "promptTokenCount", "prompt_tokens"],
  output: ["output_tokens", "outputTokens", "candidatesTokenCount", "completion_tokens"],
  reasoning: ["reasoning_output_tokens", "reasoningTokens", "thoughtsTokenCount", "thoughts_tokens"],
  cacheRead: ["cached_input_tokens", "cache_read_input_tokens", "cachedContentTokenCount", "cached_tokens"],
}

const LOOKUP = {}
for (const [group, names] of Object.entries(KEYS)) {
  for (const name of names) LOOKUP[name] = group
}

function numberAt(object, names) {
  for (const name of names) {
    if (typeof object[name] === "number") return object[name]
  }
  return 0
}

function looksLikeUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  return Object.keys(value).some((key) => LOOKUP[key])
}

// Depth-first search for the first usage-looking object. Cheap, and robust to
// the field living at an unknown depth in an unverified payload.
function findUsage(value, depth = 0) {
  if (depth > 8 || !value || typeof value !== "object") return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findUsage(item, depth + 1)
      if (found) return found
    }
    return null
  }
  if (looksLikeUsage(value)) return value
  for (const item of Object.values(value)) {
    const found = findUsage(item, depth + 1)
    if (found) return found
  }
  return null
}

function toTokens(usage) {
  const tokens = emptyTokens()
  if (!usage) return tokens
  tokens.input = numberAt(usage, KEYS.input)
  tokens.output = numberAt(usage, KEYS.output)
  tokens.reasoning = numberAt(usage, KEYS.reasoning)
  tokens.cache.read = numberAt(usage, KEYS.cacheRead)
  return tokens
}

async function main() {
  const raw = readStdin()
  let hook = {}
  try {
    hook = JSON.parse(raw || "{}")
  } catch {}

  const sessionID = process.env.GEMINI_SESSION_ID || hook.session_id || hook.sessionId || "gemini"
  const event = hook.hook_event_name || hook.event || hook.hookEventName || ""

  if (PROBE) {
    console.error("event    : " + (event || "(none - not run by a hook?)"))
    console.error("session  : " + sessionID)
    console.error("raw stdin: " + (raw.slice(0, 2000) || "(empty)"))
    console.error("usage map: " + JSON.stringify(toTokens(findUsage(hook))))
    return
  }

  if (event === "BeforeAgent") {
    await ingest("session.execution.started", { sessionID })
    return
  }

  const usage = findUsage(hook)
  if (usage) {
    // Additive: if you see totals double-counting, this payload is cumulative
    // and you should switch this one line to "session.usage.updated".
    await ingest("session.step.ended", { sessionID, tokens: toTokens(usage) })
  }

  if (event === "AfterAgent") {
    await ingest("session.execution.succeeded", { sessionID })
  }
}

// stdout stays empty: Gemini CLI parses it as JSON.
main()
  .catch(() => {})
  .finally(() => process.exit(0))
