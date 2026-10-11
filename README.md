# opencode-token-hud

[English](README.md) · [简体中文](README.zh-CN.md)

A separate desktop window that shows **live tok/s and token usage** for the current OpenCode session. Launch it with the slash command **`/hud`**.

## What it does

Run `/hud` in the composer and a small chromeless window opens showing:

```
   990 tok/s          生成中
▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂
output              3,200
reasoning             600
input               1,000
cache                 350
steps                   1
total               5,270
cost              $0.0163
```

The window updates live while the model streams text and reasoning.

## Why

The OpenCode desktop GUI has no runtime extension slot for custom panels, and plugins can only extend the `server` or `tui` surface. But a **server-side plugin** is free to open its own local window, so that is what this does — without recompiling anything.

## Requirements

- OpenCode with the **server (`@opencode/plugin` v2)** plugin API
- A **Chromium-based browser** — **Microsoft Edge** or **Google Chrome** — used in `--app=` mode, so no Electron and no extra dependency
- Runs on **Windows, macOS and Linux**, on either the **Bun or Node** plugin host (only Node built-ins are used)
- [Bun](https://bun.sh) to install the plugin's dependencies (or copy `node_modules` from another plugin)

## Install

1. Copy this folder into your OpenCode extensions directory, e.g.

   ```
   <your-config>/extensions/plugins/token-hud
   ```

2. Install its dependencies:

   ```bash
   cd <that folder>
   bun install
   ```

3. Add the folder path to the `plugins` array in `opencode.jsonc`:

   ```jsonc
   {
     "plugins": [
       "C:/path/to/extensions/plugins/token-hud"
     ]
   }
   ```

4. OpenCode hot-reloads plugin changes; if `/hud` does not appear, restart the app.

## Usage

Type `/hud` in the message composer. The window opens for the current session.

## How it works

```
OpenCode server (Bun)
  └─ token-hud plugin
       ├─ one instance binds 127.0.0.1:7788 and subscribes to session events
       ├─ relays token-relevant events over SSE  (/events)
       └─ serves the window page              (/)
                          ▲
       /hud ──► edge/chrome --app=http://127.0.0.1:7788/?session=...  (the window)
```

- Several plugin instances are loaded (one per workspace location). The first one to bind port **7788** becomes the data server; the others only register the `/hud` command.
- The window sends an `EventSource` to `/events` and computes speed and totals client-side, the same way the `token-stats` TUI plugin does: **4 characters ≈ 1 token** over a **60 s sliding window**.
- `/hud` seeds the window with the session's current totals, then live events keep it up to date.

## Uninstall

Delete the plugin folder and remove its line from the `plugins` array. Nothing else is touched.

## Notes / limitations

- The Edge app window **cannot be pinned always-on-top** with Edge flags alone (needs extra Win32 calls).
- The browser is auto-detected (Edge/Chrome); if neither is found, open `http://127.0.0.1:7788/?session=<id>` manually.
- Speed is **estimated** from character counts, not from provider-reported timing; totals come from real usage events.
- One shared window per `OPENCODE_SESSION_ID`; running `/hud` again opens another window.

## License

MIT — see [LICENSE](LICENSE).
