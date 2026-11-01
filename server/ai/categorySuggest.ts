/**
 * AI category suggestions for Uncategorized items (owner-only endpoint).
 *
 * The model sees ONLY item numbers and Costco description variants (see
 * src/analytics/categories/suggestProtocol.ts). It may answer only with the
 * app's taxonomy; anything else is normalized to "abstain". Nothing is
 * stored: the dashboard shows the suggestions for review, and an accepted
 * suggestion becomes an ordinary category override in the owner's browser.
 */
import { CATEGORIES, categoryLabel, type CategoryId } from '../../src/analytics/categories/taxonomy'
import {
  SUGGESTABLE_CATEGORIES,
  SUGGEST_LIMITS,
  cleanDescription,
  isSuggestableAssignment,
  type CategorySuggestion,
  type SuggestRequestItem,
  type SuggestResponse,
} from '../../src/analytics/categories/suggestProtocol'
import { ApiError } from '../http'
import { CATEGORY_SUGGESTION_MODEL, CATEGORY_SUGGESTION_MODEL_OPTIONS, CATEGORY_SUGGESTION_RATE_LIMIT } from './config'

/** The part of a Workers AI binding this feature uses (keeps server/ portable and testable). */
export type AiBinding = { run(model: string, input: Record<string, unknown>): Promise<unknown> }

const DEFINITIONS: Partial<Record<CategoryId, string>> = {
  grocery: 'food and non-alcoholic drinks',
  household: 'batteries, trash and storage bags, foil, light bulbs, air/water filters, disposable tableware',
  cleaning: 'detergents, dish and surface cleaners, cleaning tools',
  'paper-goods': 'toilet paper, paper towels, tissues, napkins',
  'personal-care': 'shampoo, soap, oral care, razors, cosmetics, diapers, wipes',
  health: 'vitamins, supplements, protein/collagen powders, over-the-counter medicine, first aid',
  clothing: 'apparel, footwear, accessories worn on the body',
  electronics: 'devices, computers, phones, TVs, audio, chargers and power banks, portable power stations, UPS battery backups, drones, cameras, cables',
  home: 'furniture, bedding, kitchenware, small and large appliances, air purifiers, vacuums, bathroom and plumbing fixtures (e.g. bidet seats, faucets), shelving, tools',
  seasonal: 'holiday decor, patio, pool and outdoor fire pits',
  automotive: 'vehicle parts, fluids, tires, car accessories',
  pet: 'pet food, litter, pet supplies',
  alcohol: 'wine (including wines named only by grape or region, e.g. Kirkland Signature "KS" wines), beer, spirits, hard seltzer',
}

/** Allowed taxonomy, rendered for the prompt. */
export function taxonomyForPrompt(): string {
  return CATEGORIES.filter((c) => SUGGESTABLE_CATEGORIES.includes(c.id))
    .map((c) => {
      const subs = (c.subcategories as readonly { id: string; label: string }[]).map((s) => `${s.id} (${s.label})`)
      return `- ${c.id} — ${categoryLabel(c.id)}: ${DEFINITIONS[c.id] ?? ''}${subs.length ? `. Subcategories: ${subs.join(', ')}` : '. No subcategories (use null)'}`
    })
    .join('\n')
}

export const SYSTEM_PROMPT = `You classify Costco products into a fixed category list for a personal spending dashboard.

You receive item numbers and the product descriptions printed on Costco receipts or the website. Descriptions are often abbreviated or truncated: "KS" means Kirkland Signature (Costco's own brand), "ORG" means organic, and brand names are frequently squashed together with the product (e.g. a brand followed directly by a model word).

Allowed categories (use the id exactly):
${'{TAXONOMY}'}

Rules:
1. A wrong category is worse than no category. If you cannot identify what the product is with real confidence, return categoryId null. Abstaining is always acceptable and is often the right answer.
2. Infer common Costco abbreviations and well-known brands when the product type is clear (for example a brand that only makes electronics, or "KS" followed by a wine name).
3. Abstain (null) for a bare brand that sells products in several categories, a model code, a color or style name, or any description you are unsure about.
4. Use only the category ids listed. Never invent a category. Do not use any other category to mean "unknown".
5. subcategoryId: only for grocery, and only when clearly one of its listed subcategories; otherwise null. It must belong to the chosen category.
6. confidence: a number from 0 to 1 — your probability that the category is correct.
7. reason: at most 12 words, based only on the description.
8. Return exactly one entry per input item, with the same itemNumber. Do not add items.
9. Use only the information given. Do not look anything up.
10. Some items include "identifiedAs": the product a public web search found for that exact Costco item number. Prefer it over the abbreviated description when choosing the category; still abstain if the category is unclear.`

