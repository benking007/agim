// cli-ui/cmd-handlers.ts — implementations of the 5 service-management
// commands. Each handler reads the persisted language preference, prints
// status / outcomes in that language, and shells out to systemctl / npm /
// rm where appropriate.

import { execSync, spawn } from 'node:child_process'
import { unlinkSync, existsSync, readFileSync, rmSync } from 'node:fs'
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
import { yesNo, menu, inputText, UserAbortError } from './prompts.js'
import { pickLang } from './lang-picker.js'
import { readSavedLang, t, type Lang } from './i18n.js'
import { CONFIG_DIR, CONFIG_FILE, WORKSPACES_DIR } from './paths.js'
import { ENV_FILE, removeEnvFile } from './env-file.js'

/** Candidate paths for the systemd unit; v1.0 prefers `agim.service`,
 *  pre-v1.0 wrote `im-hub.service`. Resolved at runtime by `findSystemdUnit()`
 *  so we operate on whichever exists. */
const SYSTEMD_UNIT_CANDIDATES = [
  '/etc/systemd/system/agim.service',
  '/etc/systemd/system/im-hub.service',
] as const

function findSystemdUnit(): { path: string; name: string } | null {
  for (const path of SYSTEMD_UNIT_CANDIDATES) {
    if (existsSync(path)) {
      return { path, name: path.split('/').pop() ?? '' }
    }
  }
  return null
}

/** Path of the unit file, if any exists, for compat with code that
 *  references this constant. Resolved lazily so cleanup can drop it. */
