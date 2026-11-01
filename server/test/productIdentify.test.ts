// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { AiBinding } from '../ai/categorySuggest'
import { NOT_FOUND_RETRY_MS } from '../products/identify'
import { braveSearch, cleanProductTitle, pickCandidate, searchQueries, titlesAgree, type FetchFn, type SearchResult, type WebSearch } from '../products/search'
import { createHarness } from './harness'

const r = (title: string, url: string, snippet = ''): SearchResult => ({ title, url, snippet, imageUrl: null })

/** A fake search provider: answers from a table keyed by item number, recording every query. */
function fakeSearch(table: Record<string, SearchResult[]>, opts: { fail?: boolean } = {}) {
  const queries: string[] = []
  const search: WebSearch = {
    name: 'fake',
    search: vi.fn(async (q: string) => {
      queries.push(q)
      if (opts.fail) throw new Error('search_http_500')
      const n = Object.keys(table).find((k) => q.includes(k))
      return n ? table[n]! : []
    }),
  }
  return { search, queries }
}

const TABLE = {
  '1627770': [
    r('Some blog about blue things', 'https://example.com/blue', 'classic blue paint'),
    r('Brondell Swash Thinline CL2200 Bidet Toilet Seat | Costco', 'https://www.costco.com/brondell-swash.product.4000123.html', 'Item 1627770 · Bidet seat'),
  ],
  '1712345': [r('Anker SOLIX C1000 Portable Power Station - Item 1712345', 'https://deals.example.org/anker-1712345', '')],
}

describe('targeted search helpers', () => {
  it('builds queries only from the item number and receipt description', () => {
    expect(searchQueries('1627770', 'CLASSIC BLUE')).toEqual(['Costco 1627770 CLASSIC BLUE', 'Costco "1627770"'])
    expect(searchQueries('1627770', 'KS "12*PK"')).toEqual(['Costco 1627770 KS 12 PK', 'Costco "1627770"'])
  })

  it('accepts only results that mention the exact item number, preferring costco.com', () => {
    expect(pickCandidate('1627770', TABLE['1627770'])).toMatchObject({
      confidence: 0.9,
      evidence: 'costco.com',
      result: { url: expect.stringContaining('costco.com') },
    })
    // One non-Costco page is only provisional evidence.
    expect(pickCandidate('1712345', TABLE['1712345'])).toMatchObject({ confidence: 0.4, evidence: 'single-source', sources: 1 })
    // Not the same item: a longer number, a similar product without the number.
    expect(pickCandidate('1627770', [r('Item 16277701', 'https://www.costco.com/x.html'), r('Classic Blue Bidet', 'https://www.costco.com/y.html')])).toBeNull()
    expect(pickCandidate('1627770', [])).toBeNull()
  })

  it('needs two independent, agreeing sites to call a non-Costco identity usable', () => {
    const a = r('Brondell Swash Thinline Bidet Seat 1627770', 'https://a.example/x')
    const agree = r('Swash Thinline CL2200 bidet by Brondell (Costco #1627770)', 'https://b.example/y')
    expect(pickCandidate('1627770', [a, agree])).toMatchObject({
      evidence: 'corroborated',
      confidence: 0.8,
      sources: 2,
      corroboratingUrl: 'https://b.example/y',
    })
    // Two pages of the same site are one source.
    expect(pickCandidate('1627770', [a, r('Brondell Swash Thinline 1627770 review', 'https://www.a.example/z')])).toMatchObject({ evidence: 'single-source', sources: 1 })
    // Two sites that mention the number but disagree about the product are not corroboration.
    expect(pickCandidate('1627770', [a, r('Garden hose reel 1627770', 'https://c.example/q')])).toMatchObject({ evidence: 'single-source', sources: 2, confidence: 0.4 })
    expect(titlesAgree('Costco Item 1627770 deal', 'Costco item 1627770 sale')).toBe(false) // boilerplate words do not count
  })

  it('cleans retailer suffixes from titles', () => {
    expect(cleanProductTitle('Kirkland Signature Organic Quinoa, 4.5 lbs | Costco')).toBe('Kirkland Signature Organic Quinoa, 4.5 lbs')
    expect(cleanProductTitle('Anker SOLIX C1000 - Costco Wholesale')).toBe('Anker SOLIX C1000')
    expect(cleanProductTitle('Blueair Blue Pure 211i')).toBe('Blueair Blue Pure 211i')
  })

  it('the Brave adapter sends only the query and parses https results safely', async () => {
    const fetchImpl = vi.fn<FetchFn>(async () => {
      return new Response(
        JSON.stringify({
          web: {
            results: [
              { title: '<strong>Brondell</strong> &amp; Co', url: 'https://www.costco.com/x.html', description: 'Item 1627770', thumbnail: { src: 'https://img.example/x.jpg' } },
              { title: 'insecure', url: 'http://bad.example', description: '' },
              'junk',
            ],
          },
        }),
      )
    })
    const brave = braveSearch('KEY', fetchImpl)
    const results = await brave.search('Costco 1627770 CLASSIC BLUE')
    expect(results).toEqual([{ title: 'Brondell & Co', url: 'https://www.costco.com/x.html', snippet: 'Item 1627770', imageUrl: 'https://img.example/x.jpg' }])
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(new URL(url).hostname).toBe('api.search.brave.com')
    expect(new URL(url).searchParams.get('q')).toBe('Costco 1627770 CLASSIC BLUE')
    expect((init!.headers as Record<string, string>)['x-subscription-token']).toBe('KEY')
    expect(init!.body).toBeUndefined()
  })
})

