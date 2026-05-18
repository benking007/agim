/**
 * stores/prefs.test.ts — verifies that the theme + lang setters write
 * to the *legacy* localStorage keys (agim-theme / im-hub-lang) so v1
 * and v2 share one set of preferences without a migration step.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { _resetPrefsForTest, usePrefs } from './prefs'

afterEach(() => {
  _resetPrefsForTest()
  localStorage.clear()
})

describe('usePrefs', () => {
  it('persists theme to agim-theme (legacy key)', () => {
    usePrefs.getState().setTheme('dark')
    expect(localStorage.getItem('agim-theme')).toBe('dark')
    usePrefs.getState().setTheme('light')
    expect(localStorage.getItem('agim-theme')).toBe('light')
    // 'system' removes the key so the v1 IIFE's "absent ⇒ system"
    // mapping continues to work.
    usePrefs.getState().setTheme('system')
    expect(localStorage.getItem('agim-theme')).toBeNull()
  })

  it('cycleTheme walks system → light → dark → system', () => {
    _resetPrefsForTest()
    const cycle = usePrefs.getState().cycleTheme
    expect(usePrefs.getState().theme).toBe('system')
    cycle()
    expect(usePrefs.getState().theme).toBe('light')
    cycle()
    expect(usePrefs.getState().theme).toBe('dark')
    cycle()
    expect(usePrefs.getState().theme).toBe('system')
  })

  it('persists lang to im-hub-lang (legacy key)', () => {
    usePrefs.getState().setLang('zh')
    expect(localStorage.getItem('im-hub-lang')).toBe('zh')
    usePrefs.getState().setLang('en')
    expect(localStorage.getItem('im-hub-lang')).toBe('en')
  })
})
