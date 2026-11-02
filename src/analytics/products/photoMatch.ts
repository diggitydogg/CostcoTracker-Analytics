/**
 * Photo-to-product matching: the shared protocol and the deterministic
 * matching/ranking logic (pure, tested; no AI decides a match).
 *
 * Pipeline (see docs/PHOTO_MATCHING.md), deterministic evidence first — the
 * same idea as the iOS app's Apple Vision OCR/barcode reading:
 * 1a. On-device evidence — barcodes and text (OCR) read IN THE BROWSER:
 *     Costco item numbers on shelf tags, model numbers, packaging text. The
 *     photo does not leave the device for this.
 * 2.  Local match — in the browser, against the owner's own items (receipt
 *     descriptions) and catalog identities (owner-confirmed strongest).
 *     Purchase data never leaves the browser for matching.
 * 1b. Only if that cannot identify the item, and only when the owner asks:
 *     the photo goes to Workers AI in the owner's own Cloudflare account,
 *     which describes what is visible (brand, name, variant, size…). Only the
 *     photo and a fixed instruction are sent; never purchase data. Then 2 again.
 * 3.  External identification, only if still no strong local match: generic
 *     product text read from the photo (brand, product name, variant) is
 *     searched; Costco item numbers verified from results come back.
 *     Transient; nothing stored.
 * 4.  Ranking — candidates with confidence, reasons and sources.
 * 5.  Owner confirmation — nothing is saved or overwritten automatically.
 */
import { z } from 'zod'
import { cleanDescription } from '../categories/suggestProtocol'
import { isOwnerConfirmed, isUsableIdentity, type ProductIdentity } from './identityProtocol'

// ── Evidence (stage 1) ────────────────────────────────────────────────────────

export const PHOTO_LIMITS = {
  /** Longest side of the image sent for analysis (CSS px of the re-encoded JPEG). */
  maxDimension: 1280,
  /** Encoded JPEG must fit this (bytes); the browser lowers quality to fit. */
  maxImageBytes: 1_200_000,
  /** Request body limit for the evidence endpoint (base64 data URL + JSON). */
  maxRequestBytes: 1_700_000,
  maxText: 80,
  maxVisibleText: 12,
} as const

export type PhotoQuality = 'ok' | 'blurry' | 'no-product'

/** Where evidence came from: read deterministically on the device, or described by the vision model. */
export type EvidenceSource = 'on-device' | 'typed' | 'ai-vision'

export type Barcode = { format: string; value: string }

/** What the photo shows. Every field is optional evidence; null / empty means "not visible". */
export type PhotoEvidence = {
  source: EvidenceSource
  quality: PhotoQuality
  brand: string | null
  productName: string | null
  variant: string | null
  size: string | null
  productType: string | null
  modelNumber: string | null
  /** Decoded barcodes (UPC/EAN on packaging; Costco shelf-tag barcodes). Values are matched against item numbers. */
  barcodes: Barcode[]
  /** Every 4–8 digit number visible in the text, e.g. a Costco item number on a shelf tag. */
  numbers: string[]
  /** Short pieces of readable packaging or tag text. */
  visibleText: string[]
}

const text = z.string().max(PHOTO_LIMITS.maxText).nullable()
export const photoEvidenceSchema = z.object({
  source: z.enum(['on-device', 'typed', 'ai-vision']),
  quality: z.enum(['ok', 'blurry', 'no-product']),
  brand: text,
  productName: text,
  variant: text,
  size: text,
  productType: text,
  modelNumber: text,
  barcodes: z.array(z.object({ format: z.string().max(20), value: z.string().regex(/^[0-9A-Za-z]{4,20}$/) })).max(8),
  numbers: z.array(z.string().regex(/^\d{4,8}$/)).max(20),
  visibleText: z.array(z.string().max(PHOTO_LIMITS.maxText)).max(PHOTO_LIMITS.maxVisibleText),
})

/** Every distinct standalone 4–8 digit number in some text (Costco item numbers on tags are printed as one group). */
export function visibleNumbers(lines: readonly string[]): string[] {
  const out = new Set<string>()
  for (const line of lines) for (const m of line.matchAll(/(?<![\d.,])\d{4,8}(?![\d.,]\d|\d)/g)) out.add(m[0])
  return [...out].slice(0, 20)
}

/**
 * Deterministic evidence from text the device read (OCR) or the owner typed,
 * plus decoded barcodes. No interpretation: the text itself is the evidence.
 */
