# 首次引导设计：安装后 → 访问地址 → 填入 API Key → 开始对话

> 状态：**设计方案（拟实施）** · 目标版本：v1.6+ · 关联：`docs/code-review-2026-08-15.md`（易用性 §3）、`docs/llm-backends.md`、`docs/architecture/current.md`
> 定位：降低 Agim 首次安装到"第一次对话"的门槛，把当前 CLI 菜单式引导（`agim go`）改为**"启动服务 → 浏览器向导 → 填一个 API Key → 直接聊天"**。

---

## 1. 问题与目标

### 1.1 现状痛点

首次安装后的路径（`npm install -g agim-cli && agim go`）目前是 **CLI 交互式菜单**：

```
agim go
→ 语言选择（zh/en）
→ 菜单：配置 Agim Agent 大模型 API / 查看 Agent CLI 安装命令 / 先运行本机体检 / 进入完整配置菜单
→（选"配置 Agim Agent"后）进入 setup-llm **纯英文**子向导（CR U11）
→ 保存 → 启动服务 → 打印 http://localhost:3000
→ 打开浏览器 → 还要在 Settings→LLM 里再确认一遍
```

对非 CLI 重度用户，这是一条**命令行长链路**：多步菜单、中英混杂、且最终配置入口其实藏在 Web 设置深处。CR 2026-08-15 已确认：**"填一个 key 完成初始化"所需的全部积木已经存在**（`POST /api/llm/quick-enable`、`POST /api/llm/backends/:name/ping`、`GET /api/llm/presets`、SPA `QuickAgentSetupCard`），但：

1. 没有"首次运行判定"（服务端不知道"这是不是第一次、是否需要引导"）。
2. 没有首访向导页（`/` 直接进聊天页，只在 FirstRunPanel 里提示"去 Settings 配置"）。
3. `agim go` 是 CLI 菜单而非"启动 + 打开浏览器"。
4. 完成引导后没有"成功 → 进入聊天发第一条消息"的衔接。

### 1.2 设计目标（用户旅程）

安装完成后的理想体验：

```
$ npm install -g agim-cli && agim go
→ 检测本机 agent（无可用 CLI agent）
→ 后台启动服务
→ 打印：  🚀 Agim 已启动
          Web 控制台：http://localhost:3000/setup
   （自动尝试打开默认浏览器）
→ 浏览器打开初始化向导：
   [步骤 1/3] 欢迎 + 选择模型（DeepSeek 推荐 / Kimi / GLM / MiMo / 自定义 / 本地 Ollama）
   [步骤 2/3] 填入 API Key（粘贴）
   [步骤 3/3] 测试连接 → ✅ 成功 → 进入聊天页
→ 聊天页发第一条消息，引导完成。
```

**核心原则：CLI 只负责"启动 + 给地址"，配置全部交给浏览器向导。** CLI 完整向导（`agim config` / `setup-llm`）保留为高级路径。

---

## 2. 现状积木盘点（复用，不重复造）

| 已有能力 | 位置 | 说明 |
|---|---|---|
| 一键启用 LLM 后端 | `POST /api/llm/quick-enable`（`src/web/llm-api.ts:161-205` → `quickEnableLlmPreset`） | 传 `preset + apiKey` → 自动创建 backend、写入 secret、绑定 `native-chat` role、设为默认 agent |
| 连通性测试 | `POST /api/llm/backends/:name/ping`（`llm-api.ts:134-137`） | 保存后可立即验证 key 是否可用 |
| 模型预设列表 | `GET /api/llm/presets`（`llm-api.ts:104-106`、`presets.ts`） | DeepSeek（推荐）/ Kimi / GLM / MiMo / Custom |
| 首访快速配置卡片 | `QuickAgentSetupCard`（`src/web-app/src/routes/settings/llm.tsx:271-420+`） | 完整的"选预设→填 key→保存→测试"UI 已存在，**只缺独立页面** |
| SPA 钩子 | `useLlmQuickEnable` / `useLlmPing` / `useLlmPresets` / `useAgentsStatus` / `useConfig` | 前端拼装判定所需数据已齐 |
| loopback 免登 | `src/web/auth.ts` `isTrustedLoopbackPeer` | 本机浏览器访问**无需 token 即 admin**（首访零障碍） |
| bootstrap token | `~/.agim/web-bootstrap-token` + `agim token bootstrap` | 远程访问场景的登录凭证 |
| 服务启动+打印地址 | `offerServiceStart`（`cli-ui/cmd-handlers.ts:747+`）、`printWebConsoleLine`、`openBrowserUrl`（`cmd-handlers.ts:51`） | `agim web --start --open` 已有完整"启动+打开浏览器"实现 |
| 聊天页首访面板 | `FirstRunPanel`（`chat.tsx:481-583`） | 已有四步引导 + 示例 prompt 按钮 |

