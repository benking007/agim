# `mcp__agim__ask_user` 结构化用户决策

`ask_user` 用于让 agent 以“结构化选项”向用户提问，并拿到可机器解析的结果。

适用场景：

- 需要在多个候选中确认（消歧）
- 需要用户做明确决策再继续执行
- 需要“选项 + 自定义输入”混合交互

不适用场景：

- 普通开放问答（直接聊天即可）
- 工具调用审批（走审批链路，不走 `ask_user`）

---

## 1. 请求参数

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `question` | `string` | - | 必填，问题文本，1-1000 字符 |
| `choices` | `string[]` | - | 必填，2-9 个选项，每项 ≤ 80 字符 |
| `timeoutSec` | `number` | `300` | 超时秒数，范围 5-1800 |
| `selectionMode` | `'single' \| 'multi'` | `'single'` | 单选或多选 |
| `minSelections` | `number` | `1` | 多选时最少可选数量 |
| `maxSelections` | `number` | `choices.length` | 多选时最多可选数量 |
| `allowCustomInput` | `boolean` | `false` | 是否允许用户给自定义文本 |
| `customInputLabel` | `string` | `其他（自定义输入）` | 自定义输入项的显示文案 |
| `allowTextReply` | `boolean` | `true` | 是否允许文本回复匹配（数字/字母/标签） |

> 向后兼容：不传新字段时，行为与旧版一致（单选 + 可文本回复）。

---

## 2. 返回结构

### 2.1 成功返回

```json
{
  "ok": true,
  "result": {
    "index": 2,
    "label": "张三 B",
    "via": "button",
    "raw": "ask:abc:2",
    "selectionMode": "single"
  }
}
```

字段说明：

- `index` / `label`：主选项（1-based）
- `via`：`button` 或 `text`
- `raw`：原始按钮数据或用户原始文本
- `selectionMode`：`single` 或 `multi`
- `indexes` / `labels`：仅多选时返回
- `customText`：用户走自定义输入时返回；此时 `index = 0`

### 2.2 失败返回

```json
{
  "ok": false,
  "error": "user did not respond within 120s",
  "reason": "timeout"
}
```

`reason` 可能值：

- `timeout`
- `cancelled`
- `invalid`
- `no-messenger`

---

## 3. 交互与平台行为

| 平台 | 呈现方式 | 说明 |
|---|---|---|
| Telegram / Feishu / Discord | 按钮卡片（适配器支持时） | 单选优先使用按钮；文本回复可作为补充 |
| WeChat / DingTalk | 文本提示 | 通过数字/字母/标签匹配 |
| Web Chat | 按钮或文本（依实现） | 语义与核心一致 |
| TUI | 统一决策面板（键盘交互） | 支持单选/多选/自定义输入 |

当前实现中，`selectionMode=multi` 或 `allowCustomInput=true` 的按钮卡主要由 TUI 承载；其他平台走文本回退。

---

## 4. TUI 决策面板

TUI 已将审批与 `ask_user` 统一为“决策交互”：

- 单选：`↑↓/Tab` 选择，`Enter` 提交
- 多选：`↑↓/Tab` 选择，`Space` 勾选，`Enter` 提交
- 自定义输入：选择“自定义输入”后进入输入态，`Enter` 提交，`Esc` 返回选项

同时保留文本兼容能力（当 `allowTextReply=true` 时）。

---

## 5. 按钮回调编码

`ask_user` 目前支持以下按钮数据格式：

- 单选：`ask:<reqId>:<index>`
- 多选：`ask:<reqId>:multi:1,3`
- 自定义输入：`ask:<reqId>:custom:<base64url(text)>`

说明：

- `<index>` 为 1-based
- 多选列表支持逗号分隔，服务端会去重并排序
- 自定义输入使用 base64url 编码，避免特殊字符冲突

---

## 6. 文本匹配规则

当 `allowTextReply=true`：

### 单选

按以下顺序匹配：

1. 数字（如 `2`）
2. 字母（如 `b`）
3. 标签全匹配（忽略大小写）
4. 标签子串匹配

未命中时：

- 若 `allowCustomInput=true`，按自定义文本处理
- 否则不消费消息，继续走正常路由

### 多选

支持：

- 数字集合（如 `1,3`）
- 字母集合（如 `a c`）
- 多标签匹配

未命中时：

- 若 `allowCustomInput=true`，按自定义文本处理
- 否则不消费消息

---

## 7. 约束与边界

- `choices` 必须是 2-9 条
- 多选边界需满足：`1 <= minSelections <= maxSelections <= choices.length`
- 当 `allowTextReply=false` 且当前平台无法承载所需按钮交互时，会直接返回 `invalid`

---

## 8. 最佳实践

- 问题文案尽量短（推荐 < 200 字）
- 选项按优先级排序，提升移动端点击效率
- 多选时明确最少/最多可选数量，减少误操作
- 若业务允许兜底，开启 `allowCustomInput`

---

## 9. Loop Engineering 中的用法

Loop 生命周期里 `ask_user` 有两处硬鼓励场景（契约见 [`architecture/loop-engineering.md`](./architecture/loop-engineering.md) §6）：

| 阶段 | 何时问 | 问完之后 |
|------|--------|----------|
| **ALIGNING（对焦）** | 缺目标或退出条件 | 用户确认 / `/loop confirm` 后再派工 |
| **VERIFYING（中间评审）** | 结论不确定、有疑问、或子代理数据异常 | 用户回复后继续 `loop_verdict` |

验收前父侧等待门禁（`loop-parent-wait-gate`）**放行** `mcp__agim__ask_user`，仍禁止调研 / 再派工。  
线程上若仍有 pending ask（`threadHasPendingAsk`），VERIFY follow-up 与 `verify_skipped` **推迟**，避免人还没答就把 Loop 强行收尾。

结案确认（`met=true` → Portal「结论已就绪」）走 `POST /api/loop/confirm-met`，**不是** `ask_user`。

---

## 10. 可观测性

`ask-user-rpc` 关键日志：

- `ask.opened`（含 `selectionMode` / `minSelections` / `maxSelections` / `allowCustomInput`）
- `ask.resolved.text`
- `ask.resolved.button`
- Loop 推迟收尾：`loop.exit_deferred_pending_ask`

可结合 `/tasks/asks` 观察挂起问题，定位超时与平台投递异常。
