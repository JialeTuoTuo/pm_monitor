# Polymarket Status Webhook (Cloudflare Workers)

接收 Instatus（status.polymarket.com）Webhook，按中文模板转发到 Telegram。

**不替换** 现有 GitHub Actions 轮询；两者可并行。

## 需要你在 Cloudflare 配置的 Secrets

在 Worker → Settings → Variables and Secrets 中添加（Encrypted）：

| 变量名 | 含义 |
|--------|------|
| `BOT_TOKEN` | Telegram Bot token |
| `CHAT_ID` | Telegram 群 chat id |
| `WEBHOOK_SECRET` | 在 Polymarket 状态页订阅 Webhook 时生成/自定义的签名密钥 |

不要把上述明文提交到 git 或发给任何人。

## 本地命令

```bash
cd webhook-worker
npm install
npx wrangler login          # 首次
npx wrangler deploy
# 也可用 CLI 写 secret：
# npx wrangler secret put BOT_TOKEN
# npx wrangler secret put CHAT_ID
# npx wrangler secret put WEBHOOK_SECRET
```

## 订阅

部署后把 URL 填到 status.polymarket.com → Get updates → Webhook：

`https://<你的worker>.workers.dev/webhook`

建议顺序：先 deploy → 订阅并复制 secret → 立刻在 CF 填入 `WEBHOOK_SECRET`。

## 验签算法（官方）

见 https://instatus.com/help/webhooks ：

`HMAC-SHA256(secret, JSON.stringify(parsedPayload)).digest('hex')`
与 header `x-instatus-webhook-signature` 比对。
