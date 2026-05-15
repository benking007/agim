// A2A Layer 2 — artifacts module unit tests.
//
// Pure-fs module (no SQLite), so unlike most agim DB tests these can
// actually run real I/O under bun. Each test gets its own temp AGIM_HOME.

import { describe, it, expect, beforeEach } from 'bun:test'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

// test/setup.ts (bunfig.toml preload) pins AGIM_HOME to a temp sandbox
// BEFORE the first module loads. Other test files later override
// process.env.AGIM_HOME for their own purposes, but agim-paths.ts /
// artifacts.ts already captured the original value as a `const` at load
// time — that's the path we have to point our assertions at. Import the
// authoritative const here to stay in sync no matter what other suites
// did to process.env.
const { AGIM_HOME: TEST_HOME } = await import('../../src/core/agim-paths.js')

const artifacts = await import('../../src/core/artifacts.js')

beforeEach(async () => {
  await artifacts._wipeAllForTests()
})

describe('getArtifactsDir', () => {
  it('produces deterministic absolute paths under AGIM_HOME/artifacts/<jobId>', () => {
    const dirs = artifacts.getArtifactsDir(42)
    expect(dirs.jobDir).toBe(join(TEST_HOME, 'artifacts', '42'))
    expect(dirs.inputDir).toBe(join(TEST_HOME, 'artifacts', '42', '_agim-input'))
    expect(dirs.outputDir).toBe(join(TEST_HOME, 'artifacts', '42', '_agim-output'))
  })
})

describe('ensureArtifactsDir', () => {
  it('creates input + output dirs idempotently', async () => {
    await artifacts.ensureArtifactsDir(1)
    expect(existsSync(join(TEST_HOME, 'artifacts', '1', '_agim-input'))).toBe(true)
    expect(existsSync(join(TEST_HOME, 'artifacts', '1', '_agim-output'))).toBe(true)
    // Calling again is a no-op
    await artifacts.ensureArtifactsDir(1)
  })
})

describe('copyInputs', () => {
  it('writes inline content to _agim-input/<name>', async () => {
    const out = await artifacts.copyInputs(7, [
      { name: 'note.txt', content: 'hello world' },
    ])
    expect(out).toEqual([{ name: 'note.txt', bytes: 11 }])
    expect(existsSync(join(TEST_HOME, 'artifacts', '7', '_agim-input', 'note.txt'))).toBe(true)
  })

  it('copies fromAbsolutePath (with hard-link fallback to copy)', async () => {
    const srcDir = join(TEST_HOME, 'extern')
    mkdirSync(srcDir, { recursive: true })
    const src = join(srcDir, 'data.csv')
    writeFileSync(src, 'a,b,c\n1,2,3\n')
    const out = await artifacts.copyInputs(8, [
      { name: 'data.csv', fromAbsolutePath: src },
    ])
    expect(out[0].bytes).toBeGreaterThan(0)
    expect(existsSync(join(TEST_HOME, 'artifacts', '8', '_agim-input', 'data.csv'))).toBe(true)
  })

  it('pulls fromCallerOutput out of caller _agim-output/', async () => {
    // First, place a file in caller (jobId=10) _agim-output/
    await artifacts.ensureArtifactsDir(10)
    const callerOut = join(TEST_HOME, 'artifacts', '10', '_agim-output', 'report.md')
    writeFileSync(callerOut, '# report')
    // Now caller=10 fires call_agent → callee=11 wants report.md as input
    const out = await artifacts.copyInputs(11, [
      { name: 'report.md', fromCallerOutput: 'report.md' },
    ], 10)
    expect(out[0].name).toBe('report.md')
    expect(existsSync(join(TEST_HOME, 'artifacts', '11', '_agim-input', 'report.md'))).toBe(true)
  })

  it('rejects fromCallerOutput without callerJobId', async () => {
    await expect(artifacts.copyInputs(12, [
      { name: 'x.txt', fromCallerOutput: 'x.txt' },
    ])).rejects.toThrow(/callerJobId/)
  })

  it('rejects names with slashes / ".."', async () => {
    await expect(artifacts.copyInputs(13, [
      { name: '../escape', content: 'x' },
    ])).rejects.toThrow(/invalid/)
    await expect(artifacts.copyInputs(14, [
      { name: 'a/b', content: 'x' },
    ])).rejects.toThrow(/invalid/)
  })

  it('enforces per-file size cap', async () => {
    process.env.IMHUB_A2A_ARTIFACT_MAX_BYTES_PER_FILE = '10'
    try {
      await expect(artifacts.copyInputs(15, [
        { name: 'big.txt', content: 'this is more than 10 bytes' },
      ])).rejects.toThrow(/per-file cap/)
    } finally {
      delete process.env.IMHUB_A2A_ARTIFACT_MAX_BYTES_PER_FILE
    }
  })

  it('enforces per-job byte cap across multiple inputs', async () => {
    process.env.IMHUB_A2A_ARTIFACT_MAX_BYTES_PER_JOB = '15'
    try {
      await expect(artifacts.copyInputs(16, [
        { name: 'a.txt', content: 'hello' },          // 5
        { name: 'b.txt', content: 'world' },          // 5 (total 10)
        { name: 'c.txt', content: 'abcdef' },         // 6 (total 16) → over 15
      ])).rejects.toThrow(/per-job byte cap/)
    } finally {
      delete process.env.IMHUB_A2A_ARTIFACT_MAX_BYTES_PER_JOB
    }
  })

  it('enforces per-job file count cap', async () => {
    process.env.IMHUB_A2A_ARTIFACT_MAX_FILES_PER_JOB = '2'
    try {
      await expect(artifacts.copyInputs(17, [
        { name: 'a.txt', content: '1' },
        { name: 'b.txt', content: '2' },
        { name: 'c.txt', content: '3' },
      ])).rejects.toThrow(/too many input files/)
    } finally {
      delete process.env.IMHUB_A2A_ARTIFACT_MAX_FILES_PER_JOB
    }
  })

  it('empty inputs list is a no-op', async () => {
    const out = await artifacts.copyInputs(99, [])
    expect(out).toEqual([])
  })
})

