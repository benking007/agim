// Sensitive paths + outbound scrubber — R13 B1 / B5.
//
// Lock the contract that:
//   * Read / Edit / Write / Bash / Glob / Grep / LS on protected
//     paths return deny without prompting.
//   * Bash command-string scan catches obvious exfiltration verbs
//     (cat ~/.agim/env, head ~/.ssh/id_rsa, env / printenv).
//   * scrubOutboundText removes token-shaped substrings + emits the
//     name of the matched category for audit.

import { describe, it, expect } from 'bun:test'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import {
  isSensitivePath,
  checkSensitiveToolUse,
  scrubOutboundText,
} from '../../src/core/sensitive-paths'

const HOME = homedir()

describe('isSensitivePath', () => {
  it('rejects paths under ~/.agim/', () => {
    expect(isSensitivePath(join(HOME, '.agim', 'env')).sensitive).toBe(true)
    expect(isSensitivePath(join(HOME, '.agim', 'tokens.json')).sensitive).toBe(true)
    expect(isSensitivePath(join(HOME, '.agim', 'subdir', 'file')).sensitive).toBe(true)
  })

  it('rejects legacy ~/.agim/ paths (upgraded installs)', () => {
    expect(isSensitivePath(join(HOME, '.agim', 'env')).sensitive).toBe(true)
  })

  it('rejects ~/.ssh/, ~/.aws/, ~/.kube/, ~/.docker/', () => {
    for (const sub of ['.ssh', '.aws', '.kube', '.docker', '.azure', '.gcp']) {
      expect(isSensitivePath(join(HOME, sub, 'whatever')).sensitive).toBe(true)
    }
  })

  it('rejects system auth paths', () => {
    expect(isSensitivePath('/etc/shadow').sensitive).toBe(true)
    expect(isSensitivePath('/etc/sudoers').sensitive).toBe(true)
    expect(isSensitivePath('/etc/sudoers.d/whatever').sensitive).toBe(true)
    expect(isSensitivePath('/etc/ssh/sshd_config').sensitive).toBe(true)
  })

  it('rejects /proc/self/environ', () => {
    expect(isSensitivePath('/proc/self/environ').sensitive).toBe(true)
  })

  it('rejects /proc/<pid>/{root,cwd} indirection into the real filesystem', () => {
    // /proc/self/root is a symlink to "/", so this reaches ~/.agim despite the
    // literal string not starting with the protected HOME prefix.
    expect(isSensitivePath(`/proc/self/root${join(HOME, '.agim', 'tokens.json')}`).sensitive).toBe(true)
    expect(isSensitivePath('/proc/self/root/etc/shadow').sensitive).toBe(true)
    expect(isSensitivePath('/proc/1234/root/etc/shadow').sensitive).toBe(true)
    expect(isSensitivePath('/proc/self/cwd/secret').sensitive).toBe(true)
    expect(isSensitivePath('/proc/thread-self/root/anything').sensitive).toBe(true)
    // The bare symlink itself.
    expect(isSensitivePath('/proc/self/root').sensitive).toBe(true)
  })

  it('resolves symlinks so a benign-looking path pointing at a key is caught', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agim-symlink-test-'))
    try {
      mkdirSync(join(dir, 'keys'))
      writeFileSync(join(dir, 'keys', 'id_rsa'), 'PRIVATE')
      const link = join(dir, 'innocent.txt')
      symlinkSync(join(dir, 'keys', 'id_rsa'), link)
      // Literal basename is "innocent.txt" — only realpath resolution reveals
      // it targets a protected id_rsa key.
      expect(isSensitivePath(link).sensitive).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects .env files in arbitrary directories (basename match)', () => {
    expect(isSensitivePath('/home/user/myproject/.env').sensitive).toBe(true)
    expect(isSensitivePath('/srv/app/.env.production').sensitive).toBe(true)
    expect(isSensitivePath('./.env.local').sensitive).toBe(true)
  })

  it('rejects AGENTS.md / CLAUDE.md anywhere (exfil-prone agent guides)', () => {
    expect(isSensitivePath('/srv/repo/AGENTS.md').sensitive).toBe(true)
    expect(isSensitivePath('./CLAUDE.md').sensitive).toBe(true)
  })

  it('rejects SSH private-key basenames', () => {
    for (const base of ['id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa']) {
      expect(isSensitivePath(`/tmp/${base}`).sensitive).toBe(true)
    }
  })

  it('rejects credentials.json / credentials.yaml basenames', () => {
    for (const base of ['credentials.json', 'credentials.yaml', 'credentials.yml']) {
      expect(isSensitivePath(`/srv/app/${base}`).sensitive).toBe(true)
    }
  })

  it('allows ordinary repo paths', () => {
    expect(isSensitivePath('/srv/repo/src/server.ts').sensitive).toBe(false)
    expect(isSensitivePath('./package.json').sensitive).toBe(false)
    expect(isSensitivePath('/tmp/normal-file.txt').sensitive).toBe(false)
  })

  it('handles ~ expansion', () => {
    expect(isSensitivePath('~/.agim/env').sensitive).toBe(true)
    expect(isSensitivePath('~/.ssh/id_rsa').sensitive).toBe(true)
    expect(isSensitivePath('~/projects/foo').sensitive).toBe(false)
  })

  it('attaches a human-readable reason on hits', () => {
    const r = isSensitivePath(join(HOME, '.agim', 'env'))
    expect(r.sensitive).toBe(true)
    expect(r.reason).toBeDefined()
    expect(r.reason).toContain('.agim')
  })
})

