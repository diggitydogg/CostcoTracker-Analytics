// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { Harness } from './harness'
import { createHarness, ORIGIN } from './harness'
import { createRateLimiter } from '../ai/categorySuggest'
import type { SearchResult, WebSearch } from '../products/search'

const r = (title: string, url: string, snippet = ''): SearchResult => ({ title, url, snippet, imageUrl: null })

/** Fake search keyed by item number (all queries), recording every query. */
function fakeSearch(table: Record<string, SearchResult[]>) {
  const queries: string[] = []
  const search: WebSearch = {
    name: 'fake',
    search: vi.fn(async (q: string) => {
      queries.push(q)
      const n = Object.keys(table).find((k) => q.includes(k))
      return n ? table[n]! : []
    }),
  }
  return { search, queries }
}

const MARK = { title: 'PROVISIONALTITLEMARKER', url: 'URLMARKER', snippet: 'SNIPPETMARKER' }
/** 9200001: one ordinary source only → provisional. 9200002: Costco.com → resolved automatically. */
const TABLE = {
  '9200001': [r(`${MARK.title} Synthetic Boot 9200001`, `https://blog.example/${MARK.url}`, `${MARK.snippet} $49.99`)],
  '9200002': [r('Synthetic Paper Towels | Costco', 'https://www.costco.com/x.product.1.html', 'Item 9200002')],
}

const dump = (h: Harness) => {
  const tables = h.db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]
  return JSON.stringify(tables.map(({ name }) => h.db.raw.prepare(`SELECT * FROM "${name}"`).all()))
}

const confirmBody = {
  itemNumber: '9200001',
  receiptDescription: 'SYN BOOT',
  canonicalName: 'Synthetic Rain Boot',
  brand: 'Synthetic',
  productType: 'rain boot',
}

async function setup() {
  const { search, queries } = fakeSearch(TABLE)
  const h = createHarness({ search })
  const cookie = await h.login()
  const identify = (itemNumber: string, d: string) => h.call('POST', '/api/products/identify', { cookie, body: { items: [{ itemNumber, descriptions: [d] }] } })
  return { h, cookie, queries, identify }
}

