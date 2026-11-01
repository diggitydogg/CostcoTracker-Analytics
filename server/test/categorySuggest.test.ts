// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { buildModelInput, createRateLimiter, normalizeModelOutput, type AiBinding } from '../ai/categorySuggest'
import { CATEGORY_SUGGESTION_MODEL } from '../ai/config'
import { SUGGEST_LIMITS, buildSuggestionItems } from '../../src/analytics/categories/suggestProtocol'
import { createHarness } from './harness'

/** A mocked Workers AI binding that records every call and answers with `answer(items)`. */
function mockAi(answer: (items: { itemNumber: string; descriptions: string[] }[]) => unknown) {
  const calls: { model: string; input: Record<string, unknown> }[] = []
  const ai: AiBinding = {
    run: vi.fn(async (model: string, input: Record<string, unknown>) => {
      calls.push({ model, input })
      const user = (input.messages as { role: string; content: string }[]).find((m) => m.role === 'user')!.content
      const items = JSON.parse(user.slice(user.indexOf('\n') + 1)) as { itemNumber: string; descriptions: string[] }[]
      return answer(items)
    }),
  }
  return { ai, calls }
}

const ITEMS = [
  { itemNumber: '1712345', descriptions: ['ANKERSOLIX'] },
  { itemNumber: '1700001', descriptions: ['KS CHIANTI'] },
  { itemNumber: '1700002', descriptions: ['CLASSIC BLUE'] },
]

describe('privacy: what the model receives', () => {
  // A realistic item record from the dashboard, full of data that must never be sent.
  const fullItem = {
    itemNumber: '1712345',
    descriptions: ['ANKERSOLIX', 'ANKER SOLIX C1000'],
    displayDescription: 'ANKERSOLIX',
    totalSpentCents: 49_999,
    averageUnitPriceCents: 49_999,
    latestUnitPriceCents: 49_999,
    totalQuantity: 1,
    firstPurchaseDate: '2026-05-04',
    lastPurchaseDate: '2026-05-04',
    receiptIds: ['rcpt_SECRET_RECEIPT_ID'],
    lineIds: ['line_SECRET_LINE_ID'],
    bySource: { warehouse: 1, online: 0, synthetic: 0 },
    warehouse: 'SECRET WAREHOUSE 123',
    transactionBarcode: '21134000000000000000001',
    orderNumber: 'ORDER-SECRET-1',
    returns: { count: 1, amountCents: 1234, ids: ['ret_SECRET'] },
    adjustments: { count: 1, amountCents: 500, ids: ['adj_SECRET'] },
    deviceToken: 'device-token-SECRET',
    idKey: 'idkey-SECRET',
    accessKey: 'owner-access-key-SECRET',
    category: { categoryId: 'uncategorized' },
  }

  it('the request builder copies only item numbers and descriptions', () => {
    const built = buildSuggestionItems([fullItem as never])
    expect(built).toEqual([{ itemNumber: '1712345', descriptions: ['ANKERSOLIX', 'ANKER SOLIX C1000'] }])
    expect(Object.keys(built[0]!).sort()).toEqual(['descriptions', 'itemNumber'])
  })

  it('the model input contains no purchase, location, ID or credential data', () => {
    const input = buildModelInput(buildSuggestionItems([fullItem as never]))
    // The only data in the request is the item list in the user message, and it is exactly this:
    const messages = input.messages as { role: string; content: string }[]
    expect(messages.map((m) => m.role)).toEqual(['system', 'user'])
    const user = messages[1]!.content
    expect(JSON.parse(user.slice(user.indexOf('\n') + 1))).toEqual([{ itemNumber: '1712345', descriptions: ['ANKERSOLIX', 'ANKER SOLIX C1000'] }])
    // …and no forbidden value appears anywhere in the whole model input.
    const all = JSON.stringify(input)
    for (const forbidden of [
      '49999', '499.99', '2026-05-04', 'rcpt_', 'line_', 'SECRET', 'WAREHOUSE 123', '21134000000000000000001',
      'ORDER-', 'device-token', 'idkey', 'access-key', 'totalSpent', 'amountCents', 'unitPrice', 'Quantity',
    ]) {
      expect(all, forbidden).not.toContain(forbidden)
    }
    expect(Object.keys(input).sort()).toEqual(['max_tokens', 'messages', 'response_format', 'temperature'])
  })

  it('the server rejects any extra field instead of forwarding it', async () => {
    const { ai, calls } = mockAi(() => ({ response: { suggestions: [] } }))
    const h = createHarness({ ai })
    const cookie = await h.login()
    const res = await h.call('POST', '/api/categories/suggest', {
      cookie,
      body: { items: [{ itemNumber: '1', descriptions: ['KS CHIANTI'], totalSpentCents: 999 }] },
    })
    expect(res.status).toBe(400)
    const top = await h.call('POST', '/api/categories/suggest', { cookie, body: { items: [{ itemNumber: '1', descriptions: ['X'] }], purchaseDate: '2026-01-01' } })
    expect(top.status).toBe(400)
    expect(calls).toHaveLength(0)
  })

  it('cleans and truncates descriptions and limits variants', () => {
    const built = buildSuggestionItems([
      { itemNumber: '9', descriptions: ['  LONG\tTITLE\n' + 'X'.repeat(500), 'B', 'C', 'D'] },
      { itemNumber: 'bad number!', descriptions: ['SKIPPED'] },
      { itemNumber: '10', descriptions: ['   '] },
    ])
    expect(built).toHaveLength(1)
    expect(built[0]!.descriptions).toHaveLength(SUGGEST_LIMITS.maxDescriptionsPerItem)
    expect(built[0]!.descriptions[0]!.length).toBeLessThanOrEqual(SUGGEST_LIMITS.maxDescriptionLength)
    expect(built[0]!.descriptions[0]).toMatch(/^LONG TITLE X+$/)
  })
})

