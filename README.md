# Polymarket Status → Telegram Bot

每隔 5 分钟轮询 [Polymarket 官方状态页](https://status.polymarket.com)，发现整体状态变化、组件状态变化，或新的故障 / 维护通知时，推送到指定 Telegram 群。

## 工作原理

1. 拉取 Instatus 公开接口（无需鉴权）：
   - `https://status.polymarket.com/v3/summary.json` — 整体状态、活跃 incident / maintenance
   - `https://status.polymarket.com/v3/components.json` — 各组件状态
2. 与本地 `last_state.json` 比对，有变化则调用 Telegram `sendMessage`
3. 首次运行只记录状态、不推送，避免历史 incident 刷屏
4. 状态页请求失败时记录错误并跳过本次轮询，不崩溃

## 环境变量

| 变量 | 说明 |
|------|------|
| `BOT_TOKEN` | Telegram Bot token |
| `CHAT_ID` | 目标群聊 / 频道 id（群一般为负数） |

参考 `.env.example`。

## 1. 创建 Bot 并获取 Token

1. 在 Telegram 打开 [@BotFather](https://t.me/BotFather)
2. 发送 `/newbot`，按提示设置名称和 username
3. BotFather 会返回一串 token，形如 `123456:ABC-DEF...`，即 `BOT_TOKEN`
4. 把 bot 拉进目标群，并设为管理员（部分群需要管理员权限才能发言）

## 2. 获取群聊 Chat ID

任选一种方式：

**方式 A：临时 bot 日志**

1. 把 bot 拉进群后，在群里随便发一条消息（或 @ 一下 bot）
2. 浏览器打开：
   ```
   https://api.telegram.org/bot<BOT_TOKEN>/getUpdates
   ```
3. 在返回 JSON 里找 `"chat":{"id":-100xxxxxxxxxx,...}`，该数字即 `CHAT_ID`

**方式 B：使用 @userinfobot / @getidsbot**

1. 把这类 bot 拉进群，它会直接回复 chat id

群聊 id 通常是负数（例如 `-1001234567890`）。

## 3. 配置 GitHub Secrets

本仓库用 GitHub Actions 定时跑（每 5 分钟）：

1. 打开仓库 → **Settings** → **Secrets and variables** → **Actions**
2. 新建两个 Repository secrets：
   - `BOT_TOKEN` = 你的 bot token
   - `CHAT_ID` = 群聊 id
3. 推送代码后，可在 **Actions** 页手动触发一次 **Polymarket Status Monitor**（`workflow_dispatch`）验证

状态文件 `last_state.json` 纳入仓库版本管理。每次 Actions 跑完后若文件有变化会自动 commit 并 push；无变化则跳过，避免空提交。首次运行仓库里没有该文件时，脚本会创建并写入当前状态、不触发 Telegram 推送。

## 4. 本地测试

```bash
# 安装依赖
npm install

# 配置环境变量
cp .env.example .env
# 编辑 .env，填入真实 BOT_TOKEN 和 CHAT_ID

# 第一次运行：只写入 last_state.json，不推送
npm run check

# 再跑一次：若状态无变化，输出 "No changes."
npm run check
```

想验证推送，可以临时改 `last_state.json` 里某个组件的 status（例如改成 `MAJOROUTAGE`），再执行 `npm run check`，应收到一条「状态变化」消息。

## 文件结构

```
.
├── check-status.js                 # 主脚本
├── package.json
├── .env.example
├── .gitignore
├── last_state.json                 # 状态快照（由 Actions 自动更新并提交）
└── .github/workflows/status-monitor.yml
```

## 消息示例

```
🆕 新故障：Degraded trading performance，当前状态 Investigating
影响：Major outage
时间：2026-08-03 15:30 UTC
链接：https://status.polymarket.com/incident/...
```

```
🔄 状态更新：Degraded trading performance，Investigating → Monitoring
时间：2026-08-03 15:45 UTC
```

```
✅ 已解决：Degraded trading performance
时间：2026-08-03 15:55 UTC
详情：https://status.polymarket.com
```

```
🔔 Polymarket Status 更新
组件：[Predictions] Trading API (CLOB)
状态：Operational → Degraded performance
时间：2026-08-03 15:30 UTC
```
