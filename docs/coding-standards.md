# Agim 编码与文档规范

面向贡献者与 agent 的**现行**约定。历史 CR 报告见 `docs/code-review-*.md`（归档）。

## 1. 仓库布局

| 区域 | 约定 |
|---|---|
| `src/core/` | 无 UI 的核心（config、session、LLM registry、approval） |
| `src/plugins/` | Agent / Messenger 适配器；勿从 core 反向依赖插件 UI |
| `src/web/` | Node HTTP/WS 服务端 |
| `src/web-app/` | Vite SPA；自有 `package.json` / lockfile |
| `docs/` | 现行文档；计划/分析稿必须打「归档」戳并进 `docs/README.md` |

**SSOT（勿维护第二份表）：**

- Agent 清单 → `docs/agents.md`
- LLM 内置预设 → `src/core/llm/presets.ts`（SPA `lib/llm-presets.ts` 须注释对齐；优先消费 `/api/llm/presets`）
- 发版 → `docs/release.md` + `.github/workflows/`

## 2. TypeScript / Node

- 运行时 **Node ≥ 22.19**；公共 API 用 ESM + `.js` 扩展名 import。
- 配置变更走 `updateConfigObject` + `configSchema`（原子写 + 锁）；**不要**直接 `writeFileSync(config.json)`。
- 密钥文件（`llm-secrets.json`、token 文件）必须 **0600**，写入用 tmp+rename（或等价原子替换）。
- 对外 HTTP JSON：**永不**回传 raw API key；敏感 header 在 list API 脱敏。
- URL 出站（LLM / MCP / webhook / ACP）：优先复用现有 SSRF 护栏（`url-guard` / webhook DNS 检查）；新出口必须评估私网与 redirect。
- 错误：面向操作员的短消息；内部细节进 pino（`event:` 稳定字段）。

## 3. 测试

| 套件 | 命令 | 说明 |
|---|---|---|
| 默认 | `npm test` → `bun test --isolate` | 多数单元；会改 env/registry |
| 类型 | `npm run typecheck` | src + test 双 tsconfig，均须 0 |
| Lint | `npm run lint` | backend + SPA；SPA **零 warning** |
| SQLite | `npm run test:sqlite` / `test:node` | Bun 跳过 native；CI 发版门禁 |

规则：

- 改行为必须带/更新测试；隔离用例勿依赖真实网络。
- 测文件里不要用已删除的 preset key（如 `openai`/`anthropic` 内置）去调 `Set<LlmPresetKey>.has`——用 `Set<string>` 或展开数组。
- SPA 组件若用到 react-query，测试须包 `QueryClientProvider`。

## 4. Web / SPA

- 鉴权：token 在 `localStorage`（`agim_token`）+ `Authorization`；cookie 为同源辅助且 **HttpOnly**。
- 角色：`admin` 管 REST mutation；`user` 可 Portal/桌面 **WS 聊天**，不可改控制面（见 `security-hardening.md` §3.1）。
- i18n：用户可见文案进 `en`/`zh` locale；禁止新增长文硬编码（ping 短符号除外需逐步清理）。
- Bundle：`postbuild` 预算（entry 350 KiB / chunk 400 KiB）不可靠抬高掩盖回归。
- React：跟随仓库既有模式；勿默认堆 `useMemo`/`useCallback`。用依赖数组「只为触发副作用」时，优先 render-time baseline sync（避免 biome `useExhaustiveDependencies` 误报）。

## 5. LLM / Agim Agent

- 一键启用：`quick-enable` 写 `label=presetKey`；去重 = label **或** `builtinPresetKeyForBaseUrl`（厂商 host 族）。
- `thinkingFormat`：`undefined`=启发式；`deepseek`/`openai`=强制协议；`off`=关闭 reasoning **且**清除 catalog thinking compat（resolver + runtime 均须尊重 `model.reasoning`）。
- OpenAICompat（ping/cheap）与 pi provider-resolver 对 `maxTokensField` / thinking 的行为应可预期对齐；自定义高级参数改动要双路径检查。
- Backend `name` 唯一性按**大小写不敏感**处理。

## 6. 安全默认与脚枪

文档化、勿 silently 改破坏单用户 UX 的默认值，但新代码不得扩大攻击面：

| 变量 | 默认取向 | 备注 |
|---|---|---|
| `AGIM_AUTO_APPROVE` | `1`（开放） | 接公网 IM 必须关 + allowlist |
| `AGIM_NATIVE_FS_RESTRICT` | off | 多用户/IM 建议 on |
| `AGIM_WEB_AUTH=off` | 显式逃逸 | 非 loopback 绑定极危险 |
| `AGIM_WEB_AUTH` cookie | HttpOnly | XSS 仍可经 localStorage 偷 token——修 XSS 优先 |

敏感路径 denylist ≠ 沙箱；MCP 工具当前绕过部分 sensitive 检查——接入第三方 MCP 时按敌意模型评估。

## 7. 文档与发版

- 用户可见行为变更：更新对应 `docs/*.md` + `CHANGELOG.md` `[Unreleased]`。
- 一次性 CR / 分析：`docs/code-review-YYYY-MM-DD-main.md`，并挂进 `docs/README.md` 归档表。
- **禁止**只推 tag 发版。路径：合并 `main` → Auto Version Bump → `workflow_call` Publish；核对 `npm view agim-cli version`。
- 依赖安装：根目录与 `src/web-app` 均用 `npm ci`。

## 8. PR 检查清单（精简）

- [ ] `npm run typecheck` / `npm run lint` 本地或 CI 绿
- [ ] 相关 bun/vitest 覆盖新分支
- [ ] 无密钥进日志 / 无敏感字段进 list API
- [ ] 文档与 CHANGELOG 已更新（若用户可见）
- [ ] 未抬高 SPA bundle budget