describe('POST /api/categories/suggest', () => {
  const good = (items: { itemNumber: string }[]) => ({
    response: {
      suggestions: items.map((i) =>
        i.itemNumber === '1712345'
          ? { itemNumber: i.itemNumber, categoryId: 'electronics', subcategoryId: null, confidence: 0.92, reason: 'Anker Solix portable power station' }
          : i.itemNumber === '1700001'
            ? { itemNumber: i.itemNumber, categoryId: 'alcohol', subcategoryId: null, confidence: 0.95, reason: 'Kirkland Signature Chianti wine' }
            : { itemNumber: i.itemNumber, categoryId: null, subcategoryId: null, confidence: 0.2, reason: 'Color name; product unclear' },
      ),
    },
    usage: { prompt_tokens: 900, completion_tokens: 120, total_tokens: 1020 },
  })

  it('rejects unauthenticated requests without calling the model', async () => {
    const { ai, calls } = mockAi(good)
    const h = createHarness({ ai })
    const res = await h.call('POST', '/api/categories/suggest', { body: { items: ITEMS } })
    expect(res.status).toBe(401)
    expect(calls).toHaveLength(0)
  })

  it('rejects devices and cross-origin owner requests', async () => {
    const { ai, calls } = mockAi(good)
    const h = createHarness({ ai })
    const device = await h.enroll()
    expect((await h.call('POST', '/api/categories/suggest', { bearer: device.deviceToken, body: { items: ITEMS }, origin: null })).status).toBe(403)
    const cookie = await h.login()
    expect((await h.call('POST', '/api/categories/suggest', { cookie, body: { items: ITEMS }, origin: 'https://evil.example' })).status).toBe(403)
    expect(calls).toHaveLength(0)
  })

  it('returns structured, taxonomy-checked suggestions (with abstentions) and usage diagnostics', async () => {
    const { ai, calls } = mockAi(good)
    const h = createHarness({ ai })
    const cookie = await h.login()
    const res = await h.call('POST', '/api/categories/suggest', { cookie, body: { items: ITEMS } })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      model: CATEGORY_SUGGESTION_MODEL,
      suggestions: [
        { itemNumber: '1712345', categoryId: 'electronics', subcategoryId: null, confidence: 0.92, reason: 'Anker Solix portable power station' },
        { itemNumber: '1700001', categoryId: 'alcohol', subcategoryId: null, confidence: 0.95, reason: 'Kirkland Signature Chianti wine' },
        { itemNumber: '1700002', categoryId: null, subcategoryId: null, confidence: 0, reason: 'Color name; product unclear' },
      ],
      usage: { promptTokens: 900, completionTokens: 120, totalTokens: 1020 },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.model).toBe(CATEGORY_SUGGESTION_MODEL)
    expect(calls[0]!.input.response_format).toMatchObject({ type: 'json_schema' })
    // Nothing is persisted server-side.
    expect(h.db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%suggest%'").all()).toEqual([])
  })

  it.each([
    ['not JSON', '{nope', 400],
    ['no items', JSON.stringify({ items: [] }), 400],
    ['bad item number', JSON.stringify({ items: [{ itemNumber: '12 34', descriptions: ['X'] }] }), 400],
    ['empty description', JSON.stringify({ items: [{ itemNumber: '1', descriptions: [''] }] }), 400],
    ['too many descriptions', JSON.stringify({ items: [{ itemNumber: '1', descriptions: ['A', 'B', 'C', 'D'] }] }), 400],
    ['description too long', JSON.stringify({ items: [{ itemNumber: '1', descriptions: ['X'.repeat(121)] }] }), 400],
    ['multi-line description', JSON.stringify({ items: [{ itemNumber: '1', descriptions: ['A\nB'] }] }), 400],
    ['duplicate items', JSON.stringify({ items: [{ itemNumber: '1', descriptions: ['A'] }, { itemNumber: '1', descriptions: ['B'] }] }), 400],
    ['oversized batch', JSON.stringify({ items: Array.from({ length: 26 }, (_, i) => ({ itemNumber: String(i + 1), descriptions: ['X'] })) }), 400],
    ['oversized body', JSON.stringify({ items: [{ itemNumber: '1', descriptions: ['X'] }], pad: 'x'.repeat(30_000) }), 413],
  ])('rejects %s without calling the model', async (_, rawBody, status) => {
    const { ai, calls } = mockAi(good)
    const h = createHarness({ ai })
    const cookie = await h.login()
    const res = await h.call('POST', '/api/categories/suggest', { cookie, rawBody })
    expect(res.status).toBe(status)
    expect(calls).toHaveLength(0)
  })

  it('explains when the AI binding is not configured', async () => {
    const h = createHarness()
    const cookie = await h.login()
    const res = await h.call('POST', '/api/categories/suggest', { cookie, body: { items: ITEMS } })
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('ai_not_configured')
  })

  it('reports a model failure (e.g. "JSON Mode couldn\'t be met") as a retryable error', async () => {
    const ai: AiBinding = { run: vi.fn(async () => Promise.reject(new Error("JSON Mode couldn't be met"))) }
    const h = createHarness({ ai })
    const cookie = await h.login()
    const res = await h.call('POST', '/api/categories/suggest', { cookie, body: { items: ITEMS } })
    expect(res.status).toBe(502)
    expect(res.body.error.code).toBe('ai_failed')
    expect(JSON.stringify(res.body)).not.toContain('KS CHIANTI')
  })

  it('limits request bursts', async () => {
    const { ai, calls } = mockAi(good)
    const h = createHarness({ ai, aiLimiter: createRateLimiter({ maxRequests: 2, windowMs: 60_000 }) })
    const cookie = await h.login()
    const send = () => h.call('POST', '/api/categories/suggest', { cookie, body: { items: ITEMS } })
    expect((await send()).status).toBe(200)
    expect((await send()).status).toBe(200)
    const third = await send()
    expect(third.status).toBe(429)
    expect(third.body.error.code).toBe('rate_limited')
    expect(calls).toHaveLength(2)
    h.clock.now = new Date(h.clock.now.getTime() + 61_000)
    expect((await send()).status).toBe(200)
  })
})

