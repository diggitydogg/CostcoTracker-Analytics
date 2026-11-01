// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { AiBinding } from '../ai/categorySuggest'
import { UNRESOLVED_RETRY_MS } from '../products/identify'
import type { Harness } from './harness'
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

/** Markers planted in every part of the fake search responses that must never reach D1. */
const M = {
  snippet: 'SNIPPETMARKER',
  url: 'URLMARKER',
  image: 'IMAGEMARKER',
  other: 'OTHERRESULTMARKER',
  provisionalTitle: 'PROVISIONALMARKER',
}

/** Search responses carrying markers in snippets, URLs, thumbnails and non-chosen results. */
const MARKED: Record<string, SearchResult[]> = {
  // Strong: Costco's own page.
  '1627770': [
    { title: `Unrelated ${M.other} page`, url: `https://blog.example/${M.other}`, snippet: `${M.other} classic blue`, imageUrl: `https://img.example/${M.other}.jpg` },
    {
      title: 'Brondell Swash Thinline CL2200 Bidet Toilet Seat | Costco',
      url: `https://www.costco.com/${M.url}.product.4000123.html`,
      snippet: `Item 1627770 ${M.snippet}`,
      imageUrl: `https://img.example/${M.image}.jpg`,
    },
  ],
  // Provisional: one non-Costco site only.
  '1712345': [{ title: `${M.provisionalTitle} Anker SOLIX C1000 - Item 1712345`, url: `https://deals.example.org/${M.url}-1712345`, snippet: M.snippet, imageUrl: `https://img.example/${M.image}2.jpg` }],
}

/** Every value stored anywhere in D1, as one string (all tables, all columns). */
function dumpDatabase(h: Harness): string {
  const tables = h.db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]
  return JSON.stringify(tables.map(({ name }) => h.db.raw.prepare(`SELECT * FROM "${name}"`).all()))
}

