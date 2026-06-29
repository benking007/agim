// hallucination-detector — flag turns where the assistant TALKS about
// invoking a native_* tool but never actually emits a toolCalls entry
// (v1.2.147).
//
// Why: DeepSeek-v4 and other Chinese-tuned LLMs occasionally degrade in
// long, error-recovery contexts and start narrating tool invocations
// instead of emitting them through the function-calling schema. The
// model says "我现在调用 native_write_file: ```python …```" but
// `message.tool_calls` stays empty. Downstream we treated that as a
// normal text reply and the user got "卡住没消息" — promise without
// follow-through.
//
// This detector is a fail-safe last-mile check: pure function over the
// assistant text + the actually-emitted toolCalls. When both signals
// align (narrated intent + zero real calls), we tag the turn with
// `finishReason='hallucinated_tools'` so the native adapter renders a
// targeted recap card rather than shipping the lie to the user.
//
// Off by default? No — the patterns are conservative (high-precision,
// not high-recall) and false positives just trigger a recap card that
// invites the user to retry. False negatives are silent regressions.
// Operators who want it off can set AGIM_NATIVE_HALLUCINATION_DETECT=off.

export interface HallucinationInput {
  /** The assistant's final text for this iteration. */
  text: string
  /** Tool names declared in the loop's input.tools[]. When provided we
   *  use them to tighten matching: a narrated call like "I will call
   *  native_foo" only counts if `native_foo` is in our actual tool
   *  surface. Empty array = skip the cross-check (treat any native_*
   *  name as a candidate). */
  toolNames?: ReadonlyArray<string>
  /** How many real tool calls the LLM emitted this iteration. We flag
   *  only when 0 — if the model emitted even one real call we trust the
   *  narration was framing a follow-up. */
  emittedToolCallCount: number
}

export interface HallucinationVerdict {
  /** True iff the text narrates a tool call but no real calls happened. */
  hallucinated: boolean
  /** The matched substring (≤120 chars, single-line) for audit / debug. */
  evidence?: string
  /** Which pattern fired — useful for tuning + analytics. */
  pattern?: 'zh:invoke-narration' | 'zh:promise-no-action' | 'en:invoke-narration' | 'zh:direct-write-block'
}

/**
 * Read the kill-switch env. Default ON.
 * Recognized OFF values: 'off' / '0' / 'false' / 'no' / 'disable'.
 */
export function isHallucinationDetectorOn(): boolean {
  const raw = (process.env.AGIM_NATIVE_HALLUCINATION_DETECT ?? '').toLowerCase().trim()
  if (raw === 'off' || raw === '0' || raw === 'false' || raw === 'no' || raw === 'disable') {
    return false
  }
  return true
}

// Pattern set. ORDER MATTERS — we report the first match so the more
// specific signals (direct-write-with-code-block) win over generic ones.

interface Pattern {
  id: HallucinationVerdict['pattern']
  re: RegExp
  /** Whether the match must reference a real native_* tool name from
   *  the loop's tool surface. When true we extract a capture group and
   *  cross-check; when false the pattern is intent-only. */
  needsToolName?: boolean
}

const PATTERNS: Pattern[] = [
  // "直接写文件：\n```...```" — model is about to dump a code block as
  // if that *were* the file write. Strongest signal; this is the exact
  // shape that triggered the bug in the user's screenshot.
  {
    id: 'zh:direct-write-block',
    re: /(?:直接|马上|立刻|这次|现在)?\s*(?:不废话[,，]?\s*)?直接\s*(?:写|存)\s*(?:文件|代码|内容)?[\s:：]*\n*```/,
  },
  // "我现在调用 native_write_file" / "我这就调 native_xxx" — explicit
  // Chinese narration of a tool call. Capture the tool name and check
  // it exists in the tool surface (when surface known).
  {
    id: 'zh:invoke-narration',
    re: /(?:我|让我|我来|这就|现在|我这就)\s*(?:就|马上|现在)?\s*(?:去)?\s*(?:调|调用|使用|跑|run|call|use)\s*[`'"]?\s*(native_[a-z_][a-z0-9_]*)/i,
    needsToolName: true,
  },
  // "I will call native_xxx" / "Let me invoke native_xxx" — English form.
  {
    id: 'en:invoke-narration',
    re: /(?:I(?:'?ll)?\s*(?:will\s*)?(?:now\s*)?|let\s*me\s*(?:now\s*)?)(?:call|invoke|use|run|execute)\s+[`'"]?\s*(native_[a-z_][a-z0-9_]*)/i,
    needsToolName: true,
  },
  // "这次不废话，直接写。" / "这次直接写完整文件。" — empty promise without
  // tool reference. Lower precision but the user's actual fail mode.
  {
    id: 'zh:promise-no-action',
    re: /(?:这次|这一次)\s*(?:不废话|不啰嗦|不解释)[,，。\s]*\s*(?:就|直接|马上)?\s*(?:写|存|做|调用?|开始)/,
  },
]

/**
 * Decide whether the text narrates a tool call that never actually
 * happened. Pure function; no I/O.
 */
export function detectHallucinatedToolCall(input: HallucinationInput): HallucinationVerdict {
  // Real tool calls happened → trust the model.
  if (input.emittedToolCallCount > 0) return { hallucinated: false }
  // Empty text can't narrate anything; that's handled by blank-retry.
  if (!input.text || input.text.length < 4) return { hallucinated: false }

  const toolSet = input.toolNames && input.toolNames.length > 0
    ? new Set(input.toolNames)
    : null

  for (const p of PATTERNS) {
    const m = p.re.exec(input.text)
    if (!m) continue
    // Cross-check the captured tool name against the real surface so we
    // don't false-positive on "I'll call native_foo (which doesn't
    // exist)" educational discussions. When surface unknown, skip.
    if (p.needsToolName && toolSet) {
      const cap = m[1]
      if (!cap || !toolSet.has(cap)) continue
    }
    return {
      hallucinated: true,
      pattern: p.id,
      evidence: previewMatch(input.text, m.index, m[0].length),
    }
  }
  return { hallucinated: false }
}

/** Build a single-line ≤120-char preview around the match for audit. */
function previewMatch(text: string, idx: number, len: number): string {
  const start = Math.max(0, idx - 30)
  const end = Math.min(text.length, idx + len + 30)
  return text.slice(start, end).replace(/\s+/g, ' ').trim().slice(0, 120)
}
