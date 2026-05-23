/**
 * /settings/agim-skills — manage the agim SKILL.md library
 * (P1 follow-up).
 *
 * Two-pane layout:
 *  · Left: skill list (source + availability + always-on tags;
 *    click to load body into the editor).
 *  · Right: SKILL.md editor (textarea) + Save + Delete (workspace
 *    skills only) + Create New + Refresh from disk.
 *
 * Builtin skills are read-only here — to override one, just create
 * a workspace skill with the same name; the loader shadows builtins
 * by name (see core/skills/loader.ts § discovery + shadowing).
 */

import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import {
  BookOpen, FilePlus2, Loader2, RefreshCcw, Save, Trash2,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  useAgimSkillsList, useAgimSkill,
  useAgimSkillCreate, useAgimSkillUpdate, useAgimSkillDelete,
  useAgimSkillsRefresh,
  type AgimSkillMeta,
} from '@/hooks/use-agim-skills'

const STARTER_TEMPLATE = `---
name: my-skill
description: One-line summary the LLM uses to decide whether to load this skill.
always: false
---

# My Skill

Write the body the agent should read when this skill applies.

## When to use this skill

- bullet 1
- bullet 2

## Steps

1. step one
2. step two
`

export default function SettingsAgimSkillsRoute(): JSX.Element {
  const listQuery = useAgimSkillsList()
  const refresh = useAgimSkillsRefresh()
  const [selected, setSelected] = useState<string | null>(null)

  // Pre-select the first skill once the list arrives.
  useEffect(() => {
    if (!selected && listQuery.data?.skills.length) {
      setSelected(listQuery.data.skills[0]?.name ?? null)
    }
  }, [selected, listQuery.data])

  const skills = listQuery.data?.skills ?? []
  const maxBody = listQuery.data?.maxBodyChars ?? 32_000

  async function onRefresh(): Promise<void> {
    try {
      const r = await refresh.mutateAsync()
      toast.success(`Reloaded — ${r.count} skill(s) on disk`)
    } catch (err) {
      toast.error(((err as Error)?.message ?? String(err)))
    }
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <header className="flex items-center gap-3">
        <BookOpen className="h-5 w-5 text-text-dim" />
        <h1 className="text-xl font-semibold">agim Skills</h1>
        <Badge variant="info">{skills.length}</Badge>
        <Button
          variant="ghost" size="sm" className="ml-auto"
          onClick={() => void onRefresh()}
          disabled={refresh.isPending}
        >
          {refresh.isPending
            ? <Loader2 className="h-4 w-4 animate-spin" />
            : <RefreshCcw className="h-4 w-4" />}
          <span className="hidden sm:inline">Reload from disk</span>
        </Button>
        <NewSkillButton onCreate={(n) => setSelected(n)} />
      </header>
      <p className="text-sm text-text-dim">
        SKILL.md files loaded by <code>src/core/skills/loader.ts</code>.
        Tier-1 summary (name + description) is auto-injected into every
        agent system prompt; full body is read on-demand via
        <code> mcp__imhub__read_skill</code>. Workspace skills shadow
        bundled <code>builtin</code> skills by name.
      </p>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-[280px,1fr]">
        <SkillsList
          skills={skills}
          selected={selected}
          onSelect={setSelected}
          loading={listQuery.isLoading}
        />
        {selected ? (
          <SkillEditor
            key={selected}
            name={selected}
            maxBody={maxBody}
            onDeleted={() => setSelected(null)}
          />
        ) : (
          <section className="flex items-center justify-center rounded-md border border-border bg-surface p-12 text-sm text-text-dim">
            Select a skill on the left, or click <kbd className="px-1">New</kbd> to create one.
          </section>
        )}
      </div>
    </div>
  )
}

/* ─────────────── List pane ─────────────── */

