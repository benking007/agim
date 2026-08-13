import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { AGIM_BGJOB_WRAPPER_EXPR } from '../agent-cwd.js'
import { AGIM_HOME } from '../agim-paths.js'
import { agimBgjobScript } from '../bgjob-install.js'
import {
  getExecTools,
  isExecToolName,
  buildExecDispatcher,
  isBgjobInvocation,
  rewriteBgjobCommand,
  buildExecEnv,
  clampTimeout,
  resolveExecCwd,
  bwrapMaskedStateDirs,
} from './exec-dispatcher.js'

const NEVER_ABORT = new AbortController().signal

describe('exec-dispatcher', () => {
  let cwd: string

  beforeAll(async () => {
    cwd = await realpath(await mkdtemp(join(tmpdir(), 'agim-exec-test-')))
  })

  afterAll(async () => {
    try { await rm(cwd, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  beforeEach(() => {
    delete process.env.AGIM_EXEC_SANDBOX
    delete process.env.AGIM_EXEC_TIMEOUT_MS
    delete process.env.AGIM_EXEC_MAX_OUTPUT
    delete process.env.AGIM_EXEC_ALLOW_ANY_CWD
  })

  afterEach(() => {
    delete process.env.AGIM_EXEC_SANDBOX
    delete process.env.AGIM_EXEC_TIMEOUT_MS
    delete process.env.AGIM_EXEC_MAX_OUTPUT
    delete process.env.AGIM_EXEC_ALLOW_ANY_CWD
  })

  describe('buildExecEnv — env allow-list (F1)', () => {
    const SAVED: Record<string, string | undefined> = {}
    const touch = (k: string, v: string | undefined) => {
      SAVED[k] = process.env[k]
      if (v === undefined) delete process.env[k]; else process.env[k] = v
    }
    afterEach(() => {
      for (const [k, v] of Object.entries(SAVED)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v
      }
    })

    it('does NOT forward secret-bearing env vars', () => {
      touch('OPENAI_API_KEY', 'sk-secret')
      touch('DB_PASSWORD', 'hunter2')
      touch('AWS_SECRET_ACCESS_KEY', 'topsecret')
      const env = buildExecEnv()
      expect(env.OPENAI_API_KEY).toBeUndefined()
      expect(env.DB_PASSWORD).toBeUndefined()
      expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    })

    it('forwards the safe base allow-list (PATH/HOME)', () => {
      touch('PATH', '/usr/bin:/bin')
      touch('HOME', '/home/agent')
      const env = buildExecEnv()
      expect(env.PATH).toBe('/usr/bin:/bin')
      expect(env.HOME).toBe('/home/agent')
    })

    it('honours AGIM_EXEC_ENV_PASS opt-in', () => {
      touch('AGIM_EXEC_ENV_PASS', 'FOO,BAR')
      touch('FOO', 'foo-val')
      touch('BAR', 'bar-val')
      touch('OPENAI_API_KEY', 'sk-secret')
      const env = buildExecEnv()
      expect(env.FOO).toBe('foo-val')
      expect(env.BAR).toBe('bar-val')
      expect(env.OPENAI_API_KEY).toBeUndefined()
    })

    it('always preserves the per-spawn extraEnv (RPC token injection)', () => {
      touch('OPENAI_API_KEY', 'sk-secret')
      const env = buildExecEnv({ AGIM_RPC_TOKEN: 'tok', AGIM_RPC_SOCKET: '/run/x.sock' })
      expect(env.AGIM_RPC_TOKEN).toBe('tok')
      expect(env.AGIM_RPC_SOCKET).toBe('/run/x.sock')
      expect(env.OPENAI_API_KEY).toBeUndefined()
    })

    it('always stamps resolved AGIM_HOME for portable SOP expansion', () => {
      touch('AGIM_HOME', undefined)
      const env = buildExecEnv()
      expect(env.AGIM_HOME).toBe(AGIM_HOME)
    })

    it('forwards custom AGIM_HOME even when not on AGIM_EXEC_ENV_PASS', () => {
      touch('AGIM_HOME', '/custom/agim-home')
      const env = buildExecEnv()
      expect(env.AGIM_HOME).toBe('/custom/agim-home')
    })
  })

  describe('clampTimeout — floor + cap (F10)', () => {
    it('floors tiny values at 100ms (no self-DoS via timeout_ms=1)', () => {
      expect(clampTimeout(1)).toBe(100)
      expect(clampTimeout(50)).toBe(100)
      expect(clampTimeout(99)).toBe(100)
    })
    it('passes through reasonable values', () => {
      expect(clampTimeout(5000)).toBe(5000)
    })
    it('caps at the hard ceiling', () => {
      expect(clampTimeout(10_000_000)).toBe(600_000)
    })
    it('falls back to the default for non-positive / non-finite input', () => {
      expect(clampTimeout(0)).toBe(60_000)
      expect(clampTimeout(-5)).toBe(60_000)
      expect(clampTimeout('nope')).toBe(60_000)
      expect(clampTimeout(undefined)).toBe(60_000)
    })
  })

  describe('getExecTools / isExecToolName', () => {
    it('exposes agim_exec', () => {
      const names = getExecTools().map((t) => t.name)
      expect(names).toEqual(['agim_exec'])
    })

    it('isExecToolName matches only agim_exec', () => {
      expect(isExecToolName('agim_exec')).toBe(true)
      expect(isExecToolName('agim_read_file')).toBe(false)
      expect(isExecToolName('agim_echo')).toBe(false)
    })
  })

  describe('buildExecDispatcher', () => {
    it('non-exec tool returns source="unknown"', async () => {
      const d = buildExecDispatcher({ cwd })
      const r = await d({ id: 't', name: 'agim_echo', arguments: {} }, NEVER_ABORT)
      expect(r.source).toBe('unknown')
      expect(r.isError).toBe(true)
    })

    it('rejects empty command', async () => {
      const d = buildExecDispatcher({ cwd })
      const r = await d({ id: 't', name: 'agim_exec', arguments: { command: '' } }, NEVER_ABORT)
      expect(r.isError).toBe(true)
      expect(r.text).toMatch(/command required/)
    })

    it('runs a simple command and captures stdout + exit_code', async () => {
      const d = buildExecDispatcher({ cwd })
      const r = await d(
        { id: 't', name: 'agim_exec', arguments: { command: 'echo hello' } },
        NEVER_ABORT,
      )
      expect(r.isError).toBe(false)
      expect(r.source).toBe('exec')
      const parsed = JSON.parse(r.text)
      expect(parsed.exit_code).toBe(0)
      expect(parsed.stdout.trim()).toBe('hello')
      expect(parsed.timed_out).toBe(false)
    })

    it('non-zero exit is surfaced as isError', async () => {
      const d = buildExecDispatcher({ cwd })
      const r = await d(
        { id: 't', name: 'agim_exec', arguments: { command: 'exit 7' } },
        NEVER_ABORT,
      )
      expect(r.isError).toBe(true)
      const parsed = JSON.parse(r.text)
      expect(parsed.exit_code).toBe(7)
    })

    it('respects cwd argument inside workspace', async () => {
      const sub = await realpath(await mkdtemp(join(cwd, 'sub-')))
      const d = buildExecDispatcher({ cwd })
      const r = await d(
        { id: 't', name: 'agim_exec', arguments: { command: 'pwd', cwd: sub } },
        NEVER_ABORT,
      )
      expect(r.isError).toBe(false)
      const parsed = JSON.parse(r.text)
      expect(parsed.stdout.trim()).toBe(sub)
    })

    it('refuses cwd outside workspace', async () => {
      const d = buildExecDispatcher({ cwd })
      const r = await d(
        { id: 't', name: 'agim_exec', arguments: { command: 'pwd', cwd: '/tmp' } },
        NEVER_ABORT,
      )
      expect(r.isError).toBe(true)
      expect(r.text).toMatch(/outside workspace/)
    })

    it('AGIM_EXEC_ALLOW_ANY_CWD=1 permits outside cwd', async () => {
      process.env.AGIM_EXEC_ALLOW_ANY_CWD = '1'
      const outside = await realpath(await mkdtemp(join(tmpdir(), 'agim-exec-out-')))
      try {
        const d = buildExecDispatcher({ cwd })
        const r = await d(
          { id: 't', name: 'agim_exec', arguments: { command: 'pwd', cwd: outside } },
          NEVER_ABORT,
        )
        expect(r.isError).toBe(false)
        const parsed = JSON.parse(r.text)
        expect(parsed.stdout.trim()).toBe(outside)
      } finally {
        await rm(outside, { recursive: true, force: true }).catch(() => {})
      }
    })

    it('timeout kills the process', async () => {
      const d = buildExecDispatcher({ cwd })
      const r = await d(
        { id: 't', name: 'agim_exec', arguments: { command: 'sleep 10', timeout_ms: 200 } },
        NEVER_ABORT,
      )
      expect(r.isError).toBe(true)
      const parsedText = r.text.split('\n').slice(1).join('\n')  // strip "timed out" header
      const parsed = JSON.parse(parsedText)
      expect(parsed.timed_out).toBe(true)
    }, 20000)

    it('waits for child close after external abort', async () => {
      const d = buildExecDispatcher({ cwd })
      const ctrl = new AbortController()
      const run = d(
        { id: 't', name: 'agim_exec', arguments: { command: 'sleep 10' } },
        ctrl.signal,
      )
      setTimeout(() => ctrl.abort(), 50)
      const result = await run
      expect(result.isError).toBe(true)
      expect(result.text).toMatch(/aborted|AbortError|SIGTERM/i)
    }, 10000)

    it('truncates oversize stdout', async () => {
      process.env.AGIM_EXEC_MAX_OUTPUT = '2000'
      const d = buildExecDispatcher({ cwd })
      // Deterministic ~8000-byte output, no /dev/urandom dependency.
      const r = await d(
        { id: 't', name: 'agim_exec', arguments: { command: "yes abcd | head -n 1000" } },
        NEVER_ABORT,
      )
      expect(r.isError).toBe(false)
      const parsed = JSON.parse(r.text)
      expect(parsed.stdout.length).toBeLessThanOrEqual(2000)
      expect(parsed.stdout_truncated).toBe(true)
    }, 10000)
  })

  // v1.2.66 — danger pattern denylist.
  describe('danger pattern denylist (v1.2.66)', () => {
    const cases: Array<[string, string, string]> = [
      ['rm -rf root',            'rm -rf /',                                       'rm -rf against root'],
      ['rm -rf ~',               'rm -rf ~',                                       'rm -rf against root / home'],
      ['rm -rf /*',              'rm -rf /*',                                      'rm -rf against root'],
      ['mkfs.ext4',              'mkfs.ext4 /dev/sda1',                            'filesystem format'],
      ['wipefs',                 'wipefs --all /dev/sdb',                          'filesystem format'],
      ['dd to raw disk',         'dd if=/dev/zero of=/dev/sda bs=1M',              'dd to raw block device'],
      ['dd to nvme partition',   'dd if=/tmp/x of=/dev/nvme0n1p1',                 'dd to raw block device'],
      ['fork bomb',              ':(){:|:&};:',                                    'fork bomb'],
      ['chmod -R 777 /',         'chmod -R 777 /',                                 'chmod/chown on /'],
      ['shutdown',               'shutdown -h now',                                'shutdown'],
      ['reboot',                 'reboot',                                         'reboot'],
      ['echo to /proc panic',    'echo c > /proc/sys/kernel/sysrq',                'kernel panic/sysrq'],
      ['write to /etc/passwd',   'echo evil >> /etc/passwd',                       '/etc/passwd|shadow'],
      ['setuid bit',             'chmod 4755 /tmp/bin',                            'setuid'],
      ['setuid u+s',             'chmod u+s /usr/bin/wat',                         'setuid'],
    ]

    for (const [label, cmd, _hint] of cases) {
      it(`blocks: ${label}`, async () => {
        const d = buildExecDispatcher({ cwd })
        const r = await d({ id: 't', name: 'agim_exec', arguments: { command: cmd } }, NEVER_ABORT)
        expect(r.isError).toBe(true)
        expect(r.text).toMatch(/dangerous-pattern/i)
      })
    }

    it('allows normal commands that look superficially scary', async () => {
      const d = buildExecDispatcher({ cwd })
      // rm -rf with a relative path is fine
      const ok = ['rm -rf ./build', 'rm -rf subdir', 'chmod 755 ./bin/agim']
      for (const cmd of ok) {
        const r = await d({ id: 't', name: 'agim_exec', arguments: { command: cmd } }, NEVER_ABORT)
        // Either succeeded or failed at the exec layer (not the pre-flight)
        expect(r.text).not.toMatch(/dangerous-pattern/i)
      }
    })

    it('blocks self-protect patterns before spawn (native name)', async () => {
      const d = buildExecDispatcher({ cwd })
      const r = await d(
        { id: 't', name: 'agim_exec', arguments: { command: 'systemctl restart agim' } },
        NEVER_ABORT,
      )
      expect(r.isError).toBe(true)
      expect(r.text).toContain('重启服务')
      expect(r.text).not.toMatch(/dangerous-pattern/i)
    })
  })

  describe('internal URL in command (v1.2.66)', () => {
    it('refuses curl to RFC1918', async () => {
      const d = buildExecDispatcher({ cwd })
      const r = await d(
        { id: 't', name: 'agim_exec', arguments: { command: 'curl -sSL http://192.168.1.1/admin' } },
        NEVER_ABORT,
      )
      expect(r.isError).toBe(true)
      expect(r.text).toMatch(/private|internal address/i)
    })

    it('refuses wget to AWS metadata endpoint', async () => {
      const d = buildExecDispatcher({ cwd })
      const r = await d(
        { id: 't', name: 'agim_exec', arguments: { command: 'wget http://169.254.169.254/latest/meta-data/' } },
        NEVER_ABORT,
      )
      expect(r.isError).toBe(true)
      expect(r.text).toMatch(/link-local|IMDS|private/i)
    })

    it('allows curl to public URLs', async () => {
      const d = buildExecDispatcher({ cwd })
      const r = await d(
        { id: 't', name: 'agim_exec', arguments: { command: 'echo https://example.com' } },
        NEVER_ABORT,
      )
      expect(r.isError).toBe(false)
      expect(r.text).not.toMatch(/private|internal/i)
    })
  })

  // v1.2.93 / v1.2.99 — bgjob carve-out detector. bwrap would
  // otherwise tear down bgjob's setsid-detached workers; the
  // dispatcher bypasses sandbox when isBgjobInvocation returns true.
  // v1.2.99 tightening (CR finding A1): refuses the bypass whenever
  // the command contains shell-chain metacharacters, even if the
  // bgjob wrapper itself is at the start — otherwise a payload like
  // `/root/.claude/scripts/bgjob status x && cat /etc/shadow` would
  // get the cat to run unsandboxed.
  describe('rewriteBgjobCommand / portable SOP carve-out', () => {
    const agimPath = agimBgjobScript()

    it('expands the taught AGIM_BGJOB_WRAPPER_EXPR to the absolute script', () => {
      const raw = `${AGIM_BGJOB_WRAPPER_EXPR} start foo -- /usr/bin/sleep 60`
      expect(rewriteBgjobCommand(raw)).toBe(`${agimPath} start foo -- /usr/bin/sleep 60`)
    })

    it('isBgjobInvocation accepts portable SOP after rewrite (no $ meta false-negative)', () => {
      expect(isBgjobInvocation(`${AGIM_BGJOB_WRAPPER_EXPR} start foo -- /usr/bin/sleep 60`)).toBe(true)
      expect(isBgjobInvocation(`   ${AGIM_BGJOB_WRAPPER_EXPR} status abc`)).toBe(true)
    })

    it('still REFUSES portable prefix chained with && / $()', () => {
      expect(isBgjobInvocation(`${AGIM_BGJOB_WRAPPER_EXPR} status x && cat /etc/shadow`)).toBe(false)
      expect(isBgjobInvocation(`${AGIM_BGJOB_WRAPPER_EXPR} status $(id)`)).toBe(false)
    })
  })

  describe('isBgjobInvocation (v1.2.99 hardened)', () => {
    const agimPath = agimBgjobScript()
    const claudePath = join(homedir(), '.claude', 'scripts', 'bgjob')
    const opencodePath = join(homedir(), '.config', 'opencode', 'scripts', 'bgjob')

    it('matches the Agim-installed wrapper path standalone', () => {
      expect(isBgjobInvocation(`${agimPath} start foo -- /usr/bin/sleep 60`)).toBe(true)
    })
    it('matches the legacy Claude Code wrapper path standalone', () => {
      expect(isBgjobInvocation(`${claudePath} start foo -- /usr/bin/sleep 60`)).toBe(true)
    })
    it('matches the legacy opencode wrapper path standalone', () => {
      expect(isBgjobInvocation(`${opencodePath} list --running`)).toBe(true)
    })
    it('tolerates leading whitespace', () => {
      expect(isBgjobInvocation(`   ${agimPath} status abc`)).toBe(true)
    })

    // v1.2.99 — these used to be accepted (would have leaked sandbox).
    // Now they must all be refused.
    it('REFUSES when chained via && (CR finding A1)', () => {
      expect(isBgjobInvocation(`cd /tmp && ${agimPath} status abc`)).toBe(false)
      expect(isBgjobInvocation(`${agimPath} status abc && cat /etc/shadow`)).toBe(false)
    })
    it('REFUSES when wrapped in a subshell', () => {
      expect(isBgjobInvocation(`(${agimPath} tail abc)`)).toBe(false)
    })
    it('REFUSES when chained via ; or |', () => {
      expect(isBgjobInvocation(`${agimPath} list; rm -rf /tmp/junk`)).toBe(false)
      expect(isBgjobInvocation(`${agimPath} list | tee /tmp/log`)).toBe(false)
    })
    it('REFUSES backtick / $() command substitution payload', () => {
      expect(isBgjobInvocation(`${agimPath} status \`whoami\``)).toBe(false)
      expect(isBgjobInvocation(`${agimPath} status $(id)`)).toBe(false)
    })
    it('REFUSES redirection payload', () => {
      expect(isBgjobInvocation(`${agimPath} list > /tmp/out`)).toBe(false)
      expect(isBgjobInvocation(`${agimPath} list < /tmp/in`)).toBe(false)
    })

    it('does NOT match a bare `bgjob` PATH lookup (attacker-controlled shim risk)', () => {
      expect(isBgjobInvocation('bgjob start foo -- ls')).toBe(false)
    })
    it('does NOT match unrelated paths that contain "bgjob" as a substring', () => {
      expect(isBgjobInvocation('echo /home/user/bgjobs/x.txt')).toBe(false)
      expect(isBgjobInvocation(`cat ${claudePath}.backup`)).toBe(false)
    })
    it('does NOT match an empty / whitespace command', () => {
      expect(isBgjobInvocation('')).toBe(false)
      expect(isBgjobInvocation('   ')).toBe(false)
    })
  })

  describe('resolveExecCwd / bwrapMaskedStateDirs', () => {
    it('allows relative paths inside workspace', async () => {
      const sub = await realpath(await mkdtemp(join(cwd, 'rel-')))
      const name = sub.slice(cwd.length + 1)
      const r = await resolveExecCwd(name, cwd)
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.cwd).toBe(sub)
    })

    it('rejects path escape via ..', async () => {
      const r = await resolveExecCwd('../..', cwd)
      expect(r.ok).toBe(false)
    })

    it('masks custom AGIM_HOME and legacy ~/.agim', () => {
      const saved = process.env.AGIM_HOME
      process.env.AGIM_HOME = '/custom/agim-state'
      try {
        const dirs = bwrapMaskedStateDirs()
        expect(dirs).toContain('/custom/agim-state')
        expect(dirs).toContain(join(homedir(), '.agim'))
      } finally {
        if (saved === undefined) delete process.env.AGIM_HOME
        else process.env.AGIM_HOME = saved
      }
    })
  })
})
