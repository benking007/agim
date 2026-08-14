import { beforeEach, describe, expect, it } from 'vitest'
import {
  PORTAL_RAIL_COLLAPSED_KEY,
  PORTAL_RAIL_DEFAULT_WIDTH,
  PORTAL_RAIL_MAX_WIDTH,
  PORTAL_RAIL_MIN_WIDTH,
  PORTAL_RAIL_WIDTH_KEY,
  clampPortalRailWidth,
  readPortalRailCollapsed,
  readPortalRailWidth,
  writePortalRailCollapsed,
  writePortalRailWidth,
} from './portal-rail-prefs'

describe('portal-rail-prefs', () => {
  beforeEach(() => {
    localStorage.removeItem(PORTAL_RAIL_WIDTH_KEY)
    localStorage.removeItem(PORTAL_RAIL_COLLAPSED_KEY)
  })

  it('clamps width between min and max', () => {
    expect(clampPortalRailWidth(10)).toBe(PORTAL_RAIL_MIN_WIDTH)
    expect(clampPortalRailWidth(9999)).toBe(PORTAL_RAIL_MAX_WIDTH)
    expect(clampPortalRailWidth(300.6)).toBe(301)
  })

  it('persists width and collapsed flag', () => {
    expect(readPortalRailWidth()).toBe(PORTAL_RAIL_DEFAULT_WIDTH)
    writePortalRailWidth(360)
    expect(readPortalRailWidth()).toBe(360)
    expect(readPortalRailCollapsed()).toBe(false)
    writePortalRailCollapsed(true)
    expect(readPortalRailCollapsed()).toBe(true)
  })
})
