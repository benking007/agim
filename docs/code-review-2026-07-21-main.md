# 代码审查报告（2026-07-21）

> 状态：本轮已落地一批高优先级修复（见 §4）；其余项记入 `tech-debt.md` / 本文 backlog。  
> 入口：`docs/README.md` · 规范：`docs/coding-standards.md` · 安全基线：`docs/security-hardening.md`

审查范围：全仓高风险面（鉴权 / 密钥 / LLM / Agent 执行 / WebSocket / 发布），并复核近日 LLM 预设与自定义高级参数改动。

## 1. 结论摘要

控制面硬化整体扎实（token 哈希、loopback 反代校验、workspace realpath、sensitive-path、ACP/webhook SSRF）。主要风险集中在：

1. **部署默认值偏开放**（`AGIM_AUTO_APPROVE=1`、FS 非默认隔离）——产品定位是单用户本机，但接开放 IM 时危险。
2. **文档与实现漂移**：`role=user` 在 REST 上接近只读，但 **WebSocket 聊天（含手机 Portal）故意允许驱动 Agent**。
3. **LLM 配置面近期债**：`thinkingFormat: off` 被 runtime 绕过、厂商 host 族去重不全、`extraHeaders` 明文回传、OpenAICompat 忽略 `maxTokensField`。

本轮已修复第 3 类中的可验证缺陷，并补齐编码规范文档。

## 2. 发现清单（按严重度）

| ID | 级别 | 主题 | 状态 |
|---|---|---|---|
| H1 | High | `thinkingFormat: off` 在 Agim Agent runtime 仍按 URL 启发式开 thinking | **已修** |
| H2 | High | 内置预设去重只比 exact hostname，忽略 intl 族（moonshot.ai / z.ai / …） | **已修** |
| H3 | High | `GET /api/llm` 回传 `extraHeaders` 明文（含 api-key） | **已修**（list 脱敏；拒 `Authorization`） |
| H4 | High | OpenAICompat ping/角色路径忽略 `maxTokensField` | **已修** |
| H5 | Medium | Composer context 环忽略 backend `contextWindow`；缺 MiMo 启发式 | **已修** |
| H6 | Medium | `llm-secrets.json` 非原子写 | **已修**（tmp+rename） |
| H7 | Medium | Auth cookie 缺 `HttpOnly` | **已修**（SPA 走 localStorage） |
| H8 | Medium | Backend name 大小写唯一性不一致 | **已修**（add 路径） |
| P0a | P0* | `role=user` 可经 WS 驱动 Agent | **文档澄清**（Portal 有意设计；非 REST 越权） |
| P0b | P0* | 默认 `AGIM_AUTO_APPROVE=1` + 空 allowlist | **已修**（默认关；开放 IM 无 strict allowlist 时 suppress；见 #218/#219） |
| P1a | P1 | LLM/MCP URL 缺 ACP 级 SSRF 护栏 | Backlog |
| P1b | P1 | WS `threadOwners` 仅内存；重启后 first-claim | **已修**（`web-thread-owners.ts` 持久化） |
| P1c | P1 | 默认 FS 非 restrict | Backlog（产品默认；`AGIM_NATIVE_FS_RESTRICT=1` 可选） |
| P2a | P2 | MCP GET 返回 auth headers 明文 | Backlog |
| P2b | P2 | `tokens.json` RMW 竞态 | Backlog |
| P2c | P2 | 移动 QR 把 raw token 放进 query | Backlog |
| M1 | Medium | SPA 预设 SSOT 与 `/api/llm/presets` 未接通 | Backlog |
| M2 | Medium | 组删除非原子（逐条 DELETE） | Backlog |
| L1 | Low | i18n：secret source / role 标签硬编码 | Backlog |

\*P0 标注为「开放 IM / 误配场景下的真实风险」；对「本机单用户 + Web 控制台」默认画像不视为阻断。

## 3. 设计澄清：`role=user` 与 Portal 聊天

| 面 | 行为 |
|---|---|
| REST mutation（配置 / env / 服务生命周期 / viewer DELETE…） | **需要 admin** |
| WebSocket `/ws` 消息驱动 Agent（桌面聊天 + `/m/chat`） | **任意有效 token**，含手机 QR 的 `role=user` |

这是产品选择：Portal 用降权 token 聊天，但不能改控制面。`security-hardening.md` §3.1 已同步为「REST 只读 + 可聊天」，避免再被当成实现漏洞。

若未来要更严：引入显式 `chat` capability，或给 mobile token 单独 scope，而不是直接对 `user` 封死 WS。

## 4. 本轮代码改动

- `agim-agent/index.ts`：`thinkingFallback` 先看 `model.reasoning`
- `presets.ts` / `quick-enable.ts` / SPA `llm-presets.ts`：`builtinPresetKeyForBaseUrl` 厂商族去重
- `llm-api.ts`：`redactExtraHeaders`；拒 `Authorization`；name 大小写冲突
- `openai-compat-provider.ts` + registry：贯通 `maxTokensField`
- `secrets.ts`：原子写
- `server.ts`：`HttpOnly` cookie
- Composer：优先 `contextWindow`；MiMo 窗口启发式
- 文档：本文、`coding-standards.md`、security / tech-debt / llm-backends / CHANGELOG

## 5. 建议后续迭代（不阻塞发版）

1. 复用 `assertSafeAcpUrl` 护 LLM `baseUrl` + MCP HTTP URL；`redirect: 'manual'`
2. ~~持久化 `threadId → tokenId`~~（已落地 `web-thread-owners.ts`）
3. MCP list 脱敏 auth headers
4. SPA 运行时消费 `GET /api/llm/presets`（或 codegen 对齐测试）
5. `DELETE /api/llm/backends?label=` 组删事务
6. Mobile QR 改为 short-TTL exchange code
7. 继续 peel `approval-bus.ts` 厚门面；触摸 >800 行软警告文件时顺带拆分

## 6. 测试与发版

- 相关单测：presets / quick-enable / llm-api / openai-compat / think-command
- 发版路径：合并 PR → Auto Version Bump → Publish（`workflow_call`）
