// Map-URL coordinate extraction for DingTalk `link` msgtype payloads.
//
// Kept in a separate file (rather than inline in dingtalk-adapter.ts)
// because the adapter pulls in heavy modules — `media-store.ts`,
// `dingtalk-stream`, the transcribe / location-context machinery — that
// each can have side effects at import time (env-var capture, file
// handles, etc.). Tests for the URL classifier should not pay that cost
// or risk pulling in process-wide state.

/** What coord system the URL's host implies. Drives which conversion
 *  `normalizeIncomingCoords` applies on the extracted lat/lng. */
export type MapUrlSource =
  | 'dingtalk-link-amap'      // *.amap.com (Gaode) → GCJ-02
  | 'dingtalk-link-tencent'   // map.qq.com / apis.map.qq.com → GCJ-02
  | 'dingtalk-link-baidu'     // *.baidu.com Map URLs → BD-09
  | 'dingtalk-link-unknown'   // host not recognised → pass-through (WGS-84)

function classifyHost(host: string): MapUrlSource {
  const h = host.toLowerCase()
  if (h.endsWith('.amap.com') || h === 'amap.com' || h.endsWith('.gaode.com') || h === 'gaode.com') {
    return 'dingtalk-link-amap'
  }
  if (h.endsWith('.qq.com') || h === 'qq.com') {
    // Tencent's map endpoints: map.qq.com, apis.map.qq.com, lbs.qq.com.
    // Other *.qq.com URLs (chat / mail) shouldn't legitimately carry
    // map coords; if they do, GCJ-02 is the safe assumption.
    return 'dingtalk-link-tencent'
  }
  if (h.endsWith('.baidu.com') || h === 'baidu.com') {
    return 'dingtalk-link-baidu'
  }
  return 'dingtalk-link-unknown'
}

/** Best-effort lat/lng extraction from common map URLs.
 *
 * Returns null if the URL doesn't look like a map share. On hit, also
 * returns the `source` so the caller can route through
 * `normalizeIncomingCoords()` for the right coord-system conversion:
 *   - Amap / Gaode      → GCJ-02
 *   - Tencent (map.qq)  → GCJ-02
 *   - Baidu Maps        → BD-09
 *   - Anything else     → pass-through (we don't guess for unknown hosts)
 *
 * Parses these URL shapes:
 *   - Amap:    `uri.amap.com/marker?position=lng,lat`
 *   - Tencent: `apis.map.qq.com/uri/v1/marker?marker=coord:lat,lng`
 *   - Generic: `?location=lat,lng`, `?latlng=lat,lng`, `?lat=…&lng=…` */
export function tryExtractLatLng(url: string): { lat: number; lng: number; source: MapUrlSource } | null {
  if (!url || typeof url !== 'string') return null
  try {
    const u = new URL(url)
    const source = classifyHost(u.hostname)
    const params = u.searchParams

    // Amap: ?position=lng,lat
    const position = params.get('position')
    if (position) {
      const [lngStr, latStr] = position.split(',')
      const lng = parseFloat(lngStr)
      const lat = parseFloat(latStr)
      if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng, source }
    }

    // Tencent: ?marker=coord:lat,lng;title:...
    const marker = params.get('marker')
    if (marker?.startsWith('coord:')) {
      const coord = marker.slice('coord:'.length).split(';')[0]
      const [latStr, lngStr] = coord.split(',')
      const lat = parseFloat(latStr)
      const lng = parseFloat(lngStr)
      if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng, source }
    }

    // Generic ?location=lat,lng OR ?latlng=lat,lng
    const loc = params.get('location') ?? params.get('latlng')
    if (loc) {
      const [latStr, lngStr] = loc.split(',')
      const lat = parseFloat(latStr)
      const lng = parseFloat(lngStr)
      if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng, source }
    }

    // Separate ?lat=...&lng=... (or &lon=...)
    const latParam = params.get('lat') ?? params.get('latitude')
    const lngParam = params.get('lng') ?? params.get('lon') ?? params.get('longitude')
    if (latParam && lngParam) {
      const lat = parseFloat(latParam)
      const lng = parseFloat(lngParam)
      if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng, source }
    }
  } catch {
    /* URL didn't parse — not a map share we can read. */
  }
  return null
}
