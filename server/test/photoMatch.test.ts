// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { AiBinding } from '../ai/categorySuggest'
import { PHOTO_EVIDENCE_MODEL } from '../ai/config'
import { buildEvidenceInput, candidatesFromResults, normalizeEvidence, photoSearchQueries, PHOTO_EVIDENCE_PROMPT } from '../products/photo'
import type { SearchResult, WebSearch } from '../products/search'
import { importExportValue } from '../../src/domain/import/importExport'
import { toSyncBatches } from '../../src/domain/sync/protocol'
import { syntheticExport } from '../../src/test/fixtures'
import { createHarness, uuid, type Harness } from './harness'

const IMAGE = `data:image/jpeg;base64,${'A'.repeat(400)}`
const r = (title: string, url: string, snippet = ''): SearchResult => ({ title, url, snippet, imageUrl: null })

/** Puts the synthetic purchase history (receipts, prices, dates, warehouses) into D1 through a normal sync. */
async function withPurchases(h: Harness) {
  const parsed = importExportValue(syntheticExport())
  if (!parsed.ok) throw new Error('fixture')
  const data = parsed.data
  const { deviceToken } = await h.enroll()
  const auth = { bearer: deviceToken, origin: null }
  const runId = uuid()
  await h.call('POST', '/api/sync/runs', { ...auth, body: { runId, mode: 'incremental', formatVersion: 1, exportedAt: '2026-10-31T18:00:00Z', currency: 'USD' } })
  const batches = toSyncBatches(data, 5)
  for (const [seq, batch] of batches.entries()) await h.call('PUT', `/api/sync/runs/${runId}/batches/${seq}`, { ...auth, body: batch })
  await h.call('POST', `/api/sync/runs/${runId}/complete`, { ...auth, body: { batchCount: batches.length } })
  // Every purchase-data value that must never reach the AI or the search provider.
  return [
    ...data.receipts.flatMap((x) => [x.id, x.warehouse, x.purchaseDate]),
    ...data.items.flatMap((x) => [x.id, x.description, x.purchaseId, String(x.lineTotalCents)]),
  ].filter((v): v is string => typeof v === 'string' && v.length >= 4)
}

