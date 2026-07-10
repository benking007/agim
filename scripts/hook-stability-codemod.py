from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: expected one match, found {count}')
    return text.replace(old, new, 1)


viewer_path = Path('src/web-app/src/routes/settings/viewer.tsx')
viewer = viewer_path.read_text()
start = viewer.index('function ViewerCard')
end = viewer.index('/* ─────────────── Baidu Maps card', start)
viewer_card = viewer[start:end]
if "const [syncedHash, setSyncedHash]" in viewer_card:
    viewer_card = replace_once(
        viewer_card,
        "  const [syncedHash, setSyncedHash] = useState('')\n\n",
        '',
        'ViewerCard synced hash',
    )
    viewer_card = replace_once(
        viewer_card,
        "  // Sync draft when env changes (initial load + post-save refetch).\n  useEffect(() => {\n    const next = viewerDraftFromEnv(env)\n    const hash = JSON.stringify(next)\n    if (hash !== syncedHash) {\n      setDraft(next)\n      setSyncedHash(hash)\n    }\n    // eslint-disable-next-line react-hooks/exhaustive-deps\n  }, [env.AGIM_VIEWER_ENABLED, env.AGIM_VIEWER_PUBLIC_BASE_URL,\n      env.AGIM_VIEWER_TUNNEL_MODE, env.AGIM_VIEWER_CHARS,\n      env.AGIM_VIEWER_LINES, env.AGIM_VIEWER_CODE_LINES,\n      env.AGIM_VIEWER_MAX_PASTES, env.AGIM_VIEWER_NO_DEFAULT_REMOTE])\n\n  const current = useMemo(() => viewerDraftFromEnv(env), [env])",
        "  const current = useMemo(() => viewerDraftFromEnv(env), [env])\n\n  // Sync draft when env changes (initial load + post-save refetch).\n  useEffect(() => {\n    setDraft(current)\n  }, [current])",
        'ViewerCard sync effect',
    )
    viewer = viewer[:start] + viewer_card + viewer[end:]
    viewer_path.write_text(viewer)

biome_path = Path('biome.json')
biome = biome_path.read_text()
if '"useExhaustiveDependencies": "warn"' in biome:
    biome = replace_once(
        biome,
        '"useExhaustiveDependencies": "warn"',
        '"useExhaustiveDependencies": "error"',
        'Biome dependency rule',
    )
    biome_path.write_text(biome)