describe('POST /api/products/identify — transient search, local catalog', () => {
  const items = [
    { itemNumber: '1627770', descriptions: ['CLASSIC BLUE'] },
    { itemNumber: '1712345', descriptions: ['ANKERSOLIX'] },
    { itemNumber: '1999999', descriptions: ['TORO BULLY'] },
  ]

  it('resolves strong evidence into our own record and never stores search-result content', async () => {
    const { search, queries } = fakeSearch(MARKED)
    const h = createHarness({ search })
    const cookie = await h.login()
    const res = await h.call('POST', '/api/products/identify', { cookie, body: { items } })
    expect(res.status).toBe(200)
    expect(res.body.results).toEqual([
      {
        itemNumber: '1627770',
        status: 'resolved',
        receiptDescription: 'CLASSIC BLUE',
        canonicalName: 'Brondell Swash Thinline CL2200 Bidet Toilet Seat',
        brand: null,
        productType: null,
        confidence: 0.9,
        basis: 'costco.com',
        method: 'web-search',
        resolvedAt: h.clock.now.toISOString(),
        cached: false,
      },
      // Weak evidence: not a trusted identity. The candidate name is shown now, not stored.
      expect.objectContaining({ itemNumber: '1712345', status: 'unresolved', outcome: 'provisional', candidateName: `${M.provisionalTitle} Anker SOLIX C1000 - Item 1712345`, cached: false }),
      expect.objectContaining({ itemNumber: '1999999', status: 'unresolved', outcome: 'not_found', candidateName: null }),
    ])
    expect(queries).toEqual(['Costco 1627770 CLASSIC BLUE', 'Costco 1712345 ANKERSOLIX', 'Costco 1999999 TORO BULLY', 'Costco "1999999"'])

    // D1 holds our own outcome only: no snippets, URLs, thumbnails, other results, or provisional names.
    const stored = dumpDatabase(h)
    for (const marker of Object.values(M)) expect(stored, marker).not.toContain(marker)
    expect(stored).not.toMatch(/https?:\/\//)
    expect(stored).not.toContain('| Costco')
    expect(h.db.raw.prepare('SELECT * FROM product_identities ORDER BY item_number').all()).toEqual([
      {
        item_number: '1627770',
        status: 'resolved',
        receipt_description: 'CLASSIC BLUE',
        canonical_name: 'Brondell Swash Thinline CL2200 Bidet Toilet Seat',
        brand: null,
        product_type: null,
        confidence: 0.9,
        resolution_basis: 'costco.com',
        last_outcome: null,
        method: 'web-search',
        resolved_at: h.clock.now.toISOString(),
        last_attempt_at: h.clock.now.toISOString(),
        retry_after: null,
      },
      expect.objectContaining({ item_number: '1712345', status: 'unresolved', canonical_name: null, brand: null, product_type: null, confidence: 0, resolution_basis: null, last_outcome: 'provisional' }),
      expect.objectContaining({ item_number: '1999999', status: 'unresolved', canonical_name: null, last_outcome: 'not_found' }),
    ])
    // The table has no column that could hold search-result content.
    const columns = (h.db.raw.prepare("PRAGMA table_info('product_identities')").all() as { name: string }[]).map((c) => c.name)
    for (const c of columns) expect(c).not.toMatch(/url|image|snippet|title|rank|response|source|provider/i)
  })

  it('never searches a resolved item number again; retries unresolved ones after the retry window', async () => {
    const { search, queries } = fakeSearch(MARKED)
    const h = createHarness({ search })
    let cookie = await h.login()
    await h.call('POST', '/api/products/identify', { cookie, body: { items } })
    expect(queries).toHaveLength(4)

    const again = await h.call('POST', '/api/products/identify', { cookie, body: { items } })
    expect(again.body.results.map((x: { status: string; cached: boolean }) => [x.status, x.cached])).toEqual([
      ['resolved', true],
      ['unresolved', true],
      ['unresolved', true],
    ])
    // A cached unresolved result carries no candidate name (it was never stored).
    expect(again.body.results[1].candidateName).toBeNull()
    expect(queries).toHaveLength(4)

    // Much later: only the unresolved ones are looked up again; the resolved SKU never is.
    h.clock.now = new Date(h.clock.now.getTime() + UNRESOLVED_RETRY_MS * 12)
    cookie = await h.login()
    await h.call('POST', '/api/products/identify', { cookie, body: { items } })
    expect(queries.slice(4)).toEqual(['Costco 1712345 ANKERSOLIX', 'Costco 1999999 TORO BULLY', 'Costco "1999999"'])
    expect(queries.filter((q) => q.includes('1627770'))).toHaveLength(1)

    const list = await h.call('GET', '/api/products/identities', { cookie })
    expect(list.body.identities.map((i: { itemNumber: string }) => i.itemNumber)).toEqual(['1627770']) // the catalog lists resolved records only
  })

  it('upgrades an unresolved item when stronger evidence appears later, and never downgrades a resolved one', async () => {
    const table: Record<string, SearchResult[]> = { '1712345': MARKED['1712345']! }
    const { search } = fakeSearch(table)
    const h = createHarness({ search })
    let cookie = await h.login()
    await h.call('POST', '/api/products/identify', { cookie, body: { items: [items[1]] } })
    table['1712345'] = [r('Anker SOLIX C1000 Portable Power Station | Costco', 'https://www.costco.com/anker.product.1.html', 'Item 1712345')]
    h.clock.now = new Date(h.clock.now.getTime() + UNRESOLVED_RETRY_MS + 1000)
    cookie = await h.login()
    const res = await h.call('POST', '/api/products/identify', { cookie, body: { items: [items[1]] } })
    expect(res.body.results[0]).toMatchObject({ status: 'resolved', canonicalName: 'Anker SOLIX C1000 Portable Power Station', basis: 'costco.com' })
    expect(h.db.raw.prepare('SELECT status, retry_after, last_outcome FROM product_identities').get()).toEqual({ status: 'resolved', retry_after: null, last_outcome: null })
  })

  it('the database refuses to store product details on an unresolved row', async () => {
    const h = createHarness()
    expect(() =>
      h.db.raw
        .prepare(
          "INSERT INTO product_identities (item_number, status, receipt_description, canonical_name, confidence, last_outcome, method, last_attempt_at, retry_after) VALUES ('1', 'unresolved', 'X', 'Some name', 0, 'provisional', 'web-search', '2026-01-01', '2026-02-01')",
        )
        .run(),
    ).toThrow(/CHECK constraint/)
  })

  it('serves only the local catalog when no search provider is configured', async () => {
    const h = createHarness({ search: null })
    h.db.raw
      .prepare(
        "INSERT INTO product_identities (item_number, status, receipt_description, canonical_name, confidence, resolution_basis, method, resolved_at, last_attempt_at) VALUES ('1627770', 'resolved', 'CLASSIC BLUE', 'Brondell Swash Bidet Seat', 0.9, 'costco.com', 'web-search', '2026-01-01', '2026-01-01')",
      )
      .run()
    const cookie = await h.login()
    const res = await h.call('POST', '/api/products/identify', { cookie, body: { items } })
    expect(res.body.searchConfigured).toBe(false)
    expect(res.body.results.map((x: { status: string }) => x.status)).toEqual(['resolved', 'unavailable', 'unavailable'])
  })

  it('does not record anything for a failed search', async () => {
    const { search } = fakeSearch(MARKED, { fail: true })
    const h = createHarness({ search })
    const cookie = await h.login()
    const res = await h.call('POST', '/api/products/identify', { cookie, body: { items } })
    expect(res.body.results.map((x: { status: string }) => x.status)).toEqual(['unavailable', 'unavailable', 'unavailable'])
    expect(h.db.raw.prepare('SELECT COUNT(*) AS n FROM product_identities').get()).toEqual({ n: 0 })
  })

  it('uses Workers AI only to normalize strong candidates, with public text only, and never stores its input', async () => {
    const seen: unknown[] = []
    const ai: AiBinding = {
      run: vi.fn(async (_m: string, input: Record<string, unknown>) => {
        seen.push(input)
        return { response: { items: [{ itemNumber: '1627770', normalizedName: 'Brondell Swash Thinline CL2200 Bidet Seat', brand: 'Brondell', productType: 'bidet toilet seat' }] } }
      }),
    }
    const { search } = fakeSearch(MARKED)
    const h = createHarness({ search, ai })
    const cookie = await h.login()
    const res = await h.call('POST', '/api/products/identify', { cookie, body: { items } })
    expect(res.body.results[0]).toMatchObject({ canonicalName: 'Brondell Swash Thinline CL2200 Bidet Seat', brand: 'Brondell', productType: 'bidet toilet seat', method: 'web-search+ai', confidence: 0.9 })
    // Weak evidence is not normalized and cannot gain certainty.
    expect(res.body.results[1]).toMatchObject({ status: 'unresolved', outcome: 'provisional' })
    expect(ai.run).toHaveBeenCalledTimes(1)
    const user = (seen[0] as { messages: { content: string }[] }).messages[1]!.content
    const payload = JSON.parse(user.slice(user.indexOf('\n') + 1)) as Record<string, unknown>[]
    expect(payload.map((p) => p.itemNumber)).toEqual(['1627770'])
    // The AI saw the transient result title/snippet, but none of it was stored.
    const stored = dumpDatabase(h)
    for (const marker of Object.values(M)) expect(stored).not.toContain(marker)

    const failing = createHarness({ search: fakeSearch(MARKED).search, ai: { run: vi.fn(async () => Promise.reject(new Error('x'))) } })
    const c2 = await failing.login()
    const ok = await failing.call('POST', '/api/products/identify', { cookie: c2, body: { items: items.slice(0, 1) } })
    expect(ok.body.results[0]).toMatchObject({ status: 'resolved', canonicalName: 'Brondell Swash Thinline CL2200 Bidet Toilet Seat', method: 'web-search' })
  })

  it('is owner-only, strict and bounded', async () => {
    const { search, queries } = fakeSearch(MARKED)
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

describe('AI category suggestions use the local catalog', () => {
  it('adds resolved records (only) to the model input', async () => {
    const inputs: Record<string, unknown>[] = []
    const ai: AiBinding = {
      run: vi.fn(async (_m: string, input: Record<string, unknown>) => {
        inputs.push(input)
        return { response: { suggestions: [] } }
      }),
    }
    const h = createHarness({ search: fakeSearch(MARKED).search, ai })
    const cookie = await h.login()
    await h.call('POST', '/api/products/identify', {
      cookie,
      body: { items: [{ itemNumber: '1627770', descriptions: ['CLASSIC BLUE'] }, { itemNumber: '1712345', descriptions: ['ANKERSOLIX'] }] },
    })
    await h.call('POST', '/api/categories/suggest', {
      cookie,
      body: { items: [{ itemNumber: '1627770', descriptions: ['CLASSIC BLUE'] }, { itemNumber: '1712345', descriptions: ['ANKERSOLIX'] }] },
    })
    const input = inputs.filter((i) => JSON.stringify(i).includes('"suggestions"')).at(-1)!
    const user = (input.messages as { content: string }[])[1]!.content
    expect(JSON.parse(user.slice(user.indexOf('\n') + 1))).toEqual([
      // The normalization call got no usable answer, so the cleaned name is used; null fields are omitted.
      { itemNumber: '1627770', descriptions: ['CLASSIC BLUE'], identifiedAs: { name: 'Brondell Swash Thinline CL2200 Bidet Toilet Seat' } },
      // Unresolved (provisional): nothing about it is passed on.
      { itemNumber: '1712345', descriptions: ['ANKERSOLIX'] },
    ])
  })
})
