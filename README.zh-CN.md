# opencode-token-hud

[English](README.md) · 简体中文

一个独立的小窗口,实时显示当前 OpenCode 会话的 **tok/s 速度和 token 用量**。用斜杠命令 **`/hud`** 打开。

## 功能

在输入框敲 `/hud`,会弹出一个无边框小窗口,实时显示:

```
   990 tok/s          生成中
▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂▂
输出                3,200
思考                  600
输入                1,000
缓存                  350
调用步数                1
总计                5,270
费用              $0.0163
```

模型流式输出文字和思考时,数字实时跳动。

## 为什么这么做

OpenCode 桌面版 GUI 没有可加载自定义面板的运行时扩展位置,插件只能扩展 `server` 或 `tui` 两个面。但**服务端插件**可以自由地打开自己的本地窗口——本插件就是这么做的,无需重编译任何东西。

## 环境要求

- 支持 **服务端(`@opencode/plugin` v2)** 插件 API 的 OpenCode
- `PATH` 里能用的 **Microsoft Edge**(`msedge`)——用它的 `--app=` 模式,不需要 Electron,也不需要额外依赖
- 用 [Bun](https://bun.sh) 安装插件依赖(或从别的插件复制 `node_modules`)

## 安装

1. 把本仓库文件夹放进你的 OpenCode 扩展目录,例如

   ```
   <your-config>/extensions/plugins/token-hud
   ```

2. 安装依赖:

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

4. OpenCode 会热重载插件改动;如果 `/hud` 没出现,重启一次应用。

## 用法

在输入框里敲 `/hud`,窗口即打开(针对当前会话)。

## 原理

```
OpenCode 服务端 (Bun)
  └─ token-hud 插件
       ├─ 其中一个实例绑定 127.0.0.1:7788,订阅会话事件
       ├─ 通过 SSE 转发与 token 相关的事件   (/events)
       └─ 提供窗口页面                        (/)
                          ▲
       /hud ──► msedge --app=http://127.0.0.1:7788/?session=...   (窗口)
```

- 插件会按工作区位置加载多个实例。**先抢到 7788 端口**的那个成为数据服务,其余实例只负责注册 `/hud` 命令。
- 窗口用 `EventSource` 连接 `/events`,在前端计算速度和总量,算法与 `token-stats`(TUI 版)一致:**4 字符 ≈ 1 token**,**60 秒滑窗**。
- `/hud` 会先用会话当前的总量给窗口做种子,之后由实时事件持续刷新。

## 卸载

删掉插件文件夹,并从 `plugins` 数组里去掉那一行即可,其余不受影响。

## 说明 / 局限

- Edge 的 app 窗口**仅靠命令行无法置顶**(需要额外调用 Win32)。
- 速度是**按字符数估算**的,并非模型自报的计时;总量来自真实的 usage 事件。
- 每个 `OPENCODE_SESSION_ID` 共用一个窗口;再次运行 `/hud` 会再开一个。

## 许可证

MIT,见 [LICENSE](LICENSE)。
