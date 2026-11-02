/**
 * Product identification — the shared, pure protocol for
 * `POST /api/products/identify` and `GET /api/products/identities`.
 *
 * Division of labour:
 * - web search (Brave, including a `site:` query for Warehouse Runner's
 *   Costco product pages) is a TRANSIENT discovery step: it answers "what
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
import { cleanDescription, ITEM_NUMBER_PATTERN, SUGGEST_LIMITS, suggestRequestItemSchema, type SuggestRequestItem } from '../categories/suggestProtocol'

export const IDENTIFY_LIMITS = {
  /** Items per request (each may cost up to MAX_QUERIES_PER_ITEM = 3 search queries). */
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

/**
 * Why we accepted a resolution (our own classification; no search content):
 * web evidence (`costco.com`, `costco-specialist`, `corroborated`), or the
 * owner's own explicit confirmation (`owner-confirmed`).
 */
export type ResolutionBasis = 'costco.com' | 'costco-specialist' | 'corroborated' | 'owner-confirmed'

export const RESOLUTION_BASES: readonly ResolutionBasis[] = ['costco.com', 'costco-specialist', 'corroborated', 'owner-confirmed']

/**
 * Owner-confirmed records: confidence 1 means "the owner asserted this", not
 * search certainty. The basis says so, and the UI shows "Owner confirmed"
 * instead of a percentage. Only these records can be edited or removed.
 */
export const OWNER_CONFIRMED_CONFIDENCE = 1
export const OWNER_CONFIRMED_METHOD = 'owner'

export const isOwnerConfirmed = (identity: Pick<ProductIdentity, 'basis'> | null | undefined): boolean => identity?.basis === 'owner-confirmed'

export const OWNER_IDENTITY_LIMITS = { maxNameLength: 120, maxBrandLength: 60, maxTypeLength: 60, maxRequestBytes: 2 * 1024 } as const

/** Owner-typed text: single-line, trimmed, bounded, and not a link (we never keep third-party URLs). */
const ownerText = (max: number, label: string) =>
  z
    .string()
    .min(1, { error: `${label} must not be empty.` })
    .max(max, { error: `${label} is at most ${max} characters.` })
    .refine((t) => cleanDescription(t) === t, { error: `${label} must be single-line, trimmed text.` })
    .refine((t) => !/:\/\/|^www\.|\bwww\.[a-z0-9-]+\./i.test(t), { error: `${label} must not be a web address.` })

const ownerFields = {
  canonicalName: ownerText(OWNER_IDENTITY_LIMITS.maxNameLength, 'Product name'),
  brand: ownerText(OWNER_IDENTITY_LIMITS.maxBrandLength, 'Brand').nullable(),
  productType: ownerText(OWNER_IDENTITY_LIMITS.maxTypeLength, 'Product type').nullable(),
}

/** POST /api/products/confirm: the owner's explicit identity for one item number. Strict: nothing else is accepted. */
export const confirmIdentityRequestSchema = z
  .object({
    itemNumber: z.string().regex(ITEM_NUMBER_PATTERN, { error: 'itemNumber has an unsupported format.' }),
    receiptDescription: z
      .string()
      .min(1)
      .max(SUGGEST_LIMITS.maxDescriptionLength)
      .refine((d) => cleanDescription(d) === d, { error: 'receiptDescription must be single-line, trimmed text.' }),
    ...ownerFields,
  })
  .strict()

/** PATCH /api/products/identity/:itemNumber: new values for an owner-confirmed record. */
export const updateIdentityRequestSchema = z.object(ownerFields).strict()

export type ConfirmIdentityRequest = z.infer<typeof confirmIdentityRequestSchema>
export type UpdateIdentityRequest = z.infer<typeof updateIdentityRequestSchema>

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
  /** 'web-search', 'web-search+ai', or 'owner' (owner-confirmed). */
  method: string
  resolvedAt: string
}

/** A lookup that did not produce a trusted identity. Nothing about the candidate is stored. */
export type UnresolvedResult = {
  itemNumber: string
  status: 'unresolved'
  /** 'provisional' = only one ordinary source (or disagreeing sources); 'not_found' = nothing named the item number. */
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
  basis: z.enum(['costco.com', 'costco-specialist', 'corroborated', 'owner-confirmed']),
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

export const identityResponseSchema = z.object({ identity: productIdentitySchema })

/** itemNumber → identity, as passed to the analytics engine. */
export type ProductIdentities = Readonly<Record<string, ProductIdentity>>

/**
 * Whether a local identity may feed the deterministic rules and the AI
 * prompt: resolved from Costco's own page, a Costco-specialist product page for
 * that item number, 2+ agreeing independent sources, or the owner's own
 * confirmation.
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
    case 'owner-confirmed':
      return 'your own confirmation'
  }
}

/** A short label for compact rows. */
export function resolutionBasisShortLabel(basis: ResolutionBasis): string {
  switch (basis) {
    case 'costco.com':
      return 'Costco.com'
    case 'costco-specialist':
      return 'Costco-specialist page'
    case 'corroborated':
      return 'two independent sources'
    case 'owner-confirmed':
      return 'Owner confirmed'
  }
}
