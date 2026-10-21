# 在 dev.myfund.work 上打开桥接

操作员按顺序做。桥接挂在已经在跑的这台 Agim 上，对外基址是 `https://dev.myfund.work`（路径前不要再加斜杠）。调用方可以是 ChatGPT 或 Codex。执行 Agent 仍是 `agim`。Webhook URL 和 Key 留空时只轮询；在连接设置里填了才会主动通知。

## 现在还不能验通

下面三项本文故意空着，也不要补进仓库、工单或提示词：

| 项 | 状态 |
|---|---|
| 桥接令牌 | 创建时只显示一次。经安全渠道交给调用方。本文不写。 |
| 签名密钥 | 这个调用方不需要。对等方记录里保持空。 |
| `peerId` | 登记对等方时由服务器生成/填写，发给调用方。现在没有真实值，本文不编。 |

自动审批也还没有在**这台正在跑的进程**上确认。产品在 `AGIM_AUTO_APPROVE` 未设置时按关闭处理，但这不能代替在该进程上再看一次。写本文时：

- `GET https://dev.myfund.work/api/health` 返回正常，Agent `agim` 可用，`uptimeSec` 为 761134。
- 不带令牌访问 `/api/policy/auto-approve` 和 `/api/bridge/runs`，都是 401，正文是 `{"error":"unauthorized","loginUrl":"/login"}`。
- 写作这台机器上没有 Agim 进程，读不到该进程里的 `AGIM_AUTO_APPROVE`。

所以本文只写打开步骤。确认自动审批关闭、登记好对等方、并把令牌经安全渠道交出去之前，不要让调用方发验通请求。

## 1. 先部署哪一层

`main` 在这次合并之后含阶段 1–4（#388 轮询、#389 回调、#390 开发侧 Agim 出站、#391 审批等待与进度）。合并前已发布的 `main` 版本是 v1.6.41。阶段 4 随 [#391](https://github.com/benking007/agim/pull/391) 进入 `main`。

这台进程写文档时已经连续跑了约 761134 秒，不能假定它已经加载了桥接代码。先把**含 #388 #389 #390 #391 的构建**部署到这台机器并重启。只轮询用得到的是：

- `POST /api/bridge/runs`
- `GET /api/bridge/runs/:runId`
- `POST /api/bridge/runs/:runId/cancel`

阶段 4 的「来源」筛选，以及 `run.waiting_approval`、`run.progress`，要等含 #391 的构建部署到这台机器并再次重启之后才有。打开轮询不必等这次重启。这个调用方回调 URL 为空，即使阶段 4 上了也不会收到这两则推送。

在服务器上执行 `agim --version`，确认不少于这次合并带上的版本（合并前已发布的是 v1.6.41），再做后面的步骤。

## 2. 打开桥接

管理员打开 `https://dev.myfund.work/settings/advanced/bridge`（设置 → 高级 → 连接设置），打开「打开桥接」。开关写在 `~/.agim/config.json` 的 `bridgeEnabled`。当前进程立刻生效，不必为了这个开关改环境变量或重启。关掉之后 `POST /api/bridge/runs` 仍是 404，`code` 为 `NOT_FOUND`，不创建作业。

回环策略仍写到运行该进程的用户的 `~/.agim/env`（设置了 `AGIM_HOME` 就写到那个目录的 `env`）。若 systemd 单元用 `Environment=` 写了同名变量，单元优先。改完执行 `agim restart`。

```
AGIM_TRUST_LOOPBACK=off
```

不要设置 `AGIM_WEB_AUTH=off`。未设置就是鉴权开着；只有值 `off` 会关掉整站鉴权。桥接令牌即使在鉴权关掉时也仍然必填，但这次保持整站鉴权开启。

前面是 Caddy。反代把外部请求变成回环，必须显式 `AGIM_TRUST_LOOPBACK=off`（`0`、`false`、`no` 也同样是关）。

已经把 `AGIM_BRIDGE_ENABLED` 写成 `0`、`off`、`false` 或 `no` 的机器仍是强制关闭。未设置时以连接设置为准。旧机器也可以只用 `AGIM_BRIDGE_ENABLED=1` 打开，不必先改这台机器的环境变量。

