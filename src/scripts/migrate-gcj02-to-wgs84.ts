#!/usr/bin/env node
// One-shot migration: rewrite memo rows whose stored coords are actually
// GCJ-02 (because they came from a Telegram pin or H5 navigator.geolocation
// on an Apple/Google device in China — Apple/Google apply the offset before
// the JS API returns).
//
// AFTER 2026-05-11 the ingestion paths now reverse the offset at write
// time. This script is for the rows created BEFORE that fix lands.
//
// Usage:
//   node dist/scripts/migrate-gcj02-to-wgs84.js [--dry-run]
//
// Safety:
//   - Only rows with where_lat IS NOT NULL are touched.
//   - Rows outside the China bbox are skipped (gcj02ToWgs84 no-ops there).
//   - Run with --dry-run first to preview.

import Database from 'better-sqlite3'
import { join } from 'node:path'
import { gcj02ToWgs84 } from '../core/memos.js'
import { AGIM_HOME } from '../core/agim-paths.js'

const DRY = process.argv.includes('--dry-run')
const DB_FILE = process.env.AGIM_MEMOS_DB || join(AGIM_HOME, 'memos.db')

const db = new Database(DB_FILE)
const rows = db.prepare(
  'SELECT id, what, where_lat, where_lng FROM memos WHERE where_lat IS NOT NULL',
).all() as Array<{ id: number; what: string; where_lat: number; where_lng: number }>

console.log(`Loaded ${rows.length} memo rows with coords from ${DB_FILE}`)
console.log(`Mode: ${DRY ? 'DRY-RUN' : 'WRITE'}`)
console.log()

const update = db.prepare('UPDATE memos SET where_lat = ?, where_lng = ?, updated_at = ? WHERE id = ?')
const now = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ')

let touched = 0
let skipped = 0
for (const row of rows) {
  const wgs = gcj02ToWgs84(row.where_lat, row.where_lng)
  const latDiff = Math.abs(wgs.lat - row.where_lat)
  const lngDiff = Math.abs(wgs.lng - row.where_lng)
  if (latDiff < 1e-7 && lngDiff < 1e-7) {
    console.log(`  #${row.id} [${row.what}]: no shift (out of China) — skipped`)
    skipped++
    continue
  }
  console.log(
    `  #${row.id} [${row.what}]: ${row.where_lat.toFixed(6)},${row.where_lng.toFixed(6)} → ${wgs.lat.toFixed(6)},${wgs.lng.toFixed(6)}`,
  )
  if (!DRY) {
    update.run(wgs.lat, wgs.lng, now, row.id)
  }
  touched++
}

console.log()
console.log(`Touched: ${touched} | Skipped (out of China): ${skipped} | Total: ${rows.length}`)
if (DRY) console.log('Re-run without --dry-run to apply.')
db.close()