describe('POST /api/products/identify', () => {
  const items = [
    { itemNumber: '1627770', descriptions: ['CLASSIC BLUE'] },
    { itemNumber: '1712345', descriptions: ['ANKERSOLIX'] },
    { itemNumber: '1999999', descriptions: ['TORO BULLY'] },
  ]

  it('searches unknown items once, caches the result, and serves the cache afterwards', async () => {
    const { search, queries } = fakeSearch(TABLE)
    const h = createHarness({ search })
    const cookie = await h.login()
    const first = await h.call('POST', '/api/products/identify', { cookie, body: { items } })
    expect(first.status).toBe(200)
    expect(first.body.searchConfigured).toBe(true)
    expect(first.body.results).toEqual([
      expect.objectContaining({
        itemNumber: '1627770',
        status: 'identified',
        normalizedName: 'Brondell Swash Thinline CL2200 Bidet Toilet Seat',
        sourceUrl: 'https://www.costco.com/brondell-swash.product.4000123.html',
        confidence: 0.9,
        evidence: 'costco.com',
        method: 'web-search',
        cached: false,
      }),
      // A single non-Costco page: kept as a provisional possible match, with its evidence recorded.
      expect.objectContaining({
        itemNumber: '1712345',
        status: 'provisional',
        normalizedName: 'Anker SOLIX C1000 Portable Power Station - Item 1712345',
        confidence: 0.4,
        evidence: 'single-source',
        evidenceSources: 1,
      }),
      expect.objectContaining({ itemNumber: '1999999', status: 'not_found', normalizedName: null, cached: false }),
    ])
    // Query privacy: only "Costco", the item number and the receipt description.
    expect(queries).toEqual(['Costco 1627770 CLASSIC BLUE', 'Costco 1712345 ANKERSOLIX', 'Costco 1999999 TORO BULLY', 'Costco "1999999"'])

    const second = await h.call('POST', '/api/products/identify', { cookie, body: { items } })
    expect(second.body.results.map((x: { cached: boolean }) => x.cached)).toEqual([true, true, true])
    expect(queries).toHaveLength(4) // nothing searched again

    // A "not found" is retried only after the retry window.
    h.clock.now = new Date(h.clock.now.getTime() + NOT_FOUND_RETRY_MS + 1000)
    const later = await h.login() // the earlier session has expired by now
    await h.call('POST', '/api/products/identify', { cookie: later, body: { items } })
    // Weak evidence (provisional) and "not found" are re-checked after the retry window; usable identities are not.
    expect(queries.slice(4)).toEqual(['Costco 1712345 ANKERSOLIX', 'Costco 1999999 TORO BULLY', 'Costco "1999999"'])

    const list = await h.call('GET', '/api/products/identities', { cookie: later })
    expect(list.body.identities.map((i: { itemNumber: string }) => i.itemNumber)).toEqual(['1627770', '1712345'])
  })

  it('serves only the cache when no search provider is configured', async () => {
    const { search } = fakeSearch(TABLE)
    const h = createHarness({ search })
    const cookie = await h.login()
    await h.call('POST', '/api/products/identify', { cookie, body: { items: items.slice(0, 1) } })
    const noSearch = createHarness({ search: null })
    // Same database is not shared between harnesses, so seed through the first one and copy.
    const row = h.db.raw.prepare('SELECT * FROM product_identities').get() as Record<string, unknown>
    noSearch.db.raw
      .prepare(`INSERT INTO product_identities (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`)
      .run(...(Object.values(row) as never[]))
    const c2 = await noSearch.login()
    const res = await noSearch.call('POST', '/api/products/identify', { cookie: c2, body: { items } })
    expect(res.body.searchConfigured).toBe(false)
    expect(res.body.results.map((x: { status: string }) => x.status)).toEqual(['identified', 'unavailable', 'unavailable'])
    expect(noSearch.db.raw.prepare('SELECT COUNT(*) AS n FROM product_identities').get()).toEqual({ n: 1 })
  })

  it('does not cache a failed search', async () => {
    const { search } = fakeSearch(TABLE, { fail: true })
    const h = createHarness({ search })
    const cookie = await h.login()
    const res = await h.call('POST', '/api/products/identify', { cookie, body: { items } })
    expect(res.status).toBe(200)
    expect(res.body.results.map((x: { status: string }) => x.status)).toEqual(['unavailable', 'unavailable', 'unavailable'])
    expect(h.db.raw.prepare('SELECT COUNT(*) AS n FROM product_identities').get()).toEqual({ n: 0 })
  })

  it('uses Workers AI only to normalize found results, with only public text, and falls back safely', async () => {
    const seen: unknown[] = []
    const ai: AiBinding = {
      run: vi.fn(async (_m: string, input: Record<string, unknown>) => {
        seen.push(input)
        return {
          response: {
            items: [
              { itemNumber: '1627770', normalizedName: 'Brondell Swash Thinline CL2200 Bidet Seat', brand: 'Brondell', productType: 'bidet toilet seat' },
              { itemNumber: '9999', normalizedName: 'not requested', brand: null, productType: null },
            ],
          },
        }
      }),
    }
    const { search } = fakeSearch(TABLE)
    const h = createHarness({ search, ai })
    const cookie = await h.login()
    const res = await h.call('POST', '/api/products/identify', { cookie, body: { items } })
    expect(res.body.results[0]).toMatchObject({ brand: 'Brondell', productType: 'bidet toilet seat', method: 'web-search+ai' })
    // Not normalized by the model → cleaned search title, no invented fields.
    // Weak evidence stays weak: AI never touches it, so it cannot add certainty.
    expect(res.body.results[1]).toMatchObject({ status: 'provisional', confidence: 0.4, brand: null, productType: null, method: 'web-search' })
    expect(ai.run).toHaveBeenCalledTimes(1) // one call per batch, only for found items
    const user = ((seen[0] as { messages: { content: string }[] }).messages[1]!.content)
    const payload = JSON.parse(user.slice(user.indexOf('\n') + 1)) as Record<string, unknown>[]
    // Only strong-evidence results are normalized (the single-source one is not), with public text only.
    expect(payload.map((p) => p.itemNumber)).toEqual(['1627770'])
    expect(payload.map((p) => Object.keys(p).sort())).toEqual([['itemNumber', 'receiptDescription', 'resultSnippet', 'resultTitle']])

    const failing = createHarness({ search: fakeSearch(TABLE).search, ai: { run: vi.fn(async () => Promise.reject(new Error('x'))) } })
    const c2 = await failing.login()
    const ok = await failing.call('POST', '/api/products/identify', { cookie: c2, body: { items: items.slice(0, 1) } })
    expect(ok.body.results[0]).toMatchObject({ status: 'identified', normalizedName: 'Brondell Swash Thinline CL2200 Bidet Toilet Seat', method: 'web-search' })
  })

  it('is owner-only, strict and bounded', async () => {
    const { search, queries } = fakeSearch(TABLE)
    const h = createHarness({ search })
    expect((await h.call('POST', '/api/products/identify', { body: { items } })).status).toBe(401)
    expect((await h.call('GET', '/api/products/identities')).status).toBe(401)
    const device = await h.enroll()
    expect((await h.call('POST', '/api/products/identify', { bearer: device.deviceToken, body: { items }, origin: null })).status).toBe(403)
    const cookie = await h.login()
    expect((await h.call('POST', '/api/products/identify', { cookie, body: { items }, origin: 'https://evil.example' })).status).toBe(403)
    // Purchase data can never be passed along: extra fields are rejected.
    const extra = { items: [{ itemNumber: '1627770', descriptions: ['CLASSIC BLUE'], purchaseDate: '2026-01-01', warehouse: 'X' }] }
    expect((await h.call('POST', '/api/products/identify', { cookie, body: extra })).status).toBe(400)
    const tooMany = { items: Array.from({ length: 11 }, (_, i) => ({ itemNumber: String(100 + i), descriptions: ['X'] })) }
    expect((await h.call('POST', '/api/products/identify', { cookie, body: tooMany })).status).toBe(400)
    expect(queries).toHaveLength(0)
  })
})

