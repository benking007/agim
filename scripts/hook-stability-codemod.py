from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: expected one match, found {count}')
    return text.replace(old, new, 1)


def wrap_callback(
    text: str,
    start_sig: str,
    end_marker: str,
    replacement_sig: str,
    deps: str,
    label: str,
) -> str:
    start = text.index(start_sig)
    end = text.index(end_marker, start)
    segment = text[start:end]
    segment = replace_once(segment, start_sig, replacement_sig, f'{label} signature')
    close = segment.rfind('\n  }')
    if close < 0:
        raise RuntimeError(f'{label}: closing brace not found')
    segment = segment[:close] + f'\n  }}, {deps})' + segment[close + len('\n  }'):]
    return text[:start] + segment + text[end:]


def rewrite_use_chat() -> None:
    path = Path('src/web-app/src/hooks/use-chat.ts')
    text = path.read_text()
    text = replace_once(
        text,
        "import { useEffect, useReducer, useRef } from 'react'",
        "import { useCallback, useEffect, useReducer, useRef } from 'react'",
        'use-chat import',
    )
    text = replace_once(
        text,
        "  const currentReplyIdRef = useRef<string | null>(null)\n  useEffect(() => {\n    currentReplyIdRef.current = state.currentReplyId\n  }, [state.currentReplyId])\n\n  useEffect(() => {",
        "  const currentReplyIdRef = useRef<string | null>(null)\n  const onIncomingRef = useRef<(msg: ChatIncoming) => void>(() => {})\n  useEffect(() => {\n    currentReplyIdRef.current = state.currentReplyId\n  }, [state.currentReplyId])\n  useEffect(() => {\n    onIncomingRef.current = onIncoming\n  })\n\n  useEffect(() => {",
        'use-chat latest handler ref',
    )
    text = replace_once(
        text,
        "      fn: (msg: ChatIncoming) => onIncoming(msg),",
        "      fn: (msg: ChatIncoming) => onIncomingRef.current(msg),",
        'use-chat subscription handler',
    )
    text = wrap_callback(
        text,
        "  function send(text: string): void {",
        "\n\n  function switchAgent",
        "  const send = useCallback((text: string): void => {",
        "[state.agent]",
        'send',
    )
    text = wrap_callback(
        text,
        "  function switchAgent(name: string): void {",
        "\n\n  function approvalClick",
        "  const switchAgent = useCallback((name: string): void => {",
        "[]",
        'switchAgent',
    )
    text = wrap_callback(
        text,
        "  function approvalClick(messageId: string, reqId: string, choice: ApprovalChoice): boolean {",
        "\n\n  /**\n   * Submit an ask_user answer.",
        "  const approvalClick = useCallback((messageId: string, reqId: string, choice: ApprovalChoice): boolean => {",
        "[]",
        'approvalClick',
    )
    text = wrap_callback(
        text,
        "  function choiceSubmit(messageId: string, data: string): boolean {",
        "\n\n  function newConversation",
        "  const choiceSubmit = useCallback((messageId: string, data: string): boolean => {",
        "[]",
        'choiceSubmit',
    )
    text = wrap_callback(
        text,
        "  function newConversation(): void {",
        "\n\n  return {",
        "  const newConversation = useCallback((): void => {",
        "[]",
        'newConversation',
    )
    text = replace_once(
        text,
        "\n  return {\n    state,\n    send,\n    switchAgent,\n    approvalClick,\n    choiceSubmit,\n    newConversation,\n    clearError: () => dispatch({ kind: 'CLEAR_ERROR' }),\n  }",
        "\n  const clearError = useCallback((): void => {\n    dispatch({ kind: 'CLEAR_ERROR' })\n  }, [])\n\n  return {\n    state,\n    send,\n    switchAgent,\n    approvalClick,\n    choiceSubmit,\n    newConversation,\n    clearError,\n  }",
        'use-chat clearError',
    )
    path.write_text(text)


