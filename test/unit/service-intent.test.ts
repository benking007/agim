import { describe, it, expect } from 'bun:test'
import { detectServiceIntent } from '../../src/core/service-intent.js'

describe('detectServiceIntent', () => {
  describe('restart phrasings', () => {
    const expectRestart = (s: string) => {
      const r = detectServiceIntent(s)
      expect(r).not.toBeNull()
      expect(r!.intent).toBe('restart')
    }

    it('catches Chinese short forms', () => {
      expectRestart('重启')
      expectRestart('重启服务')
      expectRestart('重启 bot')
      expectRestart('重启agim')
      expectRestart('重启一下')
      expectRestart('重启系统')
      expectRestart('重新启动')
      expectRestart('重新启动服务')
    })

    it('catches Chinese with politeness particles', () => {
      expectRestart('请重启')
      expectRestart('请重启一下')
      expectRestart('麻烦重启服务')
      expectRestart('帮我重启')
      expectRestart('帮我把服务重启')
    })

    it('catches English short forms', () => {
      expectRestart('restart')
      expectRestart('restart!')
      expectRestart('restart bot')
      expectRestart('restart agim')
      expectRestart('restart the service')
      expectRestart('reboot the bot')
      expectRestart('please restart the service')
    })

    it('catches the /restart slash form', () => {
      expectRestart('/restart')
    })

    it('rejects long-form prompts that mention restart', () => {
      expect(
        detectServiceIntent(
          '请帮我写一个 systemd unit 文件，让 agim 在崩溃后自动 restart',
        ),
      ).toBeNull()
      expect(
        detectServiceIntent('Can you walk me through how to restart a Postgres replica?'),
      ).toBeNull()
    })

    it('rejects empty / whitespace input', () => {
      expect(detectServiceIntent('')).toBeNull()
      expect(detectServiceIntent('   ')).toBeNull()
    })
  })

  describe('stop phrasings', () => {
    const expectStop = (s: string) => {
      const r = detectServiceIntent(s)
      expect(r).not.toBeNull()
      expect(r!.intent).toBe('stop')
    }

    it('catches Chinese short forms', () => {
      expectStop('停止')
      expectStop('停止服务')
      expectStop('关闭服务')
      expectStop('停掉')
      expectStop('停掉 agim')
    })

    it('catches English short forms', () => {
      expectStop('stop')
      expectStop('stop the bot')
      expectStop('shutdown')
      expectStop('shutdown the service')
    })

    it('catches /stop slash form', () => {
      expectStop('/stop')
    })
  })

  describe('status phrasings', () => {
    const expectStatus = (s: string) => {
      const r = detectServiceIntent(s)
      expect(r).not.toBeNull()
      expect(r!.intent).toBe('status')
    }

    it('catches Chinese variants', () => {
      expectStatus('状态')
      expectStatus('健康')
      expectStatus('健康检查')
      expectStatus('服务状态')
      expectStatus('agim 还活着吗')
      expectStatus('服务怎么样')
    })

    it('catches English variants', () => {
      expectStatus('status')
      expectStatus('are you alive?')
      expectStatus('alive?')
    })
  })

  it('does not match plain agent-style prompts', () => {
    expect(detectServiceIntent('帮我写个函数')).toBeNull()
    expect(detectServiceIntent('解释一下 useState 的工作原理')).toBeNull()
    expect(detectServiceIntent('what is the meaning of life')).toBeNull()
    expect(detectServiceIntent('看下 a 股最近怎么样')).toBeNull() // contains '怎么样' but with topic context
  })
})
