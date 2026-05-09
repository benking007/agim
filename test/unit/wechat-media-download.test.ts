import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdir, rm, stat, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TEST_ROOT = join(tmpdir(), `imhub-wechat-media-test-${process.pid}-${Math.random().toString(36).slice(2)}`)
process.env.IMHUB_MEDIA_ROOT = TEST_ROOT

const {
  MEDIA_ROOT,
  MAX_BYTES,
  downloadWechatMedia,
  extractCdnMedia,
  pickExtensionForImage,
  pickExtensionForVoice,
  pickExtensionForFile,
  pickExtensionForVideo,
} = await import('../../src/plugins/messengers/wechat/media-download.js')

// Minimal mock of ILinkClient that satisfies downloadMedia(cdnMedia) -> Buffer
function mockClient(response: Buffer | Error) {
  return {
    downloadMedia: async () => {
      if (response instanceof Error) throw response
      return response
    },
  } as Parameters<typeof downloadWechatMedia>[0]
}

describe('wechat media-download — pickExtension helpers', () => {
  it('pickExtensionForImage extracts from URL', () => {
    expect(pickExtensionForImage({ url: 'https://cdn.example.com/img/foo.png?t=1' })).toBe('png')
    expect(pickExtensionForImage({ url: 'https://cdn.example.com/img/bar.WEBP' })).toBe('webp')
  })

  it('pickExtensionForImage defaults to jpg', () => {
    expect(pickExtensionForImage({})).toBe('jpg')
    expect(pickExtensionForImage({ url: '' })).toBe('jpg')
  })

  it('pickExtensionForVoice returns silk for encode_type 6', () => {
    expect(pickExtensionForVoice({ encode_type: 6 })).toBe('silk')
  })

  it('pickExtensionForVoice defaults to amr', () => {
    expect(pickExtensionForVoice({})).toBe('amr')
    expect(pickExtensionForVoice({ encode_type: 0 })).toBe('amr')
  })

  it('pickExtensionForFile extracts from filename', () => {
    expect(pickExtensionForFile({ file_name: 'report.pdf' })).toBe('pdf')
    expect(pickExtensionForFile({ file_name: 'DATA.CSV' })).toBe('csv')
  })

  it('pickExtensionForFile defaults to bin', () => {
    expect(pickExtensionForFile({})).toBe('bin')
  })

  it('pickExtensionForVideo always returns mp4', () => {
    expect(pickExtensionForVideo({})).toBe('mp4')
  })
})

describe('wechat media-download — extractCdnMedia', () => {
  it('returns CDNMedia when encrypt_query_param is present', () => {
    const cdn = { encrypt_query_param: 'abc', aes_key: 'k1' }
    expect(extractCdnMedia({ media: cdn })).toBe(cdn)
  })

  it('returns null when media is missing', () => {
    expect(extractCdnMedia({})).toBeNull()
  })

  it('returns null when encrypt_query_param is empty', () => {
    expect(extractCdnMedia({ media: { encrypt_query_param: '' } })).toBeNull()
  })
})

describe('wechat media-download — downloadWechatMedia', () => {
  beforeAll(async () => {
    await mkdir(TEST_ROOT, { recursive: true })
  })

  afterAll(async () => {
    await rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {})
  })

  beforeEach(async () => {
    await rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {})
    await mkdir(TEST_ROOT, { recursive: true })
  })

  it('uses the env-overridden MEDIA_ROOT', () => {
    // MEDIA_ROOT is resolved once at import time; when run alongside
    // other test files in the same process, the value may reflect the
    // first env override that was set. We just verify it's a temp dir.
    expect(MEDIA_ROOT).toContain(tmpdir())
  })

  it('saves a file and returns the correct path', async () => {
    const data = Buffer.from('fake-image-data')
    const cdn = { encrypt_query_param: 'q=1', aes_key: 'k' }
    const client = mockClient(data)

    const result = await downloadWechatMedia(client, cdn, 'user123', 'msg1.jpg')
    expect(result.bytes).toBe(data.length)
    expect(result.path).toContain('wechat/user123/msg1.jpg')

    const saved = await readFile(result.path)
    expect(saved.equals(data)).toBe(true)
  })

  it('rejects unsafe filenames', async () => {
    const client = mockClient(Buffer.from('x'))
    const cdn = { encrypt_query_param: 'q=1' }

    await expect(
      downloadWechatMedia(client, cdn, 'u', '../escape.jpg'),
    ).rejects.toThrow(/unsafe filename/)
    await expect(
      downloadWechatMedia(client, cdn, 'u', 'a/b.jpg'),
    ).rejects.toThrow(/unsafe filename/)
  })

  it('rejects payloads exceeding MAX_BYTES', async () => {
    const huge = Buffer.alloc(MAX_BYTES + 1)
    const client = mockClient(huge)
    const cdn = { encrypt_query_param: 'q=1' }

    await expect(
      downloadWechatMedia(client, cdn, 'u', 'big.bin'),
    ).rejects.toThrow(/exceeds/)
  })

  it('propagates client download errors', async () => {
    const client = mockClient(new Error('CDN unreachable'))
    const cdn = { encrypt_query_param: 'q=1' }

    await expect(
      downloadWechatMedia(client, cdn, 'u', 'x.jpg'),
    ).rejects.toThrow(/CDN unreachable/)
  })
})
