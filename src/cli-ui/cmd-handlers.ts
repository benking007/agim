// cli-ui/cmd-handlers.ts — implementations of the 5 service-management
// commands. Each handler reads the persisted language preference, prints
// status / outcomes in that language, and shells out to systemctl / npm /
// rm where appropriate.

import { execSync, spawn } from 'node:child_process'
import { unlinkSync, existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  detectService,
  spawnBackground,
  stopService,
  formatUptime,
  readWebEndpoint,
  PID_FILE,
  LOG_FILE,
} from './service.js'
import { yesNo } from './prompts.js'
import { pickLang } from './lang-picker.js'
import { readSavedLang, t, type Lang } from './i18n.js'
import { CONFIG_FILE } from './paths.js'
import { ENV_FILE, removeEnvFile } from './env-file.js'

const SYSTEMD_UNIT_PATH = '/etc/systemd/system/im-hub.service'

/** Pick whichever language is already saved, falling back to 'zh'. We
 *  don't re-prompt for language inside per-command handlers — they
 *  shouldn't disrupt scripted flows. */
function quietLang(): Lang {
  return readSavedLang() ?? 'zh'
}

// ─── status ──────────────────────────────────────────────────────────

export function cmdStatus(): void {
  const lang = quietLang()
  console.log()
  console.log(t(lang, 'svc.status.title'))
  console.log('─'.repeat(50))
  const st = detectService()
  switch (st.mode) {
    case 'systemd':
      console.log('  ' + t(lang, 'svc.status.systemd_active', { pid: st.pid ?? '?' }))
      break
    case 'background':
      console.log('  ' + t(lang, 'svc.status.bg_running', { pid: st.pid ?? '?', log: LOG_FILE }))
      break
    case 'foreground':
      console.log('  ' + t(lang, 'svc.status.fg_running', { pid: st.pid ?? '?' }))
      break
    case 'none':
      console.log('  ' + t(lang, 'svc.status.not_running'))
      if (existsSync(SYSTEMD_UNIT_PATH)) {
        console.log('  ' + t(lang, 'svc.status.systemd_inactive'))
      }
      return
  }
  if (typeof st.uptimeSec === 'number') {
    console.log('  ' + t(lang, 'svc.status.uptime', { duration: formatUptime(st.uptimeSec) }))
  }
  const web = readWebEndpoint()
  if (web) {
    console.log('  ' + t(lang, 'svc.status.web', { bind: web.bind, port: web.port }))
  }
  console.log()
}

// ─── start ───────────────────────────────────────────────────────────

/**
 * Foreground start is the legacy `program.command('start').action(...)`
 * path in cli.ts — we DON'T re-implement it here, just delegate. For
 * background, we re-spawn ourselves detached.
 */
export async function cmdStart(bg: boolean, runForegroundStart: () => Promise<void>): Promise<void> {
  const lang = quietLang()
  const st = detectService()
  if (st.mode === 'systemd') {
    console.log(t(lang, 'svc.start.systemd_managed'))
    return
  }
  if (st.mode !== 'none') {
    console.log(t(lang, 'svc.start.already_running', { pid: st.pid ?? '?' }))
    return
  }
  if (bg) {
    console.log(t(lang, 'svc.start.starting_bg'))
    // Re-exec self detached. Use the same node + cli.js paths so global vs
    // local install both work.
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const cliJs = join(__dirname, '..', 'cli.js')
    const { pid } = spawnBackground(process.execPath, [cliJs, 'start'])
    // Tiny wait so the child has a chance to either bind ports or crash;
    // status check picks up the latter.
    await new Promise(r => setTimeout(r, 1500))
    const after = detectService()
    if (after.mode === 'background' && after.pid === pid) {
      console.log(t(lang, 'svc.start.bg_ready', { pid, log: LOG_FILE }))
      console.log(t(lang, 'svc.start.bg_hint'))
    } else {
      console.log('⚠️ Background daemon may have failed to bind ports — check log:')
      console.log(`   tail -n 40 ${LOG_FILE}`)
    }
    return
  }
  console.log(t(lang, 'svc.start.starting_fg'))
  await runForegroundStart()
}

// ─── stop ────────────────────────────────────────────────────────────