/** The exact model input for a batch. Pure — tested to contain only item numbers and descriptions. */
/** Public product identity found by web search for an item number (see server/products). */
export type IdentityHint = { normalizedName: string | null; brand: string | null; productType: string | null }

export function buildModelInput(items: readonly SuggestRequestItem[], identities: ReadonlyMap<string, IdentityHint> = new Map()): Record<string, unknown> {
  const payload = items.map((i) => {
    const id = identities.get(i.itemNumber)
    const identifiedAs = id ? Object.fromEntries(Object.entries({ name: id.normalizedName, brand: id.brand, productType: id.productType }).filter(([, v]) => v)) : null
    return {
      itemNumber: i.itemNumber,
      descriptions: i.descriptions.map(cleanDescription),
      ...(identifiedAs && Object.keys(identifiedAs).length ? { identifiedAs } : {}),
    }
  })
  return {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT.replace('{TAXONOMY}', taxonomyForPrompt()) },
      {
        role: 'user',
        content: `Classify these ${payload.length} items. Return JSON {"suggestions":[...]} with one entry per item.\n${JSON.stringify(payload)}`,
      },
    ],
    response_format: { type: 'json_schema', json_schema: RESPONSE_JSON_SCHEMA },
    ...CATEGORY_SUGGESTION_MODEL_OPTIONS,
  }
}

const SUBCATEGORY_IDS = CATEGORIES.flatMap((c) => (c.subcategories as readonly { id: string }[]).map((s) => s.id))

export const RESPONSE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          itemNumber: { type: 'string' },
          categoryId: { type: ['string', 'null'], enum: [...SUGGESTABLE_CATEGORIES, null] },
          subcategoryId: { type: ['string', 'null'], enum: [...SUBCATEGORY_IDS, null] },
          confidence: { type: 'number' },
          reason: { type: 'string' },
        },
        required: ['itemNumber', 'categoryId', 'subcategoryId', 'confidence', 'reason'],
      },
    },
  },
  required: ['suggestions'],
} as const

const ABSTAIN_WORDS = new Set(['', 'null', 'none', 'unknown', 'uncategorized', 'n/a'])

function normalizeConfidence(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return 0
  if (n <= 1) return n
  if (n <= 100) return n / 100 // a percentage
  return 0
}

function normalizeReason(value: unknown): string {
  if (typeof value !== 'string') return ''
  return cleanDescription(value).slice(0, SUGGEST_LIMITS.maxReasonLength)
}

const abstain = (itemNumber: string, reason: string): CategorySuggestion => ({ itemNumber, categoryId: null, subcategoryId: null, confidence: 0, reason })

/**
 * Turns whatever the model returned into exactly one validated suggestion per
 * requested item. Unknown items are dropped; missing items, unknown
 * categories and subcategories that do not belong to the category become
 * abstentions. Never trusts the model's output shape.
 */