function systemdUnitPath(): string | null {
  return findSystemdUnit()?.path ?? null
}

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
      if (systemdUnitPath()) {
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
    const unit = findSystemdUnit()
    if (unit) execSync(`systemctl restart ${unit.name}`, { stdio: 'inherit' })
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

type UninstallMode = 'keep' | 'creds' | 'full'

/** The credential files that mode='creds' and mode='full' both wipe.
 *  Resolved from CONFIG_DIR so the legacy `~/.im-hub/` layout is handled
 *  automatically (agim-paths.ts auto-detects on a 0.x upgrade). */
function credentialFiles(): string[] {
  return [
    join(CONFIG_DIR, 'tokens.json'),
    join(CONFIG_DIR, 'admin-bootstrap-token'),
    join(CONFIG_DIR, 'acp-token'),
    join(CONFIG_DIR, 'approval-bus.sock'),
  ]
}

/** Cheap probe for `shred` on PATH — used to decide whether full-destruction
 *  mode can do a secure overwrite or has to fall back to plain unlink. */
function hasShred(): boolean {
  try {
    execSync('command -v shred', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** Best-effort secure delete: shred -u when available, else unlink + warn.
 *  Returns whether the file no longer exists at end. */
function secureDelete(path: string, lang: Lang, shredAvailable: boolean): void {
  if (!existsSync(path)) return
  if (shredAvailable) {
    try {
      execSync(`shred -u "${path.replace(/"/g, '\\"')}"`, { stdio: 'ignore' })
      return
    } catch {
      // Fall through to unlink.
    }
  } else {
    // Only warn once per uninstall — caller printed the warning before
    // looping; here we just unlink silently.
  }
  try { unlinkSync(path) } catch { /* ignore */ }
}

export async function cmdUninstall(): Promise<void> {
  const lang = await pickLang()
  // Path interpolations — match whatever AGIM_HOME / AGIM_WORKSPACES
  // resolved to so the prompts reflect the actual on-disk layout (the
  // legacy ~/.im-hub/ on upgraded systems, the new ~/.agim/ on fresh).
  const pathVars = {
    config: CONFIG_FILE,
    workspaces: WORKSPACES_DIR,
    home: CONFIG_DIR,
  }
  console.log()
  console.log(t(lang, 'svc.uninstall.intro'))
  console.log()

  // Pick uninstall mode. menu() throws UserAbortError on Ctrl-C; treat as
  // cancel (not a crash). We don't pass `back:` so BACK sentinel can't
  // come back, but TS still narrows the return type — handle it for
  // exhaustiveness.
  let mode: UninstallMode
  try {
    const picked = await menu<UninstallMode>({
      lang,
      message: t(lang, 'svc.uninstall.mode.prompt'),
      choices: [
        {
          value: 'keep',
          name: t(lang, 'svc.uninstall.mode.keep_name'),
          description: t(lang, 'svc.uninstall.mode.keep_desc', pathVars),
        },
        {
          value: 'creds',
          name: t(lang, 'svc.uninstall.mode.creds_name'),
          description: t(lang, 'svc.uninstall.mode.creds_desc'),
        },
        {
          value: 'full',
          name: t(lang, 'svc.uninstall.mode.full_name'),
          description: t(lang, 'svc.uninstall.mode.full_desc', pathVars),
        },
      ],
      default: 'keep',
    })
    if (typeof picked === 'symbol') {
      console.log(t(lang, 'svc.uninstall.cancelled'))
      return
    }
    mode = picked
  } catch (err) {
    if (err instanceof UserAbortError) {
      console.log(t(lang, 'svc.uninstall.cancelled'))
      return
    }
    throw err
  }

  // Full destruction needs a typed confirmation — the menu pick alone
  // is too easy to fat-finger when the consequences are irreversible.
  if (mode === 'full') {
    console.log()
    console.log(t(lang, 'svc.uninstall.full_warn', pathVars))
    console.log()
    let typed: string
    try {
      typed = await inputText({
        message: t(lang, 'svc.uninstall.full_confirm_prompt'),
      })
    } catch (err) {
      if (err instanceof UserAbortError) {
        console.log(t(lang, 'svc.uninstall.full_aborted'))
        return
      }
      throw err
    }
    if (typed.trim() !== 'DELETE') {
      console.log(t(lang, 'svc.uninstall.full_aborted'))
      return
    }
  }

  // ─── Steps common to all three modes ───────────────────────────────
  // 1. Stop any running instance.
  console.log(t(lang, 'svc.uninstall.stopping'))
  await stopService()
  // 2. Remove systemd unit if present (requires root). Both `agim.service`
  //    (v1.0+) and the legacy `im-hub.service` are cleaned up so an upgrade
  //    across the rename doesn't leave a stale unit behind.
  for (const unitPath of SYSTEMD_UNIT_CANDIDATES) {
    if (!existsSync(unitPath)) continue
    const unitName = unitPath.split('/').pop() ?? ''
    console.log(t(lang, 'svc.uninstall.removing_unit'))
    try {
      execSync(`systemctl disable ${unitName}`, { stdio: 'ignore' })
    } catch { /* ok if not enabled */ }
    try {
      unlinkSync(unitPath)
    } catch (err) {
      console.warn(`⚠️ Could not remove ${unitPath}: ${err instanceof Error ? err.message : String(err)} — try \`sudo rm ${unitPath}\` manually.`)
    }
  }
  try { execSync('systemctl daemon-reload', { stdio: 'ignore' }) } catch { /* ok */ }
  // 3. Remove config + env + pidfile (kept in mode=keep for backward compat
  //    with prior behaviour — config is regenerated on next `agim config`).
  console.log(t(lang, 'svc.uninstall.removing_config', pathVars))
  try { unlinkSync(CONFIG_FILE) } catch { /* missing is fine */ }
  removeEnvFile()
  try { unlinkSync(PID_FILE) } catch { /* missing is fine */ }
  // 4. Uninstall npm package globally.
  console.log(t(lang, 'svc.uninstall.removing_npm'))
  try {
    // Best-effort uninstall the current package `agim-cli` plus the
    // legacy npm names `im-hub-pro` and `im-hub` so a user who upgraded
    // across the rename(s) doesn't end up with stale dangling bins.
    execSync('npm uninstall -g agim-cli im-hub-pro im-hub', { stdio: 'inherit' })
  } catch (err) {
    console.warn(`⚠️ npm uninstall failed: ${err instanceof Error ? err.message : String(err)} — run \`npm uninstall -g agim-cli\` manually.`)
  }

  if (mode === 'keep') {
    console.log()
    console.log(t(lang, 'svc.uninstall.workspaces_kept', pathVars))
    console.log(t(lang, 'svc.uninstall.done'))
    return
  }

  // ─── Mode='creds' or 'full': wipe credential files ─────────────────
  // These four files are what would let an attacker keep using the Web
  // dashboard / ACP after the install is gone. unlink is fine here
  // because mode='full' falls through to a secure shred + rm -rf below.
  console.log(t(lang, 'svc.uninstall.removing_creds'))
  for (const f of credentialFiles()) {
    try { unlinkSync(f) } catch { /* missing is fine */ }
  }

  if (mode === 'creds') {
    console.log()
    console.log(t(lang, 'svc.uninstall.creds_done'))
    return
  }

  // ─── Mode='full': shred sensitive files, then rm -rf ───────────────
  // Why shred when we're about to `rm -rf`? On ext4 / xfs / btrfs without
  // FS-level encryption (LUKS / BitLocker), `rm` just unlinks — file
  // blocks linger on raw disk until reused. `shred -u` overwrites then
  // unlinks. This is a best-effort hardening — the right answer is
  // FS-level encryption, but for users who skipped that, shred catches
  // the obvious credential files.
  console.log(t(lang, 'svc.uninstall.shredding'))
  const shredAvailable = hasShred()
  if (!shredAvailable) {
    console.log(t(lang, 'svc.uninstall.shred_unavailable'))
  }
  // Re-target the files since credentialFiles() are now gone (unlinked
  // above). Sensitive-files-list also includes env + config that we
  // already unlinked in the common step — explicitly cover them in case
  // a future refactor changes ordering.
  const sensitive = [ENV_FILE, CONFIG_FILE, ...credentialFiles()]
  for (const f of sensitive) secureDelete(f, lang, shredAvailable)

  console.log(t(lang, 'svc.uninstall.removing_all', pathVars))
  for (const dir of [CONFIG_DIR, WORKSPACES_DIR]) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (err) {
      console.warn(`⚠️ Failed to remove ${dir}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  console.log()
  console.log(t(lang, 'svc.uninstall.full_done'))
}

// ─── post-config: offer to start the service ────────────────────────
//
// Called by runConfigWizard right after saveConfig(). Drops the "what
// next?" cliff users used to fall off after the wizard ended. Behaviour
// depends on the current service state:
//
//   - none       → ask "start in background now?" Y/N.
//   - background → ask "restart so changes take effect?" Y/N.
//   - systemd    → ask "systemctl restart?" Y/N (requires root; if it
//                  fails we just print the command).
//   - foreground → can't restart from here. Print a one-line hint that
//                  the user has to go back to the owning shell.
//
// Stays quiet on Ctrl-C (UserAbortError) so an exit doesn't dump a
// stack on top of a successful wizard run.

export async function offerServiceStart(lang: Lang): Promise<void> {
  const { yesNo, UserAbortError } = await import('./prompts.js')
  const st = detectService()
  try {
    if (st.mode === 'none') {
      console.log()
      console.log(t(lang, 'svc.offer.not_running_title'))
      const wantStart = await yesNo({
        message: t(lang, 'svc.offer.not_running_q'),
        default: true,
      })
      if (!wantStart) {
        console.log(t(lang, 'svc.offer.skipped'))
        return
      }
      // Re-exec self detached. Mirrors cmdStart(true, ...).
      const __dirname = dirname(fileURLToPath(import.meta.url))
      const cliJs = join(__dirname, '..', 'cli.js')
      const { pid } = spawnBackground(process.execPath, [cliJs, 'start'])
      await new Promise(r => setTimeout(r, 1500))
      const after = detectService()
      if (after.mode === 'background' && after.pid === pid) {
        console.log(t(lang, 'svc.offer.bg_started', { pid, log: LOG_FILE }))
        const web = readWebEndpoint()
        if (web) {
          // Localhost binds: show 127.0.0.1 (what the user will actually
          // open in a browser on this machine). 0.0.0.0 is a server-side
          // listen address that no browser actually connects to as-is.
          const bind = web.bind === '0.0.0.0' ? '127.0.0.1' : web.bind
          console.log(t(lang, 'svc.offer.bg_url', { bind, port: web.port }))
        }
      } else {
        console.log(t(lang, 'svc.offer.bg_check_log'))
        console.log(`   tail -n 40 ${LOG_FILE}`)
      }
      return
    }

    if (st.mode === 'foreground') {
      console.log()
      console.log(t(lang, 'svc.offer.running_title', { mode: 'foreground', pid: st.pid ?? '?' }))
      console.log(t(lang, 'svc.offer.foreground_hint'))
      return
    }

    // background OR systemd — same UX: ask whether to restart so the
    // freshly-saved config takes effect.
    console.log()
    console.log(t(lang, 'svc.offer.running_title', { mode: st.mode, pid: st.pid ?? '?' }))
    const wantRestart = await yesNo({
      message: t(lang, 'svc.offer.restart_q'),
      default: true,
    })
    if (!wantRestart) {
      console.log(t(lang, 'svc.offer.restart_skipped'))
      return
    }

    if (st.mode === 'systemd') {
      const unit = findSystemdUnit()
      if (unit) {
        try {
          execSync(`systemctl restart ${unit.name}`, { stdio: 'inherit' })
          console.log(t(lang, 'svc.offer.systemd_restarted'))
        } catch (err) {
          console.warn(`⚠️ ${err instanceof Error ? err.message : String(err)}`)
          console.log(`   sudo systemctl restart ${unit.name}`)
        }
      }
      return
    }

    // background: stop + re-spawn.
    await stopService()
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const cliJs = join(__dirname, '..', 'cli.js')
    const { pid } = spawnBackground(process.execPath, [cliJs, 'start'])
    await new Promise(r => setTimeout(r, 1500))
    const after = detectService()
    if (after.mode === 'background' && after.pid === pid) {
      console.log(t(lang, 'svc.offer.bg_started', { pid, log: LOG_FILE }))
      const web = readWebEndpoint()
      if (web) {
        const bind = web.bind === '0.0.0.0' ? '127.0.0.1' : web.bind
        console.log(t(lang, 'svc.offer.bg_url', { bind, port: web.port }))
      }
    } else {
      console.log(t(lang, 'svc.offer.bg_check_log'))
      console.log(`   tail -n 40 ${LOG_FILE}`)
    }
  } catch (err) {
    if (err instanceof UserAbortError) {
      // User hit Ctrl-C inside the y/n prompt. Quiet exit — they're done.
      return
    }
    throw err
  }
}

// Suppress unused imports linters for now — spawn is referenced via spawnBackground.
void spawn
void readFileSync
void homedir
void ENV_FILE