describe('AI category suggestions use cached identities', () => {
  it('adds the identified product to the model input for that item only', async () => {
    const inputs: Record<string, unknown>[] = []
    const ai: AiBinding = {
      run: vi.fn(async (_m: string, input: Record<string, unknown>) => {
        inputs.push(input)
        return { response: { suggestions: [] } }
      }),
    }
    const h = createHarness({ search: fakeSearch(TABLE).search, ai })
    const cookie = await h.login()
    await h.call('POST', '/api/products/identify', { cookie, body: { items: [{ itemNumber: '1627770', descriptions: ['CLASSIC BLUE'] }] } })
    const suggestCalls = () => inputs.filter((i) => JSON.stringify(i).includes('"suggestions"'))
    await h.call('POST', '/api/categories/suggest', {
      cookie,
      body: { items: [{ itemNumber: '1627770', descriptions: ['CLASSIC BLUE'] }, { itemNumber: '1999999', descriptions: ['TORO BULLY'] }] },
    })
    const input = suggestCalls().at(-1)!
    const user = (input.messages as { content: string }[])[1]!.content
    expect(JSON.parse(user.slice(user.indexOf('\n') + 1))).toEqual([
      // The normalization call got no usable answer, so the cleaned search title is used; null fields are omitted.
      { itemNumber: '1627770', descriptions: ['CLASSIC BLUE'], identifiedAs: { name: 'Brondell Swash Thinline CL2200 Bidet Toilet Seat' } },
      { itemNumber: '1999999', descriptions: ['TORO BULLY'] },
    ])
  })
})

