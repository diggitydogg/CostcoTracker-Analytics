// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { CATEGORY_SUGGESTION_MODEL, PRODUCT_NORMALIZATION_MODEL } from '../../server/ai/config'
import { normalizeStrongCandidates, toResolvedIdentity } from '../../server/products/identify'
import type { FetchFn } from '../../server/products/search'
import { workersAiRest } from './workersAiRest'

const strong = [
  {
    itemNumber: '41407',
    receiptDescription: 'TORT PASTA',
    candidate: {
      result: { title: 'Kirkland Signature Tortellini Pasta Salad | Costco', url: 'https://www.costco.com/x.html', snippet: 'Item 41407 with mozzarella pearls', imageUrl: null },
      confidence: 0.9,
      evidence: 'costco.com' as const,
      sources: 1,
      corroboratingUrl: null,
    },
  },
]

describe('Workers AI REST adapter (validator only)', () => {
  it('forwards the identical production model and input, and returns the binding-shaped result', async () => {
    const fetchImpl = vi.fn<FetchFn>(async () =>
      Response.json({
        success: true,
        errors: [],
        result: {
          response: {
            items: [
              {
                itemNumber: '41407',
                normalizedName: 'Kirkland Signature Tortellini Pasta Salad with Mozzarella Pearls',
                brand: 'Kirkland Signature',
                productType: 'pasta salad',
              },
            ],
          },
          usage: { total_tokens: 500 },
        },
      }),
    )
    const ai = workersAiRest('acct123', 'TOKEN', fetchImpl)
    // The exact production step, through the adapter.
    const normalized = await normalizeStrongCandidates(ai, strong)
    const record = toResolvedIdentity(strong[0]!, normalized.get('41407'), '2026-11-02T00:00:00.000Z')
    expect(record).toMatchObject({
      canonicalName: 'Kirkland Signature Tortellini Pasta Salad with Mozzarella Pearls',
      brand: 'Kirkland Signature',
      productType: 'pasta salad',
      method: 'web-search+ai',
      confidence: 0.9, // never changed by AI
    })
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/acct123/ai/run/${PRODUCT_NORMALIZATION_MODEL}`)
    expect(PRODUCT_NORMALIZATION_MODEL).toBe(CATEGORY_SUGGESTION_MODEL) // no validator-specific model
    expect((init!.headers as Record<string, string>).authorization).toBe('Bearer TOKEN')
    const sent = JSON.parse(String(init!.body)) as { messages: { content: string }[]; response_format: { type: string } }
    expect(sent.response_format.type).toBe('json_schema')
    expect(sent.messages[0]!.content).toContain('You normalize product identities')
    // Only public search text and the item number / receipt description reach the model.
    const user = sent.messages[1]!.content
    expect(JSON.parse(user.slice(user.indexOf('\n') + 1))).toEqual([
      { itemNumber: '41407', receiptDescription: 'TORT PASTA', resultTitle: 'Kirkland Signature Tortellini Pasta Salad | Costco', resultSnippet: 'Item 41407 with mozzarella pearls' },
    ])
  })

  it('falls back to the cleaned search title exactly like production when the API fails', async () => {
    const fetchImpl = vi.fn<FetchFn>(async () => Response.json({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, { status: 403 }))
    const ai = workersAiRest('acct123', 'BAD', fetchImpl)
    await expect(ai.run(PRODUCT_NORMALIZATION_MODEL, {})).rejects.toThrow('workers_ai_http_403: 10000 Authentication error')
    const normalized = await normalizeStrongCandidates(ai, strong)
    expect(normalized.size).toBe(0)
    expect(toResolvedIdentity(strong[0]!, undefined, 'x')).toMatchObject({ canonicalName: 'Kirkland Signature Tortellini Pasta Salad', method: 'web-search' })
  })
})
