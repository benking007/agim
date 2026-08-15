// cli-ui/entry-menu.ts — what bare `agim` shows when invoked with
// no args. Drops the user at the language picker, then a short "start
// here" menu. Service maintenance stays available, but behind a submenu
// so first-run users see the product path before the ops path.
//
// We dispatch to the existing commander actions by calling them directly
// (they're exposed via the cli.ts module via `exec*` helpers). Could also
// re-spawn `agim <subcmd>` but that doubles startup time; direct
// dispatch keeps everything in one process.

import { BACK, menu, UserAbortError } from './prompts.js'
import { pickLang } from './lang-picker.js'
import { readSavedLang, t, type Lang } from './i18n.js'
import { loadOnboardingStatus } from '../core/onboarding-status.js'

export type EntryAction =
  | { kind: 'quickstart' }
  | { kind: 'web' }
  | { kind: 'config' }
  | { kind: 'doctor' }
  | { kind: 'status' }
  | { kind: 'start'; bg: boolean }
  | { kind: 'restart' }
  | { kind: 'stop' }
  | { kind: 'token' }
  | { kind: 'uninstall' }
  | { kind: 'quit' }

type MainPick = EntryAction['kind'] | 'service'
type ServicePick = 'status' | 'start_bg' | 'restart' | 'stop' | 'start'

async function pickServiceAction(lang: Lang): Promise<EntryAction | null> {
  console.log()
  const picked = await menu<ServicePick>({
    lang,
    message: t(lang, 'menu.service.subtitle'),
    choices: [
      { value: 'start_bg', name: t(lang, 'menu.start_bg') },
      { value: 'restart',  name: t(lang, 'menu.restart') },
      { value: 'stop',     name: t(lang, 'menu.stop') },
      { value: 'status',   name: t(lang, 'menu.status'), separatorBefore: true },
      { value: 'start',    name: t(lang, 'menu.start') },
    ],
    back: 'back',
  })
  if (picked === BACK) return null
  if (picked === 'start_bg') return { kind: 'start', bg: true }
  if (picked === 'start') return { kind: 'start', bg: false }
  return { kind: picked }
}

/**
 * Run the language picker + entry menu, return the action the user picked
 * AND the lang they picked. The dispatcher needs the lang to localize
 * follow-up flows (notably `runConfigWizard`) without re-prompting — the
 * user already chose; asking again is a regression.
 */
export async function runEntryMenu(): Promise<{ action: EntryAction; lang: Lang }> {
  let lang: Lang
  try {
    lang = await pickLang()
  } catch (err) {
    if (err instanceof UserAbortError) {
      return { action: { kind: 'quit' }, lang: readSavedLang() ?? 'zh' }
    }
    throw err
  }
  try {
    const status = await loadOnboardingStatus()
    if (status.firstRun) {
      return { action: { kind: 'quickstart' }, lang }
    }
  } catch {
    // Probe failure must not block the menu for returning users.
  }
  console.log()
  console.log(t(lang, 'menu.title'))
  console.log()
  while (true) {
    try {
      const picked = await menu<MainPick>({
        lang,
        message: t(lang, 'menu.subtitle'),
        choices: [
          { value: 'quickstart', name: t(lang, 'menu.quickstart') },
          { value: 'web',        name: t(lang, 'menu.web') },
          { value: 'config',     name: t(lang, 'menu.config') },
          { value: 'doctor',     name: t(lang, 'menu.doctor'), separatorBefore: true },
          { value: 'status',     name: t(lang, 'menu.status') },
          { value: 'service',    name: t(lang, 'menu.service') },
          { value: 'token',      name: t(lang, 'menu.token'), separatorBefore: true },
          { value: 'uninstall',  name: t(lang, 'menu.uninstall') },
          { value: 'quit',       name: t(lang, 'menu.quit'), separatorBefore: true },
        ],
      })
      if (picked === 'service') {
        const action = await pickServiceAction(lang)
        if (action) return { action, lang }
        console.log()
        continue
      }
      return { action: { kind: picked } as EntryAction, lang }
    } catch (err) {
      if (err instanceof UserAbortError) return { action: { kind: 'quit' }, lang }
      throw err
    }
  }
}
