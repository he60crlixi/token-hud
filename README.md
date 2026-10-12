# token-hud

[English](README.md) · [简体中文](README.zh-CN.md)

A separate desktop window showing **live tok/s and token usage** for the coding
agent you are currently using.

```
   990 tok/s          生成中
▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂
输出              3,200
思考                600
输入              1,000
缓存命中            350
调用步数              1
总计              5,270
费用            $0.0163
```

## What it does

A small chromeless window that updates live while your agent streams text and
reasoning. It survives behind your editor, so you can glance at it instead of
running `/stats`.

## Why

The OpenCode desktop GUI has no runtime extension slot for custom panels, and
plugins can only extend the `server` or `tui` surface. But a server-side plugin
is free to open its own local window — so that is what this does, without
recompiling anything. That same trick works for any agent that can run a
command, which is why this is now one core plus small adapters.

## Requirements

- **Node 18+** or **Bun** (only Node built-ins are used by the core)
- A **Chromium-based browser** — Microsoft Edge or Google Chrome — used in
  `--app=` mode, so no Electron and no extra dependency
- Windows, macOS or Linux

## Install

```bash
git clone https://github.com/he60crlixi/token-hud
cd token-hud
node scripts/install.mjs          # shows what it found; changes nothing
node scripts/install.mjs --apply  # writes the hooks, backing up each file
```

Then restart the agent. `install.mjs` only touches files it can edit safely and
leaves a `.bak` beside each one. If your OpenCode config contains comments it
prints a snippet to paste instead of rewriting the file.

Nothing to install for other agents — see below.

## Usage

```bash
node bin/token-hud.mjs          # start the window, no agent required
node bin/token-hud.mjs --open   # same thing, explicitly
npx token-hud --port 9000       # a different port
```

With OpenCode, type **`/hud`** in the composer.

The window also works with **no agent at all**. Push your own numbers in from
anything that can run a shell command:

```bash
curl -X POST http://127.0.0.1:7788/ingest \
  -H "Content-Type: application/json" \
  -d '{"type":"session.step.ended","data":{"sessionID":"x",
       "tokens":{"input":1000,"output":3200},"cost":0.016}}'
```

## Supported agents

| Agent | tok/s | Totals | Status |
|---|---|---|---|
| **OpenCode** | live, per token | exact | **verified** |
| **Claude Code** | bursty (tool boundaries) | exact | unverified |
| **Codex CLI** | bursty | exact | unverified |
| **Gemini CLI** | bursty | approximate | unverified |
| anything else | — | — | use `POST /ingest` |

**Unverified** means the adapter was written against public documentation but
never run, because that agent was not installed on the development machine.
Each one has a `--probe` mode that prints exactly what it sees — run that first:

```bash
node adapters/claude-code.mjs --probe   # feed it a hook payload on stdin
node adapters/codex.mjs --probe         # prints the newest rollout transcript
echo '{}' | node adapters/gemini.mjs --probe
```

Only OpenCode has a real event bus, so only OpenCode gets a smooth per-token
rate. Claude Code's hooks fire at tool boundaries and never per token; there is
no way around that short of giving up its interactive TUI.
See [docs/AGENTS.md](docs/AGENTS.md) for the full explanation.

## How it works

```
        ┌──────────────────────────────────────────┐
        │  core.js   (agent-agnostic)              │
        │    GET  /          the window            │
        │    GET  /events    SSE broadcast         │
        │    POST /ingest    <- adapters push here │
        │    GET  /open      opens the window      │
        └──────────────────────────────────────────┘
             ▲          ▲          ▲          ▲
      opencode      claude       codex      anything
```

- The core binds `127.0.0.1:7788` and relays normalized events over SSE.
- Adapters translate their agent's telemetry into that one schema. They own no
  server and spawn the core if it is not already running.
- The core is idempotent: a second copy exits 0 instead of stealing the port,
  so several agents can share one window.
- The window computes tok/s client-side the same way the `token-stats` TUI
  plugin does: **4 characters ≈ 1 token** over a **60 s sliding window**.

## Adding an agent

Most integrations need no adapter at all — a `curl` in a hook script is
complete. For a real one, `adapters/lib.mjs` already has the plumbing, and
[docs/AGENTS.md](docs/AGENTS.md) describes the schema and the pitfalls.

## Checks

```bash
node scripts/selfcheck.mjs        # the core's contract and trust boundary
node scripts/install.test.mjs     # the installer's merge logic
npm run check                     # both
```

Neither needs an agent installed.

## Limitations

- The `--app=` window **cannot be pinned always-on-top** with browser flags
  alone.
- Speed is **estimated** from character counts, not provider-reported timing.
  Totals come from real usage events.
- `/ingest` is unauthenticated on localhost, by design — any local process can
  push numbers at it. Browser pages cannot, because the required
  `Content-Type` forces a CORS preflight the core never answers.
- One window per session.

## License

MIT — see [LICENSE](LICENSE).
