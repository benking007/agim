import { describe, expect, it } from 'vitest'
import {
  detectAtTrigger,
  detectSlashTrigger,
  isImeComposingKey,
} from '@/components/m-portal/portal-composer-menus'
import {
  chipsFromValue,
  makeChip,
  serializeComposer,
} from '@/components/m-portal/portal-composer-input'
import {
  filterSlashCommands,
  skillMarker,
  workspaceFileMarker,
  workspaceMarker,
} from '@/components/m-portal/portal-slash-commands'

describe('isImeComposingKey', () => {
  it('is true while composing or keyCode 229', () => {
    expect(isImeComposingKey({ isComposing: true, keyCode: 13 } as KeyboardEvent)).toBe(true)
    expect(isImeComposingKey({ isComposing: false, keyCode: 229 } as KeyboardEvent)).toBe(true)
    expect(isImeComposingKey({ isComposing: false, keyCode: 13 } as KeyboardEvent)).toBe(false)
  })
})

describe('detectSlashTrigger', () => {
  it('opens on bare slash', () => {
    expect(detectSlashTrigger('/', 1)).toEqual({ start: 0, query: '' })
  })

  it('captures query after slash', () => {
    expect(detectSlashTrigger('/pla', 4)).toEqual({ start: 0, query: 'pla' })
  })

  it('ignores slash mid-word', () => {
    expect(detectSlashTrigger('foo/bar', 7)).toBeNull()
  })
})

describe('detectAtTrigger', () => {
  it('opens on bare at', () => {
    expect(detectAtTrigger('@', 1)).toEqual({ start: 0, query: '' })
  })

  it('captures query', () => {
    expect(detectAtTrigger('see @wo', 7)).toEqual({ start: 4, query: 'wo' })
  })
})

describe('composer chips serialize roundtrip', () => {
  it('roundtrips workspace + file chips', () => {
    const chips = [
      makeChip({ kind: 'workspace', marker: workspaceMarker(), label: 'workspace' }),
      makeChip({
        kind: 'file',
        marker: workspaceFileMarker('src/a.ts', false),
        label: 'a.ts',
        path: 'src/a.ts',
      }),
      makeChip({ kind: 'skill', marker: skillMarker('babysit'), label: 'babysit' }),
    ]
    const value = serializeComposer(chips, 'please review')
    const again = chipsFromValue(value)
    expect(again.chips.map((c) => c.kind)).toEqual(['workspace', 'file', 'skill'])
    expect(again.text.trim()).toBe('please review')
  })
})

describe('filterSlashCommands', () => {
  it('prioritizes Plan for pla query', () => {
    const list = filterSlashCommands('pla')
    expect(list[0]?.id).toBe('plan')
  })

  it('fills memo as /memo here', () => {
    const memo = filterSlashCommands('memo')[0]
    expect(memo?.id).toBe('memo')
    expect(memo?.action).toEqual({ type: 'fill', text: '/memo here' })
  })
})

describe('backspace deletes trailing chip', () => {
  it('drops last chip via serialize roundtrip', () => {
    const chips = [
      makeChip({ kind: 'workspace', marker: workspaceMarker(), label: 'workspace' }),
      makeChip({ kind: 'skill', marker: skillMarker('agim-reminders'), label: 'agim-reminders' }),
    ]
    const value = serializeComposer(chips, '')
    const parsed = chipsFromValue(value)
    expect(parsed.chips).toHaveLength(2)
    const after = serializeComposer(parsed.chips.slice(0, -1), parsed.text)
    expect(chipsFromValue(after).chips.map((c) => c.kind)).toEqual(['workspace'])
  })
})
