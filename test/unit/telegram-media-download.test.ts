import { describe, it, expect } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { downloadToMediaRoot } from '../../src/plugins/messengers/telegram/media-download'

describe('telegram media download', () => {
  it('passes curl flags that reject redirects', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'imhub-curl-'))
    const binDir = join(dir, 'bin')
    const oldPath = process.env.PATH

    try {
      await mkdir(binDir)
      const fakeCurl = join(binDir, 'curl')
      await writeFile(fakeCurl, `#!/usr/bin/env node
const args = process.argv.slice(2)
const redirIdx = args.indexOf('--max-redirs')
if (redirIdx >= 0 && args[redirIdx + 1] === '0') {
  console.error('Maximum redirects followed')
  process.exit(47)
}
const outIdx = args.indexOf('--output')
if (outIdx >= 0) {
  require('fs').writeFileSync(args[outIdx + 1], 'downloaded')
}
`)
      await chmod(fakeCurl, 0o755)
      process.env.PATH = `${binDir}:${oldPath || ''}`

      await expect(downloadToMediaRoot({
        url: 'https://api.telegram.org/file/botTOKEN/photos/file.jpg',
        subdir: `test-${Date.now()}`,
        filename: 'file.jpg',
      })).rejects.toThrow(/Maximum redirects followed/)
    } finally {
      process.env.PATH = oldPath
      await rm(dir, { recursive: true, force: true })
    }
  })
})