export async function cmdStop(): Promise<void> {
  const lang = quietLang()
  const st = detectService()
  if (st.mode === 'none') {
    console.log(t(lang, 'svc.stop.not_running'))
    return
  }
  if (st.mode === 'systemd') {
    console.log(t(lang, 'svc.stop.stopping_systemd'))
  } else if (st.mode === 'background') {
    console.log(t(lang, 'svc.stop.stopping_bg', { pid: st.pid ?? '?' }))
  } else if (st.mode === 'foreground') {
    console.log('⚠️ ' + (lang === 'zh'
      ? '检测到前台进程在跑。会发 SIGTERM，但建议你回那个 shell 里 Ctrl-C。'
      : 'Foreground process detected. Sending SIGTERM — but Ctrl-C in the owning shell is cleaner.'))
  }
  await stopService()
  console.log(t(lang, 'svc.stop.stopped'))
}

// ─── restart ─────────────────────────────────────────────────────────

export async function cmdRestart(): Promise<void> {
  const lang = quietLang()
  const st = detectService()
  if (st.mode === 'systemd') {
    console.log(t(lang, 'svc.restart.systemd'))
    execSync('systemctl restart im-hub.service', { stdio: 'inherit' })
    console.log(t(lang, 'svc.restart.done'))
    return
  }
  if (st.mode === 'foreground') {
    console.log(t(lang, 'svc.restart.fg_warning'))
    return
  }
  if (st.mode === 'background' || st.mode === 'none') {
    console.log(t(lang, 'svc.restart.bg'))
    if (st.mode === 'background') await stopService()
    // Re-spawn detached.
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const cliJs = join(__dirname, '..', 'cli.js')
    const { pid } = spawnBackground(process.execPath, [cliJs, 'start'])
    await new Promise(r => setTimeout(r, 1500))
    console.log(t(lang, 'svc.start.bg_ready', { pid, log: LOG_FILE }))
    console.log(t(lang, 'svc.restart.done'))
  }
}

// ─── uninstall ───────────────────────────────────────────────────────

export async function cmdUninstall(): Promise<void> {
  const lang = await pickLang()
  console.log()
  console.log(t(lang, 'svc.uninstall.confirm'))
  console.log()
  const ok = await yesNo({ message: t(lang, 'confirm'), default: false })
  if (!ok) {
    console.log(t(lang, 'svc.uninstall.cancelled'))
    return
  }
  // 1. Stop any running instance.
  console.log(t(lang, 'svc.uninstall.stopping'))
  await stopService()
  // 2. Remove systemd unit if present (requires root).
  if (existsSync(SYSTEMD_UNIT_PATH)) {
    console.log(t(lang, 'svc.uninstall.removing_unit'))
    try {
      execSync('systemctl disable im-hub.service', { stdio: 'ignore' })
    } catch { /* ok if not enabled */ }
    try {
      unlinkSync(SYSTEMD_UNIT_PATH)
      execSync('systemctl daemon-reload', { stdio: 'ignore' })
    } catch (err) {
      console.warn(`⚠️ Could not remove ${SYSTEMD_UNIT_PATH}: ${err instanceof Error ? err.message : String(err)} — try \`sudo rm ${SYSTEMD_UNIT_PATH}\` manually.`)
    }
  }
  // 3. Remove config + env (but KEEP workspaces).
  console.log(t(lang, 'svc.uninstall.removing_config'))
  try { unlinkSync(CONFIG_FILE) } catch { /* missing is fine */ }
  removeEnvFile()
  try { unlinkSync(PID_FILE) } catch { /* missing is fine */ }
  // 4. Uninstall npm package globally.
  console.log(t(lang, 'svc.uninstall.removing_npm'))
  try {
    execSync('npm uninstall -g im-hub-pro', { stdio: 'inherit' })
  } catch (err) {
    console.warn(`⚠️ npm uninstall failed: ${err instanceof Error ? err.message : String(err)} — run \`npm uninstall -g im-hub-pro\` manually.`)
  }
  console.log()
  console.log(t(lang, 'svc.uninstall.workspaces_kept'))
  console.log(t(lang, 'svc.uninstall.done'))
}

// Suppress unused imports linters for now — spawn is referenced via spawnBackground.
void spawn
void readFileSync
void homedir
void ENV_FILE