describe('provisional identities are never used automatically', () => {
  it('keeps a single-source identity out of the AI suggestion prompt', async () => {
    const inputs: Record<string, unknown>[] = []
    const ai: AiBinding = {
      run: vi.fn(async (_m: string, input: Record<string, unknown>) => {
        inputs.push(input)
        return { response: { suggestions: [] } }
      }),
    }
    const h = createHarness({ search: fakeSearch(TABLE).search, ai })
    const cookie = await h.login()
    const id = await h.call('POST', '/api/products/identify', { cookie, body: { items: [{ itemNumber: '1712345', descriptions: ['ANKERSOLIX'] }] } })
    expect(id.body.results[0]).toMatchObject({ status: 'provisional' })
    expect(ai.run).not.toHaveBeenCalled() // no normalization for weak evidence
    await h.call('POST', '/api/categories/suggest', { cookie, body: { items: [{ itemNumber: '1712345', descriptions: ['ANKERSOLIX'] }] } })
    const user = (inputs.at(-1)!.messages as { content: string }[])[1]!.content
    expect(JSON.parse(user.slice(user.indexOf('\n') + 1))).toEqual([{ itemNumber: '1712345', descriptions: ['ANKERSOLIX'] }])
    // It is still listed for transparency.
    const list = await h.call('GET', '/api/products/identities', { cookie })
    expect(list.body.identities).toEqual([expect.objectContaining({ itemNumber: '1712345', status: 'provisional', evidence: 'single-source' })])
  })
})
