import { describe, expect, it, afterAll } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'agim-sched-run-home-'))
const WS = mkdtempSync(join(tmpdir(), 'agim-sched-run-ws-'))
process.env.AGIM_HOME = HOME
process.env.AGIM_WORKSPACES = WS

const { wrapSchedulePrompt } = await import('./schedule-prompt.js')
const { prepareScheduledTurn } = await import('./schedule-run.js')
const { agentCwdForAccount, defaultAgentCwd } = await import('./agent-cwd.js')

afterAll(() => {
  try { rmSync(HOME, { recursive: true, force: true }) } catch { /* ignore */ }
  try { rmSync(WS, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('prepareScheduledTurn', () => {
  it('mkdirs artifacts under the account cwd and does not chdir there', () => {
    const prompt = wrapSchedulePrompt('写金价', {
      model: 'deepseek-v4-pro',
      artifacts: 'PROJECTS/gold-daily',
    })
    const prepared = prepareScheduledTurn({
      agent: 'agim',
      prompt,
      creatorId: 'usr_test1',
    })
    const cwd = agentCwdForAccount('agim', 'usr_test1')
    expect(prepared.workspacePath).toBe(cwd)
    expect(prepared.model).toBe('deepseek-v4-pro')
    expect(prepared.sendOpts.model).toBe('deepseek-v4-pro')
    expect(prepared.sendOpts.workspacePath).toBe(cwd)
    expect(prepared.artifactsRel).toBe('PROJECTS/gold-daily')
    expect(prepared.artifactsAbs).toBe(join(cwd, 'PROJECTS/gold-daily'))
    expect(existsSync(join(cwd, 'PROJECTS/gold-daily'))).toBe(true)
    expect(prepared.userPrompt).toContain('写金价')
    expect(prepared.userPrompt).toContain('PROJECTS/gold-daily')
  })

  it('ignores model for CLI agents', () => {
    const prompt = wrapSchedulePrompt('hi', { model: 'deepseek-v4-pro' })
    const prepared = prepareScheduledTurn({ agent: 'codex', prompt })
    expect(prepared.model).toBeUndefined()
    expect(prepared.sendOpts.model).toBeUndefined()
    expect(prepared.workspacePath).toBe(defaultAgentCwd('codex'))
  })

  it('does not mkdir parent-escape artifacts', () => {
    const prepared = prepareScheduledTurn({
      agent: 'agim',
      prompt: '<!-- agim:schedule {"artifacts":"../outside"} -->\nhi',
    })
    expect(prepared.artifactsAbs).toBeUndefined()
    expect(prepared.userPrompt).toBe('hi')
    expect(existsSync(join(WS, 'outside'))).toBe(false)
  })
})
