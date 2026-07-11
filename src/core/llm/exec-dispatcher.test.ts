import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  getExecTools,
  isExecToolName,
  buildExecDispatcher,
  isBgjobInvocation,
  buildExecEnv,
  clampTimeout,
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
  })

  afterEach(() => {
    delete process.env.AGIM_EXEC_SANDBOX
    delete process.env.AGIM_EXEC_TIMEOUT_MS
    delete process.env.AGIM_EXEC_MAX_OUTPUT
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
    it('exposes native_exec', () => {
      const names = getExecTools().map((t) => t.name)
      expect(names).toEqual(['native_exec'])
    })

    it('isExecToolName matches only native_exec', () => {
      expect(isExecToolName('native_exec')).toBe(true)
      expect(isExecToolName('native_read_file')).toBe(false)
      expect(isExecToolName('native_echo')).toBe(false)
    })
  })

  describe('buildExecDispatcher', () => {
    it('non-exec tool returns source="unknown"', async () => {
      const d = buildExecDispatcher({ cwd })
      const r = await d({ id: 't', name: 'native_echo', arguments: {} }, NEVER_ABORT)
      expect(r.source).toBe('unknown')
      expect(r.isError).toBe(true)
    })

    it('rejects empty command', async () => {
      const d = buildExecDispatcher({ cwd })
      const r = await d({ id: 't', name: 'native_exec', arguments: { command: '' } }, NEVER_ABORT)
      expect(r.isError).toBe(true)
      expect(r.text).toMatch(/command required/)
    })

    it('runs a simple command and captures stdout + exit_code', async () => {
      const d = buildExecDispatcher({ cwd })
      const r = await d(
        { id: 't', name: 'native_exec', arguments: { command: 'echo hello' } },
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
        { id: 't', name: 'native_exec', arguments: { command: 'exit 7' } },
        NEVER_ABORT,
      )
      expect(r.isError).toBe(true)
      const parsed = JSON.parse(r.text)
      expect(parsed.exit_code).toBe(7)
    })

    it('respects cwd argument', async () => {
      const d = buildExecDispatcher({ cwd: '/tmp' })  // dispatcher default
      const r = await d(
        { id: 't', name: 'native_exec', arguments: { command: 'pwd', cwd } },
        NEVER_ABORT,
      )
      expect(r.isError).toBe(false)
      const parsed = JSON.parse(r.text)
      // cwd override wins
      expect(parsed.stdout.trim()).toBe(cwd)
    })

    it('timeout kills the process', async () => {
      const d = buildExecDispatcher({ cwd })
      const r = await d(
        { id: 't', name: 'native_exec', arguments: { command: 'sleep 10', timeout_ms: 200 } },
        NEVER_ABORT,
      )
      expect(r.isError).toBe(true)
      const parsedText = r.text.split('\n').slice(1).join('\n')  // strip "timed out" header
      const parsed = JSON.parse(parsedText)
      expect(parsed.timed_out).toBe(true)
    }, 20000)

    it('truncates oversize stdout', async () => {
      process.env.AGIM_EXEC_MAX_OUTPUT = '2000'
      const d = buildExecDispatcher({ cwd })
      // Deterministic ~8000-byte output, no /dev/urandom dependency.
      const r = await d(
        { id: 't', name: 'native_exec', arguments: { command: "yes abcd | head -n 1000" } },
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
        const r = await d({ id: 't', name: 'native_exec', arguments: { command: cmd } }, NEVER_ABORT)
        expect(r.isError).toBe(true)
        expect(r.text).toMatch(/dangerous-pattern/i)
      })
    }

    it('allows normal commands that look superficially scary', async () => {
      const d = buildExecDispatcher({ cwd })
      // rm -rf with a relative path is fine
      const ok = ['rm -rf ./build', 'rm -rf subdir', 'chmod 755 ./bin/agim']
      for (const cmd of ok) {
        const r = await d({ id: 't', name: 'native_exec', arguments: { command: cmd } }, NEVER_ABORT)
        // Either succeeded or failed at the exec layer (not the pre-flight)
        expect(r.text).not.toMatch(/dangerous-pattern/i)
      }
    })
  })

  describe('internal URL in command (v1.2.66)', () => {
    it('refuses curl to RFC1918', async () => {
      const d = buildExecDispatcher({ cwd })
      const r = await d(
        { id: 't', name: 'native_exec', arguments: { command: 'curl -sSL http://192.168.1.1/admin' } },
        NEVER_ABORT,
      )
      expect(r.isError).toBe(true)
      expect(r.text).toMatch(/private|internal address/i)
    })

    it('refuses wget to AWS metadata endpoint', async () => {
      const d = buildExecDispatcher({ cwd })
      const r = await d(
        { id: 't', name: 'native_exec', arguments: { command: 'wget http://169.254.169.254/latest/meta-data/' } },
        NEVER_ABORT,
      )
      expect(r.isError).toBe(true)
      expect(r.text).toMatch(/link-local|IMDS|private/i)
    })

    it('allows curl to public URLs', async () => {
      const d = buildExecDispatcher({ cwd })
      const r = await d(
        { id: 't', name: 'native_exec', arguments: { command: 'echo https://example.com' } },
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
  describe('isBgjobInvocation (v1.2.99 hardened)', () => {
    it('matches the Claude Code wrapper path standalone', () => {
      expect(isBgjobInvocation('/root/.claude/scripts/bgjob start foo -- /usr/bin/sleep 60')).toBe(true)
    })
    it('matches the opencode wrapper path standalone', () => {
      expect(isBgjobInvocation('/root/.config/opencode/scripts/bgjob list --running')).toBe(true)
    })
    it('tolerates leading whitespace', () => {
      expect(isBgjobInvocation('   /root/.claude/scripts/bgjob status abc')).toBe(true)
    })

    // v1.2.99 — these used to be accepted (would have leaked sandbox).
    // Now they must all be refused.
    it('REFUSES when chained via && (CR finding A1)', () => {
      expect(isBgjobInvocation('cd /tmp && /root/.claude/scripts/bgjob status abc')).toBe(false)
      expect(isBgjobInvocation('/root/.claude/scripts/bgjob status abc && cat /etc/shadow')).toBe(false)
    })
    it('REFUSES when wrapped in a subshell', () => {
      expect(isBgjobInvocation('(/root/.claude/scripts/bgjob tail abc)')).toBe(false)
    })
    it('REFUSES when chained via ; or |', () => {
      expect(isBgjobInvocation('/root/.claude/scripts/bgjob list; rm -rf /tmp/junk')).toBe(false)
      expect(isBgjobInvocation('/root/.claude/scripts/bgjob list | tee /tmp/log')).toBe(false)
    })
    it('REFUSES backtick / $() command substitution payload', () => {
      expect(isBgjobInvocation('/root/.claude/scripts/bgjob status `whoami`')).toBe(false)
      expect(isBgjobInvocation('/root/.claude/scripts/bgjob status $(id)')).toBe(false)
    })
    it('REFUSES redirection payload', () => {
      expect(isBgjobInvocation('/root/.claude/scripts/bgjob list > /tmp/out')).toBe(false)
      expect(isBgjobInvocation('/root/.claude/scripts/bgjob list < /tmp/in')).toBe(false)
    })

    it('does NOT match a bare `bgjob` PATH lookup (attacker-controlled shim risk)', () => {
      expect(isBgjobInvocation('bgjob start foo -- ls')).toBe(false)
    })
    it('does NOT match unrelated paths that contain "bgjob" as a substring', () => {
      expect(isBgjobInvocation('echo /home/user/bgjobs/x.txt')).toBe(false)
      expect(isBgjobInvocation('cat /root/.claude/scripts/bgjob.backup')).toBe(false)
    })
    it('does NOT match an empty / whitespace command', () => {
      expect(isBgjobInvocation('')).toBe(false)
      expect(isBgjobInvocation('   ')).toBe(false)
    })
  })
})