describe('owner-confirmed identities', () => {
  it('confirming a provisional item saves a resolved owner-confirmed row with only our own fields', async () => {
    const { h, cookie, identify } = await setup()
    expect((await identify('9200001', 'SYN BOOT')).body.results[0]).toMatchObject({ status: 'unresolved', outcome: 'provisional' })

    const res = await h.call('POST', '/api/products/confirm', { cookie, body: confirmBody })
    expect(res.status).toBe(200)
    expect(res.body.identity).toEqual({
      itemNumber: '9200001',
      status: 'resolved',
      receiptDescription: 'SYN BOOT',
      canonicalName: 'Synthetic Rain Boot',
      brand: 'Synthetic',
      productType: 'rain boot',
      confidence: 1,
      basis: 'owner-confirmed',
      method: 'owner',
      resolvedAt: h.clock.now.toISOString(),
    })
    expect(h.db.raw.prepare('SELECT * FROM product_identities WHERE item_number = ?').get('9200001')).toMatchObject({
      status: 'resolved',
      resolution_basis: 'owner-confirmed',
      confidence: 1,
      last_outcome: null,
      retry_after: null,
      method: 'owner',
    })
    // Served by the catalog endpoint like any resolved identity.
    const list = await h.call('GET', '/api/products/identities', { cookie })
    expect(list.body.identities).toEqual([expect.objectContaining({ itemNumber: '9200001', basis: 'owner-confirmed', canonicalName: 'Synthetic Rain Boot' })])
    // Nothing from the search results was persisted anywhere.
    const stored = dump(h)
    for (const m of Object.values(MARK)) expect(stored).not.toContain(m)
    expect(stored).not.toMatch(/https?:\/\/|\$49\.99/)
  })

  it('also works for an item number that was never looked up, with null brand/type', async () => {
    const { h, cookie } = await setup()
    const res = await h.call('POST', '/api/products/confirm', { cookie, body: { ...confirmBody, itemNumber: '9200009', brand: null, productType: null } })
    expect(res.body.identity).toMatchObject({ itemNumber: '9200009', basis: 'owner-confirmed', brand: null, productType: null })
  })

  it('a confirmed item number is never searched again', async () => {
    const { h, cookie, queries, identify } = await setup()
    await identify('9200001', 'SYN BOOT')
    const before = queries.length
    await h.call('POST', '/api/products/confirm', { cookie, body: confirmBody })
    h.clock.now = new Date(h.clock.now.getTime() + 400 * 24 * 60 * 60 * 1000) // far past any retry window
    const fresh = await h.login() // the old session has expired by then
    const again = await h.call('POST', '/api/products/identify', { cookie: fresh, body: { items: [{ itemNumber: '9200001', descriptions: ['SYN BOOT'] }] } })
    expect(again.body.results[0]).toMatchObject({ status: 'resolved', basis: 'owner-confirmed', cached: true })
    expect(queries).toHaveLength(before)
  })

  it('rejects extra or private fields, links and malformed values (strict schema)', async () => {
    const { h, cookie } = await setup()
    for (const extra of [
      { sourceUrl: 'https://blog.example/x' },
      { snippet: 'x' },
      { imageUrl: 'https://img.example/x.jpg' },
      { price: 1999 },
      { purchaseDate: '2026-01-01' },
      { warehouse: 'Synthetic #1' },
      { receiptId: 'r1' },
      { orderId: 'o1' },
      { provider: 'brave' },
      { confidence: 0.2 },
      { basis: 'costco.com' },
    ]) {
      const res = await h.call('POST', '/api/products/confirm', { cookie, body: { ...confirmBody, ...extra } })
      expect(res.status, JSON.stringify(extra)).toBe(400)
    }
    for (const bad of [
      { canonicalName: '' },
      { canonicalName: 'https://blog.example/boot' },
      { canonicalName: 'see www.example.com' },
      { canonicalName: 'two\nlines' },
      { canonicalName: 'x'.repeat(121) },
      { brand: '' },
      { itemNumber: '../x' },
      { receiptDescription: '' },
    ]) {
      const res = await h.call('POST', '/api/products/confirm', { cookie, body: { ...confirmBody, ...bad } })
      expect(res.status, JSON.stringify(bad)).toBe(400)
    }
    const missingName: Record<string, unknown> = { ...confirmBody }
    delete missingName.canonicalName
    expect((await h.call('POST', '/api/products/confirm', { cookie, body: missingName })).status).toBe(400)
    // PATCH is strict too.
    await h.call('POST', '/api/products/confirm', { cookie, body: confirmBody })
    const patch = await h.call('PATCH', '/api/products/identity/9200001', { cookie, body: { canonicalName: 'X', brand: null, productType: null, url: 'https://x.example' } })
    expect(patch.status).toBe(400)
    expect(h.db.raw.prepare('SELECT COUNT(*) AS n FROM product_identities').get()).toEqual({ n: 1 })
  })

  it('edits an owner-confirmed identity', async () => {
    const { h, cookie } = await setup()
    await h.call('POST', '/api/products/confirm', { cookie, body: confirmBody })
    h.clock.now = new Date(h.clock.now.getTime() + 60_000)
    const res = await h.call('PATCH', '/api/products/identity/9200001', {
      cookie,
      body: { canonicalName: 'Synthetic Waterproof Rain Boot', brand: null, productType: 'boot' },
    })
    expect(res.status).toBe(200)
    expect(res.body.identity).toMatchObject({ canonicalName: 'Synthetic Waterproof Rain Boot', brand: null, productType: 'boot', basis: 'owner-confirmed', confidence: 1, resolvedAt: h.clock.now.toISOString() })
  })

  it('removes an owner-confirmed identity, and the item can be searched again', async () => {
    const { h, cookie, queries, identify } = await setup()
    await h.call('POST', '/api/products/confirm', { cookie, body: confirmBody })
    const del = await h.call('DELETE', '/api/products/identity/9200001', { cookie })
    expect(del).toMatchObject({ status: 200, body: { removed: '9200001' } })
    expect(h.db.raw.prepare('SELECT COUNT(*) AS n FROM product_identities').get()).toEqual({ n: 0 })
    expect((await h.call('GET', '/api/products/identities', { cookie })).body.identities).toEqual([])
    // A later lookup searches it again (immediately: the row, and with it any retry window, is gone).
    const again = await identify('9200001', 'SYN BOOT')
    expect(again.body.results[0]).toMatchObject({ status: 'unresolved', outcome: 'provisional', cached: false })
    expect(queries.filter((q) => q.includes('9200001')).length).toBeGreaterThan(0)
    // Removing again: nothing to remove.
    expect((await h.call('DELETE', '/api/products/identity/9200001', { cookie })).status).toBe(404)
  })

  it('automatic identities cannot be replaced, edited or removed', async () => {
    const { h, cookie, identify } = await setup()
    expect((await identify('9200002', 'SYN TOWELS')).body.results[0]).toMatchObject({ status: 'resolved', basis: 'costco.com' })
    const before = h.db.raw.prepare('SELECT * FROM product_identities WHERE item_number = ?').get('9200002')

    const confirm = await h.call('POST', '/api/products/confirm', { cookie, body: { ...confirmBody, itemNumber: '9200002' } })
    expect(confirm).toMatchObject({ status: 409, body: { error: { code: 'already_resolved' } } })
    const patch = await h.call('PATCH', '/api/products/identity/9200002', { cookie, body: { canonicalName: 'Hijack', brand: null, productType: null } })
    expect(patch).toMatchObject({ status: 409, body: { error: { code: 'not_owner_confirmed' } } })
    const del = await h.call('DELETE', '/api/products/identity/9200002', { cookie })
    expect(del).toMatchObject({ status: 409, body: { error: { code: 'not_owner_confirmed' } } })
    expect(h.db.raw.prepare('SELECT * FROM product_identities WHERE item_number = ?').get('9200002')).toEqual(before)

    // An owner-confirmed record is edited with PATCH, not re-confirmed.
    await h.call('POST', '/api/products/confirm', { cookie, body: confirmBody })
    expect((await h.call('POST', '/api/products/confirm', { cookie, body: confirmBody })).body.error.code).toBe('already_confirmed')
    // Unknown item numbers: 404.
    expect((await h.call('PATCH', '/api/products/identity/9299999', { cookie, body: { canonicalName: 'X', brand: null, productType: null } })).status).toBe(404)
  })

  it('is owner-only, same-origin and rate-limited', async () => {
    const h = createHarness({ search: fakeSearch(TABLE).search, catalogLimiter: createRateLimiter({ maxRequests: 2, windowMs: 60_000 }, 'Too many catalog changes.') })
    expect((await h.call('POST', '/api/products/confirm', { body: confirmBody })).status).toBe(401)
    expect((await h.call('DELETE', '/api/products/identity/9200001', {})).status).toBe(401)
    const { deviceToken } = await h.enroll()
    expect((await h.call('POST', '/api/products/confirm', { bearer: deviceToken, body: confirmBody, origin: null })).status).toBe(403)
    const cookie = await h.login()
    expect((await h.call('POST', '/api/products/confirm', { cookie, body: confirmBody, origin: 'https://evil.example' })).status).toBe(403)
    expect((await h.call('PATCH', '/api/products/identity/9200001', { cookie, body: { canonicalName: 'X', brand: null, productType: null }, origin: 'https://evil.example' })).status).toBe(403)
    expect((await h.call('POST', '/api/products/confirm', { cookie, body: confirmBody, origin: ORIGIN })).status).toBe(200)
    expect((await h.call('PATCH', '/api/products/identity/9200001', { cookie, body: { canonicalName: 'Y', brand: null, productType: null } })).status).toBe(200)
    expect((await h.call('DELETE', '/api/products/identity/9200001', { cookie })).status).toBe(429)
    expect((await h.call('POST', '/api/products/confirm', { cookie, rawBody: JSON.stringify({ ...confirmBody, canonicalName: 'x'.repeat(3000) }) })).status).toBe(413)
  })

  it('answers catalog_not_configured before migration 0002', async () => {
    const { h, cookie } = await setup()
    h.db.raw.exec('DROP TABLE product_identities')
    expect(await h.call('POST', '/api/products/confirm', { cookie, body: confirmBody })).toMatchObject({ status: 503, body: { error: { code: 'catalog_not_configured' } } })
  })

  it('the database still refuses product details on an unresolved row', async () => {
    const { h } = await setup()
    expect(() =>
      h.db.raw
        .prepare(
          `INSERT INTO product_identities (item_number, status, receipt_description, canonical_name, confidence, resolution_basis, last_outcome, method, last_attempt_at, retry_after)
           VALUES ('9200003', 'unresolved', 'X', 'Leak', 0, 'owner-confirmed', 'provisional', 'owner', '2026-01-01', '2026-02-01')`,
        )
        .run(),
    ).toThrow(/CHECK constraint/)
  })
})
