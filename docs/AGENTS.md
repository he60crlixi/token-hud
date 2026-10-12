# Adding an agent

The HUD is split into one **agent-agnostic core** and small **adapters** that
translate a specific agent's telemetry into a single normalized event schema.
Adding an agent means writing a translator, not touching the core, and never
touching `page.html`.

```
        ┌──────────────────────────────────────────┐
        │  core.js   (agent-agnostic)              │
        │    GET  /          page.html             │
        │    GET  /events    SSE broadcast         │
        │    POST /ingest    <- adapters push here │
        │    GET  /open      Chromium --app= window│
        │    GET  /ping      { relayed, clients }  │
        └──────────────────────────────────────────┘
             ▲          ▲          ▲          ▲
      opencode      claude       codex      anything
      (plugin)       (hook)      (notify)   (curl)
```

Because the core is shared, several agents running at once all push into the
**same window** instead of fighting over the port.

## The wire contract

This table is the entire interface. `tokens` mirrors OpenCode's shape:

```json
{ "input": 1000, "output": 3200, "reasoning": 600,
  "cache": { "read": 350, "write": 0 } }
```

| type | `data` | effect on the HUD |
|---|---|---|
| `session.text.delta` | `{ sessionID, delta }` | feeds the live tok/s rate |
| `session.reasoning.delta` | `{ sessionID, delta }` | feeds the rate, shows 思考中 |
| `session.step.started` | `{ sessionID, step? }` | status → 思考中 |
| `session.step.ended` | `{ sessionID, step?, cost?, tokens? }` | **adds** totals, +1 step, ends the run |
| `session.step.failed` | same as ended | same |
| `session.execution.started` | `{ sessionID }` | status → 生成中 |
| `session.execution.succeeded` | `{ sessionID }` | status → 空闲 |
| `session.execution.failed` | `{ sessionID }` | status → 空闲 |
| `session.execution.interrupted` | `{ sessionID }` | status → 空闲 |
| `session.usage.updated` | `{ sessionID, cost?, tokens? }` | **overwrites** totals |

`cost` is a per-turn delta on `step.ended`, and an absolute total on
`usage.updated`.

Unknown types are rejected with `400` and the response body lists the full set,
so a typo tells you immediately instead of silently doing nothing.

## The ladder: how much can an agent actually give you?

Only one agent here has a real event bus. Everything else is a trade-off:

1. **Per-token stream** → smooth tok/s. Needs a streaming API (`stream-json`, a
   plugin event bus).
2. **Message/tool boundaries** → status and accurate totals, but the rate is
   bursty and reads 0 between events.
3. **Turn boundaries only** → totals refresh once per turn. Activity light only.

Say which rung you are on in the adapter's header comment. Do not pretend to be
on rung 1 when you are on rung 2.

## Current adapters

| Agent | Rung | Source | Status |
|---|---|---|---|
| **OpenCode** | 1 | plugin event bus | verified — `scripts/selfcheck.mjs` |
| **Claude Code** | 2 | hooks + session transcript | UNVERIFIED |
| **Codex CLI** | 2–3 | rollout transcript `token_count` | UNVERIFIED |
| **Gemini CLI** | 2 | `AfterModel` hook payload | UNVERIFIED, least certain |
| **anything else** | any | `POST /ingest` | works today, no code |

"UNVERIFIED" means the code was written against public docs but never run,
because those agents were not installed on the development machine. Each of
those adapters has a `--probe` mode that prints exactly what it sees. **Run
`--probe` first** and check the field names before trusting the rest.

## Writing a new adapter

Most of the work is already in `adapters/lib.mjs`: `ingest()`, `readStdin()`,
`readState()`, `readFrom()`, `newestFile()`, `parseLines()`.

Three rules:

1. **Never block or fail the agent.** A Claude Code hook that exits non-zero can
   block a tool call; a Gemini CLI hook that prints to stdout breaks JSON
   parsing. Swallow your own errors, exit 0, and on Gemini print only to stderr.
2. **Never re-read a whole log file.** Agents append megabytes. Use
   `readFrom(path, offset)` and persist the offset with `readState`/`writeState`.