describe('model output normalization', () => {
  const req = [
    { itemNumber: '1', descriptions: ['A'] },
    { itemNumber: '2', descriptions: ['B'] },
    { itemNumber: '3', descriptions: ['C'] },
  ]

  it('turns invented categories and mismatched subcategories into abstentions', () => {
    const out = normalizeModelOutput(
      {
        response: {
          suggestions: [
            { itemNumber: '1', categoryId: 'gadgets', subcategoryId: null, confidence: 0.99, reason: 'made up' },
            { itemNumber: '2', categoryId: 'electronics', subcategoryId: 'produce', confidence: 0.9, reason: 'wrong sub' },
            { itemNumber: '3', categoryId: 'grocery', subcategoryId: 'snacks', confidence: 0.8, reason: 'chips' },
          ],
        },
      },
      req,
    )
    expect(out[0]).toMatchObject({ itemNumber: '1', categoryId: null, subcategoryId: null, confidence: 0 })
    expect(out[1]).toMatchObject({ itemNumber: '2', categoryId: null, subcategoryId: null, confidence: 0 })
    expect(out[2]).toEqual({ itemNumber: '3', categoryId: 'grocery', subcategoryId: 'snacks', confidence: 0.8, reason: 'chips' })
  })

  it('never lets the model choose Uncategorized or Other as a category', () => {
    const out = normalizeModelOutput(
      [
        { itemNumber: '1', categoryId: 'other', subcategoryId: null, confidence: 0.9, reason: 'x' },
        { itemNumber: '2', categoryId: 'uncategorized', subcategoryId: null, confidence: 0.9, reason: 'x' },
      ],
      req.slice(0, 2),
    )
    expect(out.map((s) => s.categoryId)).toEqual([null, null])
  })

  it('handles garbage, string JSON, extra and missing items, and odd confidence values', () => {
    for (const garbage of [null, 'not json', 42, { response: 'nope' }, { response: { suggestions: 'x' } }, [1, 'a', null]]) {
      const out = normalizeModelOutput(garbage, req)
      expect(out.map((s) => s.categoryId)).toEqual([null, null, null])
      expect(out.map((s) => s.itemNumber)).toEqual(['1', '2', '3'])
    }
    const out = normalizeModelOutput(
      {
        response: JSON.stringify({
          suggestions: [
            { itemNumber: '99', categoryId: 'pet', subcategoryId: null, confidence: 1, reason: 'not requested' },
            { itemNumber: 2, categoryId: 'Electronics', subcategoryId: 'none', confidence: 85, reason: 'percent' },
            { itemNumber: '2', categoryId: 'pet', subcategoryId: null, confidence: 1, reason: 'duplicate ignored' },
            { itemNumber: '3', categoryId: 'home', subcategoryId: null, confidence: -4, reason: 'x\n'.repeat(300) },
          ],
        }),
      },
      req,
    )
    expect(out).toHaveLength(3)
    expect(out[0]).toMatchObject({ itemNumber: '1', categoryId: null, reason: 'No answer from the model for this item.' })
    expect(out[1]).toMatchObject({ itemNumber: '2', categoryId: 'electronics', subcategoryId: null, confidence: 0.85 })
    expect(out[2]!.confidence).toBe(0)
    expect(out[2]!.reason.length).toBeLessThanOrEqual(SUGGEST_LIMITS.maxReasonLength)
    expect(out[2]!.reason).not.toContain('\n')
  })
})

describe('prompt', () => {
  it('lists the allowed taxonomy, favors abstention and forbids lookups', () => {
    const input = buildModelInput([{ itemNumber: '1', descriptions: ['PHILIPS'] }])
    const system = (input.messages as { role: string; content: string }[])[0]!.content
    expect(system).toContain('A wrong category is worse than no category')
    expect(system).toContain('Abstaining is always acceptable')
    expect(system).toContain('Do not look anything up')
    for (const id of ['grocery', 'electronics', 'home', 'alcohol', 'meat-seafood']) expect(system).toContain(id)
    expect(system).not.toMatch(/- other —|- uncategorized —/)
    expect(input).not.toHaveProperty('tools')
  })
})
