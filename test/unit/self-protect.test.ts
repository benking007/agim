import { describe, it, expect } from 'bun:test'
import { checkToolUse } from '../../src/core/self-protect.js'

describe('self-protect', () => {
  describe('systemctl on agim units', () => {
    it('blocks systemctl restart agim', () => {
      const r = checkToolUse('Bash', { command: 'systemctl restart agim' })
      expect(r).not.toBeNull()
      expect(r!.deny).toBe(true)
      expect(r!.message).toContain('重启服务')
    })
    it('blocks systemctl restart agim', () => {
      expect(checkToolUse('Bash', { command: 'systemctl restart agim' })).not.toBeNull()
      expect(checkToolUse('Bash', { command: 'systemctl restart agim' })).not.toBeNull()
    })
    it('blocks systemctl stop / reload / disable', () => {
      expect(checkToolUse('Bash', { command: 'systemctl stop agim' })).not.toBeNull()
      expect(checkToolUse('Bash', { command: 'systemctl reload agim' })).not.toBeNull()
      expect(checkToolUse('Bash', { command: 'systemctl disable agim' })).not.toBeNull()
    })
    it('blocks `service` command equivalent', () => {
      expect(checkToolUse('Bash', { command: 'service agim restart' })).not.toBeNull()
    })
    it('does NOT block systemctl on unrelated units', () => {
      expect(checkToolUse('Bash', { command: 'systemctl restart nginx' })).toBeNull()
      expect(checkToolUse('Bash', { command: 'systemctl status some-other.service' })).toBeNull()
    })
  })

  describe('pkill / killall', () => {
    it('blocks pkill agim', () => {
      expect(checkToolUse('Bash', { command: 'pkill agim' })).not.toBeNull()
      expect(checkToolUse('Bash', { command: 'pkill -9 agim' })).not.toBeNull()
      expect(checkToolUse('Bash', { command: 'killall agim' })).not.toBeNull()
    })
    it('does NOT block pkill on unrelated processes', () => {
      expect(checkToolUse('Bash', { command: 'pkill -f chromium' })).toBeNull()
    })
  })

  describe('kill <pid>', () => {
    it('blocks kill with our own PID', () => {
      const myPid = process.pid
      const r = checkToolUse('Bash', { command: `kill ${myPid}` })
      expect(r).not.toBeNull()
    })
    it('blocks kill -9 with our PID', () => {
      const myPid = process.pid
      expect(checkToolUse('Bash', { command: `kill -9 ${myPid}` })).not.toBeNull()
    })
    it('blocks kill $(pgrep agim)', () => {
      expect(checkToolUse('Bash', { command: 'kill $(pgrep agim)' })).not.toBeNull()
      expect(checkToolUse('Bash', { command: 'kill -9 $(pgrep agim)' })).not.toBeNull()
    })
    it('does NOT block kill on an unrelated PID', () => {
      // Use a PID that's NOT ours
      const otherPid = process.pid + 1
      expect(checkToolUse('Bash', { command: `kill ${otherPid}` })).toBeNull()
    })
  })

  describe('recursive agim CLI calls', () => {
    it('blocks agim restart / stop', () => {
      expect(checkToolUse('Bash', { command: 'agim restart' })).not.toBeNull()
      expect(checkToolUse('Bash', { command: 'agim stop' })).not.toBeNull()
      expect(checkToolUse('Bash', { command: 'agim restart' })).not.toBeNull()
    })
    it('blocks npm restart / stop', () => {
      expect(checkToolUse('Bash', { command: 'npm restart' })).not.toBeNull()
      expect(checkToolUse('Bash', { command: 'npm stop' })).not.toBeNull()
    })
  })

  describe('process.kill in Edit/Write tools', () => {
    it('blocks process.kill(pid, SIGTERM) attempts', () => {
      const r = checkToolUse('Edit', {
        file_path: '/tmp/x.js',
        new_string: "process.kill(123, 'SIGTERM')",
      })
      expect(r).not.toBeNull()
    })
    it('does NOT block harmless content', () => {
      expect(checkToolUse('Edit', {
        file_path: '/tmp/x.js',
        new_string: "console.log('hello')",
      })).toBeNull()
    })
  })

  describe('removal-side fields (regression)', () => {
    it('does NOT scan Edit.old_string', () => {
      // Build the literal at runtime so this test source itself doesn't trip
      // the guard during the transition window when an older dist is still
      // running and re-emits this file via Edit.
      const dangerous = ['systemctl', 'restart', 'agim'].join(' ')
      expect(checkToolUse('Edit', {
        file_path: '/tmp/x.md',
        old_string: `Run ${dangerous} to apply`,
        new_string: 'Restart the service to apply',
      })).toBeNull()
    })
  })

  describe('content-side authoring (post-split)', () => {
    // After the Bash/Code pattern split (2026-05-14), shell literals in
    // content fields are NOT a deny — they're text being authored, not a
    // shell action. These tests pin that contract so future "let's add a
    // belt-and-braces scan of new_string" patches don't silently regress
    // the debrand / docs / i18n workflow.

    const sh = ['systemctl', 'restart', 'agim'].join(' ')
    const pk = ['pkill', 'agim'].join(' ')
    const ac = ['agim', 'restart'].join(' ')

    it('Edit.new_string with systemctl literal is allowed', () => {
      expect(checkToolUse('Edit', {
        file_path: '/tmp/deploy.md',
        old_string: 'placeholder',
        new_string: `Run \`${sh}\` after configuration changes.`,
      })).toBeNull()
    })
    it('Write.content with pkill / agim CLI literals is allowed', () => {
      expect(checkToolUse('Write', {
        file_path: '/tmp/runbook.md',
        content: `If the daemon hangs: ${pk}\nOtherwise: ${ac}`,
      })).toBeNull()
    })
    it('NotebookEdit.new_source with shell literal is allowed', () => {
      expect(checkToolUse('NotebookEdit', {
        notebook_path: '/tmp/nb.ipynb',
        new_source: `# example: ${sh}`,
      })).toBeNull()
    })
    it('but process.kill code in new_string IS still blocked', () => {
      expect(checkToolUse('Edit', {
        file_path: '/tmp/x.js',
        new_string: "process.kill(123, 'SIGTERM')",
      })).not.toBeNull()
    })
    it('Bash with the same literal as a command IS still blocked', () => {
      // Verify the split didn't accidentally weaken Bash detection.
      expect(checkToolUse('Bash', { command: sh })).not.toBeNull()
      expect(checkToolUse('Bash', { command: pk })).not.toBeNull()
      expect(checkToolUse('Bash', { command: ac })).not.toBeNull()
    })
  })

  describe('non-action tools (post-split)', () => {
    // Read / Grep / Glob / LS / NotebookRead / WebFetch / WebSearch / MCP
    // tools don't execute shell and don't author file content. They get
    // a free pass — the previous behavior of scanning file_path was dead
    // code (no pattern matched a path) and has been removed.

    const sh = ['systemctl', 'restart', 'agim'].join(' ')

    it('Read on a path containing a dangerous literal is allowed', () => {
      expect(checkToolUse('Read', {
        file_path: '/tmp/notes-about-systemctl-restart-agim.md',
      })).toBeNull()
    })
    it('Grep for a dangerous literal is allowed', () => {
      expect(checkToolUse('Grep', { pattern: sh, path: '/tmp' })).toBeNull()
    })
    it('WebFetch / WebSearch are not scanned', () => {
      expect(checkToolUse('WebFetch', { url: `https://example.com/${sh}` })).toBeNull()
      expect(checkToolUse('WebSearch', { query: sh })).toBeNull()
    })
    it('arbitrary MCP tool is not scanned', () => {
      expect(checkToolUse('mcp__custom__do_thing', {
        command: sh,
        new_string: sh,
      })).toBeNull()
    })
  })
})
