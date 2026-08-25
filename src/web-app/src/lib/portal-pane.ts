export type PortalPane = 'chat' | 'skills' | 'automation' | 'library'

export function parsePortalPane(raw: string | null | undefined): PortalPane {
  if (raw === 'skills' || raw === 'automation' || raw === 'library') return raw
  return 'chat'
}
