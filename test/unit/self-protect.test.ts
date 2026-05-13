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
    it('blocks systemctl restart im-hub', () => {
      expect(checkToolUse('Bash', { command: 'systemctl restart im-hub' })).not.toBeNull()
      expect(checkToolUse('Bash', { command: 'systemctl restart im-hub-pro' })).not.toBeNull()
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
      expect(checkToolUse('Bash', { command: 'pkill -9 im-hub-pro' })).not.toBeNull()
      expect(checkToolUse('Bash', { command: 'killall im-hub' })).not.toBeNull()
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
      expect(checkToolUse('Bash', { command: 'kill -9 $(pgrep im-hub)' })).not.toBeNull()
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
      expect(checkToolUse('Bash', { command: 'im-hub-pro restart' })).not.toBeNull()
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
})
