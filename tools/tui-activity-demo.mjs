/**
 * Visual demo for TUI ActivityBlock — run with:
 *   node --import tsx  ... OR bun tools/tui-activity-demo.mjs
 * Prefer the .mjs that imports from dist/:
 *   node tools/tui-activity-demo.mjs
 */
import React, { useEffect, useState } from 'react'
import { Box, Text, render } from 'ink'
import { ActivityBlock } from '../dist/cli-ui/tui/activity-block.js'

function runningActivity(now) {
  return {
    runId: 'demo-run',
    status: 'running',
    startedAt: now - 7_000,
    steps: [
      {
        id: 's1',
        kind: 'tool',
        label: 'agim_read',
        status: 'success',
        startedAt: now - 6_500,
        finishedAt: now - 5_800,
        preview: '{"path":"package.json"}',
      },
      {
        id: 's2',
        kind: 'agent',
        label: 'claude-code',
        status: 'running',
        startedAt: now - 5_700,
        preview: 'Run the unit tests…',
      },
      {
        id: 's3',
        kind: 'approval',
        label: 'agim_exec',
        status: 'pending',
        startedAt: now - 5_500,
        preview: '{"command":"npm test","cwd":"/workspace"}',
      },
    ],
  }
}

function doneActivity(now) {
  return {
    runId: 'demo-run',
    status: 'success',
    startedAt: now - 7_000,
    finishedAt: now - 2_500,
    durationMs: 4_500,
    steps: [
      {
        id: 's1',
        kind: 'tool',
        label: 'agim_read',
        status: 'success',
        startedAt: now - 6_500,
        finishedAt: now - 5_800,
        preview: '{"path":"package.json"}',
      },
      {
        id: 's2',
        kind: 'agent',
        label: 'claude-code',
        status: 'success',
        startedAt: now - 5_700,
        finishedAt: now - 4_200,
        preview: '1.3s · 842 chars',
      },
      {
        id: 's3',
        kind: 'approval',
        label: 'agim_exec',
        status: 'success',
        startedAt: now - 5_500,
        finishedAt: now - 3_000,
        preview: '{"command":"npm test"}',
      },
    ],
  }
}

function DemoFrame({ mode }) {
  const now = Date.now()
  const activity = mode === 'running' ? runningActivity(now) : doneActivity(now)
  return React.createElement(
    Box,
    { flexDirection: 'column', paddingX: 1, width: 72 },
    React.createElement(
      Text,
      { bold: true, color: 'cyan' },
      mode === 'running' ? '【演示 A】执行中 · 等待子 Agent' : '【演示 B】已完成 · 含 A2A / 审批步骤',
    ),
    React.createElement(Text, { dimColor: true }, '─'.repeat(60)),
    React.createElement(
      Text,
      null,
      React.createElement(Text, { color: 'cyan', bold: true }, '你 '),
      'Run the unit tests and summarize failures.',
    ),
    React.createElement(
      Box,
      { flexDirection: 'column', marginTop: 1 },
      React.createElement(
        Text,
        null,
        React.createElement(Text, { color: 'magenta', bold: true }, 'agim '),
        mode === 'running'
          ? React.createElement(Text, { dimColor: true }, '· 生成中…（Esc 取消）')
          : null,
      ),
      React.createElement(ActivityBlock, { activity }),
      mode === 'done'
        ? React.createElement(Text, null, 'All unit tests passed. One flake was retried successfully.')
        : React.createElement(Text, { dimColor: true }, '…'),
      mode === 'done'
        ? React.createElement(Text, { dimColor: true }, '■ agim · 4.5s')
        : null,
    ),
    mode === 'running'
      ? React.createElement(
          Box,
          { marginTop: 1, borderStyle: 'single', borderColor: 'yellow', paddingX: 1, flexDirection: 'column' },
          React.createElement(
            Text,
            null,
            React.createElement(Text, { bold: true, color: 'yellow' }, '审批请求 '),
            'agim_exec',
          ),
          React.createElement(Text, { dimColor: true }, '{"command":"npm test"}'),
          React.createElement(
            Text,
            null,
            React.createElement(Text, { color: 'green', inverse: true, bold: true }, '› 批准 '),
            React.createElement(Text, { color: 'red' }, '  拒绝 '),
            React.createElement(Text, { dimColor: true }, ' · ↑↓ 选择 · Enter 确认'),
          ),
        )
      : null,
    React.createElement(
      Text,
      { dimColor: true },
      mode === 'running' ? '2.5 秒后切换到「已完成」态…' : '演示结束',
    ),
  )
}

function App() {
  const modeEnv = (process.env.TUI_DEMO_MODE || '').trim()
  const holdMs = Number(process.env.TUI_DEMO_HOLD_MS || 0)
  const [mode, setMode] = useState(modeEnv === 'done' ? 'done' : 'running')
  useEffect(() => {
    if (modeEnv === 'running' || modeEnv === 'done') {
      const quit = setTimeout(() => process.exit(0), holdMs > 0 ? holdMs : 60_000)
      return () => clearTimeout(quit)
    }
    const t = setTimeout(() => setMode('done'), 2500)
    const quit = setTimeout(() => process.exit(0), 5500)
    return () => {
      clearTimeout(t)
      clearTimeout(quit)
    }
  }, [modeEnv, holdMs])
  return React.createElement(DemoFrame, { mode })
}

render(React.createElement(App))
