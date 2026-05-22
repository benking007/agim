// /#wgs / /#gcj / /#bd — record the user's coord-system preference and,
// if they have a recent memo with a location, re-interpret its coords
// and return fresh map URLs.
//
// Plan C (2026-05-22): per-(platform, user_id) preference, learned
// from one reply after a wrong marker. See core/user-coord-prefs.ts.

import type { RouteContext } from '../router.js'
import type { CoordSystem } from '../user-coord-prefs.js'
import { setUserCoordPref } from '../user-coord-prefs.js'
import {
  listMemos, updateMemo, mapUrls,
  type Memo,
} from '../memos.js'
import {
  gcj02ToWgs84, bd09ToWgs84, outOfChina, wgs84ToGcj02, wgs84ToBd09,
} from '../coord-systems.js'

const HUMAN_NAME: Record<CoordSystem, string> = {
  wgs84: 'WGS-84 (Google / Apple / OSM)',
  gcj02: 'GCJ-02 (高德 / iOS 系统位置 / 国内地图)',
  bd09: 'BD-09 (百度地图)',
}

export function handleCoordCommand(system: CoordSystem, ctx: RouteContext): string {
  const userId = ctx.userId
  if (!userId) {
    return '⚠️ 收到 # 坐标系命令，但当前消息没有 user_id，无法保存偏好。'
  }

  // 1) Persist the preference. Future locations from this user are
  //    auto-normalized accordingly.
  const ok = setUserCoordPref(ctx.platform, userId, system)
  if (!ok) {
    return `⚠️ 偏好保存失败（user-prefs.db 不可用）。下次发位置仍会按默认处理。`
  }

  const lines: string[] = []
  lines.push(`✅ 已记住：你的坐标使用 **${HUMAN_NAME[system]}**`)
  lines.push(`   未来从这里发的位置会自动按此坐标系处理。`)

  // 2) Best-effort: find the user's most recent memo with a location
  //    in this thread and re-interpret its stored coords as `system`,
  //    then rewrite where_lat/lng in DB and emit fresh map URLs.
  //    If the user is correcting a wrong guess, this gives them a
  //    second-chance accurate marker without sending a new pin.
  const recent = listMemos({ userId, limit: 20 }) as Memo[]
  const target = recent.find((m) => m.where_lat != null && m.where_lng != null)
  if (target && target.where_lat != null && target.where_lng != null) {
    // Stored coords are WGS-84 (whatever normalize-on-ingest produced).
    // The user just told us the *original input* should have been
    // interpreted as `system`. So the stored value is wrong by the
    // delta between (assumed wgs84-pass-through) and (actual system).
    // Rebuild the WGS-84 value from the stored one by undoing the
    // wrong normalize and re-applying the right one.
    //
    // Practically: most past mistakes are "in-China telegram-native
    // treated as WGS-84 when it was actually GCJ-02". To recover, the
    // raw input was the stored value (no normalize applied), and the
    // correct WGS-84 is gcj02ToWgs84(stored).
    const storedLat = target.where_lat
    const storedLng = target.where_lng
    let correctedLat = storedLat
    let correctedLng = storedLng
    if (!outOfChina(storedLat, storedLng)) {
      if (system === 'gcj02') {
        const wgs = gcj02ToWgs84(storedLat, storedLng)
        correctedLat = wgs.lat
        correctedLng = wgs.lng
      } else if (system === 'bd09') {
        const wgs = bd09ToWgs84(storedLat, storedLng)
        correctedLat = wgs.lat
        correctedLng = wgs.lng
      } else if (system === 'wgs84') {
        // The user is telling us the stored value is *actually* WGS-84
        // but it was treated as something else on ingest. Without
        // knowing what wrong path was applied, the best we can do is
        // pass through (and hope the prior normalize was a no-op).
        // For Plan C's known cases (in-China telegram-native default
        // = GCJ-02 → gcj02ToWgs84 applied), undo that.
        const back = wgs84ToGcj02(storedLat, storedLng) // re-apply forward
        correctedLat = back.lat
        correctedLng = back.lng
      }
    }
    void wgs84ToBd09 // referenced for future symmetry; lint-quiet

    const updated = updateMemo(
      target.id,
      { whereLat: correctedLat, whereLng: correctedLng },
      { userId },
    )
    if (updated) {
      const urls = mapUrls(correctedLat, correctedLng, target.where_label ?? '')
      lines.push('')
      lines.push(`🔁 已重生成最近一条 memo #${target.id}「${target.what}」 的地图链接：`)
      lines.push(`百度: ${urls.baidu}`)
      lines.push(`高德: ${urls.amap}`)
      lines.push(`Google: ${urls.google}`)
    }
  }

  return lines.join('\n')
}