export function evidenceFromText(lines: readonly string[], barcodes: readonly Barcode[], source: 'on-device' | 'typed'): PhotoEvidence {
  const visibleText = lines
    .map((l) => cleanDescription(l).slice(0, PHOTO_LIMITS.maxText))
    .filter((l) => /[A-Za-z0-9]{2,}/.test(l))
    .slice(0, PHOTO_LIMITS.maxVisibleText)
  const usable = visibleText.length > 0 || barcodes.length > 0
  return {
    source,
    quality: usable ? 'ok' : 'blurry',
    brand: null,
    productName: null,
    variant: null,
    size: null,
    productType: null,
    modelNumber: null,
    barcodes: barcodes.slice(0, 8),
    numbers: visibleNumbers(lines),
    visibleText,
  }
}
export const photoEvidenceResponseSchema = z.object({ evidence: photoEvidenceSchema })

/** The only request body of the evidence endpoint: one re-encoded image as a data URL. */
export const photoEvidenceRequestSchema = z
  .object({
    image: z
      .string()
      .max(PHOTO_LIMITS.maxRequestBytes)
      .regex(/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/, { error: 'image must be a base64 JPEG, PNG or WebP data URL.' }),
  })
  .strict()

// ── External identification (stage 3) ────────────────────────────────────────

/** Generic product text read from the photo — the only thing sent to the search provider. */
const searchText = z
  .string()
  .min(1)
  .max(PHOTO_LIMITS.maxText)
  .refine((t) => t.trim() === t && !/[\r\n]/.test(t), { error: 'Single-line, trimmed text only.' })
export const photoSearchRequestSchema = z
  .object({
    brand: searchText.nullable(),
    productName: searchText,
    variant: searchText.nullable(),
  })
  .strict()
export type PhotoSearchRequest = z.infer<typeof photoSearchRequestSchema>

export type ExternalBasis = 'costco.com' | 'costco-specialist' | 'web'
export type ExternalCandidate = { itemNumber: string; title: string; basis: ExternalBasis }
export const photoSearchResponseSchema = z.object({
  searchConfigured: z.boolean(),
  candidates: z.array(z.object({ itemNumber: z.string(), title: z.string().max(300), basis: z.enum(['costco.com', 'costco-specialist', 'web']) })).max(8),
})

/**
 * The search text for stage 3, built ONLY from brand, product name and
 * variant read from the photo (CLAUDE.md product-identification exception:
 * generic product text). Null when the photo gave no product name.
 */