def stabilize_search_params(
    file_name: str,
    insert_after: str,
    old_effect: str,
    callback: str,
    old_function: str,
    new_effect: str,
) -> None:
    path = Path(file_name)
    text = path.read_text()
    text = replace_once(
        text,
        "import { useEffect, useMemo, useState } from 'react'",
        "import { useCallback, useEffect, useMemo, useState } from 'react'",
        f'{file_name} import',
    )
    text = replace_once(text, insert_after, insert_after + callback, f'{file_name} callback insert')
    text = replace_once(text, old_effect, new_effect, f'{file_name} effect')
    text = replace_once(text, old_function, '', f'{file_name} old patchParams')
    path.write_text(text)


def rewrite_search_routes() -> None:
    stabilize_search_params(
        'src/web-app/src/routes/memory/facts.tsx',
        "  const perPage = Number(params.get('per_page')) || DEFAULT_PER_PAGE\n",
        "  const [qDraft, setQDraft] = useState(q)\n  useEffect(() => {\n    if (qDraft === q) return\n    const timer = window.setTimeout(() => patchParams({ q: qDraft || null }), SEARCH_DEBOUNCE_MS)\n    return () => window.clearTimeout(timer)\n    // eslint-disable-next-line react-hooks/exhaustive-deps\n  }, [qDraft])",
        "\n  const patchParams = useCallback((patch: Record<string, string | null>): void => {\n    setParams((current) => {\n      const next = new URLSearchParams(current)\n      for (const [key, value] of Object.entries(patch)) {\n        if (value == null || value === '') next.delete(key)\n        else next.set(key, value)\n      }\n      if (Object.keys(patch).some((key) => key !== 'page')) next.delete('page')\n      return next\n    }, { replace: false })\n  }, [setParams])\n",
        "\n  function patchParams(patch: Record<string, string | null>): void {\n    const next = new URLSearchParams(params)\n    for (const [k, v] of Object.entries(patch)) {\n      if (v == null || v === '') next.delete(k)\n      else next.set(k, v)\n    }\n    // Reset to page 1 on any filter mutation.\n    if (Object.keys(patch).some((k) => k !== 'page')) next.delete('page')\n    setParams(next, { replace: false })\n  }\n",
        "  const [qDraft, setQDraft] = useState(q)\n  useEffect(() => {\n    if (qDraft === q) return\n    const timer = window.setTimeout(() => patchParams({ q: qDraft || null }), SEARCH_DEBOUNCE_MS)\n    return () => window.clearTimeout(timer)\n  }, [patchParams, q, qDraft])",
    )

    stabilize_search_params(
        'src/web-app/src/routes/memos.tsx',
        "  const incExpired = params.get('include_expired') === '1'\n",
        "  const [qDraft, setQDraft] = useState(q)\n\n  useEffect(() => {\n    if (qDraft === q) return\n    const timer = window.setTimeout(() => {\n      patchParams({ q: qDraft || null })\n    }, SEARCH_DEBOUNCE_MS)\n    return () => window.clearTimeout(timer)\n    // eslint-disable-next-line react-hooks/exhaustive-deps\n  }, [qDraft])",
        "\n  const patchParams = useCallback((patch: Record<string, string | null>): void => {\n    setParams((current) => {\n      const next = new URLSearchParams(current)\n      for (const [key, value] of Object.entries(patch)) {\n        if (value == null || value === '') next.delete(key)\n        else next.set(key, value)\n      }\n      return next\n    }, { replace: true })\n  }, [setParams])\n",
        "\n  function patchParams(patch: Record<string, string | null>): void {\n    const next = new URLSearchParams(params)\n    for (const [k, v] of Object.entries(patch)) {\n      if (v == null || v === '') next.delete(k)\n      else next.set(k, v)\n    }\n    setParams(next, { replace: true })\n  }\n",
        "  const [qDraft, setQDraft] = useState(q)\n\n  useEffect(() => {\n    if (qDraft === q) return\n    const timer = window.setTimeout(() => {\n      patchParams({ q: qDraft || null })\n    }, SEARCH_DEBOUNCE_MS)\n    return () => window.clearTimeout(timer)\n  }, [patchParams, q, qDraft])",
    )

    stabilize_search_params(
        'src/web-app/src/routes/observability/audit.tsx',
        "  const intent   = params.get('intent') ?? ''\n",
        "  useEffect(() => {\n    const timer = window.setTimeout(() => {\n      patchParams({\n        agent:    agentDraft    || null,\n        platform: platformDraft || null,\n        user:     userDraft     || null,\n        intent:   intentDraft   || null,\n      })\n    }, SEARCH_DEBOUNCE_MS)\n    return () => window.clearTimeout(timer)\n    // eslint-disable-next-line react-hooks/exhaustive-deps\n  }, [agentDraft, platformDraft, userDraft, intentDraft])",
        "\n  const patchParams = useCallback((patch: Record<string, string | null>): void => {\n    setParams((current) => {\n      const next = new URLSearchParams(current)\n      for (const [key, value] of Object.entries(patch)) {\n        if (value == null || value === '') next.delete(key)\n        else next.set(key, value)\n      }\n      return next\n    }, { replace: true })\n  }, [setParams])\n",
        "\n  function patchParams(patch: Record<string, string | null>): void {\n    const next = new URLSearchParams(params)\n    for (const [k, v] of Object.entries(patch)) {\n      if (v == null || v === '') next.delete(k)\n      else next.set(k, v)\n    }\n    setParams(next, { replace: true })\n  }\n",
        "  useEffect(() => {\n    const timer = window.setTimeout(() => {\n      patchParams({\n        agent:    agentDraft    || null,\n        platform: platformDraft || null,\n        user:     userDraft     || null,\n        intent:   intentDraft   || null,\n      })\n    }, SEARCH_DEBOUNCE_MS)\n    return () => window.clearTimeout(timer)\n  }, [agentDraft, intentDraft, patchParams, platformDraft, userDraft])",
    )


