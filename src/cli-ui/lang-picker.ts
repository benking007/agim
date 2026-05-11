// cli-ui/lang-picker.ts — first-line of every interactive entry point.
// Reads the persisted preference (~/.im-hub/cli-lang) so a returning user
// just hits Enter. Saves the choice back on every selection so toggling
// once flips the default for next time.

import { menu } from './prompts.js'
import { readSavedLang, saveLang, t, type Lang } from './i18n.js'

/**
 * Prompt for language. Default = last saved choice, or 'zh' for first-run
 * users (the install.sh installer already greets in zh by default).
 *
 * Returns the picked Lang. Persists ONLY when the choice actually changed
 * from the saved value — minimizes disk writes for the no-change case.
 */
export async function pickLang(): Promise<Lang> {
  const saved = readSavedLang()
  const def: Lang = saved ?? 'zh'
  // i18n.t needs a Lang to render the picker question itself. We render
  // in the user's saved language (or zh on first run) so returning users
  // never see English they didn't ask for.
  const picked = await menu<Lang>({
    lang: def,
    message: t(def, 'lang.pick'),
    choices: [
      { value: 'en', name: t(def, 'lang.label.en') },
      { value: 'zh', name: t(def, 'lang.label.zh') },
    ],
    default: def,
  }) as Lang
  if (picked !== saved) saveLang(picked)
  return picked
}
