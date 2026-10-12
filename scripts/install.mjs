#!/usr/bin/env node
// ===========================================================================
// Wires the HUD into whichever agents are on this machine.
//
//   node scripts/install.mjs                          show what it found, change nothing
//   node scripts/install.mjs --apply                  apply every detected agent
//   node scripts/install.mjs --apply --agent codex    just one
//   node scripts/install.mjs --config /tmp/x.json --agent claude-code --apply
//
// Prints a snippet instead of editing when a format is not safely machine
// editable (OpenCode's config allows comments, which rewriting would destroy).
// Always leaves a .bak next to a file before rewriting it.
//
// STATUS: the JSON/TOML merging is exercised by scripts/install.test.mjs, but
// the result has not been run against real Claude Code / Codex / Gemini
// installs. Check the printed snippet before trusting it.
// ===========================================================================

import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)))
const APPLY = process.argv.includes("--apply")
const at = (name) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}
const ONLY = at("--agent")
const OVERRIDE = at("--config")

// Node accepts forward slashes on Windows, which sidesteps quoting entirely.
const adapter = (name) => join(REPO, "adapters", name).replace(/\\/g, "/")
const run = (name) => "node " + adapter(name)

const CODEX_HOME = process.env.CODEX_HOME || join(homedir(), ".codex")

function firstExisting(paths) {
  return paths.find((path) => existsSync(path)) || null
}

// ---------------------------------------------------------------- agents ---

const AGENTS = {
  "claude-code": {
    label: "Claude Code",
    format: "json",
    candidates: [join(homedir(), ".claude", "settings.json")],
    // Hooks fire at tool boundaries only; there is no per-token callback, so
    // this adapter reports activity and accurate totals, not a smooth rate.
    merge(config) {
      const next = { ...config, hooks: { ...(config.hooks || {}) } }
      const command = run("claude-code.mjs")
      for (const event of ["PreToolUse", "PostToolUse", "Stop"]) {
        const existing = Array.isArray(next.hooks[event]) ? next.hooks[event] : []
        const already = existing.some((group) =>
          (group?.hooks || []).some((hook) => String(hook?.command || "").includes("claude-code.mjs")),
        )
        if (already) continue
        const group = { hooks: [{ type: "command", command }] }
        if (event !== "Stop") group.matcher = "*"
        next.hooks[event] = [...existing, group]
      }
      return next
    },
  },

  "gemini": {
    label: "Gemini CLI",
    format: "json",
    candidates: [join(homedir(), ".gemini", "settings.json")],
    merge(config) {
      const next = { ...config, hooks: { ...(config.hooks || {}) } }
      const command = run("gemini.mjs")
      for (const event of ["BeforeAgent", "AfterModel", "AfterAgent"]) {
        const existing = Array.isArray(next.hooks[event]) ? next.hooks[event] : []
        const already = existing.some((group) =>
          (group?.hooks || []).some((hook) => String(hook?.command || "").includes("gemini.mjs")),
        )
        if (already) continue
        next.hooks[event] = [
          ...existing,
          { matcher: "*", hooks: [{ name: "token-hud", type: "command", command, timeout: 5000 }] },
        ]
      }
      return next
    },
  },

  "codex": {
    label: "Codex CLI",
    format: "toml",
    candidates: [join(CODEX_HOME, "config.toml")],
    // Appended, not machine-merged: Codex's notify is a single top-level key,
    // so a duplicate would be a parse error. We only append when absent.
    snippet: () => `notify = ["node", "${adapter("codex.mjs")}"]`,
    merge(text) {
      return /^\s*notify\s*=/m.test(text) ? text : text.replace(/\s*$/, "\n") + this.snippet() + "\n"
    },
  },

  "opencode": {
    label: "OpenCode",
    format: "json",
    candidates: [
      process.env.OPENCODE_CONFIG,
      join(homedir(), ".config", "opencode", "opencode.json"),
      join(homedir(), ".config", "opencode", "opencode.jsonc"),
      process.env.APPDATA ? join(process.env.APPDATA, "opencode", "opencode.jsonc") : null,
      process.env.APPDATA ? join(process.env.APPDATA, "opencode", "opencode.json") : null,
      join(homedir(), "opencode", "config", "opencode", "opencode.jsonc"),
      join(homedir(), "opencode", "config", "opencode", "opencode.json"),
    ].filter(Boolean),
    merge(config) {
      const next = { ...config }
      const plugins = Array.isArray(next.plugins) ? next.plugins.slice() : []
      if (!plugins.some((entry) => String(entry).includes("token-hud"))) plugins.push(REPO)
      next.plugins = plugins
      return next
    },
  },
}

// ------------------------------------------------------------------ main ---

const names = Object.keys(AGENTS).filter((name) => !ONLY || name === ONLY)
if (names.length === 0) {
  console.error("unknown --agent. known: " + Object.keys(AGENTS).join(", "))
  process.exit(1)
}

let problems = 0

for (const name of names) {
  const agent = AGENTS[name]
  const path = OVERRIDE || firstExisting(agent.candidates)
  console.log("\n" + agent.label)

  if (!path) {
    console.log("  not found. looked for:")
    for (const candidate of agent.candidates) console.log("    " + candidate)
    if (agent.snippet) console.log("  add this to your config yourself:\n    " + agent.snippet())
    else console.log("  create the file and re-run with --config <path>")
    continue
  }

  console.log("  config: " + path)
  const original = existsSync(path) ? readFileSync(path, "utf8") : ""

  let updated
  if (agent.format === "toml") {
    updated = agent.merge(original)
  } else {
    let parsed = {}
    if (original.trim()) {
      try {
        parsed = JSON.parse(original)
      } catch {
        console.log("  SKIPPED: this file is not plain JSON (comments?), which a")
        console.log("  rewrite would destroy. Add this by hand instead:")
        console.log("    " + JSON.stringify({ plugins: [REPO] }, null, 2).replace(/\n/g, "\n    "))
        problems++
        continue
      }
    }
    updated = JSON.stringify(agent.merge(parsed), null, 2) + "\n"
  }

  if (updated === original) {
    console.log("  already installed, nothing to do")
    continue
  }

  if (!APPLY) {
    console.log("  would write (dry run, pass --apply to commit):")
    for (const line of updated.split("\n")) console.log("    " + line)
    continue
  }

  try {
    mkdirSync(dirname(path), { recursive: true })
    if (original) copyFileSync(path, path + ".bak")
    writeFileSync(path, updated)
    console.log("  written" + (original ? " (backup at " + path + ".bak)" : ""))
  } catch (error) {
    console.log("  FAILED: " + String(error.message || error))
    problems++
  }
}

console.log(
  APPLY
    ? "\nDone. Restart the agent so it picks up the change."
    : "\nDry run only. Re-run with --apply to write.",
)
process.exit(problems ? 1 : 0)
