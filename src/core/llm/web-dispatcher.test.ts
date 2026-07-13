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
  const ORIG_PRIVATE = process.env.AGIM_NATIVE_WEB_ALLOW_PRIVATE

  beforeEach(() => { delete process.env.AGIM_NATIVE_WEB_ALLOW_PRIVATE })
  afterEach(() => {
    if (ORIG_PRIVATE === undefined) delete process.env.AGIM_NATIVE_WEB_ALLOW_PRIVATE
    else process.env.AGIM_NATIVE_WEB_ALLOW_PRIVATE = ORIG_PRIVATE
  })

  describe('getWebTools / isWebToolName', () => {
    it('exposes the 2 expected tool names', () => {
      const names = getWebTools().map((t) => t.name).sort()
      expect(names).toEqual(['agim_web_fetch', 'agim_web_search'])
    })

    it('isWebToolName matches only the 2 web tools', () => {
      expect(isWebToolName('agim_web_fetch')).toBe(true)
      expect(isWebToolName('agim_web_search')).toBe(true)
      expect(isWebToolName('agim_read_file')).toBe(false)
      expect(isWebToolName('agim_echo')).toBe(false)
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

    // v1.2.70 — CR-4: IPv6 ULA in compressed forms that the regex
    // missed. The new bit-mask check honours fc00::/7 regardless of
    // canonicalisation. (Note: `fc::1` expands to `00fc:..:1`, which
    // has high 7 bits `0000000` — NOT a ULA. Real ULAs start with
    // fc** or fd**.)
    it('IPv6 ULA in compressed form blocked (CR-4)', () => {
      expect(checkUrlSafety('http://[fc00::]/').ok).toBe(false)
      expect(checkUrlSafety('http://[fdff::dead]/').ok).toBe(false)
      expect(checkUrlSafety('http://[fcab:1234::5]/').ok).toBe(false)
      expect(checkUrlSafety('http://[fd12:3456:789a::1]/').ok).toBe(false)
    })

    it('IPv6 loopback :: and ::1 blocked', () => {
      expect(checkUrlSafety('http://[::1]/').ok).toBe(false)
      expect(checkUrlSafety('http://[::]/').ok).toBe(false)
    })

    it('IPv6 mapped-v4 form catches RFC1918 (e.g. ::ffff:10.0.0.1)', () => {
      expect(checkUrlSafety('http://[::ffff:127.0.0.1]/').ok).toBe(false)
      expect(checkUrlSafety('http://[::ffff:192.168.1.1]/').ok).toBe(false)
    })

    it('IPv6 public addresses still pass', () => {
      expect(checkUrlSafety('http://[2606:4700:4700::1111]/').ok).toBe(true)
      expect(checkUrlSafety('http://[2001:db8::1]/').ok).toBe(true)
      // fc::1 is NOT ULA — first group 0x00fc, high 7 bits are all
      // zeros, so it's actually a valid global address.
      expect(checkUrlSafety('http://[fc::1]/').ok).toBe(true)
    })

    // v1.2.70 — CR-3: decimal-int / hex / octal / short-form IPv4 forms.
    // Node's URL parser already canonicalises these to dotted-quad
    // BEFORE we see hostname, so the safety check sees "127.0.0.1"
    // directly. This means the regex never had the bypass we feared —
    // but defense in depth (tryParseIPv4Variants) covers cases where
    // hostnames arrive from a parser that DOESN'T canonicalise.
    it('decimal-integer IPv4 forms blocked (CR-3, canonicalised by URL)', () => {
      expect(checkUrlSafety('http://2130706433/').ok).toBe(false)  // 127.0.0.1
      expect(checkUrlSafety('http://3232235521/').ok).toBe(false)  // 192.168.0.1
      expect(checkUrlSafety('http://167772161/').ok).toBe(false)   // 10.0.0.1
    })

    it('hex-integer IPv4 forms blocked (CR-3)', () => {
      expect(checkUrlSafety('http://0x7f000001/').ok).toBe(false)   // 127.0.0.1
      expect(checkUrlSafety('http://0xc0a80101/').ok).toBe(false)   // 192.168.1.1
      expect(checkUrlSafety('http://0xa9fea9fe/').ok).toBe(false)   // 169.254.169.254 (IMDS)
    })

    it('octal-prefixed IPv4 octets blocked (CR-3)', () => {
      // 0177.0.0.1 → 127.0.0.1 (URL canonicalises)
      expect(checkUrlSafety('http://0177.0.0.1/').ok).toBe(false)
      // 010.0.0.1 → 8.0.0.1 (octal 10 = decimal 8) → public, allowed
      expect(checkUrlSafety('http://010.0.0.1/').ok).toBe(true)
    })

    it('short-form IPv4 (RFC3986 §3.2.2) blocked (CR-3)', () => {
      expect(checkUrlSafety('http://127.1/').ok).toBe(false)            // 127.0.0.1
      expect(checkUrlSafety('http://192.168.1/').ok).toBe(false)        // 192.168.0.1
      expect(checkUrlSafety('http://10.1/').ok).toBe(false)             // 10.0.0.1
    })

    it('overflow IPv4 octets fail URL parse → blocked (CR-3)', () => {
      // 999.999.999.999 / 256.0.0.1 — Node's URL parser rejects them
      // outright. We propagate as "invalid URL" → ok:false. No way for
      // a malformed-but-meaningful-looking hostname to slip past.
      expect(checkUrlSafety('http://999.999.999.999/').ok).toBe(false)
      expect(checkUrlSafety('http://256.0.0.1/').ok).toBe(false)
    })

    // Unit test the raw IPv4 parser too, since it has paths URL doesn't
    // exercise (it's exported for defense-in-depth in other consumers).
    it('tryParseIPv4Variants handles all forms', async () => {
      const { tryParseIPv4Variants } = await import('./web-dispatcher.js')
      expect(tryParseIPv4Variants('127.0.0.1')).toEqual([127, 0, 0, 1])
      expect(tryParseIPv4Variants('2130706433')).toEqual([127, 0, 0, 1])
      expect(tryParseIPv4Variants('0x7f000001')).toEqual([127, 0, 0, 1])
      expect(tryParseIPv4Variants('0177.0.0.1')).toEqual([127, 0, 0, 1])
      expect(tryParseIPv4Variants('127.1')).toEqual([127, 0, 0, 1])
      expect(tryParseIPv4Variants('192.168.1')).toEqual([192, 168, 0, 1])
      // Overflow / out-of-range → null
      expect(tryParseIPv4Variants('999.999.999.999')).toBeNull()
      expect(tryParseIPv4Variants('256.0.0.1')).toBeNull()
      expect(tryParseIPv4Variants('not-an-ip')).toBeNull()
    })

    it('AGIM_NATIVE_WEB_ALLOW_PRIVATE=1 lifts the block', () => {
      process.env.AGIM_NATIVE_WEB_ALLOW_PRIVATE = '1'
      expect(checkUrlSafety('http://localhost/').ok).toBe(true)
      expect(checkUrlSafety('http://192.168.1.1/').ok).toBe(true)
    })

    // v1.2.66 — CGN (RFC 6598) blocked by default.
    it('blocks 100.64.0.0/10 carrier-grade NAT by default', () => {
      expect(checkUrlSafety('http://100.64.0.1/').ok).toBe(false)
      expect(checkUrlSafety('http://100.127.255.254/').ok).toBe(false)
      // 100.63.x and 100.128.x are OUTSIDE the /10, should pass
      expect(checkUrlSafety('http://100.63.0.1/').ok).toBe(true)
      expect(checkUrlSafety('http://100.128.0.1/').ok).toBe(true)
    })

    it('CIDR whitelist (AGIM_NATIVE_WEB_SSRF_WHITELIST) allows otherwise-blocked ranges', () => {
      const ORIG = process.env.AGIM_NATIVE_WEB_SSRF_WHITELIST
      try {
        process.env.AGIM_NATIVE_WEB_SSRF_WHITELIST = '100.64.0.0/10,10.20.0.0/16'
        expect(checkUrlSafety('http://100.64.0.1/').ok).toBe(true)   // CGN whitelisted
        expect(checkUrlSafety('http://10.20.5.5/').ok).toBe(true)     // RFC1918 + whitelist
        expect(checkUrlSafety('http://10.21.0.0/').ok).toBe(false)    // outside whitelist
        expect(checkUrlSafety('http://192.168.1.1/').ok).toBe(false)  // different RFC1918
      } finally {
        if (ORIG === undefined) delete process.env.AGIM_NATIVE_WEB_SSRF_WHITELIST
        else process.env.AGIM_NATIVE_WEB_SSRF_WHITELIST = ORIG
      }
    })
  })

  describe('checkUrlSafetyAsync — DNS-aware SSRF (F3)', () => {
    it('rejects a hostname that resolves to the IMDS link-local address', async () => {
      const { checkUrlSafetyAsync } = await import('./web-dispatcher.js')
      const rebind = async () => [{ address: '169.254.169.254', family: 4 }]
      const r = await checkUrlSafetyAsync('http://evil.example.com/', rebind)
      expect(r.ok).toBe(false)
      expect(r.reason).toContain('169.254.169.254')
    })

    it('rejects a hostname that resolves to RFC1918 / loopback', async () => {
      const { checkUrlSafetyAsync } = await import('./web-dispatcher.js')
      expect((await checkUrlSafetyAsync('http://a.test/', async () => [{ address: '10.0.0.5', family: 4 }])).ok).toBe(false)
      expect((await checkUrlSafetyAsync('http://b.test/', async () => [{ address: '127.0.0.1', family: 4 }])).ok).toBe(false)
      expect((await checkUrlSafetyAsync('http://c.test/', async () => [{ address: '::1', family: 6 }])).ok).toBe(false)
    })

    it('rejects when ANY resolved address is private (dual-record rebind)', async () => {
      const { checkUrlSafetyAsync } = await import('./web-dispatcher.js')
      const mixed = async () => [{ address: '8.8.8.8', family: 4 }, { address: '169.254.169.254', family: 4 }]
      expect((await checkUrlSafetyAsync('http://mixed.test/', mixed)).ok).toBe(false)
    })

    it('allows a hostname that resolves only to public addresses', async () => {
      const { checkUrlSafetyAsync } = await import('./web-dispatcher.js')
      const pub = async () => [{ address: '93.184.216.34', family: 4 }]
      expect((await checkUrlSafetyAsync('https://example.com/', pub)).ok).toBe(true)
    })

    it('rejects when DNS resolution fails (fail-closed)', async () => {
      const { checkUrlSafetyAsync } = await import('./web-dispatcher.js')
      const fail = async () => { throw new Error('ENOTFOUND') }
      expect((await checkUrlSafetyAsync('http://nope.test/', fail)).ok).toBe(false)
    })

    it('does not resolve IP literals (sync decision stands)', async () => {
      const { checkUrlSafetyAsync } = await import('./web-dispatcher.js')
      let called = false
      const spy = async () => { called = true; return [{ address: '8.8.8.8', family: 4 }] }
      expect((await checkUrlSafetyAsync('http://10.0.0.1/', spy)).ok).toBe(false)
      expect((await checkUrlSafetyAsync('http://8.8.8.8/', spy)).ok).toBe(true)
      expect(called).toBe(false)
    })

    it('honours AGIM_NATIVE_WEB_ALLOW_PRIVATE=1 (no resolution)', async () => {
      const { checkUrlSafetyAsync } = await import('./web-dispatcher.js')
      process.env.AGIM_NATIVE_WEB_ALLOW_PRIVATE = '1'
      try {
        let called = false
        const spy = async () => { called = true; return [{ address: '169.254.169.254', family: 4 }] }
        expect((await checkUrlSafetyAsync('http://evil.example.com/', spy)).ok).toBe(true)
        expect(called).toBe(false)
      } finally {
        delete process.env.AGIM_NATIVE_WEB_ALLOW_PRIVATE
      }
    })
  })

  describe('parseSsrfWhitelist (v1.2.66)', () => {
    it('parses comma-separated CIDR list', async () => {
      const { parseSsrfWhitelist } = await import('./web-dispatcher.js')
      const r = parseSsrfWhitelist('10.0.0.0/8, 192.168.0.0/16,100.64.0.0/10')
      expect(r.length).toBe(3)
    })

    it('drops invalid entries silently', async () => {
      const { parseSsrfWhitelist } = await import('./web-dispatcher.js')
      const r = parseSsrfWhitelist('not-a-cidr,10.0.0.0/33,10.0.0.0/8')
      expect(r.length).toBe(1)
    })

    it('empty / undefined returns []', async () => {
      const { parseSsrfWhitelist } = await import('./web-dispatcher.js')
      expect(parseSsrfWhitelist(undefined).length).toBe(0)
      expect(parseSsrfWhitelist('').length).toBe(0)
      expect(parseSsrfWhitelist('   ').length).toBe(0)
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
      const r = await d({ id: 't', name: 'agim_echo', arguments: { text: 'x' } }, NEVER_ABORT)
      expect(r.source).toBe('unknown')
      expect(r.isError).toBe(true)
    })

    it('web_fetch refuses missing url', async () => {
      const d = buildWebDispatcher()
      const r = await d({ id: 't', name: 'agim_web_fetch', arguments: {} }, NEVER_ABORT)
      expect(r.isError).toBe(true)
      expect(r.text).toMatch(/url required/)
    })

    it('web_fetch refuses private URL by default', async () => {
      const d = buildWebDispatcher()
      const r = await d(
        { id: 't', name: 'agim_web_fetch', arguments: { url: 'http://192.168.1.1/' } },
        NEVER_ABORT,
      )
      expect(r.isError).toBe(true)
      expect(r.text).toMatch(/RFC1918|private/i)
    })

    it('web_search refuses empty query', async () => {
      const d = buildWebDispatcher()
      const r = await d({ id: 't', name: 'agim_web_search', arguments: { query: '' } }, NEVER_ABORT)
      expect(r.isError).toBe(true)
      expect(r.text).toMatch(/query required/)
    })
  })
})