describe('checkSensitiveToolUse — file-path tools', () => {
  it('Read("~/.agim/env") → deny', () => {
    const r = checkSensitiveToolUse('Read', { file_path: '~/.agim/env' })
    expect(r.deny).toBe(true)
    expect(r.reason).toContain('tool=Read')
  })

  it('Edit / Write blocked when file_path is sensitive', () => {
    expect(checkSensitiveToolUse('Edit', { file_path: '~/.agim/tokens.json' }).deny).toBe(true)
    expect(checkSensitiveToolUse('Write', { file_path: '/etc/sudoers' }).deny).toBe(true)
  })

  it('LS / Glob / Grep blocked on sensitive dirs', () => {
    expect(checkSensitiveToolUse('LS',   { path: '~/.ssh' }).deny).toBe(true)
    expect(checkSensitiveToolUse('Glob', { path: '~/.agim' }).deny).toBe(true)
    expect(checkSensitiveToolUse('Grep', { path: '/etc/sudoers.d' }).deny).toBe(true)
  })

  it('Read("~/projects/foo") → allow', () => {
    expect(checkSensitiveToolUse('Read', { file_path: '~/projects/foo/bar.ts' }).deny).toBe(false)
  })

  it('Read("./AGENTS.md") → deny (agent guide exfil)', () => {
    expect(checkSensitiveToolUse('Read', { file_path: './AGENTS.md' }).deny).toBe(true)
    expect(checkSensitiveToolUse('Read', { file_path: '/srv/repo/CLAUDE.md' }).deny).toBe(true)
  })

  it('inspects `path` field as alternative to file_path (MCP-style)', () => {
    expect(checkSensitiveToolUse('Read', { path: '~/.agim/env' }).deny).toBe(true)
  })

  it('unknown tool → allow (only known-shape inputs are scanned)', () => {
    expect(checkSensitiveToolUse('mcp__custom__weird_tool', { foo: '~/.agim/env' }).deny).toBe(false)
  })
})