**结论：本轮新增面很小——1 个状态 API + 1 个前端向导页 + CLI 少量改动。**

---

## 3. 详细设计

### 3.1 服务端：首次运行状态 API（新增）

**`GET /api/onboarding/status`**（`src/web/server.ts` 注册，处理函数放新文件 `src/web/onboarding-api.ts`；沿用 `sendError` 契约，CR U8 姿势）

```jsonc
// 200
{
  "firstRun": true,            // 判定结果：是否处于"首次引导"状态
  "reason": "no-usable-agent", // 细分：no-usable-agent | no-llm | cli-agent-available | ready
  "hasLlmSecret": false,       // 是否存在带 secret 的 llmBackends
  "availableCliAgents": [],    // 本机可用 CLI agent 名列表
  "defaultAgent": "agim",
  "skipped": false             // 用户是否点过"跳过"（持久化标记）
}
```

**判定逻辑**（放在 `src/core/onboarding.ts` 新增 `getOnboardingStatus()`）：

```
usableLlm = 存在 llmBackends 条目且 resolveSecret(...) 非 none
cliOk    = checkAgentsFresh(config).available 非空（复用现有 readiness.ts 逻辑）

if  !cliOk 且 !usableLlm  → firstRun=true,  reason='no-usable-agent'
elif  usableLlm           → firstRun=false, reason='ready'
elif  cliOk               → firstRun=false, reason='cli-agent-available'
```

**"跳过"标记**：写入 `~/.agim/setup-skipped`（或 config 加 `setupSkipped: true` 字段——**选 config 字段**，避免第三个状态文件，与 `config-schema.ts` 的 `passthrough()` 兼容）。`skipped=true` 时 `firstRun=false`（向导不再强制，但 Settings→LLM 里仍可随时配置）。

### 3.2 前端：`/setup` 初始化向导页（新增路由 + 页面）

**路由**：`src/web-app/src/router.tsx` 加 `{ path: '/setup', element: <SetupRoute /> }`（独立于主布局，无侧栏，全屏居中卡片）。

**重定向**：在 `chat.tsx`（`/`）挂载时调 `GET /api/onboarding/status`：
- `firstRun=true` → `<Navigate to="/setup" replace />`（不再显示 FirstRunPanel，直接进向导）
- `skipped=true` 或 `reason='cli-agent-available'` → 正常进聊天（FirstRunPanel 已有提示）

**页面结构**（`src/web-app/src/routes/setup.tsx`，3 步，复用 `QuickAgentSetupCard` 组件）：

```
步骤 1/3 · 欢迎与选择
  - 标题：🚀 欢迎使用 Agim（阿吉姆）
  - 说明：连接你的第一个大模型，即可开始对话。也可以稍后配置（跳过）。
  - 卡片：DeepSeek（推荐）/ Kimi / GLM / MiMo / 自定义（OpenAI 兼容）/ 本地 Ollama（免 Key）
    （从 useLlmPresets 渲染，与 Settings→LLM 一致；本地 Ollama = custom 预设 + 空 key 提示）

步骤 2/3 · 填入 API Key
  - 密码框 + 粘贴按钮 + "Key 只保存在本机 ~/.agim/llm-secrets.json"
  - 自定义预设时补 baseUrl / model 输入（复用现有表单字段）

步骤 3/3 · 测试与完成
  - 保存（useLlmQuickEnable）→ 测试（useLlmPing）
  - 成功：✅ 已连接 · 平均延迟 xx ms → 按钮「开始聊天」→ navigate('/?welcome=1')
  - 失败：展示 ping 返回的具体错误（可操作文案，如"401 密钥无效 / 网络不可达"）
  - 底部：`跳过，稍后配置`（写入 setupSkipped 标记 → navigate('/')）
```

**组件抽取**：把 `QuickAgentSetupCard` 从 `settings/llm.tsx` 抽到 `src/web-app/src/components/setup/quick-agent-setup.tsx`（props 不变），`/setup` 页与 Settings→LLM 页共用同一实例——保证"首次引导"与"设置页"行为一致、不产生第二套逻辑。

**i18n**：新增 `setup.json` 双语（en/zh），`check-i18n` 保持 11×2 parity；文案遵循 CR U1–U6 教训（en 词典不得含中文）。

### 3.3 CLI：首次运行自动进入向导（"安装后自动执行 agim go"的正确落地）