def rewrite_settings_drafts() -> None:
    path = Path('src/web-app/src/routes/settings/email.tsx')
    text = path.read_text()
    text = replace_once(text, "  const [syncedHash, setSyncedHash] = useState<string>('')\n", '', 'email synced hash')
    text = replace_once(
        text,
        "  useEffect(() => {\n    if (!envQuery.data) return\n    const next = draftFromEnv(env)\n    const hash = JSON.stringify(next)\n    if (hash !== syncedHash) {\n      setDraft(next)\n      setSyncedHash(hash)\n    }\n    // eslint-disable-next-line react-hooks/exhaustive-deps\n  }, [envQuery.dataUpdatedAt])",
        "  useEffect(() => {\n    if (!envQuery.data) return\n    setDraft(draftFromEnv(envQuery.data.env))\n  }, [envQuery.data])",
        'email sync effect',
    )
    path.write_text(text)

    path = Path('src/web-app/src/routes/settings/viewer.tsx')
    text = path.read_text()
    text = replace_once(text, "  const [syncedHash, setSyncedHash] = useState('')\n\n", '', 'viewer synced hash')
    text = replace_once(
        text,
        "  // Sync draft when env changes (initial load + post-save refetch).\n  useEffect(() => {\n    const next = viewerDraftFromEnv(env)\n    const hash = JSON.stringify(next)\n    if (hash !== syncedHash) {\n      setDraft(next)\n      setSyncedHash(hash)\n    }\n    // eslint-disable-next-line react-hooks/exhaustive-deps\n  }, [env.AGIM_VIEWER_ENABLED, env.AGIM_VIEWER_PUBLIC_BASE_URL,\n      env.AGIM_VIEWER_TUNNEL_MODE, env.AGIM_VIEWER_CHARS,\n      env.AGIM_VIEWER_LINES, env.AGIM_VIEWER_CODE_LINES,\n      env.AGIM_VIEWER_MAX_PASTES, env.AGIM_VIEWER_NO_DEFAULT_REMOTE])\n\n  const current = useMemo(() => viewerDraftFromEnv(env), [env])",
        "  const current = useMemo(() => viewerDraftFromEnv(env), [env])\n\n  // Sync draft when env changes (initial load + post-save refetch).\n  useEffect(() => {\n    setDraft(current)\n  }, [current])",
        'viewer sync effect',
    )
    path.write_text(text)


def promote_rule() -> None:
    path = Path('biome.json')
    text = path.read_text()
    text = replace_once(
        text,
        '"useExhaustiveDependencies": "warn"',
        '"useExhaustiveDependencies": "error"',
        'Biome dependency rule',
    )
    path.write_text(text)


rewrite_use_chat()
rewrite_search_routes()
rewrite_settings_drafts()
promote_rule()
