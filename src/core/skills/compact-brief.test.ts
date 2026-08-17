import { describe, expect, it } from 'bun:test'
import { compactSkillBrief, oneLineDescription, SHORT_ROW_DESCRIPTION_CHARS } from './compact-brief.js'
import { shippedSkillBrief } from './skill-briefs.js'

describe('compactSkillBrief', () => {
  it('uses explicit brief when provided', () => {
    expect(compactSkillBrief('很长的描述。还有第二句。', '长期事实记忆(5W1H)')).toBe('长期事实记忆(5W1H)')
  })

  it('compresses Chinese fin-data descriptions toward inject style', () => {
    expect(compactSkillBrief(
      '查询 A 股个股巨潮公告列表（标题 / 类型 / 日期 / 详情 URL）。',
    )).toBe('A股个股巨潮公告')

    expect(compactSkillBrief(
      '综述类查询的**统一入口**——"看看 X" / "X 怎么样" / "X 基本面"',
    )).toBe('综述类查询的统一入口("看看X")')

    expect(compactSkillBrief(
      '查询港股行情：日线（不复权）、复权日线、复权因子、分钟线。',
    )).toBe('港股行情')

    expect(compactSkillBrief(
      '策略层信号查询的**统一入口**——"X 有什么信号" / "今天有什么机会"',
    )).toBe('策略层信号查询的统一入口("X有什么信号")')
  })

  it('strips [ECC] and keeps a short English clause', () => {
    const out = compactSkillBrief('[ECC] Head-to-head comparison of coding agents on custom tasks.')
    expect(out.startsWith('[ECC]')).toBe(false)
    expect(out.length).toBeLessThanOrEqual(SHORT_ROW_DESCRIPTION_CHARS + 1)
  })

  it('caps oversize briefs', () => {
    const out = compactSkillBrief('x'.repeat(80))
    expect(out.endsWith('…')).toBe(true)
    expect(out.length).toBe(SHORT_ROW_DESCRIPTION_CHARS + 1)
  })
})

describe('oneLineDescription (legacy first sentence)', () => {
  it('handles Chinese terminators and hard caps', () => {
    expect(oneLineDescription('查询用户长期事实。使用 5W1H 记录。')).toBe('查询用户长期事实。')
    expect(oneLineDescription('Persist facts. Use 5W1H.')).toBe('Persist facts.')
    expect(oneLineDescription('')).toBe('')
  })
})

describe('shippedSkillBrief', () => {
  it('covers framework + coding-verify + one ECC pick', () => {
    expect(shippedSkillBrief('agim-memory')).toBe('长期事实记忆(5W1H)')
    expect(shippedSkillBrief('coding-verify')).toBe('编码循环(编辑→诊断→测试→门禁)')
    expect(shippedSkillBrief('tdd-workflow')).toBe('TDD工作流(新功能/修复/重构)')
    expect(shippedSkillBrief('fin-data-dossier')).toBe('综合查询入口("看看X")')
  })
})
