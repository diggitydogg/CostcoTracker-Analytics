/**
 * AI category suggestions — the shared, pure protocol between the dashboard
 * and the owner-only server endpoint (`POST /api/categories/suggest`).
 *
 * Privacy boundary: a suggestion request carries ONLY an item number and up
 * to a few of its Costco description variants. `buildSuggestionItems` is the
 * single place the dashboard builds a request; it copies just those two
 * fields, so purchase dates, prices, spend, quantities, warehouses, receipt
 * or order IDs, returns/adjustments and any auth/device data can never be
 * included. The server schema is strict and rejects any other field.
 *
 * Suggestions are only proposals. They never change analytics until the
 * owner accepts one, which then goes through the normal category override.
 */
import { z } from 'zod'
import { CATEGORIES, isValidAssignment, type CategoryId } from './taxonomy'

export const SUGGEST_LIMITS = {
  /** Items per request (and per server call to the model). */
  maxItemsPerRequest: 25,
  /** Description variants sent per item (most recent first). */
  maxDescriptionsPerItem: 3,
  /** Characters per description; longer (online) titles are truncated client-side. */
  maxDescriptionLength: 120,
  /** Request body bytes (well above 25 × 3 × 120 characters of JSON). */
  maxRequestBytes: 24 * 1024,
  /** Characters kept from a model's reason. */
  maxReasonLength: 200,
} as const

/** Item numbers that may be sent: letters, digits and . _ - (Costco item numbers are digits). */
export const ITEM_NUMBER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/

/**
 * Categories the model may choose. "uncategorized" is expressed as a null
 * category (abstain), and the catch-all "other" is excluded so the model
 * cannot turn uncertainty into a category.
 */
export const SUGGESTABLE_CATEGORIES: readonly CategoryId[] = CATEGORIES.map((c) => c.id).filter((id) => id !== 'uncategorized' && id !== 'other')

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g

/** Collapses whitespace and removes control characters. */
export function cleanDescription(text: string): string {
  return text.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
}

export const suggestRequestItemSchema = z
  .object({
    itemNumber: z.string().regex(ITEM_NUMBER_PATTERN, { error: 'itemNumber has an unsupported format.' }),
    descriptions: z
      .array(
        z
          .string()
          .min(1, { error: 'Descriptions must not be empty.' })
          .max(SUGGEST_LIMITS.maxDescriptionLength, { error: `Descriptions are at most ${SUGGEST_LIMITS.maxDescriptionLength} characters.` })
          .refine((d) => cleanDescription(d) === d, { error: 'Descriptions must be single-line, trimmed text.' }),
      )
      .min(1, { error: 'At least one description is required.' })
      .max(SUGGEST_LIMITS.maxDescriptionsPerItem, { error: `At most ${SUGGEST_LIMITS.maxDescriptionsPerItem} descriptions per item.` }),
  })
  .strict()

export const suggestRequestSchema = z
  .object({
    items: z
      .array(suggestRequestItemSchema)
      .min(1, { error: 'At least one item is required.' })
      .max(SUGGEST_LIMITS.maxItemsPerRequest, { error: `At most ${SUGGEST_LIMITS.maxItemsPerRequest} items per request.` })
      .refine((items) => new Set(items.map((i) => i.itemNumber)).size === items.length, { error: 'Item numbers must be unique.' }),
  })
  .strict()

export type SuggestRequestItem = z.infer<typeof suggestRequestItemSchema>
export type SuggestRequest = z.infer<typeof suggestRequestSchema>

export type CategorySuggestion = {
  itemNumber: string
  /** null = the model abstained (leave Uncategorized). */
  categoryId: CategoryId | null
  subcategoryId: string | null
  /** 0–1. */
  confidence: number
  reason: string
}

export type SuggestResponse = {
  model: string
  suggestions: CategorySuggestion[]
  /** Token usage when the provider reports it; diagnostics only. */
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number }
}

/**
 * Builds suggestion request items from anything carrying an item number and
 * description variants. ONLY `itemNumber` and cleaned, truncated
 * `descriptions` are copied — every other property of the input is ignored.
 * Items whose number cannot be sent, or that have no description, are skipped.
 */
export function buildSuggestionItems(items: readonly { itemNumber: string; descriptions: readonly string[] }[]): SuggestRequestItem[] {
  const out: SuggestRequestItem[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const itemNumber = String(item.itemNumber)
    if (!ITEM_NUMBER_PATTERN.test(itemNumber) || seen.has(itemNumber)) continue
    const descriptions: string[] = []
    for (const raw of item.descriptions) {
      const d = cleanDescription(String(raw)).slice(0, SUGGEST_LIMITS.maxDescriptionLength).trim()
      if (d && !descriptions.includes(d)) descriptions.push(d)
      if (descriptions.length === SUGGEST_LIMITS.maxDescriptionsPerItem) break
    }
    if (descriptions.length === 0) continue
    seen.add(itemNumber)
    out.push({ itemNumber, descriptions })
  }
  return out
}

/** Splits request items into batches of at most `size`. */
export function batches<T>(items: readonly T[], size: number = SUGGEST_LIMITS.maxItemsPerRequest): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** True when a (category, subcategory) pair is a suggestion the dashboard may offer. */
export function isSuggestableAssignment(categoryId: string, subcategoryId: string | null): boolean {
  return SUGGESTABLE_CATEGORIES.includes(categoryId as CategoryId) && isValidAssignment(categoryId, subcategoryId)
}

const suggestionSchema = z.object({
  itemNumber: z.string(),
  categoryId: z.string().nullable(),
  subcategoryId: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(SUGGEST_LIMITS.maxReasonLength),
})

/** Client-side check of the server response (never trust a response shape blindly). */
export const suggestResponseSchema = z.object({
  model: z.string(),
  suggestions: z.array(suggestionSchema).max(SUGGEST_LIMITS.maxItemsPerRequest),
  usage: z
    .object({ promptTokens: z.number().optional(), completionTokens: z.number().optional(), totalTokens: z.number().optional() })
    .optional(),
})
