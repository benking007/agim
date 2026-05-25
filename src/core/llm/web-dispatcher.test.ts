import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import {
  getWebTools,
  isWebToolName,
  buildWebDispatcher,
  parseDdgHtml,
  parseMetasoResults,
  checkUrlSafety,
} from './web-dispatcher.js'

const NEVER_ABORT = new AbortController().signal

describe('web-dispatcher', () => {
  const ORIG_PRIVATE = process.env.IMHUB_NATIVE_WEB_ALLOW_PRIVATE

  beforeEach(() => { delete process.env.IMHUB_NATIVE_WEB_ALLOW_PRIVATE })
  afterEach(() => {
    if (ORIG_PRIVATE === undefined) delete process.env.IMHUB_NATIVE_WEB_ALLOW_PRIVATE
    else process.env.IMHUB_NATIVE_WEB_ALLOW_PRIVATE = ORIG_PRIVATE
  })

  describe('getWebTools / isWebToolName', () => {
    it('exposes the 2 expected tool names', () => {
      const names = getWebTools().map((t) => t.name).sort()
      expect(names).toEqual(['native_web_fetch', 'native_web_search'])
    })

    it('isWebToolName matches only the 2 web tools', () => {
      expect(isWebToolName('native_web_fetch')).toBe(true)
      expect(isWebToolName('native_web_search')).toBe(true)
      expect(isWebToolName('native_read_file')).toBe(false)
      expect(isWebToolName('native_echo')).toBe(false)
    })
  })

  describe('checkUrlSafety', () => {
    it('allows public https URLs', () => {
      expect(checkUrlSafety('https://example.com/').ok).toBe(true)
      expect(checkUrlSafety('https://duckduckgo.com/html/?q=test').ok).toBe(true)
    })

    it('refuses non-http(s) protocols', () => {
      expect(checkUrlSafety('ftp://example.com/').ok).toBe(false)
      expect(checkUrlSafety('file:///etc/hostname').ok).toBe(false)
      expect(checkUrlSafety('javascript:alert(1)').ok).toBe(false)
    })

    it('refuses invalid URLs', () => {
      expect(checkUrlSafety('not a url').ok).toBe(false)
      expect(checkUrlSafety('').ok).toBe(false)
    })

    it('refuses RFC1918 + loopback + link-local by default', () => {
      expect(checkUrlSafety('http://localhost/').ok).toBe(false)
      expect(checkUrlSafety('http://127.0.0.1/').ok).toBe(false)
      expect(checkUrlSafety('http://10.0.0.1/').ok).toBe(false)
      expect(checkUrlSafety('http://172.16.0.5/').ok).toBe(false)
      expect(checkUrlSafety('http://172.31.255.5/').ok).toBe(false)
      expect(checkUrlSafety('http://192.168.1.1/').ok).toBe(false)
      expect(checkUrlSafety('http://169.254.169.254/').ok).toBe(false)  // AWS metadata
    })

    it('allows 172.32+ (outside RFC1918) and other public ranges', () => {
      expect(checkUrlSafety('http://172.32.0.1/').ok).toBe(true)
      expect(checkUrlSafety('http://8.8.8.8/').ok).toBe(true)
    })

    it('IPv6 private/link-local blocked', () => {
      expect(checkUrlSafety('http://[fe80::1]/').ok).toBe(false)
      expect(checkUrlSafety('http://[fc00::1]/').ok).toBe(false)
      expect(checkUrlSafety('http://[fd00::1]/').ok).toBe(false)
    })

    it('IMHUB_NATIVE_WEB_ALLOW_PRIVATE=1 lifts the block', () => {
      process.env.IMHUB_NATIVE_WEB_ALLOW_PRIVATE = '1'
      expect(checkUrlSafety('http://localhost/').ok).toBe(true)
      expect(checkUrlSafety('http://192.168.1.1/').ok).toBe(true)
    })
  })

  describe('parseDdgHtml', () => {
    it('extracts title + url + snippet from typical DDG markup', () => {
      const html = `
        <div class="result results_links_deep">
          <div class="result__body">
            <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage1&rut=x">
              <b>Example</b> Page 1
            </a>
            <a class="result__snippet" href="...">
              The first <b>example</b> page snippet.
            </a>
          </div>
        </div>
        <div class="result results_links_deep">
          <div class="result__body">
            <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fp2">
              Example 2
            </a>
            <a class="result__snippet" href="...">Second snippet.</a>
          </div>
        </div>
      `
      const hits = parseDdgHtml(html, 10)
      expect(hits.length).toBe(2)
      expect(hits[0].title).toBe('Example Page 1')
      expect(hits[0].url).toBe('https://example.com/page1')
      expect(hits[0].snippet).toContain('first example page')
      expect(hits[1].url).toBe('https://example.org/p2')
    })

    it('respects max cap', () => {
      const block = `
        <div class="result results_links_deep">
          <div class="result__body">
            <a class="result__a" href="https://a.example/">a</a>
            <a class="result__snippet" href="...">x</a>
          </div>
        </div>`.repeat(5)
      const hits = parseDdgHtml(block, 3)
      expect(hits.length).toBe(3)
    })

    it('returns [] on empty / non-SERP html', () => {
      expect(parseDdgHtml('', 10)).toEqual([])
      expect(parseDdgHtml('<html><body>nothing</body></html>', 10)).toEqual([])
    })
  })

  describe('parseMetasoResults', () => {
    it('handles { results: [{title, url, snippet}, ...] }', () => {
      const hits = parseMetasoResults({
        results: [
          { title: 'A', url: 'https://a.example/', snippet: 'aaa' },
          { title: 'B', url: 'https://b.example/', summary: 'bbb' },
        ],
      }, 10)
      expect(hits.length).toBe(2)
      expect(hits[0].snippet).toBe('aaa')
      expect(hits[1].snippet).toBe('bbb')
    })

    it('handles { data: { list: [...] } }', () => {
      const hits = parseMetasoResults({
        data: { list: [{ name: 'X', link: 'https://x.example/', content: 'desc' }] },
      }, 10)
      expect(hits.length).toBe(1)
      expect(hits[0].title).toBe('X')
      expect(hits[0].url).toBe('https://x.example/')
      expect(hits[0].snippet).toBe('desc')
    })

    it('returns [] on bad shape', () => {
      expect(parseMetasoResults({}, 10)).toEqual([])
      expect(parseMetasoResults(null, 10)).toEqual([])
      expect(parseMetasoResults('string', 10)).toEqual([])
    })

    it('respects max cap', () => {
      const items = Array.from({ length: 10 }, (_, i) => ({ title: `t${i}`, url: `https://x${i}.example/` }))
      const hits = parseMetasoResults({ results: items }, 3)
      expect(hits.length).toBe(3)
    })
  })

  describe('buildWebDispatcher', () => {
    it('non-web tool name returns source="unknown" so combineDispatchers falls through', async () => {
      const d = buildWebDispatcher()
      const r = await d({ id: 't', name: 'native_echo', arguments: { text: 'x' } }, NEVER_ABORT)
      expect(r.source).toBe('unknown')
      expect(r.isError).toBe(true)
    })

    it('web_fetch refuses missing url', async () => {
      const d = buildWebDispatcher()
      const r = await d({ id: 't', name: 'native_web_fetch', arguments: {} }, NEVER_ABORT)
      expect(r.isError).toBe(true)
      expect(r.text).toMatch(/url required/)
    })

    it('web_fetch refuses private URL by default', async () => {
      const d = buildWebDispatcher()
      const r = await d(
        { id: 't', name: 'native_web_fetch', arguments: { url: 'http://192.168.1.1/' } },
        NEVER_ABORT,
      )
      expect(r.isError).toBe(true)
      expect(r.text).toMatch(/RFC1918|private/i)
    })

    it('web_search refuses empty query', async () => {
      const d = buildWebDispatcher()
      const r = await d({ id: 't', name: 'native_web_search', arguments: { query: '' } }, NEVER_ABORT)
      expect(r.isError).toBe(true)
      expect(r.text).toMatch(/query required/)
    })
  })
})
