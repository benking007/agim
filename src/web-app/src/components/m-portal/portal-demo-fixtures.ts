/**
 * Local visual QA / demo fixtures for the agent portal.
 *
 * Activated via URL query params on `/m/chat`:
 *   ?demo=width    — wide markdown table for column-width screenshots
 *   ?demo=pet      — running activity for the pet panel
 *   ?demo=todo     — Cursor-style plan checklist card
 *   ?demo=media    — image thumbnails + @file attachment
 *   ?demo=collapse — long user body for fold/mask behaviour
 *   ?demo=jump-latest — long transcript to exercise jump-to-latest
 *   ?demo=step-reflect — parent reflect card + live Agim Subagent carousel
 */

import type { ChatMessage } from '@/hooks/use-chat'

/** Local visual QA only (`/m/chat?demo=width`) — seeds a wide markdown
 *  table so AI reply column width can be screenshotted without a live agent. */
export function widthDemoMessages(): ChatMessage[] {
  const now = Date.now()
  return [
    {
      id: 'demo-width-user',
      role: 'user',
      content: '请帮我详细对比一下中证A50和中证A500这两个指数，我打算配置养老金，不知道选哪个更合适？',
      timestamp: now - 60_000,
    },
    {
      id: 'demo-width-assistant',
      role: 'assistant',
      agent: 'agim',
      timestamp: now - 1_000,
      activity: {
        runId: 'demo-width-run',
        status: 'success',
        startedAt: now - 59_000,
        finishedAt: now - 1_000,
        durationMs: 58_000,
        steps: [
          { id: 't1', kind: 'tool', label: 'web_search', status: 'success', startedAt: now - 58_000, finishedAt: now - 50_000 },
          { id: 't2', kind: 'tool', label: 'fetch', status: 'success', startedAt: now - 50_000, finishedAt: now - 40_000 },
          { id: 't3', kind: 'tool', label: 'analyze', status: 'success', startedAt: now - 40_000, finishedAt: now - 30_000 },
          { id: 't4', kind: 'tool', label: 'compare', status: 'success', startedAt: now - 30_000, finishedAt: now - 20_000 },
          { id: 't5', kind: 'tool', label: 'summarize', status: 'success', startedAt: now - 20_000, finishedAt: now - 10_000 },
          { id: 's1', kind: 'skill', label: 'market', status: 'success', startedAt: now - 45_000, finishedAt: now - 35_000 },
          { id: 's2', kind: 'skill', label: 'pension', status: 'success', startedAt: now - 35_000, finishedAt: now - 25_000 },
          { id: 's3', kind: 'skill', label: 'index', status: 'success', startedAt: now - 25_000, finishedAt: now - 15_000 },
        ],
      },
      content: [
        '## 中证 A50 vs 中证 A500（养老金配置向）',
        '',
        '| 维度 | 中证 A50 | 中证 A500 |',
        '| --- | --- | --- |',
        '| 样本空间 | 沪深市场超大盘龙头 | 剔除超大盘后的中大盘 |',
        '| 行业结构 | 金融/消费权重更高 | 制造/科技更均衡 |',
        '| 波动特征 | 相对更稳、弹性略低 | 弹性更大、回撤也更大 |',
        '| 适合谁 | 求稳、核心底仓 | 增强收益、卫星仓 |',
        '',
        '简要建议：养老金核心仓可偏 A50，卫星仓再用 A500 做增强；具体比例按风险承受能力调整。',
      ].join('\n'),
    },
  ]
}

/** Local visual QA (`/m/chat?demo=pet`) — running activity for the pet panel. */
export function petDemoMessages(): ChatMessage[] {
  const now = Date.now()
  return [
    {
      id: 'demo-pet-user',
      role: 'user',
      content: '帮我查一下今天大盘，并整理成三条要点。',
      timestamp: now - 20_000,
    },
    {
      id: 'demo-pet-assistant',
      role: 'assistant',
      agent: 'agim',
      timestamp: now - 5_000,
      activity: {
        runId: 'demo-pet-run',
        status: 'running',
        startedAt: now - 18_000,
        steps: [
          { id: 't1', kind: 'tool', label: 'web_search', status: 'success', startedAt: now - 17_000, finishedAt: now - 12_000 },
          { id: 't2', kind: 'tool', label: 'summarize', status: 'running', startedAt: now - 11_000 },
        ],
      },
      content: '正在整理要点…',
    },
  ]
}