function SkillsList({
  skills, selected, onSelect, loading,
}: { skills: AgimSkillMeta[]; selected: string | null; onSelect: (n: string) => void; loading: boolean }): JSX.Element {
  if (loading) return <div className="h-48 rounded-md bg-surface-2 animate-pulse" />
  if (skills.length === 0) {
    return (
      <section className="rounded-md border border-border bg-surface p-4 text-sm text-text-dim">
        No skills loaded. Click <kbd className="px-1">New</kbd> to create one
        (lands at <code>~/.agim/skills/&lt;name&gt;/SKILL.md</code>).
      </section>
    )
  }
  return (
    <nav className="rounded-md border border-border bg-surface">
      <ul className="divide-y divide-border">
        {skills.map((s) => {
          const isSelected = selected === s.name
          const flag = !s.available
            ? <Badge variant="outline" title={s.unavailableReason}>unavailable</Badge>
            : s.always
              ? <Badge variant="success">always-on</Badge>
              : null
          const src = s.source === 'workspace'
            ? <Badge variant="info">ws</Badge>
            : <Badge variant="outline">builtin</Badge>
          return (
            <li key={s.name}>
              <button
                type="button"
                onClick={() => onSelect(s.name)}
                className={
                  'flex w-full flex-col items-start gap-1 px-3 py-2 text-left text-xs transition hover:bg-surface-2 '
                  + (isSelected ? 'bg-surface-2 font-semibold' : '')
                }
              >
                <span className="flex w-full items-center gap-2 font-mono text-[12px]">
                  <span className="grow truncate">{s.name}</span>
                  {src}
                  {flag}
                </span>
                <span className="line-clamp-2 text-[11px] text-text-dim">{s.description}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

/* ─────────────── Editor pane ─────────────── */

function SkillEditor({
  name, maxBody, onDeleted,
}: { name: string; maxBody: number; onDeleted: () => void }): JSX.Element {
  const detail = useAgimSkill(name)
  const update = useAgimSkillUpdate()
  const remove = useAgimSkillDelete()

  const [draft, setDraft] = useState('')
  const [syncedFor, setSyncedFor] = useState<string>('')

  useEffect(() => {
    if (detail.data && syncedFor !== name) {
      setDraft(detail.data.body)
      setSyncedFor(name)
    }
  }, [detail.data, name, syncedFor])

  const meta = detail.data?.meta
  const isBuiltin = meta?.source === 'builtin'
  const initial = detail.data?.body ?? ''
  const isDirty = useMemo(() => draft !== initial, [draft, initial])

  async function onSave(): Promise<void> {
    try {
      await update.mutateAsync({ name, body: draft })
      toast.success(`Saved "${name}"`)
    } catch (err) {
      toast.error(((err as Error)?.message ?? String(err)))
    }
  }

  async function onDelete(): Promise<void> {
    if (isBuiltin) return
    if (!confirm(`Delete workspace skill "${name}"? The builtin (if any) will become visible again.`)) return
    try {
      await remove.mutateAsync(name)
      toast.success(`Deleted "${name}"`)
      onDeleted()
    } catch (err) {
      toast.error(((err as Error)?.message ?? String(err)))
    }
  }

  if (detail.isLoading) return <section className="h-72 rounded-md bg-surface-2 animate-pulse" />
  if (!meta) return <section className="rounded-md border border-border bg-surface p-4 text-sm text-danger">Not found.</section>

  return (
    <section className="flex flex-col gap-2">
      <header className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface px-3 py-2">
        <span className="font-mono text-sm font-semibold">{meta.name}</span>
        {meta.source === 'workspace' ? <Badge variant="info">workspace</Badge> : <Badge variant="outline">builtin (read-only via UI)</Badge>}
        {meta.always && <Badge variant="success">always-on</Badge>}
        {!meta.available && <Badge variant="outline" title={meta.unavailableReason}>unavailable</Badge>}
        <span className="ml-auto text-[11px] text-text-dim">{draft.length} / {maxBody}</span>
      </header>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        disabled={isBuiltin && !isDirty}
        spellCheck={false}
        className="min-h-[500px] w-full rounded-md border border-border bg-surface p-3 font-mono text-xs leading-relaxed focus:border-accent focus:outline-none"
      />
      <div className="text-[11px] text-text-dim">
        Workspace path: <code>{meta.dir}</code> ·
        Required bins: <code>{meta.requiresBins.join(', ') || 'none'}</code> ·
        Required env: <code>{meta.requiresEnv.join(', ') || 'none'}</code>
      </div>
      <div className="flex items-center gap-2">
        {isBuiltin && (
          <span className="text-[11px] text-text-dim">
            Builtin shown for reference. Save creates a workspace shadow that overrides it.
          </span>
        )}
        <span className="ml-auto" />
        {!isBuiltin && (
          <Button
            variant="ghost" size="sm"
            onClick={() => void onDelete()}
            disabled={remove.isPending}
            className="text-danger hover:text-danger"
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </Button>
        )}
        <Button
          size="sm"
          onClick={() => void onSave()}
          disabled={update.isPending || !isDirty}
        >
          {update.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {isBuiltin ? 'Save (create workspace shadow)' : 'Save'}
        </Button>
      </div>
    </section>
  )
}

/* ─────────────── New skill ─────────────── */

function NewSkillButton({ onCreate }: { onCreate: (name: string) => void }): JSX.Element {
  const create = useAgimSkillCreate()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) { toast.error('name required'); return }
    if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
      toast.error('safe chars only: [A-Za-z0-9._-]'); return
    }
    const body = STARTER_TEMPLATE.replace('name: my-skill', `name: ${trimmed}`)
    try {
      const r = await create.mutateAsync({ name: trimmed, body })
      toast.success(`Created "${r.meta.name}"`)
      setOpen(false)
      setName('')
      onCreate(r.meta.name)
    } catch (err) {
      toast.error(((err as Error)?.message ?? String(err)))
    }
  }

  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)}>
        <FilePlus2 className="h-4 w-4" /> New
      </Button>
    )
  }

  return (
    <form onSubmit={(e) => void onSubmit(e)} className="flex items-center gap-1">
      <Label className="sr-only">Name</Label>
      <Input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="skill-name"
        className="h-8 w-44 font-mono text-xs"
      />
      <Button type="submit" size="sm" disabled={create.isPending}>
        {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Create'}
      </Button>
      <Button type="button" variant="ghost" size="sm" onClick={() => { setOpen(false); setName('') }}>
        Cancel
      </Button>
    </form>
  )
}
