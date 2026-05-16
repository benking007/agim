// cli-ui/entry-menu.ts — what bare `agim` shows when invoked with
// no args. Drops the user at the language picker, then a 7-row menu
// covering the 5 service-mgmt commands + config + quit.
//
// We dispatch to the existing commander actions by calling them directly
// (they're exposed via the cli.ts module via `exec*` helpers). Could also
// re-spawn `agim <subcmd>` but that doubles startup time; direct
// dispatch keeps everything in one process.

import { menu, UserAbortError } from './prompts.js'
import { pickLang } from './lang-picker.js'
import { t, type Lang } from './i18n.js'

export type EntryAction =
  | { kind: 'config' }
  | { kind: 'status' }
  | { kind: 'start'; bg: boolean }
  | { kind: 'restart' }
  | { kind: 'stop' }
  | { kind: 'token' }
  | { kind: 'uninstall' }
  | { kind: 'quit' }

/**
 * Run the language picker + entry menu, return the action the user picked
 * AND the lang they picked. The dispatcher needs the lang to localize
 * follow-up flows (notably `runConfigWizard`) without re-prompting — the
 * user already chose; asking again is a regression.
 */
export async function runEntryMenu(): Promise<{ action: EntryAction; lang: Lang }> {
  const lang = await pickLang()
  console.log()
  console.log(t(lang, 'menu.title'))
  console.log()
  try {
    const picked = (await menu<EntryAction['kind'] | 'start_bg'>({
      lang,
      message: t(lang, 'menu.subtitle'),
      choices: [
        { value: 'config',    name: t(lang, 'menu.config') },
        { value: 'status',    name: t(lang, 'menu.status'),    separatorBefore: true },
        { value: 'start',     name: t(lang, 'menu.start') },
        { value: 'start_bg',  name: t(lang, 'menu.start_bg') },
        { value: 'restart',   name: t(lang, 'menu.restart') },
        { value: 'stop',      name: t(lang, 'menu.stop') },
        { value: 'token',     name: t(lang, 'menu.token'),     separatorBefore: true },
        { value: 'uninstall', name: t(lang, 'menu.uninstall') },
        { value: 'quit',      name: t(lang, 'menu.quit'),      separatorBefore: true },
      ],
    })) as EntryAction['kind'] | 'start_bg'
    if (picked === 'start_bg') return { action: { kind: 'start', bg: true }, lang }
    if (picked === 'start')    return { action: { kind: 'start', bg: false }, lang }
    return { action: { kind: picked } as EntryAction, lang }
  } catch (err) {
    if (err instanceof UserAbortError) return { action: { kind: 'quit' }, lang }
    throw err
  }
}
