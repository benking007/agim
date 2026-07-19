import { afterEach, describe, expect, it } from 'vitest'
import { stripLegacyUnrestrictedCjkFaces } from './ensure-cjk-fonts'

describe('stripLegacyUnrestrictedCjkFaces', () => {
  afterEach(() => {
    for (const el of Array.from(document.querySelectorAll('style[data-test-cjk]'))) {
      el.remove()
    }
  })

  it('removes Agim CJK @font-face styles without unicode-range', () => {
    const bad = document.createElement('style')
    bad.dataset.testCjk = '1'
    bad.textContent = '@font-face{font-family:"Agim CJK";src:url("/fonts/x.woff2")}'
    document.head.appendChild(bad)

    const good = document.createElement('style')
    good.dataset.testCjk = '1'
    good.textContent = '@font-face{font-family:"Agim CJK";unicode-range:U+4E00-9FFF;src:url("/fonts/x.woff2")}'
    document.head.appendChild(good)

    expect(stripLegacyUnrestrictedCjkFaces()).toBe(1)
    expect(document.contains(bad)).toBe(false)
    expect(document.contains(good)).toBe(true)
  })
})
