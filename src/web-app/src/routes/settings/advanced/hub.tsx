/**
 * /settings/advanced index — four cards into the capability pages.
 */

import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Cable, Eye, Globe2, Mail, Mic } from 'lucide-react'

const ITEMS = [
  { to: 'search', icon: Globe2, titleKey: 'tabs.search', descKey: 'advanced.searchDesc' },
  { to: 'stt',    icon: Mic,    titleKey: 'tabs.stt',    descKey: 'advanced.sttDesc' },
  { to: 'email',  icon: Mail,   titleKey: 'tabs.email',  descKey: 'advanced.emailDesc' },
  { to: 'viewer', icon: Eye,    titleKey: 'tabs.viewer', descKey: 'advanced.viewerDesc' },
  { to: 'bridge', icon: Cable,  titleKey: 'tabs.bridge', descKey: 'advanced.bridgeDesc' },
] as const

export default function SettingsAdvancedHub(): JSX.Element {
  const { t } = useTranslation('settings')
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {ITEMS.map((item) => {
        const Icon = item.icon
        return (
          <Link
            key={item.to}
            to={item.to}
            className="flex gap-3 rounded-xl border border-border bg-surface p-4 no-underline transition-colors hover:bg-surface-hover"
          >
            <span className="mt-0.5 text-text-dim">
              <Icon className="h-5 w-5" aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-text">{t(item.titleKey)}</span>
              <span className="mt-1 block text-sm text-text-dim">{t(item.descKey)}</span>
            </span>
          </Link>
        )
      })}
    </div>
  )
}
