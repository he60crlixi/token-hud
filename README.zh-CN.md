# token-hud

[English](README.md) · [简体中文](README.zh-CN.md)

一个独立的小窗口，实时显示你**当前正在使用的编码 agent** 的 tok/s 和 token 用量。

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

## 它做什么

模型边流式输出文字和思考，这个小窗口边实时更新。它可以一直待在你编辑器后面，瞟一眼就行，不用去敲 `/stats`。

## 为什么这么做

OpenCode 的桌面 GUI 没有给自定义面板留运行时扩展位，插件只能扩展 `server` 或 `tui` 两个面。但**服务端插件可以开自己的本地窗口**——所以就这么干了，不用重编任何东西。

同样的招数对任何「能执行命令」的 agent 都有效，所以现在是**一个核心 + 若干小适配器**。

## 环境要求

- **Node 18+** 或 **Bun**（核心只用 Node 内置模块）
- 一个 **Chromium 内核浏览器**——Microsoft Edge 或 Google Chrome，用 `--app=` 模式启动，不需要 Electron，也不多一个依赖
- Windows / macOS / Linux

## 安装

```bash
git clone https://github.com/he60crlixi/token-hud
cd token-hud
node scripts/install.mjs          # 只列出检测到什么，不改任何东西
node scripts/install.mjs --apply  # 写入 hook，每个文件先备份
```

然后重启对应的 agent。`install.mjs` 只改它能安全编辑的文件，并在旁边留 `.bak`。如果你的 OpenCode 配置里有注释，它会打印一段片段让你手动粘贴，而不是重写文件。

其他 agent 不需要额外安装，见下。

## 使用

```bash
node bin/token-hud.mjs          # 直接开窗，不需要任何 agent
node bin/token-hud.mjs --open   # 同上，显式写法
npx token-hud --port 9000       # 换端口
```

在 OpenCode 里，在输入框敲 **`/hud`**。

**完全不装 agent 也能用。** 任何能跑 shell 命令的东西都能往里推数据：

```bash
curl -X POST http://127.0.0.1:7788/ingest \
  -H "Content-Type: application/json" \
  -d '{"type":"session.step.ended","data":{"sessionID":"x",
       "tokens":{"input":1000,"output":3200},"cost":0.016}}'
```

## 支持的 agent

| Agent | tok/s | 用量统计 | 状态 |
|---|---|---|---|
| **OpenCode** | 实时，逐 token | 精确 | **已跑通** |
| **Claude Code** | 一阵一阵（工具边界） | 精确 | 未验证 |
| **Codex CLI** | 一阵一阵 | 精确 | 未验证 |
| **Gemini CLI** | 一阵一阵 | 近似 | 未验证 |
| 其他 | — | — | 用 `POST /ingest` |

**未验证**的意思是：适配器是照着公开文档写的，但**从没跑过**，因为开发机上没装那个 agent。每个都有一个 `--probe` 模式，会把看到的东西原样打印出来——先跑它：

```bash
node adapters/claude-code.mjs --probe   # 从 stdin 喂一个 hook payload
node adapters/codex.mjs --probe         # 打印最新的 rollout 记录
echo '{}' | node adapters/gemini.mjs --probe
```

只有 OpenCode 有真正的事件总线，所以只有它能拿到平滑的逐 token 速率。Claude Code 的 hooks 只在工具边界触发，永远拿不到逐 token——除非放弃它的交互式 TUI，不划算。完整解释见 [docs/AGENTS.md](docs/AGENTS.md)。

## 工作原理

```
        ┌──────────────────────────────────────────┐
        │  core.js   (与 agent 无关)                │
        │    GET  /          窗口页面               │
        │    GET  /events    SSE 广播               │
        │    POST /ingest    ← 适配器往这里推        │
        │    GET  /open      开窗                   │
        └──────────────────────────────────────────┘
             ▲          ▲          ▲          ▲
      opencode      claude       codex     任意东西
```

- 核心监听 `127.0.0.1:7788`，把归一化事件用 SSE 广播出去。
- 适配器把各自 agent 的遥测翻译成**同一套 schema**。它们不拥有服务器，核心没跑就自己拉起来。
- 核心是幂等的：第二个实例会以 0 退出，而不是抢端口，所以多个 agent 可以共用同一个窗口。
- 窗口在客户端算速率，算法跟 `token-stats` 那个 TUI 插件一致：**4 字符 ≈ 1 token**，**60 秒滑动窗口**。

## 加一个新 agent

大多数集成**根本不需要写适配器**——hook 脚本里一行 `curl` 就是完整集成。真要写，`adapters/lib.mjs` 已经把管道铺好了，schema 和坑都在 [docs/AGENTS.md](docs/AGENTS.md)。

## 自检

```bash
node scripts/selfcheck.mjs        # 核心的契约与信任边界
node scripts/install.test.mjs     # 安装脚本的合并逻辑
npm run check                     # 两个一起跑
```

都不需要装任何 agent。

## 已知限制

- `--app=` 窗口**没法用浏览器参数置顶**。
- 速率是**估算**（字符数），不是 provider 报的真实计时；用量来自真实 usage 事件。
- `/ingest` 在 localhost 上**没有鉴权**，这是设计如此——本机任何进程都能往里推数据。但浏览器网页推不进来：它要求的 `Content-Type` 会触发 CORS 预检，而核心从不回应预检。
- 一个 session 一个窗口。

## 许可证

MIT — 见 [LICENSE](LICENSE)。
