// cli-ui/entry-menu.ts — what bare `im-hub-pro` shows when invoked with
// no args. Drops the user at the language picker, then a 7-row menu
// covering the 5 service-mgmt commands + config + quit.
//
// We dispatch to the existing commander actions by calling them directly
// (they're exposed via the cli.ts module via `exec*` helpers). Could also
// re-spawn `im-hub-pro <subcmd>` but that doubles startup time; direct
// dispatch keeps everything in one process.

import { menu, UserAbortError } from './prompts.js'
import { pickLang } from './lang-picker.js'
import { t } from './i18n.js'

export type EntryAction =
  | { kind: 'config' }
  | { kind: 'status' }
  | { kind: 'start'; bg: boolean }
  | { kind: 'restart' }
  | { kind: 'stop' }
  | { kind: 'uninstall' }
  | { kind: 'quit' }

/**
 * Run the language picker + entry menu, return the action the user picked.
 * The cli.ts top-level dispatcher then executes it. Returning an
 * EntryAction instead of running commands inline keeps the entry menu
 * decoupled from the heavy command implementations.
 */
export async function runEntryMenu(): Promise<EntryAction> {
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
        { value: 'uninstall', name: t(lang, 'menu.uninstall'), separatorBefore: true },
        { value: 'quit',      name: t(lang, 'menu.quit'),      separatorBefore: true },
      ],
    })) as EntryAction['kind'] | 'start_bg'
    if (picked === 'start_bg') return { kind: 'start', bg: true }
    if (picked === 'start')    return { kind: 'start', bg: false }
    return { kind: picked } as EntryAction
  } catch (err) {
    if (err instanceof UserAbortError) return { kind: 'quit' }
    throw err
  }
}