**先说清一个现实约束**：npm 安装本身**不会、也不应该**自动运行 `agim go`——
- `postinstall` 自动启动守护进程 / 弹浏览器是反模式（`--ignore-scripts` 或 CI 环境下不生效，且吓到用户）；
- 全局安装的 CLI 无法在安装完成时可靠地拿到用户交互上下文。

因此"首次安装后自动串联首次设置"的正确落地是 **入口即向导**：用户安装后敲的第一个命令就是 `agim`（无参数），检测到 first-run 时**跳过菜单直接进入首次设置流程**——对用户而言等价于"装完自动开始配置"。

**改动 1 · `entry-menu.ts`：first-run 直通（核心）**

```
runEntryMenu():
  lang = await pickLang()                      // 保留语言选择（向导/打印需要）
  if (await getOnboardingStatusCli().firstRun) // 新增同步判定（见下）
     → 不弹菜单，直接 return { action: { kind: 'quickstart' }, lang }
  ...原有菜单逻辑不变
```

即裸 `agim` 首次运行 = `agim go`。菜单只对非首次（已配置/已跳过）用户显示。

**改动 2 · `quickstart.ts` 重构为"启动 + 打开浏览器"**（保留签名 `runQuickstart(lang)`）：

```
1. loadConfig + checkAgentsFresh（同现状）
2. 若有可用 CLI agent（claude-code 等已安装）→ 维持现状：选中默认 agent，启动服务，打印地址（不进向导）
3. 若无可用 agent：
   a. 不再弹 CLI 菜单（删除 configureNativeAgent 的 setup-llm 委托）
   b. 直接 offerServiceStart() 启动后台服务（或提示前台启动）
   c. 打印：🚀 首次启动，请打开：http://localhost:3000/setup
   d. 尝试 openBrowserUrl(url)（复用 cmd-handlers.ts:51；失败则仅打印）
   e. 打印 bootstrap token 提示（远程访问场景）：`agim token bootstrap`
```

**改动 3 · 判定复用**：CLI 侧用与 `GET /api/onboarding/status` **同一套核心判定**——把 `getOnboardingStatus()`（§3.1）做成纯函数放 `src/core/onboarding.ts`，`onboarding-api.ts` 与 `entry-menu.ts` 各自调用（API 走 async 版本，CLI 走同步/缓存版本 `checkAgentsFresh`，readiness.ts 已有缓存，首敲 `agim` 的额外耗时 <100ms）。

**改动 4 · 启动横幅提示**：`start-runtime.ts` 启动完成后若 `getOnboardingStatus().firstRun`，横幅追加一行 `   🆕 首次使用？打开 http://localhost:3000/setup 完成初始化`（复用现有 i18n 通道，不硬编码中文——修 CR U2 同类问题）。

**兼容**：`agim go` 命令本身保留且行为一致（显式路径）；`agim config`、`setup-llm`、`doctor` 全部保留不动（高级路径）。已配置过的用户敲 `agim` 看到的菜单与现状完全相同（回归面小）。

### 3.4 安全

| 场景 | 机制 | 说明 |
|---|---|---|
| 本机访问 | loopback 免登（已有） | `isTrustedLoopbackPeer` 直接 admin，首访零 token 障碍 |
| 远程访问 | bootstrap token（已有） | CLI 打印 `agim token bootstrap` 提示；`/setup` 走 `requireAdmin` 同一鉴权链 |
| API Key 存储 | `~/.agim/llm-secrets.json`（已有，原子写 + chmod 600） | 向导页**不落 localStorage**，只经 `POST /api/llm/secrets/:name` 走服务端 |
| 向导 API 鉴权 | `/setup` 页面 + `/api/onboarding/status` 均过 `requireAdmin`（`firstRun` 状态本身非敏感，但写入类操作必须鉴权） | 与现有 API 一致 |
| 跳过标记 | config `setupSkipped`（非敏感） | 无权限扩散 |

### 3.5 边界与降级

| 场景 | 行为 |
|---|---|
| 已安装 Claude Code/Codex 等 | `reason='cli-agent-available'` → 不进向导，直接聊天（FirstRunPanel 显示可用 agent） |
| 用户想用本地 Ollama | 步骤 1 选"本地 Ollama" → 步骤 2 显示"无需 Key，填 baseUrl（默认 http://localhost:11434/v1）" |
| 用户点跳过 | 写 `setupSkipped=true` → 进聊天页（无 agent 时 FirstRunPanel 仍提示"配置 Agent"）；Settings→LLM 随时可回 |
| key 无效 | 步骤 3 ping 失败 → 显示具体错误 + 返回步骤 2 修改（不清空已填 baseUrl/model） |
| 服务未启动访问 /setup | 正常登录后 404？→ 不：向导页静态存在，status 返回 `reason='ready'` 时页面显示"已完成初始化"并给「进入聊天」按钮（幂等） |
| 断网 | 步骤 3 ping 超时 → 提示网络错误，允许"先保存，稍后测试" |
| 已有 `~/.agim/config.json` 旧配置 | 判定按实际可用性，不按文件存在性 → 老用户不会误触发向导 |