export function photoSearchRequest(e: PhotoEvidence): PhotoSearchRequest | null {
  const clean = (v: string | null) => {
    const t = cleanDescription((v ?? '').replace(/["*]/g, ' ')).slice(0, PHOTO_LIMITS.maxText).trim()
    return t || null
  }
  const productName = clean(e.productName)
  if (!productName) return null
  return { brand: clean(e.brand), productName, variant: clean(e.variant) }
}

// ── Local matching and ranking (stages 2 and 4) ──────────────────────────────

export const PHOTO_MATCH = {
  /** At or above: a strong match (one result is shown as "the" match when clearly ahead). */
  strong: 0.75,
  /** Below this every candidate is a weak guess. */
  plausible: 0.45,
  /** Candidates under this are not shown. */
  floor: 0.25,
  /** The top candidate must lead the next one by this much to be presented alone. */
  lead: 0.15,
  maxCandidates: 5,
} as const

/** Where a candidate's evidence came from: on-device text/barcodes, typed text, AI image description, the local catalog, or a web listing. */
export type MatchSource = 'on-device' | 'typed' | 'image' | 'local-catalog' | 'external'

/** What the matcher needs about each of the owner's items (from the analytics snapshot, in the browser). */
export type MatchableItem = {
  itemNumber: string
  descriptions: readonly string[]
  identity: ProductIdentity | null
  purchaseEvents: number
  lastPurchaseDate: string | null
}

export type PhotoMatchCandidate = {
  /** Costco item number when known (always for local candidates). */
  itemNumber: string | null
  canonicalName: string
  brand: string | null
  /** 0–1, from the deterministic scoring below (never from the AI). */
  confidence: number
  /** Short, human-readable reasons, strongest first. */
  reasons: string[]
  sources: MatchSource[]
  /** Our catalog identity for the item number, if any. */
  identity: ProductIdentity | null
  ownerConfirmed: boolean
  /** Linkage to the owner's purchases (for the item drawer, and the return assistant later). */
  purchases: { purchaseEvents: number; lastPurchaseDate: string | null } | null
  externalBasis: ExternalBasis | null
}

export type PhotoMatchStatus = 'match' | 'candidates' | 'low-confidence' | 'none' | 'unreadable'

export type PhotoMatchResult = {
  status: PhotoMatchStatus
  candidates: PhotoMatchCandidate[]
  evidence: PhotoEvidence
  /** Whether the external search ran (only when the local match was not strong). */
  searchedExternally: boolean
}

/** What a confirmed match hands to the rest of the app (the item drawer now; the return assistant in PR #11). */
export type ConfirmedPhotoMatch = {
  itemNumber: string
  canonicalName: string
  identity: ProductIdentity | null
  confidence: number
  confirmation: 'owner-confirmed-match'
  sources: MatchSource[]
  confirmedAt: string
}

const STOP = new Set(['THE', 'AND', 'WITH', 'FOR', 'OF', 'IN', 'COSTCO', 'PACK', 'COUNT', 'CT', 'PK', 'NEW', 'ITEM'])
/** Upper-case alphanumeric tokens, at least 2 characters, without filler words. */
export function tokens(text: string | null | undefined): string[] {
  if (!text) return []
  return text
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter((t) => t.length >= 2 && !STOP.has(t))
}

/** Brand spellings that appear on Costco receipts. */
function brandTokens(brand: string | null): string[] {
  const t = tokens(brand)
  if (t.join(' ') === 'KIRKLAND SIGNATURE' || t.join(' ') === 'KIRKLAND') return [...t, 'KS']
  return t
}

/**
 * How much of `wanted` appears in `have`. Receipt descriptions abbreviate
 * ("TORT" for "TORTELLINI"), so a have-token of 3+ characters that starts a
 * wanted token also counts.
 */
function coverage(wanted: readonly string[], have: readonly string[]): number {
  if (wanted.length === 0 || have.length === 0) return 0
  const set = new Set(have)
  let hit = 0
  for (const w of wanted) {
    if (set.has(w) || have.some((h) => h.length >= 3 && w.length > h.length && w.startsWith(h))) hit += 1
  }
  return hit / wanted.length
}

/**
 * For raw text (OCR / typed): how much of an item's own name appears in the
 * photo's text. Receipt words are abbreviated, so "TORT" matches "TORTELLINI".
 * One matching word is weak evidence; two or more make a real match.
 */
function reverseScore(itemTokens: readonly string[], photoTokens: readonly string[]): number {
  const wanted = [...new Set(itemTokens.filter((t) => t.length >= 3 && /[A-Z]/.test(t)))]
  if (wanted.length === 0 || photoTokens.length === 0) return 0
  const have = new Set(photoTokens)
  let hit = 0
  for (const w of wanted) if (have.has(w) || photoTokens.some((p) => p.length > w.length && p.startsWith(w))) hit += 1
  return (hit / wanted.length) * Math.min(1, hit / 2) * 0.9
}

function textScore(e: PhotoEvidence, have: readonly string[]): { score: number; brand: boolean; name: number } {
  const brand = brandTokens(e.brand)
  const name = tokens(e.productName)
  const extra = [...tokens(e.variant), ...tokens(e.productType), ...tokens(e.size)]
  // Receipts abbreviate Kirkland Signature to "KS": the alias alone is a brand match.
  const b = brand.length > 0 && (coverage(brand.filter((t) => t !== 'KS'), have) >= 0.5 || (brand.includes('KS') && have.includes('KS')))
  const n = coverage(name, have)
  const x = coverage(extra, have)
  // Weights: the product name carries the identity; the brand and the details refine it.
  const score = (b ? 0.25 : 0) + n * 0.6 + x * 0.15
  return { score, brand: b, name: n }
}

const round = (n: number) => Math.round(n * 100) / 100

/**
 * Stage 2: rank the owner's own items against the photo evidence. Pure and
 * deterministic. A Costco item number visible in the photo that the owner
 * bought is decisive; otherwise the visible brand/name/variant are compared
 * with our catalog identity (preferred: it is a clean name) and with the
 * receipt descriptions. Owner-confirmed identities get the strongest trust.
 */
export function matchLocal(e: PhotoEvidence, items: readonly MatchableItem[]): PhotoMatchCandidate[] {
  if (e.quality !== 'ok') return []
  const out: PhotoMatchCandidate[] = []
  for (const item of items) {
    const identity = isUsableIdentity(item.identity ?? undefined) ? item.identity : null
    const owner = isOwnerConfirmed(identity)
    const reasons: string[] = []
    let confidence: number
    const onBarcode = e.barcodes.some((b) => b.value === item.itemNumber || b.value.replace(/^0+/, '') === item.itemNumber)
    if (e.numbers.includes(item.itemNumber) || onBarcode) {
      confidence = 0.97
      reasons.push(onBarcode ? `Item number ${item.itemNumber} is in a barcode in the photo` : `Costco item number ${item.itemNumber} is visible in the photo`)
    } else {
      const photoTokens = e.visibleText.flatMap((t) => tokens(t))
      const identityTokens = identity ? [...tokens(identity.canonicalName), ...tokens(identity.brand), ...tokens(identity.productType)] : []
      const receiptTokens = item.descriptions.flatMap((d) => tokens(d))
      // Structured evidence (AI vision): the photo's name against our names. Raw text (OCR/typed): our names inside the photo's text.
      const structured = e.productName !== null
      const score = (have: readonly string[], name: readonly string[]) => {
        const t = structured ? textScore(e, have) : null
        return Math.max(t && t.name > 0 ? t.score : 0, reverseScore(name, photoTokens))
      }
      const byIdentity = identity ? score(identityTokens, tokens(identity.canonicalName)) : 0
      // Receipt text is abbreviated and less reliable than a catalog name.
      const byReceipt = score(receiptTokens, receiptTokens) * 0.9
      const via = byIdentity >= byReceipt && byIdentity > 0 ? ('identity' as const) : ('receipt' as const)
      confidence = Math.max(byIdentity, byReceipt)
      if (confidence === 0) continue
      if (structured && e.brand && textScore(e, via === 'identity' ? identityTokens : receiptTokens).brand) reasons.push(`Brand ${e.brand} matches`)
      reasons.push(
        via === 'identity'
          ? `${structured ? 'Name' : 'Text in the photo'} matches your catalog: ${identity!.canonicalName}`
          : `${structured ? 'Name' : 'Text in the photo'} matches your receipt text: ${item.descriptions[0] ?? ''}`,
      )
      if (owner) {
        confidence += 0.08
        reasons.push('You confirmed this product')
      } else if (identity && via === 'identity') {
        confidence += 0.03
      }
      confidence = Math.min(0.95, confidence)
    }
    if (confidence < PHOTO_MATCH.floor) continue
    out.push({
      itemNumber: item.itemNumber,
      canonicalName: identity?.canonicalName ?? item.descriptions[0] ?? `Item ${item.itemNumber}`,
      brand: identity?.brand ?? null,
      confidence: round(confidence),
      reasons,
      sources: [e.source === 'ai-vision' ? 'image' : e.source === 'typed' ? 'typed' : 'on-device', 'local-catalog'],
      identity: item.identity,
      ownerConfirmed: owner,
      purchases: { purchaseEvents: item.purchaseEvents, lastPurchaseDate: item.lastPurchaseDate },
      externalBasis: null,
    })
  }
  return sortCandidates(out)
}

const sortCandidates = (c: PhotoMatchCandidate[]) =>
  [...c].sort((a, b) => b.confidence - a.confidence || Number(b.ownerConfirmed) - Number(a.ownerConfirmed) || (a.itemNumber ?? '').localeCompare(b.itemNumber ?? ''))

/** Whether to run the external search: only when the photo named a product and no local candidate is strong. */
export function needsExternal(e: PhotoEvidence, local: readonly PhotoMatchCandidate[]): boolean {
  return e.quality === 'ok' && photoSearchRequest(e) !== null && (local[0]?.confidence ?? 0) < PHOTO_MATCH.strong
}

const BASIS_CONFIDENCE: Record<ExternalBasis, number> = { 'costco.com': 0.7, 'costco-specialist': 0.65, web: 0.4 }

/**
 * Stage 3 → 4: fold external candidates (Costco item numbers verified from
 * search results) into the local ranking. An external item number the owner
 * bought joins that local item (combined evidence); others are shown as
 * "not in your purchases". Confidence scales with how well the listing
 * title agrees with what the photo shows.
 */
export function mergeExternal(e: PhotoEvidence, local: readonly PhotoMatchCandidate[], external: readonly ExternalCandidate[], items: readonly MatchableItem[]): PhotoMatchCandidate[] {
  const byNumber = new Map(local.filter((c) => c.itemNumber).map((c) => [c.itemNumber!, { ...c, reasons: [...c.reasons], sources: [...c.sources] }]))
  const itemByNumber = new Map(items.map((i) => [i.itemNumber, i]))
  for (const x of external) {
    const agreement = textScore(e, tokens(x.title)).score
    const confidence = round(Math.min(0.9, BASIS_CONFIDENCE[x.basis] * (0.5 + 0.5 * Math.min(1, agreement))))
    const where = x.basis === 'costco.com' ? 'Costco.com' : x.basis === 'costco-specialist' ? 'a Costco product listing (Warehouse Runner)' : 'a web listing'
    const existing = byNumber.get(x.itemNumber)
    if (existing) {
      existing.confidence = round(Math.min(0.95, Math.max(existing.confidence, confidence) + 0.05))
      existing.reasons.push(`Item ${x.itemNumber} is named for this product on ${where}`)
      if (!existing.sources.includes('external')) existing.sources.push('external')
      existing.externalBasis ??= x.basis
      continue
    }
    if (confidence < PHOTO_MATCH.floor) continue
    const item = itemByNumber.get(x.itemNumber)
    const identity = item && isUsableIdentity(item.identity ?? undefined) ? item.identity : null
    byNumber.set(x.itemNumber, {
      itemNumber: x.itemNumber,
      canonicalName: identity?.canonicalName ?? x.title,
      brand: identity?.brand ?? null,
      confidence,
      reasons: [`Found on ${where} as item ${x.itemNumber}`],
      sources: ['image', 'external', ...(item ? (['local-catalog'] as const) : [])] as MatchSource[],
      identity: item?.identity ?? null,
      ownerConfirmed: isOwnerConfirmed(identity),
      purchases: item ? { purchaseEvents: item.purchaseEvents, lastPurchaseDate: item.lastPurchaseDate } : null,
      externalBasis: x.basis,
    })
  }
  return sortCandidates([...byNumber.values()])
}

/** Stage 4: the outcome shown to the owner. Never presents an uncertain match as certain. */
export function decide(e: PhotoEvidence, ranked: readonly PhotoMatchCandidate[], searchedExternally: boolean): PhotoMatchResult {
  const candidates = ranked.slice(0, PHOTO_MATCH.maxCandidates)
  if (e.quality !== 'ok') return { status: 'unreadable', candidates: [], evidence: e, searchedExternally }
  if (candidates.length === 0) return { status: 'none', candidates, evidence: e, searchedExternally }
  const [top, next] = candidates
  if (top!.confidence < PHOTO_MATCH.plausible) return { status: 'low-confidence', candidates, evidence: e, searchedExternally }
  if (top!.confidence >= PHOTO_MATCH.strong && (!next || top!.confidence - next.confidence >= PHOTO_MATCH.lead)) {
    return { status: 'match', candidates, evidence: e, searchedExternally }
  }
  return { status: 'candidates', candidates, evidence: e, searchedExternally }
}

export const confidenceLabel = (c: number): string => (c >= PHOTO_MATCH.strong ? 'Strong match' : c >= PHOTO_MATCH.plausible ? 'Possible match' : 'Weak match')

/**
 * Whether confirming this candidate may also save the product identity —
 * only through the existing owner-confirmed identity workflow, and only for an
 * item the owner bought that has no catalog identity yet. An existing
 * identity (owner-confirmed or automatic) is never overwritten from a photo.
 */
export const canSaveIdentity = (c: PhotoMatchCandidate): boolean => c.itemNumber !== null && c.purchases !== null && c.identity === null

/** The structure handed on when the owner confirms a candidate (for the item drawer and, later, returns). */
export function confirmMatch(c: PhotoMatchCandidate, now: Date): ConfirmedPhotoMatch | null {
  if (!c.itemNumber || !c.purchases) return null
  return {
    itemNumber: c.itemNumber,
    canonicalName: c.canonicalName,
    identity: c.identity,
    confidence: c.confidence,
    confirmation: 'owner-confirmed-match',
    sources: c.sources,
    confirmedAt: now.toISOString(),
  }
}

/** Evidence from two passes (on-device first, then AI vision) combined, so nothing the device read is lost. */
export function combineEvidence(first: PhotoEvidence, second: PhotoEvidence): PhotoEvidence {
  const uniq = <T,>(xs: T[], key: (x: T) => string) => [...new Map(xs.map((x) => [key(x), x])).values()]
  return {
    ...second,
    quality: first.quality === 'ok' || second.quality === 'ok' ? 'ok' : second.quality,
    barcodes: uniq([...first.barcodes, ...second.barcodes], (b) => b.value).slice(0, 8),
    numbers: [...new Set([...first.numbers, ...second.numbers])].slice(0, 20),
    visibleText: [...new Set([...first.visibleText, ...second.visibleText])].slice(0, PHOTO_LIMITS.maxVisibleText),
  }
}
