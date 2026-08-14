/**
 * Persist Portal left-rail width + collapsed icon mode.
 * Separate keys from workbench (`agim-workbench-sidebar-collapsed`).
 */

export const PORTAL_RAIL_WIDTH_KEY = 'agim-portal-rail-width'
export const PORTAL_RAIL_COLLAPSED_KEY = 'agim-portal-rail-collapsed'

/** Default matches Tailwind `w-64` (16rem). */
export const PORTAL_RAIL_DEFAULT_WIDTH = 256
export const PORTAL_RAIL_MIN_WIDTH = 200
export const PORTAL_RAIL_MAX_WIDTH = 420
/** Icon-only strip when collapsed. */
export const PORTAL_RAIL_COLLAPSED_WIDTH = 72

export function clampPortalRailWidth(width: number): number {
  if (!Number.isFinite(width)) return PORTAL_RAIL_DEFAULT_WIDTH
  return Math.min(PORTAL_RAIL_MAX_WIDTH, Math.max(PORTAL_RAIL_MIN_WIDTH, Math.round(width)))
}

export function readPortalRailWidth(): number {
  try {
    const raw = localStorage.getItem(PORTAL_RAIL_WIDTH_KEY)
    if (!raw) return PORTAL_RAIL_DEFAULT_WIDTH
    return clampPortalRailWidth(Number(raw))
  } catch {
    return PORTAL_RAIL_DEFAULT_WIDTH
  }
}

export function writePortalRailWidth(width: number): void {
  try {
    localStorage.setItem(PORTAL_RAIL_WIDTH_KEY, String(clampPortalRailWidth(width)))
  } catch {
    /* private mode */
  }
}

export function readPortalRailCollapsed(): boolean {
  try {
    return localStorage.getItem(PORTAL_RAIL_COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

export function writePortalRailCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(PORTAL_RAIL_COLLAPSED_KEY, collapsed ? '1' : '0')
  } catch {
    /* private mode */
  }
}