describe('listOutputs', () => {
  it('returns [] when output dir does not exist', async () => {
    const out = await artifacts.listOutputs(123)
    expect(out).toEqual([])
  })

  it('lists files with bytes + mtime', async () => {
    await artifacts.ensureArtifactsDir(20)
    writeFileSync(join(TEST_HOME, 'artifacts', '20', '_agim-output', 'a.md'), '# hi')
    writeFileSync(join(TEST_HOME, 'artifacts', '20', '_agim-output', 'b.json'), '{}')
    const out = await artifacts.listOutputs(20)
    expect(out.length).toBe(2)
    expect(out[0].name).toBe('a.md')
    expect(out[0].bytes).toBe(4)
    expect(out[1].name).toBe('b.json')
    expect(out[1].mtime).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

describe('readOutput', () => {
  it('returns file contents for valid name', async () => {
    await artifacts.ensureArtifactsDir(21)
    writeFileSync(join(TEST_HOME, 'artifacts', '21', '_agim-output', 'x.txt'), 'payload')
    const buf = await artifacts.readOutput(21, 'x.txt')
    expect(buf?.toString()).toBe('payload')
  })

  it('refuses path-traversal names', async () => {
    expect(await artifacts.readOutput(21, '../etc/passwd')).toBeNull()
    expect(await artifacts.readOutput(21, '..')).toBeNull()
  })

  it('returns null for missing file', async () => {
    expect(await artifacts.readOutput(21, 'nope')).toBeNull()
  })
})

describe('pruneArtifacts / pruneArtifactsBatch', () => {
  it('removes the entire job dir', async () => {
    await artifacts.ensureArtifactsDir(30)
    writeFileSync(join(TEST_HOME, 'artifacts', '30', '_agim-output', 'a'), 'x')
    expect(existsSync(join(TEST_HOME, 'artifacts', '30'))).toBe(true)
    await artifacts.pruneArtifacts(30)
    expect(existsSync(join(TEST_HOME, 'artifacts', '30'))).toBe(false)
  })

  it('pruneArtifactsBatch reports a count + handles missing dirs', async () => {
    await artifacts.ensureArtifactsDir(40)
    await artifacts.ensureArtifactsDir(41)
    const n = await artifacts.pruneArtifactsBatch([40, 41, 42 /* never existed */])
    expect(n).toBe(3)
    expect(existsSync(join(TEST_HOME, 'artifacts', '40'))).toBe(false)
    expect(existsSync(join(TEST_HOME, 'artifacts', '41'))).toBe(false)
  })

  it('pruneArtifactsBatch([]) is a no-op (returns 0)', async () => {
    expect(await artifacts.pruneArtifactsBatch([])).toBe(0)
  })
})

describe('statJob', () => {
  it('aggregates inputs + outputs sizes', async () => {
    await artifacts.copyInputs(50, [{ name: 'in.txt', content: 'AAAA' }])
    await artifacts.ensureArtifactsDir(50)
    writeFileSync(join(TEST_HOME, 'artifacts', '50', '_agim-output', 'out.txt'), 'BBBBBB')
    const s = await artifacts.statJob(50)
    expect(s.files).toBe(2)
    expect(s.bytes).toBe(10)  // 4 + 6
    expect(s.inputs.map((f) => f.name)).toEqual(['in.txt'])
    expect(s.outputs.map((f) => f.name)).toEqual(['out.txt'])
  })
})

describe('buildEnvelope', () => {
  it('mentions output dir, lists inputs with sizes, lists expected outputs', () => {
    const envelope = artifacts.buildEnvelope({
      jobId: 60,
      inputs: [
        { name: 'data.csv', bytes: 1024 },
        { name: 'readme.md', bytes: 256 },
      ],
      expectOutputs: ['summary.md'],
    })
    expect(envelope).toContain('[A2A workspace]')
    expect(envelope).toContain(join(TEST_HOME, 'artifacts', '60', '_agim-output'))
    expect(envelope).toContain('data.csv')
    expect(envelope).toContain('readme.md')
    expect(envelope).toContain('summary.md')
    expect(envelope).toContain('1.0 KB')
  })

  it('omits the inputs section when there are none', () => {
    const envelope = artifacts.buildEnvelope({ jobId: 61, inputs: [] })
    expect(envelope).toContain('[A2A workspace]')
    expect(envelope).not.toContain('Input files placed')
  })

  it('omits expected outputs section when not provided', () => {
    const envelope = artifacts.buildEnvelope({
      jobId: 62,
      inputs: [{ name: 'a', bytes: 1 }],
    })
    expect(envelope).not.toContain('Expected outputs')
  })

  it('formats bytes correctly across sizes', () => {
    const { formatBytes } = artifacts._internal
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(900)).toBe('900 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB')
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.00 GB')
  })
})