重启后用**管理员**会话区分桥接开关（不带令牌的 401 带 `loginUrl`，那是整站门，进不了桥接模块）：

| 管理员访问 `POST /api/bridge/runs` | 含义 |
|---|---|
| 404，`code` 为 `NOT_FOUND` | 桥接仍关，或进程还是旧构建 |
| 403，`code` 为 `FORBIDDEN` | 桥接已开。管理员令牌不能创建运行 |

## 3. 在这台进程上确认自动审批是关的

发出基址和 `peerId` 给调用方之前做这一步。只看 `~/.agim/env` 或进程启动时的环境不够：设置页保存会直接改当前进程。

1. 管理员打开 `https://dev.myfund.work`。
2. 聊天输入栏应显示「请求审批」。若显示「替我审批」或「替我审批·未生效」，先关掉。
3. 用管理员会话 `GET https://dev.myfund.work/api/policy/auto-approve`。要看到 `enabled` 为 `false`。`effective` 也应为 `false`。
4. 设置页 `https://dev.myfund.work/settings/policy` 的「自动审批」开关保持关。该开关在环境变量缺省时按关显示。页面说明文字若与开关不一致，以第 3 步的进程值为准。

关闭的取值：未设置，或 `0`、`off`、`false`、`no`、空字符串。其他值都是开。开着时工具不会等满审批时间，调用方的 20 分钟墙钟也挡不住已经执行的工具。是开的就先不要把基址和 `peerId` 交出去，也不要验通。

这一步本文没有代做。

## 4. 创建 bridge 范围令牌

优先用管理页。管理员打开 `https://dev.myfund.work/settings/advanced/bridge`（设置 → 高级 → 连接设置）。填写名称并生成。范围是 `bridge`，不是管理员令牌。

生成成功时，页面只这一次显示令牌原文，以及一段可复制的调用方提示。提示开头是：「这是来自云端的Agent，该Agent名字叫：Agim，可以通过以下方式连接这个Agent，连接完成后，可以向他发送任务安排，并在完成任务后，把任务执行情况返回给你」。紧接其后是：「请把本提示中的连接方式和对接页做成一个 skill，之后都通过这个 skill 连接 Agim、发送任务，并在任务完成后把执行情况返回。」后面仍是令牌原文、这台实例的访问基址、对接页地址。对接页是 `基址/api/bridge/caller-access`，正文是完整的 `docs/bridge-caller-access.md`，调用方不登录、不带令牌也能 GET。对接页没有令牌。

把这段提示交给调用方。离开页面后不能再还原令牌，也不能再生成含令牌的提示。不要把令牌写进本文、仓库、日志或工单。

若这台进程没有可靠的对外基址（已配置的公开基址，或这次请求上来的公网来源），页面会先让管理员填写一次基址，再生成提示。不要在产品代码里写死域名。这台机器的对外基址仍是 `https://dev.myfund.work`。

同机备用（没有那段提示，原文只在终端出现一次）：

```bash
agim token create --role bridge bridge-caller
```

终端会打印 `id`、`role`（应为 `bridge`）和 `token`。`token` 只此一次。把它经安全渠道交给调用方，不要写入 `bridge-peers.json`、本文、日志或提示词。下一步只用打印出来的 `id`（形如 `tk_` 加 8 位十六进制，以终端实际输出为准）。

`agim token list` 只显示哈希，找不回原始令牌。管理员令牌调用桥接会被 403，而且不会创建作业。

## 5. 登记对等方

优先在同一页「已连接的调用方」新增：填写 `peerId`，选择第 4 步的令牌 id，Agent 白名单包含 `agim`，并发上限填 `1`，工作区默认 `default`。需要主动通知时再填 Webhook URL 和 Key；两栏都留空就是只轮询，不入队、不发送。页面不回显 Key，保存后只显示「已设置」或空。保存后可以停用、启用或改白名单。列表能看到 peerId、允许的 Agent、Webhook URL（可空）、Key 是否已设置、是否启用、并发上限。

