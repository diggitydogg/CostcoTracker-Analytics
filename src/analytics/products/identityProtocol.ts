/**
 * Product identification — the shared, pure protocol for
 * `POST /api/products/identify` and `GET /api/products/identities`.
 *
 * Division of labour:
 * - web search answers "what actual product is Costco item #N?" (by item
 *   number + receipt description, once per item number, cached in D1);
 * - deterministic rules then categorize the identified product name;
 * - AI only normalizes search results and suggests categories for what the
 *   rules still cannot place (owner review unchanged).
 *
 * Privacy: a request carries only item numbers and receipt descriptions (the
 * same strict item shape as AI suggestions). The search query is built from
 * those two values only. Nothing about purchases is sent.
 */
import { z } from 'zod'
import { suggestRequestItemSchema, type SuggestRequestItem } from '../categories/suggestProtocol'

export const IDENTIFY_LIMITS = {
  /** Items per request (each may cost up to two search queries). */
  maxItemsPerRequest: 10,
  maxRequestBytes: 12 * 1024,
  /** Identities shown to the rules and the AI must be at least this confident. */
  minConfidenceForUse: 0.6,
} as const

export const identifyRequestSchema = z
  .object({
    items: z
      .array(suggestRequestItemSchema)
      .min(1, { error: 'At least one item is required.' })
      .max(IDENTIFY_LIMITS.maxItemsPerRequest, { error: `At most ${IDENTIFY_LIMITS.maxItemsPerRequest} items per request.` })
      .refine((items) => new Set(items.map((i) => i.itemNumber)).size === items.length, { error: 'Item numbers must be unique.' }),
  })
  .strict()

export type IdentifyRequestItem = SuggestRequestItem

/** A cached product identity, as the dashboard sees it. */
export type ProductIdentity = {
  itemNumber: string
  status: 'identified' | 'not_found'
  receiptDescription: string
  normalizedName: string | null
  brand: string | null
  productType: string | null
  sourceUrl: string | null
  imageUrl: string | null
  confidence: number
  method: string
  lookedUpAt: string
}

export type IdentifyResult = ProductIdentity & {
  /** True when served from the cache (no search was made). */
  cached: boolean
}

export type IdentifyResponse = {
  /** False when no search provider is configured: unknown items are reported as `unavailable`. */
  searchConfigured: boolean
  results: (IdentifyResult | { itemNumber: string; status: 'unavailable'; reason: string })[]
}

const text = z.string().max(300).nullable()
export const productIdentitySchema = z.object({
  itemNumber: z.string(),
  status: z.enum(['identified', 'not_found']),
  receiptDescription: z.string(),
  normalizedName: text,
  brand: text,
  productType: text,
  sourceUrl: z.string().max(2048).nullable(),
  imageUrl: z.string().max(2048).nullable(),
  confidence: z.number().min(0).max(1),
  method: z.string(),
  lookedUpAt: z.string(),
})

export const identifyResponseSchema = z.object({
  searchConfigured: z.boolean(),
  results: z
    .array(
      z.union([
        productIdentitySchema.extend({ cached: z.boolean() }),
        z.object({ itemNumber: z.string(), status: z.literal('unavailable'), reason: z.string() }),
      ]),
    )
    .max(IDENTIFY_LIMITS.maxItemsPerRequest),
})

export const identitiesResponseSchema = z.object({ identities: z.array(productIdentitySchema) })

/** itemNumber → identity, as passed to the analytics engine. */
export type ProductIdentities = Readonly<Record<string, ProductIdentity>>

/**
 * The texts the deterministic category rules may also match for an item:
 * the identified product name and product type, only for confident
 * identities. Receipt descriptions are always tried first.
 */
export function identityTexts(identity: ProductIdentity | undefined): string[] {
  if (!identity || identity.status !== 'identified' || identity.confidence < IDENTIFY_LIMITS.minConfidenceForUse) return []
  return [identity.normalizedName, identity.productType].filter((t): t is string => typeof t === 'string' && t.trim() !== '')
}
