/**
 * ThemeAndLangControls — shared topbar widget (lang + theme Select).
 * Lives in shell/ so every route's topbar reaches for the same
 * component; if we ever change the affordance (icon button vs
 * dropdown vs cycle button) the change lands once.
 */

import { useTranslation } from 'react-i18next'
import { Laptop, Moon, SunMedium } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { usePrefs, type Lang, type ThemeMode } from '@/stores/prefs'

export function ThemeAndLangControls(): JSX.Element {
  const { t } = useTranslation()
  const theme = usePrefs((s) => s.theme)
  const lang = usePrefs((s) => s.lang)
  const setTheme = usePrefs((s) => s.setTheme)
  const setLang = usePrefs((s) => s.setLang)

  return (
    <>
      <Select value={lang} onValueChange={(v) => setLang(v as Lang)}>
        <SelectTrigger
          className="h-7 min-h-7 w-16 shrink-0 whitespace-nowrap py-0 text-xs leading-none sm:w-20 [&>span]:whitespace-nowrap [&>svg]:size-3.5 [&>svg]:shrink-0"
          aria-label={t('lang.label')}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="en">{t('lang.en')}</SelectItem>
          <SelectItem value="zh">{t('lang.zh')}</SelectItem>
        </SelectContent>
      </Select>
      <Select value={theme} onValueChange={(v) => setTheme(v as ThemeMode)}>
        <SelectTrigger
          className="h-7 min-h-7 w-32 shrink-0 whitespace-nowrap py-0 text-xs leading-none [&>span]:whitespace-nowrap [&>svg]:size-3.5 [&>svg]:shrink-0"
          aria-label={t('theme.label')}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="system">
            <span className="inline-flex items-center gap-2 whitespace-nowrap">
              <Laptop className="h-4 w-4 shrink-0" /> {t('theme.system')}
            </span>
          </SelectItem>
          <SelectItem value="light">
            <span className="inline-flex items-center gap-2 whitespace-nowrap">
              <SunMedium className="h-4 w-4 shrink-0" /> {t('theme.light')}
            </span>
          </SelectItem>
          <SelectItem value="dark">
            <span className="inline-flex items-center gap-2 whitespace-nowrap">
              <Moon className="h-4 w-4 shrink-0" /> {t('theme.dark')}
            </span>
          </SelectItem>
        </SelectContent>
      </Select>
    </>
  )
}