/** Local visual QA (`/m/chat?demo=todo`) — Cursor-style plan checklist card. */
export function todoDemoMessages(): ChatMessage[] {
  const now = Date.now()
  return [
    {
      id: 'demo-todo-user',
      role: 'user',
      content: '帮我评估一下科技板块仓位，给出结论和操作建议。',
      timestamp: now - 40_000,
    },
    {
      id: 'demo-todo-assistant',
      role: 'assistant',
      agent: 'agim',
      timestamp: now - 5_000,
      activity: {
        runId: 'demo-todo-run',
        status: 'running',
        startedAt: now - 38_000,
        steps: [
          {
            id: 't-quote',
            kind: 'tool',
            label: 'agim_exec',
            status: 'running',
            startedAt: now - 20_000,
            preview: 'curl -s "http://localhost:8000/api/v1/tushare/hk/quote/daily"',
          },
          {
            id: 'agim-plan-checklist',
            kind: 'tool',
            label: 'agim_todo_write',
            status: 'success',
            startedAt: now - 37_000,
            finishedAt: now - 36_000,
            todoItems: [
              { content: '获取科技板块相关指数近期走势（科创50、恒生科技、纳斯达克、创业板50）', status: 'completed' },
              { content: '获取科技子板块行情（半导体、软件、通信、动漫游戏）', status: 'completed' },
              { content: '获取腾讯及港股科技龙头最新行情与估值', status: 'in_progress' },
              { content: '获取全球科技宏观事件与快讯', status: 'pending' },
              { content: '逐仓位评估持有逻辑是否成立，给出结论与操作建议', status: 'pending' },
              { content: '输出完整分析报告并落盘', status: 'pending' },
            ],
          },
        ],
      },
      content: '正在拉取腾讯及港股科技龙头行情…',
    },
  ]
}

/** Local visual QA (`/m/chat?demo=media`) — 8 image thumbs (5+3 wrap) + @file. */
export function mediaDemoMessages(imagePaths: string[], filePath: string, fileName: string): ChatMessage[] {
  const now = Date.now()
  const markers = [
    ...imagePaths.map((p) => `[图片附件：${p}]`),
    `[文件附件：${filePath} (${fileName}, 12 B)]`,
  ]
  return [
    {
      id: 'demo-media-user',
      role: 'user',
      content: [...markers, 'see the photo'].join('\n'),
      timestamp: now - 10_000,
    },
  ]
}

/** Local visual QA (`/m/chat?demo=collapse`) — long user body for fold/mask. */
export const COLLAPSE_DEMO_MESSAGES: ChatMessage[] = [
  {
    id: 'demo-collapse-user',
    role: 'user',
    content: [
      '1、老问题，这个输入款高度太高了',
      '2、/memo 应该自动填充 /memo here',
      '3、输入 / 或 @ 后，如果用的是键盘上下键选择，无法选择列表的选项。',
      '4、左侧的加号菜单，也加上 models、skills、remember',
      '5、消息体过长时需要默认折叠，点击后再展开',
      '6、选择文件夹/文件/skill 后，backspace 要能删掉 chip',
      '7、小精灵位置往上调，把脚挡住就行',
    ].join('\n'),
    timestamp: 0,
  },
]

export function collapseDemoMessages(): ChatMessage[] {
  return COLLAPSE_DEMO_MESSAGES
}

/** Local visual QA (`/m/chat?demo=jump-latest`) — enough turns to scroll. */
/** Local visual QA (`/m/chat?demo=step-reflect`) — parent reflect + Agim carousel. */
export function stepReflectDemoMessages(): ChatMessage[] {
  const now = Date.now()
  return [
    {
      id: 'demo-sr-user',
      role: 'user',
      content: '改一下 README 的安装步骤，并让子代理核对链接。',
      timestamp: now - 20_000,
    },
    {
      id: 'demo-sr-assistant',
      role: 'assistant',
      agent: 'agim',
      timestamp: now - 2_000,
      activity: {
        runId: 'demo-sr-run',
        status: 'running',
        startedAt: now - 18_000,
        steps: [
          {
            id: 't-write',
            kind: 'tool',
            label: 'agim_write_file',
            status: 'success',
            startedAt: now - 17_000,
            finishedAt: now - 14_000,
            preview: 'README.md',
          },
          {
            id: 'step-reflect-1',
            kind: 'reflect',
            label: 'Dispatch a checker for the new install URLs',
            status: 'success',
            startedAt: now - 13_500,
            finishedAt: now - 13_400,
            preview: 'Wrote install steps; links still unverified.',
          },
          {
            id: 'a2a-agim',
            kind: 'agent',
            label: 'agim/cheap',
            status: 'running',
            startedAt: now - 13_000,
            jobId: 42,
            preview: 'Verify README install URLs',
            reflects: [
              { stance: 'keep', next: 'Fetch the first install URL', at: now - 9_000 },
              { stance: 'adjust', next: 'Retry the 404 with the docs host', at: now - 5_000 },
              { stance: 'keep', next: 'Summarize which links still fail', at: now - 2_000 },
            ],
          },
          {
            id: 'a2a-cli',
            kind: 'agent',
            label: 'claude-code',
            status: 'running',
            startedAt: now - 12_000,
            jobId: 43,
            preview: 'CLI worker — no step-reflect slot',
          },
        ],
      },
      content: '正在核对安装链接…',
    },
  ]
}

export function jumpLatestDemoMessages(): ChatMessage[] {
  const now = Date.now()
  const out: ChatMessage[] = []
  for (let i = 1; i <= 18; i += 1) {
    out.push({
      id: `demo-jump-user-${i}`,
      role: 'user',
      content: `第 ${i} 条用户消息：请继续往下看。`,
      timestamp: now - (19 - i) * 8_000,
    })
    out.push({
      id: `demo-jump-assistant-${i}`,
      role: 'assistant',
      agent: 'agim',
      content: i === 18
        ? '这是最新一条回复，切会话或点「回到最新」应落到这里。'
        : `第 ${i} 条助手回复。`,
      timestamp: now - (19 - i) * 8_000 + 1_000,
    })
  }
  return out
}
