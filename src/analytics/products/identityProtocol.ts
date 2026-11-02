/**
 * Product identification — the shared, pure protocol for
 * `POST /api/products/identify` and `GET /api/products/identities`.
 *
 * Division of labour:
 * - web search (Brave) is a TRANSIENT discovery step: it answers "what
 *   product is Costco item #N?" once, inside one request;
 * - the outcome is saved as OUR OWN local catalog record (item number →
 *   canonical name, brand, type, confidence, basis). No search-result content
 *   is stored, and a resolved item number is never searched again;
 * - deterministic rules then categorize the canonical product name;
 * - AI only normalizes the name during resolution and suggests categories
 *   for what the rules still cannot place (owner review unchanged).
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

/** Why we accepted a resolution (our own classification of the evidence; no search content). */
export type ResolutionBasis = 'costco.com' | 'costco-specialist' | 'corroborated'

export const RESOLUTION_BASES: readonly ResolutionBasis[] = ['costco.com', 'costco-specialist', 'corroborated']

/**
 * Our own resolved product record for a Costco item number (local catalog).
 * It holds no search-result content: no titles, snippets, URLs or images.
 */
export type ProductIdentity = {
  itemNumber: string
  status: 'resolved'
  /** The receipt description we looked up (our own data). */
  receiptDescription: string
  canonicalName: string
  brand: string | null
  productType: string | null
  /** Our confidence, from the evidence class only (never raised by AI). */
  confidence: number
  basis: ResolutionBasis
  /** 'web-search' or 'web-search+ai'. */
  method: string
  resolvedAt: string
}

/** A lookup that did not produce a trusted identity. Nothing about the candidate is stored. */
export type UnresolvedResult = {
  itemNumber: string
  status: 'unresolved'
  /** 'provisional' = only one non-Costco source (or disagreeing sources); 'not_found' = nothing named the item number. */
  outcome: 'provisional' | 'not_found'
  /**
   * For a fresh provisional lookup only: the candidate product name, shown to
   * the owner for this session. Transient — never written to D1, and null when
   * the result comes from the cache.
   */
  candidateName: string | null
  retryAfter: string
  cached: boolean
}

export type IdentifyResult = (ProductIdentity & { cached: boolean }) | UnresolvedResult

export type IdentifyResponse = {
  /** False when no search provider is configured: unknown items are reported as `unavailable`. */
  searchConfigured: boolean
  results: (IdentifyResult | { itemNumber: string; status: 'unavailable'; reason: string })[]
}

const text = z.string().max(300).nullable()
export const productIdentitySchema = z.object({
  itemNumber: z.string(),
  status: z.literal('resolved'),
  receiptDescription: z.string(),
  canonicalName: z.string().max(300),
  brand: text,
  productType: text,
  confidence: z.number().min(0).max(1),
  basis: z.enum(['costco.com', 'costco-specialist', 'corroborated']),
  method: z.string(),
  resolvedAt: z.string(),
})

const unresolvedSchema = z.object({
  itemNumber: z.string(),
  status: z.literal('unresolved'),
  outcome: z.enum(['provisional', 'not_found']),
  candidateName: text,
  retryAfter: z.string(),
  cached: z.boolean(),
})

export const identifyResponseSchema = z.object({
  searchConfigured: z.boolean(),
  results: z
    .array(
      z.union([
        productIdentitySchema.extend({ cached: z.boolean() }),
        unresolvedSchema,
        z.object({ itemNumber: z.string(), status: z.literal('unavailable'), reason: z.string() }),
      ]),
    )
    .max(IDENTIFY_LIMITS.maxItemsPerRequest),
})

export const identitiesResponseSchema = z.object({ identities: z.array(productIdentitySchema) })

/** itemNumber → identity, as passed to the analytics engine. */
export type ProductIdentities = Readonly<Record<string, ProductIdentity>>

/**
 * Whether a local identity may feed the deterministic rules and the AI
 * prompt: resolved from Costco's own page, a Costco-specialist product page for
 * that item number, or 2+ agreeing independent sources.
 * (Provisional evidence never becomes a local identity in the first place.)
 */
export function isUsableIdentity(identity: ProductIdentity | undefined): identity is ProductIdentity {
  return (
    !!identity &&
    identity.status === 'resolved' &&
    RESOLUTION_BASES.includes(identity.basis) &&
    identity.confidence >= IDENTIFY_LIMITS.minConfidenceForUse
  )
}

/**
 * The texts the deterministic category rules may also match for an item:
 * the identified product name and product type, only for usable
 * identities. Receipt descriptions are always tried first.
 */
export function identityTexts(identity: ProductIdentity | undefined): string[] {
  if (!isUsableIdentity(identity)) return []
  return [identity.canonicalName, identity.productType].filter((t): t is string => typeof t === 'string' && t.trim() !== '')
}

/** How a resolution basis is described to the owner. */
export function resolutionBasisLabel(basis: ResolutionBasis): string {
  switch (basis) {
    case 'costco.com':
      return "Costco's own page for this item number"
    case 'costco-specialist':
      return "a Costco-specialist product page (Warehouse Runner) for this item number"
    case 'corroborated':
      return 'two independent sources that agree on this item number'
  }
}
