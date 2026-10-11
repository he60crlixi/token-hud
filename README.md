# opencode-token-hud

A separate desktop window that shows **live tok/s and token usage** for the current OpenCode session. Launch it with the slash command **`/hud`**.

一个独立的小窗口,实时显示当前 OpenCode 会话的 **tok/s 速度和 token 用量**。用斜杠命令 **`/hud`** 打开。

---

## English

### What it does

Run `/hud` in the composer and a small chromeless window opens showing:

```
   990 tok/s          生成中
▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂
输出 (output)       3,200
思考 (reasoning)      600
输入 (input)        1,000
缓存命中 (cache)      350
调用步数 (steps)        1
总计 (total)        5,270
费用 (cost)       $0.0163
```

The window updates live while the model streams text and reasoning.

### Why

The OpenCode desktop GUI has no runtime extension slot for custom panels, and plugins can only extend the `server` or `tui` surface. But a **server-side plugin** is free to open its own local window, so that is what this does — without recompiling anything.

### Requirements

- OpenCode with the **server (`@opencode/plugin` v2)** plugin API
- **Microsoft Edge** (`msedge`) on `PATH` — used in `--app=` mode, which needs no Electron and no extra dependency
- [Bun](https://bun.sh) to install the plugin's dependencies (or copy `node_modules` from another plugin)

### Install

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

### Usage

Type `/hud` in the message composer. The window opens for the current session.

### How it works

```
OpenCode server (Bun)
  └─ token-hud plugin
       ├─ one instance binds 127.0.0.1:7788 and subscribes to session events
       ├─ relays token-relevant events over SSE  (/events)
       └─ serves the window page              (/)
                          ▲
       /hud ──► msedge --app=http://127.0.0.1:7788/?session=...  (the window)
```

- Several plugin instances are loaded (one per workspace location). The first one to bind port **7788** becomes the data server; the others only register the `/hud` command.
- The window sends an `EventSource` to `/events` and computes speed and totals client-side, the same way the `token-stats` TUI plugin does: **4 characters ≈ 1 token** over a **60 s sliding window**.
- `/hud` seeds the window with the session's current totals, then live events keep it up to date.

### Uninstall

Delete the plugin folder and remove its line from the `plugins` array. Nothing else is touched.

### Notes / limitations

- The Edge app window **cannot be pinned always-on-top** with Edge flags alone (needs extra Win32 calls).
- Speed is **estimated** from character counts, not from provider-reported timing; totals come from real usage events.
- One shared window per `OPENCODE_SESSION_ID`; running `/hud` again opens another window.

### License

MIT — see [LICENSE](LICENSE).

---

## 中文

### 功能

在输入框敲 `/hud`,会弹出一个无边框小窗口,实时显示:

```
   990 tok/s          生成中
▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂
输出 (output)       3,200
思考 (reasoning)      600
输入 (input)        1,000
缓存命中 (cache)      350
调用步数 (steps)        1
总计 (total)        5,270
费用 (cost)       $0.0163
```

模型吐字和思考时,数字实时跳动。

### 为什么这么做

OpenCode 桌面版 GUI 没有第三方运行时扩展位,插件只能扩展 `server` 或 `tui`。但**服务端插件**可以自己拉起一个本地窗口,于是就这么做——不用重编译、不改官方安装包。

### 前置要求

- OpenCode,带**服务端(`@opencode/plugin` v2)插件 API**
- 装了 **Microsoft Edge**(`msedge` 在 `PATH` 里)——用它的 `--app=` 模式,零额外依赖
- [Bun](https://bun.sh),用来装插件依赖(或从别的插件复制 `node_modules`)

### 安装

1. 把本文件夹拷到你的 OpenCode 扩展目录,例如:

   ```
   <你的配置目录>/extensions/plugins/token-hud
   ```

2. 装依赖:

   ```bash
   cd <该文件夹>
   bun install
   ```

3. 在 `opencode.jsonc` 的 `plugins` 数组里加上这个文件夹路径:

   ```jsonc
   {
     "plugins": [
       "C:/path/to/extensions/plugins/token-hud"
     ]
   }
   ```

4. OpenCode 会热重载插件;若 `/hud` 没出现,重启一次应用。

### 用法

在输入框敲 `/hud`,窗口即打开(针对当前会话)。

### 原理

```
OpenCode 服务端 (Bun)
  └─ token-hud 插件
       ├─ 单个实例占用 127.0.0.1:7788,订阅会话事件
       ├─ 通过 SSE 转发 token 相关事件     (/events)
       └─ 提供窗口页面                     (/)
                          ▲
        /hud ──► msedge --app=http://127.0.0.1:7788/?session=...   (窗口)
```

- 插件会按「工作区位置」加载多个实例。**先抢到 7788 端口**的那个成为数据服务,其余的只负责注册 `/hud` 命令。
- 窗口用 `EventSource` 连 `/events`,在前端算速度和总量,算法和 `token-stats`(TUI 版)一致:**4 字符 ≈ 1 token**,**60 秒滑窗**。
- `/hud` 会用会话当前的总量给窗口做初始种子,之后由实时事件持续刷新。

### 卸载

删掉插件文件夹 + 从 `plugins` 数组里去掉那一行即可,别的都不动。

### 说明 / 局限

- Edge 的 app 窗口**无法只靠命令行置顶**(需要额外调 Win32)。
- 速度是**按字符数估算**的,不是模型自报的计时;总量来自真实的 usage 事件。
- 同一个 `OPENCODE_SESSION_ID` 共用一个窗口;再次运行 `/hud` 会再开一个。

### 许可证

MIT,见 [LICENSE](LICENSE)。