---

## 4. 实施清单（按依赖排序）

| # | 任务 | 文件 | 预估 |
|---|---|---|---|
| 1 | `getOnboardingStatus()` 核心判定（纯函数，CLI/API 共用） | `src/core/onboarding.ts`（新增导出） | 0.5d |
| 2 | `GET /api/onboarding/status` + `setupSkipped` 读写 | `src/web/onboarding-api.ts`（新增）、`server.ts` 注册、`config-api.ts` 允许字段 | 0.5d |
| 3 | `QuickAgentSetupCard` 抽为共享组件 | `src/web-app/src/components/setup/quick-agent-setup.tsx`（新增）、`settings/llm.tsx` 改引用 | 0.5d |
| 4 | `/setup` 向导页 + 路由 + 重定向逻辑 | `src/web-app/src/routes/setup.tsx`（新增）、`router.tsx`、`chat.tsx`（首访重定向） | 1d |
| 5 | `setup.json` 双语 i18n + check-i18n | `src/web-app/src/i18n/locales/{en,zh}/setup.json` | 0.5d |
| 6 | `entry-menu.ts` first-run 直通（裸 `agim` = `agim go`） | `src/cli-ui/entry-menu.ts` | 0.5d |
| 7 | `agim go` 简化 + 启动横幅提示 | `src/cli-ui/quickstart.ts`、`src/cli/start-runtime.ts`、`i18n.ts`（en 词典补全） | 1d |
| 8 | 测试：状态判定单测 + 入口直通测试 + 向导页组件测试 + quickstart 流程测试 | `onboarding.test.ts`、`entry-menu` 相关、`setup.test.tsx` | 1d |
| 9 | 文档：README 快速开始改写（`agim` 首敲即引导）、docs 导航 | `README.md` / `README.zh-CN.md`、`docs/README.md` | 0.5d |

**总计约 6 人日**（复用为主，新增代码面小）。

---

## 5. 验收标准

1. 全新环境安装后**首次敲 `agim`**：跳过菜单直接进入首次设置（等价 `agim go`），无可用 CLI agent 时打印 `http://localhost:3000/setup` 并自动打开浏览器。
2. 浏览器打开 `/setup`：三步向导可完成"选 DeepSeek → 粘贴 Key → 测试成功 → 进入聊天页"。
3. 聊天页发第一条消息能收到 agent 回复（默认 agent=agim，llmBackends 已配置）。
4. 跳过路径：点"跳过"后进聊天页不再强制向导；再敲 `agim` 恢复显示正常菜单；Settings→LLM 仍可配置。
5. 已有 CLI agent 的机器：`agim go` / 裸 `agim` 均不弹向导，行为与现状一致（回归）。
6. en/zh 双语完整，`check-i18n` 通过；向导页无硬编码中文。
7. 远程访问（非 loopback）：未登录时访问 `/setup` 被导向登录页，`agim token bootstrap` 可登录后进入。
8. 回归：`npm run verify:release` 全绿（含新增测试）。

---

## 6. 开放问题（实施前确认）

- **Q1**：`/setup` 是否也应在"已有 CLI agent 但用户想用 LLM"时可达？—— 建议：是，路由常驻，仅"重定向强制"按 firstRun 判定。
- **Q2**：跳过标记放 config 字段还是独立文件？—— 建议 config 字段（`setupSkipped`），与现有 `passthrough()` 兼容，避免第三个状态文件。
- **Q3**：向导是否要支持"同时配置多个 backend"？—— 建议首版只配一个（向导的承诺就是"填一个 key"），多 backend 走 Settings→LLM。
- **Q4**：`agim go` 的"查看 CLI 安装命令"入口是否保留？—— 建议保留为向导页"使用本地 Agent CLI"分支（展示 install hint），CLI 菜单中移除。
- **Q5**：裸 `agim` first-run 直通后，用户想中途退出（不想现在配置）怎么办？—— 建议：quickstart 流程保留 `Ctrl-C` 退出（现状已支持 `UserAbortError`），退出后写入 `setupSkipped`，下次敲 `agim` 恢复菜单；或提供向导页"跳过"按钮（等价）。
- **Q6**：安装后是否要打印一句欢迎语（如 npm 安装完成提示"运行 `agim` 开始配置"）？—— 建议：不做 postinstall（见 §3.3 约束），改为 README 首行强调 + 本项目 `agim` 包 description 引导。