3. **Never spawn `process.execPath` to start the core.** The OpenCode plugin
   host is a compiled Bun binary, so its `execPath` is `OpenCode.exe` — spawning
   it re-launches the host, which receives the core's path as a project
   directory and dies with `ENOTDIR`. The core never binds and `/hud` is
   silently inert. Use `findRuntime()` from `lib.mjs`, or `HUD_RUNTIME` to
   override. `scripts/adapter.test.mjs` is the regression test for this.

The laziest adapter is no adapter at all:

```bash
curl -X POST http://127.0.0.1:7788/ingest \
  -H "Content-Type: application/json" \
  -d '{"type":"session.step.ended","data":{"sessionID":"x",
       "tokens":{"input":1000,"output":3200},"cost":0.016}}'
```

If your agent can run a shell command, that is already a complete integration.

## Per-agent notes

### OpenCode

The only rung-1 source. `adapters/opencode.js` subscribes to the plugin event
bus, spawns the core if it is not running, and registers `/hud`. Because deltas
arrive per stream chunk it pushes fire-and-forget with an in-flight cap, so a
fast model never backs up behind the network.

### Claude Code

Hooks fire on `PreToolUse` / `PostToolUse` / `Stop` — **never per token**. There
is no way to get a smooth tok/s line from hooks. The adapter reads the session
transcript at `transcript_path` and sums `message.usage` from the lines appended
since the last call, so totals are exact even though the rate is not.

Cost is not in the transcript, so this adapter reports no cost.

To get a real per-token stream you would have to run `claude -p
--output-format stream-json` wrapped in a pipe, which gives up the interactive
TUI. Not worth it for a HUD.

### Codex CLI

Two sources exist and both are used:

- `notify` in `~/.codex/config.toml` — one JSON argument on turn completion.
  The payload carries **no usage**, so the adapter reads the newest rollout
  transcript instead.
- `~/.codex/sessions/**/rollout-*.jsonl` — contains
  `{"type":"event_msg","payload":{"type":"token_count","info":{
  "total_token_usage":{...},"last_token_usage":{...}}}}` with
  `input_tokens`, `cached_input_tokens`, `output_tokens`,
  `reasoning_output_tokens`.

`total_token_usage` is cumulative, which is exactly what `session.usage.updated`
means, so totals cannot double-count. `codex exec --json` emits `item.completed`
rather than per-token deltas, so even `--watch` will not produce a perfectly
smooth rate.

### Gemini CLI

Config and event names are from the official hooks docs
(`BeforeAgent` / `AfterModel` / `AfterAgent`, `settings.json`, `matcher`,
`timeout`, plus `GEMINI_SESSION_ID`). The token-usage field names inside the
`AfterModel` payload could **not** be confirmed, so the adapter walks the
payload for any object holding token-ish keys rather than hardcoding a path.
Run `--probe` to see what your version sends.

Gemini CLI parses hook stdout as JSON, so this adapter writes only to stderr.
If totals double-count, the payload is cumulative — switch the one marked line
from `session.step.ended` to `session.usage.updated`.

Note: Google replaced Gemini CLI with Antigravity CLI on 2026-06-18 for unpaid
and Google One users. On Antigravity this adapter may not apply.

### Agents that cannot be supported

- **Cline / Roo Code / Kilo** — VS Code extensions with no external event API.
  Only their internal task JSON can be polled, which is fragile and breaks on
  every extension update.
- **Cursor** — its hooks fire on boundaries and expose no token data at all, so
  there is nothing to display.

## Limitations

- The Edge/Chrome `--app=` window **cannot be pinned always-on-top** with
  browser flags alone; that needs platform-specific Win32 calls.
- The rate is **estimated** from character counts (4 chars ≈ 1 token, 60 s
  sliding window), not from provider-reported timing. Totals come from real
  usage events.
- One window per session; running `/hud` twice opens a second window.
- The core binds `127.0.0.1` only. `/ingest` is unauthenticated, so any local
  process can push numbers at it — that is the feature. Browser pages cannot,
  because `/ingest` requires `Content-Type: application/json`, which forces a
  CORS preflight that the core never answers.
