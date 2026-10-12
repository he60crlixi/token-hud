// Self-check for the installer's merge logic. Needs no agents installed.
//
//   node scripts/install.test.mjs
//
// Runs the real installer against throwaway config files in a temp directory
// and asserts the result is valid, idempotent, and non-destructive. The one
// thing this cannot tell you is whether the hook format is what each agent
// actually expects — only the real agent can.
//
// Exits non-zero on the first failure.

import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const INSTALL = fileURLToPath(new URL("./install.mjs", import.meta.url))
const scratch = mkdtempSync(join(tmpdir(), "token-hud-install-"))

function run(agent, config, apply) {
  const args = [INSTALL, "--agent", agent, "--config", config]
  if (apply) args.push("--apply")
  try {
    return { code: 0, out: execFileSync(process.execPath, args, { encoding: "utf8" }) }
  } catch (error) {
    return { code: error.status ?? 1, out: String(error.stdout || "") + String(error.stderr || "") }
  }
}

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

const cases = [
  { agent: "claude-code", file: "claude.json", seed: { hooks: { Stop: [{ hooks: [{ type: "command", command: "other.sh" }] }] } } },
  { agent: "gemini", file: "gemini.json", seed: {} },
  { agent: "opencode", file: "opencode.json", seed: { plugins: ["keep-me"] } },
]

console.log("json agents")
for (const testCase of cases) {
  const path = join(scratch, testCase.file)
  writeFileSync(path, JSON.stringify(testCase.seed, null, 2))

  const dry = run(testCase.agent, path, false)
  check(testCase.agent + ": dry run leaves the file untouched", () => {
    assert.equal(dry.code, 0)
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), testCase.seed)
  })

  const applied = run(testCase.agent, path, true)
  check(testCase.agent + ": --apply reports success", () => assert.equal(applied.code, 0))
  check(testCase.agent + ": writes valid JSON", () => {
    JSON.parse(readFileSync(path, "utf8"))
  })
  check(testCase.agent + ": backs the original up", () => {
    assert.ok(existsSync(path + ".bak"))
    assert.deepEqual(JSON.parse(readFileSync(path + ".bak", "utf8")), testCase.seed)
  })

  const once = readFileSync(path, "utf8")
  run(testCase.agent, path, true)
  check(testCase.agent + ": is idempotent", () => {
    assert.equal(readFileSync(path, "utf8"), once)
  })

  const check1 =
    testCase.agent === "claude-code"
      ? (config) => {
          const groups = config.hooks.Stop
          assert.ok(groups.some((g) => g.hooks.some((h) => h.command.includes("claude-code.mjs"))))
          assert.ok(groups.some((g) => g.hooks.some((h) => h.command === "other.sh")), "clobbered an existing hook")
        }
      : testCase.agent === "gemini"
        ? (config) => assert.ok(config.hooks.AfterModel[0].hooks[0].command.includes("gemini.mjs"))
        : (config) => assert.deepEqual(config.plugins.includes("keep-me"), true)

  check(testCase.agent + ": produced the expected shape", () => {
    check1(JSON.parse(readFileSync(path, "utf8")))
  })
}

console.log("\njson with comments (opencode.jsonc)")
{
  const path = join(scratch, "opencode.jsonc")
  writeFileSync(path, '{\n  // a comment a rewrite would destroy\n  "plugins": []\n}\n')
  const result = run("opencode", path, true)
  check("refuses to rewrite and prints a snippet instead", () => {
    assert.match(result.out, /not plain JSON/)
    assert.match(readFileSync(path, "utf8"), /a comment a rewrite would destroy/)
  })
}

console.log("\ntoml agent")
{
  const path = join(scratch, "config.toml")
  writeFileSync(path, 'model = "gpt-5"\n')

  check("codex: --apply succeeds", () => assert.equal(run("codex", path, true).code, 0))
  const once = readFileSync(path, "utf8")
  check("codex: appends a notify line", () => assert.match(once, /^notify = \["node", ".*codex\.mjs"\]$/m))
  check("codex: preserves the existing key", () => assert.match(once, /^model = "gpt-5"$/m))

  run("codex", path, true)
  check("codex: is idempotent", () => {
    assert.equal(readFileSync(path, "utf8"), once)
    assert.equal(readFileSync(path, "utf8").match(/notify =/g).length, 1, "wrote notify twice")
  })
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? "\nPASS" : `\nFAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