export function normalizeModelOutput(raw: unknown, requested: readonly SuggestRequestItem[]): CategorySuggestion[] {
  let value: unknown = raw
  if (value && typeof value === 'object' && 'response' in value) value = (value as { response: unknown }).response
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      value = null
    }
  }
  const list = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { suggestions?: unknown }).suggestions)
      ? (value as { suggestions: unknown[] }).suggestions
      : []

  const byItem = new Map<string, CategorySuggestion>()
  const wanted = new Set(requested.map((r) => r.itemNumber))
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const itemNumber = typeof e.itemNumber === 'string' ? e.itemNumber : typeof e.itemNumber === 'number' ? String(e.itemNumber) : null
    if (itemNumber === null || !wanted.has(itemNumber) || byItem.has(itemNumber)) continue
    const rawCategory = typeof e.categoryId === 'string' ? e.categoryId.trim().toLowerCase() : null
    const rawSub = typeof e.subcategoryId === 'string' && !ABSTAIN_WORDS.has(e.subcategoryId.trim().toLowerCase()) ? e.subcategoryId.trim().toLowerCase() : null
    const reason = normalizeReason(e.reason)
    if (rawCategory === null || ABSTAIN_WORDS.has(rawCategory)) {
      byItem.set(itemNumber, abstain(itemNumber, reason || 'The model did not identify this product.'))
      continue
    }
    if (!isSuggestableAssignment(rawCategory, rawSub)) {
      byItem.set(itemNumber, abstain(itemNumber, 'The model answered outside the allowed categories, so it was ignored.'))
      continue
    }
    byItem.set(itemNumber, {
      itemNumber,
      categoryId: rawCategory as CategoryId,
      subcategoryId: rawSub,
      confidence: normalizeConfidence(e.confidence),
      reason,
    })
  }
  return requested.map((r) => byItem.get(r.itemNumber) ?? abstain(r.itemNumber, 'No answer from the model for this item.'))
}

function usageOf(raw: unknown): SuggestResponse['usage'] {
  const u = raw && typeof raw === 'object' ? (raw as { usage?: unknown }).usage : undefined
  if (!u || typeof u !== 'object') return undefined
  const pick = (k: string) => {
    const v = (u as Record<string, unknown>)[k]
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined
  }
  const usage = { promptTokens: pick('prompt_tokens'), completionTokens: pick('completion_tokens'), totalTokens: pick('total_tokens') }
  const defined = Object.fromEntries(Object.entries(usage).filter(([, v]) => v !== undefined))
  return Object.keys(defined).length ? defined : undefined
}

export async function suggestCategories(
  ai: AiBinding | undefined,
  items: readonly SuggestRequestItem[],
  identities: ReadonlyMap<string, IdentityHint> = new Map(),
): Promise<SuggestResponse> {
  if (!ai || typeof ai.run !== 'function') {
    throw new ApiError(
      503,
      'ai_not_configured',
      'AI suggestions are not set up on this cloud: the Pages project has no Workers AI binding named "AI". Add it under Settings → Bindings, then redeploy. Everything else works without it.',
    )
  }
  let raw: unknown
  try {
    raw = await ai.run(CATEGORY_SUGGESTION_MODEL, buildModelInput(items, identities))
  } catch (error) {
    // Never log the payload; the error class is enough.
    console.error('ai_error', error instanceof Error ? error.name : 'unknown')
    throw new ApiError(502, 'ai_failed', 'The AI model could not classify these items. Nothing was changed; you can try again.')
  }
  const usage = usageOf(raw)
  return { model: CATEGORY_SUGGESTION_MODEL, suggestions: normalizeModelOutput(raw, items), ...(usage ? { usage } : {}) }
}

/** Best-effort sliding-window limiter (per isolate; no storage). */
export function createRateLimiter(limit: { maxRequests: number; windowMs: number } = CATEGORY_SUGGESTION_RATE_LIMIT) {
  const hits: number[] = []
  return {
    check(now: Date): void {
      const t = now.getTime()
      while (hits.length && hits[0]! <= t - limit.windowMs) hits.shift()
      if (hits.length >= limit.maxRequests) {
        throw new ApiError(429, 'rate_limited', 'Too many AI suggestion requests. Wait a few minutes and try again.')
      }
      hits.push(t)
    },
  }
}

/** Shared by every request this isolate serves. */
export const defaultSuggestionLimiter = createRateLimiter()
