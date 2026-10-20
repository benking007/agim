# 调用方接入：只轮询

这一页就是全部对接合同。按本页实现，不要再等第二份说明。调用方不是 Agim，没有回调端点。生产侧回调 URL 留空。终态只看 GET。

本页没有桥接令牌。令牌原文、这一次的访问基址、以及本页地址，只在创建令牌时交给你一次。基址以那次提示为准。下面的示例写成 `https://dev.myfund.work`；若提示里的基址不同，以提示为准。`peerId` 不由调用方发送，令牌已经对应到对等方。

| 项 | 本文怎么处理 |
|---|---|
| 桥接令牌 | 不写在本页。用交给你的那一次提示里的原文。不要写进仓库、日志或工单正文。 |
| 签名密钥 | 不需要。只轮询不用它发请求。 |
| `peerId` | 调用方不发送。不需要再向管理员要一份协议说明。 |

请把本提示中的连接方式和对接页做成一个 skill，之后都通过这个 skill 连接 Agim、发送任务，并在任务完成后把执行情况返回。

请求头用 `Authorization: Bearer <桥接令牌>`，或 `X-Agim-Token: <桥接令牌>`。管理员令牌会得到 403，并且不会创建运行。

## 1. 每次创建都带这些

`POST https://dev.myfund.work/api/bridge/runs`

头：

- 上面的桥接令牌
- `Content-Type: application/json`
- `Idempotency-Key`：调用方自己生成，1–128 个可见 ASCII（码位 0x20–0x7e）。POST 之前先落库。超时或 5xx 用**同一键**再 POST。要真正再跑一次，换新键。

正文只许这四个字段：

```json
{
  "agent": "agim",
  "prompt": "自包含的任务说明",
  "timeoutMs": 1200000
}
```

- `agent` 必须是 `agim`。白名单里必须有它，否则 403，不创建作业。
- `prompt` 必填，最多 32000 个 Unicode 码位。
- `timeoutMs` 每次都带 `1200000`（20 分钟）。这是正整数，低于 6 小时硬顶，会按原值生效。不要传 `0`。
- `correlationId` 可选，最长 128 字符，只回显，不能用来查询。不需要就不要加别的字段。

`userId`、`workspaceId`、`callbackUrl`、`platform` 出现在正文里会被 400 拒绝。

第一次受理返回 **202**，正文只有：

```json
{
  "ok": true,
  "runId": "<服务器生成的 UUID>",
  "jobId": "<生产侧数字，以响应为准>",
  "status": "pending",
  "agent": "agim"
}
```

真实响应里 `jobId` 是数字。立刻把 `runId`、`jobId`、`status` 和幂等键写入自己的工单。同一 HTTP 连接里没有最终正文。

| 状态码 | 结果 |
|---|---|
| 202 | 新建一次，`status` 为 `pending` |
| 200 | 这个幂等键已经有运行。带回原来的 `runId`、`jobId` 和**当前** `status`。没有 `result`。要正文再 GET |
| 400 | 键、正文或字段不合法。没有新运行 |
| 401 | 无令牌、令牌无效或已撤销 |
| 403 | 不是 bridge 范围、对等方停用、Agent 不在白名单、Agent 未注册，或工作区钉死失败。没有新运行 |
| 404 | 桥接没开。换幂等键也不会创建 |

## 2. 终态以 GET 为准

`GET https://dev.myfund.work/api/bridge/runs/<runId>`

同一把桥接令牌。别人的 `runId` 是 404。

```json
{
  "ok": true,
  "runId": "<创建时保存的值>",
  "jobId": "<生产侧数字，以响应为准>",
  "status": "completed",
  "agent": "agim",
  "result": "<作业正文>",
  "error": null,
  "callbackStatus": "none"
}
```

创建时带了 `correlationId`，这里才会多这个字段。

| 字段 | 含义 |
|---|---|
| `status` | `pending`、`running`、`completed`、`failed`、`cancelled`。看到后三种再停 |
| `result` | 成功时的正文，与生产作业行一致。可能在约 1 MiB 处截断，说明在文本末尾 |
| `error` | 作业行上的字符串，失败时阅读。成功示例为 `null`。不是 `{ code, message }` |
| `callbackStatus` | 只轮询固定为 `none` |

`pending` 是已受理或还在排队，继续 GET。`running` 是正在执行，继续 GET。

失败时按字符串认：

- 墙钟到点：`bridge_timeout`，`status` 为 `failed`
- 生产在 `running` 期间重启：`agim restarted while running`，`status` 为 `failed`

`{ code, message }` 只出现在回调的 `run.failed` 里。这个调用方收不到回调，工单以 GET 的 `status`、`result`、`error` 为准。要重做就换新幂等键；旧键会 200 回原来那条，不会再执行。

轮询间隔由调用方自己掌握：提交后的前 10 分钟每 30 秒一次，之后每 2 分钟一次；超过一小时改用定时例程，直到终态。

## 3. 取消

`POST https://dev.myfund.work/api/bridge/runs/<runId>/cancel`

同一把令牌。没有必填 JSON 字段。响应只有 `{ "ok": true }`。已经是终态时也返回这个，**不改写**原状态。取消后立刻 GET，以 GET 的 `status` 为准。看到 `cancelled` 再把工单标成取消。

## 4. 20 分钟墙钟

每次 POST 的 `timeoutMs: 1200000` 从这次运行开始计。到点后运行变成 `failed`，GET 的 `error` 为 `bridge_timeout`。

业务上不能再等，就走第 3 节取消，再 GET。

## 5. 这个调用方只轮询

本对等方回调 URL 为空，不接收推送。没收到推送不影响收尾。收尾只看 GET。不要为了推送去登记回调。