const dump = (h: Harness) => JSON.stringify((h.db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map(({ name }) => h.db.raw.prepare(`SELECT * FROM "${name}"`).all()))

describe('POST /api/products/photo/evidence (AI step)', () => {
  it('sends Workers AI only the photo and a fixed instruction — never purchase data — and stores nothing', async () => {
    const inputs: unknown[] = []
    const ai: AiBinding = {
      run: vi.fn(async (model: string, input: Record<string, unknown>) => {
        inputs.push({ model, input })
        return { response: { quality: 'ok', brand: 'Synthetic', productName: 'Olive Oil', variant: null, size: '2 L', productType: 'olive oil', modelNumber: null, upc: null, costcoItemNumber: null, visibleText: ['SYNTHETIC', 'OLIVE OIL 2 L'] } }
      }),
    }
    const h = createHarness({ ai })
    const purchaseValues = await withPurchases(h)
    const cookie = await h.login()
    const before = dump(h)
    const res = await h.call('POST', '/api/products/photo/evidence', { cookie, body: { image: IMAGE } })
    expect(res.status).toBe(200)
    expect(res.body.evidence).toMatchObject({ source: 'ai-vision', quality: 'ok', brand: 'Synthetic', productName: 'Olive Oil', size: '2 L' })
    expect(inputs).toEqual([{ model: PHOTO_EVIDENCE_MODEL, input: buildEvidenceInput(IMAGE) }])
    const sent = JSON.stringify(inputs)
    for (const v of purchaseValues) expect(sent, v).not.toContain(v)
    expect(dump(h)).toBe(before)
  })

  it('the model input is exactly the fixed prompt and the image', () => {
    const input = buildEvidenceInput(IMAGE) as { messages: { role: string; content: unknown }[] }
    expect(input.messages).toEqual([
      { role: 'system', content: PHOTO_EVIDENCE_PROMPT },
      { role: 'user', content: [{ type: 'text', text: 'Describe the product in this photo. Return JSON only.' }, { type: 'image_url', image_url: { url: IMAGE } }] },
    ])
    expect(Object.keys(input).sort()).toEqual(['max_tokens', 'messages', 'response_format', 'temperature'])
  })

  it('is strict: one image data URL and nothing else', async () => {
    const h = createHarness({ ai: { run: vi.fn() } })
    const cookie = await h.login()
    for (const body of [
      { image: IMAGE, receiptId: 'r1' },
      { image: IMAGE, itemNumber: '1234567' },
      { image: IMAGE, purchases: [] },
      { image: 'https://example.com/photo.jpg' },
      { image: 'data:image/svg+xml;base64,AAAA' },
      { image: 'data:image/jpeg;base64,not base64!' },
      {},
    ]) {
      expect((await h.call('POST', '/api/products/photo/evidence', { cookie, body })).status, JSON.stringify(body).slice(0, 60)).toBe(400)
    }
    expect((await h.call('POST', '/api/products/photo/evidence', { cookie, rawBody: JSON.stringify({ image: `data:image/jpeg;base64,${'A'.repeat(1_800_000)}` }) })).status).toBe(413)
  })

  it('is owner-only and explains a missing AI binding or a failed model call', async () => {
    const none = createHarness()
    expect((await none.call('POST', '/api/products/photo/evidence', { body: { image: IMAGE } })).status).toBe(401)
    const c1 = await none.login()
    expect(await none.call('POST', '/api/products/photo/evidence', { cookie: c1, body: { image: IMAGE } })).toMatchObject({ status: 503, body: { error: { code: 'ai_not_configured' } } })
    const failing = createHarness({ ai: { run: vi.fn(async () => Promise.reject(new Error('boom'))) } })
    const c2 = await failing.login()
    expect(await failing.call('POST', '/api/products/photo/evidence', { cookie: c2, body: { image: IMAGE } })).toMatchObject({ status: 502, body: { error: { code: 'ai_failed' } } })
  })

  it('never trusts the model: no invented item numbers or barcodes, bounded text, unusable → no-product', () => {
    const e = normalizeEvidence({
      response: JSON.stringify({
        quality: 'ok',
        brand: '  Synthetic\n',
        productName: 'x'.repeat(200),
        costcoItemNumber: '9300002', // not in the visible text → dropped
        upc: '0123456789012', // not in the visible text → dropped
        visibleText: ['SYNTHETIC', 'UNKNOWN', ...Array.from({ length: 20 }, (_, i) => `line ${i}`)],
      }),
    })
    expect(e.brand).toBe('Synthetic')
    expect(e.productName).toHaveLength(80)
    expect(e.numbers).toEqual([])
    expect(e.barcodes).toEqual([])
    expect(e.visibleText).toHaveLength(12)
    const seen = normalizeEvidence({ quality: 'ok', costcoItemNumber: '9300002', upc: '0123456789012', visibleText: ['Item 9300002', '0 12345 67890 12'] })
    expect(seen.numbers).toContain('9300002')
    expect(seen.barcodes).toEqual([{ format: 'printed', value: '0123456789012' }])
    expect(normalizeEvidence({ quality: 'ok', visibleText: [] }).quality).toBe('no-product')
    expect(normalizeEvidence('not json').quality).toBe('no-product')
    expect(normalizeEvidence({ quality: 'blurry' }).quality).toBe('blurry')
  })
})

describe('POST /api/products/photo/search (search step)', () => {
  function fakeSearch(results: SearchResult[]) {
    const queries: string[] = []
    const search: WebSearch = { name: 'fake', search: vi.fn(async (q: string) => (queries.push(q), results)) }
    return { search, queries }
  }

  it('searches only with brand, product name and variant from the photo; returns verified item numbers; stores nothing', async () => {
    const { search, queries } = fakeSearch([
      r('SYNTHETIC OLIVE OIL 2 L', 'https://app.warehouserunner.com/costco/9300002-synthetic-olive-oil-2-l'),
      r('Unrelated blog', 'https://blog.example/olive'),
    ])
    const h = createHarness({ search })
    const purchaseValues = await withPurchases(h)
    const cookie = await h.login()
    const before = dump(h)
    const res = await h.call('POST', '/api/products/photo/search', { cookie, body: { brand: 'Synthetic', productName: 'Olive Oil', variant: null } })
    expect(res.body).toEqual({ searchConfigured: true, candidates: [{ itemNumber: '9300002', title: 'SYNTHETIC OLIVE OIL 2 L', basis: 'costco-specialist' }] })
    expect(queries).toEqual(['Costco Synthetic Olive Oil']) // a specialist result stops the search
    for (const v of purchaseValues) expect(queries.join(' '), v).not.toContain(v)
    expect(dump(h)).toBe(before)
  })

  it('is strict: no receipt text, item numbers, prices or anything else', async () => {
    const h = createHarness({ search: fakeSearch([]).search })
    const cookie = await h.login()
    for (const body of [
      { brand: null, productName: 'Olive Oil', variant: null, receiptDescription: 'KS OLIVE OIL' },
      { brand: null, productName: 'Olive Oil', variant: null, itemNumber: '9300002' },
      { brand: null, productName: 'Olive Oil', variant: null, price: 1599 },
      { brand: null, productName: 'Olive\nOil', variant: null },
      { brand: null, productName: '', variant: null },
    ]) {
      expect((await h.call('POST', '/api/products/photo/search', { cookie, body })).status, JSON.stringify(body)).toBe(400)
    }
  })

  it('reports when search is not configured, and a failed search as retryable', async () => {
    const off = createHarness({ search: null })
    const c1 = await off.login()
    expect((await off.call('POST', '/api/products/photo/search', { cookie: c1, body: { brand: null, productName: 'Olive Oil', variant: null } })).body).toEqual({ searchConfigured: false, candidates: [] })
    const broken = createHarness({ search: { name: 'x', search: vi.fn(async () => Promise.reject(new Error('search_http_500'))) } })
    const c2 = await broken.login()
    expect(await broken.call('POST', '/api/products/photo/search', { cookie: c2, body: { brand: null, productName: 'Olive Oil', variant: null } })).toMatchObject({ status: 502, body: { error: { code: 'search_failed' } } })
  })

  it('builds at most two queries and extracts only item numbers a result verifiably names', () => {
    expect(photoSearchQueries({ brand: 'Synthetic', productName: 'Olive Oil', variant: 'Extra Virgin' })).toEqual([
      'Costco Synthetic Olive Oil Extra Virgin',
      'site:app.warehouserunner.com Synthetic Olive Oil',
    ])
    expect(
      candidatesFromResults([
        r('Synthetic Olive Oil | Costco', 'https://www.costco.com/olive.product.4000.html', 'Item 9300002 · 2 L'),
        r('SYNTHETIC OLIVE OIL', 'https://app.warehouserunner.com/costco/9300002-synthetic-olive-oil'),
        r('Olive oil deals', 'https://app.warehouserunner.com/costco/category/grocery', 'Item 9399999'),
        r('Costco find: Synthetic Olive Oil, item #9311111', 'https://blog.example/x'),
        r('Olive oil review', 'https://blog.example/y', 'model 12345'),
      ]),
    ).toEqual([
      { itemNumber: '9300002', title: 'Synthetic Olive Oil', basis: 'costco.com' },
      { itemNumber: '9311111', title: 'Costco find: Synthetic Olive Oil, item #9311111', basis: 'web' },
    ])
  })
})