describe('checkSensitiveToolUse — Bash', () => {
  it('blocks "cat ~/.agim/env"', () => {
    expect(checkSensitiveToolUse('Bash', { command: 'cat ~/.agim/env' }).deny).toBe(true)
  })

  it('blocks "tail /etc/shadow"', () => {
    expect(checkSensitiveToolUse('Bash', { command: 'tail /etc/shadow' }).deny).toBe(true)
  })

  it('blocks "less ~/.ssh/id_rsa"', () => {
    expect(checkSensitiveToolUse('Bash', { command: 'less ~/.ssh/id_rsa' }).deny).toBe(true)
  })

  it('blocks AGENTS.md / CLAUDE.md reads via shell', () => {
    expect(checkSensitiveToolUse('Bash', { command: 'cat AGENTS.md' }).deny).toBe(true)
    expect(checkSensitiveToolUse('Bash', { command: 'head -50 CLAUDE.md' }).deny).toBe(true)
  })

  it('blocks chained env exfil', () => {
    expect(checkSensitiveToolUse('Bash', { command: 'ls && cat .env' }).deny).toBe(true)
    expect(checkSensitiveToolUse('Bash', { command: 'find . -name "*.go" ; cat /etc/sudoers' }).deny).toBe(true)
  })

  it('blocks env / printenv / set when standalone', () => {
    expect(checkSensitiveToolUse('Bash', { command: 'env' }).deny).toBe(true)
    expect(checkSensitiveToolUse('Bash', { command: 'printenv' }).deny).toBe(true)
    expect(checkSensitiveToolUse('Bash', { command: 'env | grep PASS' }).deny).toBe(true)
  })

  it('blocks /proc/self/environ reads', () => {
    expect(checkSensitiveToolUse('Bash', { command: 'cat /proc/self/environ' }).deny).toBe(true)
  })

  it('blocks tokens.json by name regardless of dir prefix', () => {
    expect(checkSensitiveToolUse('Bash', { command: 'cat /tmp/tokens.json' }).deny).toBe(true)
  })

  it('allows ordinary commands', () => {
    expect(checkSensitiveToolUse('Bash', { command: 'ls -la' }).deny).toBe(false)
    expect(checkSensitiveToolUse('Bash', { command: 'npm test' }).deny).toBe(false)
    expect(checkSensitiveToolUse('Bash', { command: 'echo hello' }).deny).toBe(false)
    expect(checkSensitiveToolUse('Bash', { command: 'git diff main' }).deny).toBe(false)
  })

  it('does NOT trigger on words that happen to contain "env" but are not the env command', () => {
    expect(checkSensitiveToolUse('Bash', { command: 'echo "environment variable"' }).deny).toBe(false)
    expect(checkSensitiveToolUse('Bash', { command: 'npm install --save-dev' }).deny).toBe(false)
  })

  it('blocks credentials.json / credentials.yaml access', () => {
    expect(checkSensitiveToolUse('Bash', { command: 'cat ~/.gcp/credentials.json' }).deny).toBe(true)
    expect(checkSensitiveToolUse('Bash', { command: 'cp /srv/x/credentials.yaml /tmp/' }).deny).toBe(true)
  })
})

describe('checkSensitiveToolUse — native_exec', () => {
  // v1.2.101 — native_exec gets the same command-string scan as Bash,
  // closing the bypass seen in field testing where an agent ran
  // `cat .../fin_data/.env; env | grep DB_` through auto-allow without
  // hitting the Bash branch.
  it('blocks .env access via native_exec command chain', () => {
    const cmd = 'cat /root/workspace/ai-agent-platform/services/fin_data/.env 2>/dev/null; echo "===ENV==="; env | grep -i DB_ 2>/dev/null'
    const r = checkSensitiveToolUse('native_exec', { command: cmd })
    expect(r.deny).toBe(true)
    expect(r.reason).toContain('tool=native_exec')
  })

  it('blocks ssh private key reads via native_exec', () => {
    expect(checkSensitiveToolUse('native_exec', { command: 'cat ~/.ssh/id_rsa' }).deny).toBe(true)
  })

  it('blocks env dump via native_exec', () => {
    expect(checkSensitiveToolUse('native_exec', { command: 'env' }).deny).toBe(true)
    expect(checkSensitiveToolUse('native_exec', { command: 'printenv | sort' }).deny).toBe(true)
  })

  it('blocks credentials.* via native_exec', () => {
    expect(checkSensitiveToolUse('native_exec', { command: 'cat /etc/gcloud/credentials.json' }).deny).toBe(true)
  })

  it('allows ordinary native_exec commands', () => {
    expect(checkSensitiveToolUse('native_exec', { command: 'ls -la /tmp' }).deny).toBe(false)
    expect(checkSensitiveToolUse('native_exec', { command: 'curl -s https://example.com' }).deny).toBe(false)
  })
})

