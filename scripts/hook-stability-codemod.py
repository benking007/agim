from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: expected one match, found {count}')
    return text.replace(old, new, 1)


# Desktop chat: message updates intentionally trigger scrolling, so represent
# that trigger as a value actually consumed by the effect.
path = Path('src/web-app/src/routes/chat.tsx')
text = path.read_text()
if 'const messageScrollKey =' not in text:
    text = replace_once(
        text,
        "  // Auto-scroll to bottom on new messages OR streaming chunk. Use\n",
        "  const messageScrollKey = `${state.messages.length}:${state.messages.at(-1)?.content.length ?? 0}`\n\n  // Auto-scroll to bottom on new messages OR streaming chunk. Use\n",
        'desktop chat scroll key',
    )
    text = replace_once(
        text,
        "  useEffect(() => {\n    if (!listRef.current) return\n",
        "  useEffect(() => {\n    if (messageScrollKey === '0:0' || !listRef.current) return\n",
        'desktop chat scroll guard',
    )
    text = replace_once(
        text,
        "  }, [state.messages, state.currentReplyId])",
        "  }, [messageScrollKey, state.currentReplyId])",
        'desktop chat scroll deps',
    )
    path.write_text(text)


# Mobile chat: same scroll signal, plus make the textarea input dependency
# explicit because the DOM measurement happens after that value renders.
path = Path('src/web-app/src/routes/m/chat.tsx')
text = path.read_text()
if 'const messageScrollKey =' not in text:
    text = replace_once(
        text,
        "  // Auto-scroll to bottom on new messages OR streaming chunk. Same\n",
        "  const messageScrollKey = `${state.messages.length}:${state.messages.at(-1)?.content.length ?? 0}`\n\n  // Auto-scroll to bottom on new messages OR streaming chunk. Same\n",
        'mobile chat scroll key',
    )
    text = replace_once(
        text,
        "  useEffect(() => {\n    const el = listRef.current\n    if (!el) return\n",
        "  useEffect(() => {\n    const el = listRef.current\n    if (messageScrollKey === '0:0' || !el) return\n",
        'mobile chat scroll guard',
    )
    text = replace_once(
        text,
        "  }, [state.messages, state.currentReplyId])",
        "  }, [messageScrollKey, state.currentReplyId])",
        'mobile chat scroll deps',
    )
if '// `input` is the resize trigger' not in text:
    text = replace_once(
        text,
        "  useEffect(() => {\n    const ta = inputRef.current\n    if (!ta) return\n    ta.style.height = 'auto'",
        "  useEffect(() => {\n    // `input` is the resize trigger; dimensions are read from the DOM after render.\n    void input\n    const ta = inputRef.current\n    if (!ta) return\n    ta.style.height = 'auto'",
        'mobile input resize trigger',
    )
path.write_text(text)


# Facts selection is scoped to the current user/filter/page tuple. The scope is
# deliberately consumed as the reset signal rather than listing unused values.
path = Path('src/web-app/src/routes/memory/facts.tsx')
text = path.read_text()
if 'const selectionScope =' not in text:
    text = replace_once(
        text,
        "  // Selection state for the bulk delete bar.\n  const [selection, setSelection] = useState<Set<string>>(new Set())\n  useEffect(() => { setSelection(new Set()) }, [userKey, q, cat, page, perPage])",
        "  // Selection state for the bulk delete bar.\n  const selectionScope = JSON.stringify([userKey, q, cat, page, perPage])\n  const [selection, setSelection] = useState<Set<string>>(new Set())\n  useEffect(() => {\n    // The scope value is the reset signal when URL-driven list identity changes.\n    void selectionScope\n    setSelection(new Set())\n  }, [selectionScope])",
        'facts selection scope',
    )
    path.write_text(text)


# Memoize the workspace agent-name list directly from query data. This removes
# the unstable fallback object and the redundant string key dependency.
path = Path('src/web-app/src/routes/workspace.tsx')
text = path.read_text()
if 'const agentKey =' in text:
    text = replace_once(
        text,
        "  const agents = agentsQuery.data ?? {}\n  const agentNames = useMemo(() => Object.keys(agents).sort(), [agents])\n  const agentKey = agentNames.join('\\0')",
        "  const agents = agentsQuery.data ?? {}\n  const agentNames = useMemo(\n    () => Object.keys(agentsQuery.data ?? {}).sort(),\n    [agentsQuery.data],\n  )",
        'workspace agent names',
    )
    text = replace_once(
        text,
        "  }, [agent, agentKey, agentNames, agentsQuery.isLoading, defaultAgent, params, setParams])",
        "  }, [agent, agentNames, agentsQuery.isLoading, defaultAgent, params, setParams])",
        'workspace effect deps',
    )
    path.write_text(text)