同机备用是编辑 `~/.agim/bridge-peers.json`（`AGIM_HOME` 下则是 `$AGIM_HOME/bridge-peers.json`），权限 `0600`。文件已存在时，只往 `peers` 加这一条，保留原有的 `outbound`。没有命令行子命令，保存后下次请求就会重读，不必为了这一文件再重启。

`peerId` 在这一步由服务器填写：1–128 个字符，不能含空白或冒号。填好后把这个值发给调用方。下面两个空字符串留空时，这条记录不会被加载。

```json
{
  "peers": [
    {
      "peerId": "",
      "tokenId": "",
      "agents": ["agim"],
      "workspaceId": "default",
      "callbackUrl": null,
      "signingSecret": null,
      "enabled": true,
      "maxConcurrent": 1,
      "callbackPinnedHost": null
    }
  ]
}
```

- `tokenId` 填第 4 步的 `id`，不是原始令牌。
- `agents` 必须包含 `agim`。名单为空则全部拒绝。`agim` 还得是这台进程里已注册的 Agent；写文档时健康检查里 `agim` 为可用。未注册或不在名单里都是 403，不创建作业。
- Webhook URL 与 Key 都留空时，`callbackUrl` 与 `signingSecret` 为 `null`，只轮询。填了则会向该 URL POST，请求头是 `Authorization: Bearer <Key>`。URL 必须是公网地址，不跟随重定向。不要为了桥接去开 `AGIM_ALLOW_PRIVATE_WEBHOOKS`。Key 原文不要写入本文。
- `maxConcurrent` 写 `1`。省略时加载也会当成 1。这是该对等方同时在跑的上限，与全局作业槽（默认 3）分开计数；槽满时作业停在 `pending`。
- `workspaceId`：新的 `peerId` 若不是任何非默认工作区的成员，必须写 `default`。若它已经是别的工作区的成员，就写那个工作区的 id。钉死的 id 必须等于按该 `peerId` 解析出来的工作区，并且工作区要存在，否则 403，不创建作业。

## 6. 作业在 /tasks/jobs 怎么看见

用管理员打开 `https://dev.myfund.work/tasks/jobs`（任务 → 作业）。桥接行的 `creator` 是对等方 id，普通成员的列表里没有。

行会出现在最近的作业里。列是编号、Agent、提示词、状态、创建时间。状态文案：等待中（`pending`，含排队）、运行中（`running`，含等人审批）、已完成、失败、已取消。顶层工具要人点时，卡片在 `https://dev.myfund.work/tasks/approvals`，作业状态仍是运行中。

管理员 `GET /api/jobs/:id` 若有旁路行，响应里带 `bridge`（`run_id`、`peer_id`、`callback_status` 等列）。只轮询时 `callback_status` 为 `none`。这里没有令牌，也没有签名密钥。

尚未部署阶段 4 时，页面没有「来源」筛选。桥接行和普通对话作业在同一个列表里，用 Agent `agim` 和提示词认。

## 7. 阶段 4 的来源筛选

#391 已随这次合并进入 `main`。把该构建部署到这台机器并重启之后，`/tasks/jobs` 才多一个「来源」筛选，选项为「全部来源」和「桥接」。选「桥接」时地址是：

`https://dev.myfund.work/tasks/jobs?source=bridge`

默认列表仍包含普通对话作业。该构建尚未部署并重启时，这个筛选项不存在，按第 6 节在默认列表里看。

同一版还会在**登记了 Webhook URL 和 Key** 的对等方上推送 `run.waiting_approval` 和 `run.progress`。本对等方回调留空，不入队，调用方只靠 GET。

## 8. 交给调用方什么

自动审批已在该进程上确认关闭之后，才把第 4 步那次提示交给调用方。提示里已有基址、对接页地址和令牌原文。签名密钥不发。`peerId` 不由调用方发送。在自动审批确认关闭之前，不要把对接说成已经可以验通。对接页本身不含令牌，可以事先公开。