describe('scrubOutboundText', () => {
  it('redacts an agim token in chat', () => {
    const r = scrubOutboundText(`your token is agim_${'a'.repeat(40)}`)
    expect(r.text).toContain('[REDACTED-agim_token]')
    expect(r.text).not.toContain('agim_aaaa')
    expect(r.redactedKinds).toContain('agim_token')
  })

  it('redacts OpenAI / Anthropic style sk- keys', () => {
    const r = scrubOutboundText('the key: sk-proj-abcdef1234567890ABCDEF1234567890XYZ')
    expect(r.text).toContain('[REDACTED-openai_or_anthropic]')
    expect(r.redactedKinds).toContain('openai_or_anthropic')
  })

  it('redacts GitHub PATs', () => {
    const r = scrubOutboundText('ghp_1234567890ABCDEFabcdef1234567890ABCDef')
    expect(r.text).toContain('[REDACTED-github_token]')
  })

  it('redacts Slack tokens', () => {
    const r = scrubOutboundText('xoxb-12345-67890-abcdefghijklmnop')
    expect(r.text).toContain('[REDACTED-slack_token]')
  })

  it('redacts AWS access key ids', () => {
    const r = scrubOutboundText('AKIAIOSFODNN7EXAMPLE')
    expect(r.text).toContain('[REDACTED-aws_access_key_id]')
  })

  it('redacts Telegram bot tokens', () => {
    const r = scrubOutboundText('1234567:AAAA-BBBB_CCCCdddd1234567890abcdefghij')
    expect(r.text).toContain('[REDACTED-telegram_bot_token]')
  })

  it('redacts PEM private keys', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----'
    const r = scrubOutboundText(`attaching: ${pem}`)
    expect(r.text).toContain('[REDACTED-pem_private_key]')
    expect(r.text).not.toContain('MIIEpAIBAAKCAQEA')
  })

  it('redacts JWT', () => {
    // Realistic JWT — three base64url segments. Header + payload >= 10
    // chars after eyJ; signature >= 20 chars.
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
    const r = scrubOutboundText(`token=${jwt}`)
    expect(r.text).toContain('[REDACTED-jwt]')
  })

  it('idempotent — running twice produces same output', () => {
    const a = scrubOutboundText(`agim_${'b'.repeat(40)}`)
    const b = scrubOutboundText(a.text)
    expect(b.text).toBe(a.text)
    expect(b.redactedKinds).toEqual([])
  })

  it('returns empty redactedKinds for clean text', () => {
    const r = scrubOutboundText('hello world, nothing sensitive here')
    expect(r.text).toBe('hello world, nothing sensitive here')
    expect(r.redactedKinds).toEqual([])
  })

  it('handles empty / non-string input', () => {
    expect(scrubOutboundText('').text).toBe('')
    expect(scrubOutboundText(undefined as unknown as string).redactedKinds).toEqual([])
  })

  it('deduplicates kinds when multiple instances of same type appear', () => {
    const r = scrubOutboundText(`one agim_${'a'.repeat(40)} and agim_${'b'.repeat(40)}`)
    expect(r.redactedKinds).toEqual(['agim_token'])
  })

  it('sorts kinds for stable audit-event payloads', () => {
    const r = scrubOutboundText(`gh: ghp_${'a'.repeat(36)} agim: agim_${'b'.repeat(40)}`)
    expect(r.redactedKinds).toEqual(['agim_token', 'github_token'])
  })
})
