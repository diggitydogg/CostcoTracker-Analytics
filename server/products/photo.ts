/**
 * Photo-to-product matching, server side (owner-only). Two narrow steps; the
 * local match against the owner's purchases happens in the browser, so these
 * endpoints never read purchase data at all (see docs/PHOTO_MATCHING.md).
 *
 * 1. extractPhotoEvidence — Workers AI (the owner's own Cloudflare account)
 *    reads what is VISIBLE in one re-encoded photo. Sent: the image and a
 *    fixed instruction. Nothing else. Nothing is stored.
 * 2. searchPhotoCandidates — Brave, with generic product text read from the
 *    photo (brand, product name, variant). Returns Costco item numbers that a
 *    result verifiably names. Transient; nothing is stored.
 */
import { cleanDescription } from '../../src/analytics/categories/suggestProtocol'
import {
  PHOTO_LIMITS,
  visibleNumbers,
  type ExternalBasis,
  type ExternalCandidate,
  type PhotoEvidence,
  type PhotoSearchRequest,
} from '../../src/analytics/products/photoMatch'
import type { AiBinding } from '../ai/categorySuggest'
import { PHOTO_EVIDENCE_MODEL } from '../ai/config'
import { ApiError } from '../http'
import { cleanProductTitle, specialistItemNumber, type SearchResult, type WebSearch } from './search'

export const PHOTO_EVIDENCE_PROMPT = [
  'You read product photos for a personal Costco purchase tracker. Describe ONLY what is visible in the photo.',
  'Return JSON with: quality ("ok", "blurry" if text and product are not legible, "no-product" if no retail product is shown),',
  'brand, productName (as printed, e.g. "Organic Extra Virgin Olive Oil"), variant (flavor, scent, color), size (e.g. "2 L", "48 count"),',
  'productType (a short generic noun phrase such as "olive oil", "bath towels"), modelNumber, upc (digits of a printed UPC/EAN barcode number, only if the digits are legible),',
  'costcoItemNumber (digits of a Costco item number only if a Costco shelf tag or label shows it), and visibleText (up to 12 short pieces of legible packaging or tag text, verbatim).',
  'Use null for anything not clearly visible. Never guess, infer or complete text that is not legible. Do not identify people. Do not look anything up.',
].join('\n')

const EVIDENCE_SCHEMA = {
  type: 'object',
  properties: {
    quality: { type: 'string', enum: ['ok', 'blurry', 'no-product'] },
    brand: { type: ['string', 'null'] },
    productName: { type: ['string', 'null'] },
    variant: { type: ['string', 'null'] },
    size: { type: ['string', 'null'] },
    productType: { type: ['string', 'null'] },
    modelNumber: { type: ['string', 'null'] },
    upc: { type: ['string', 'null'] },
    costcoItemNumber: { type: ['string', 'null'] },
    visibleText: { type: 'array', items: { type: 'string' } },
  },
  required: ['quality', 'brand', 'productName', 'variant', 'size', 'productType', 'modelNumber', 'upc', 'costcoItemNumber', 'visibleText'],
}

/** The exact model input: the fixed instruction and the image. Pure — tested to contain nothing else. */
export function buildEvidenceInput(image: string): Record<string, unknown> {
  return {
    messages: [
      { role: 'system', content: PHOTO_EVIDENCE_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe the product in this photo. Return JSON only.' },
          { type: 'image_url', image_url: { url: image } },
        ],
      },
    ],
    response_format: { type: 'json_schema', json_schema: EVIDENCE_SCHEMA },
    temperature: 0,
    max_tokens: 700,
  }
}

const field = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const t = cleanDescription(v).slice(0, PHOTO_LIMITS.maxText).trim()
  return t && !/^(null|none|unknown|n\/a|not visible)$/i.test(t) ? t : null
}
const digits = (v: unknown, min: number, max: number): string | null => {
  const d = typeof v === 'string' ? v.replace(/[\s-]/g, '') : ''
  return new RegExp(`^\\d{${min},${max}}$`).test(d) ? d : null
}

/** Never trusts the model: validates every field, and keeps a "visible" number only if it also appears in the visible text. */
export function normalizeEvidence(raw: unknown): PhotoEvidence {
  let value: unknown = raw && typeof raw === 'object' && 'response' in raw ? (raw as { response: unknown }).response : raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      value = null
    }
  }
  const x = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const visibleText = (Array.isArray(x.visibleText) ? x.visibleText : []).map(field).filter((t): t is string => t !== null).slice(0, PHOTO_LIMITS.maxVisibleText)
  const shown = visibleText.join(' ').replace(/[\s-]/g, '')
  const inText = (d: string | null) => (d && shown.includes(d) ? d : null)
  const upc = inText(digits(x.upc, 8, 14))
  const item = inText(digits(x.costcoItemNumber, 4, 8))
  const evidence: PhotoEvidence = {
    source: 'ai-vision',
    quality: x.quality === 'blurry' || x.quality === 'no-product' ? x.quality : 'ok',
    brand: field(x.brand),
    productName: field(x.productName),
    variant: field(x.variant),
    size: field(x.size),
    productType: field(x.productType),
    modelNumber: field(x.modelNumber),
    barcodes: upc ? [{ format: 'printed', value: upc }] : [],
    // Numbers only as the model read them in the visible text, never a number it merely asserts.
    numbers: [...new Set([...(item ? [item] : []), ...visibleNumbers(visibleText)])].slice(0, 20),
    visibleText,
  }
  // "ok" with nothing usable is not a product we can match.
  if (evidence.quality === 'ok' && !evidence.brand && !evidence.productName && !evidence.productType && evidence.numbers.length === 0 && visibleText.length === 0) {
    evidence.quality = 'no-product'
  }
  return evidence
}

export async function extractPhotoEvidence(ai: AiBinding | undefined, image: string): Promise<PhotoEvidence> {
  if (!ai || typeof ai.run !== 'function') {
    throw new ApiError(503, 'ai_not_configured', 'Photo identification needs the Workers AI binding "AI" on this cloud (Settings → Bindings), then a redeploy.')
  }
  let raw: unknown
  try {
    raw = await ai.run(PHOTO_EVIDENCE_MODEL, buildEvidenceInput(image))
  } catch (error) {
    // Never log the image or its contents.
    console.error('photo_ai_error', error instanceof Error ? error.name : 'unknown')
    throw new ApiError(502, 'ai_failed', 'The photo could not be analyzed right now. Try again in a moment.')
  }
  return normalizeEvidence(raw)
}

/** The queries for stage 3, built only from the photo's generic product text. At most two. */
export function photoSearchQueries(req: PhotoSearchRequest): string[] {
  const text = [req.brand, req.productName, req.variant].filter(Boolean).join(' ')
  return [`Costco ${text}`, `site:app.warehouserunner.com ${[req.brand, req.productName].filter(Boolean).join(' ')}`]
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}
const ITEM_IN_TEXT = /\bitem\s*(?:#|no\.?|number)?\s*:?\s*(\d{4,8})\b/i
const RANK: Record<ExternalBasis, number> = { 'costco.com': 3, 'costco-specialist': 2, web: 1 }

/** Costco item numbers a result verifiably names: a specialist product page's path, or "Item 1234567" text on Costco.com or another page that says Costco. */
export function candidatesFromResults(results: readonly SearchResult[]): ExternalCandidate[] {
  const best = new Map<string, ExternalCandidate>()
  for (const r of results) {
    const host = hostOf(r.url)
    let found: ExternalCandidate | null = null
    const fromPath = specialistItemNumber(r.url)
    if (fromPath) found = { itemNumber: fromPath, title: cleanProductTitle(r.title), basis: 'costco-specialist' }
    else {
      const m = ITEM_IN_TEXT.exec(`${r.title} ${r.snippet}`)
      if (m) {
        const costco = host === 'costco.com' || host.endsWith('.costco.com')
        if (costco || /costco/i.test(`${r.title} ${r.snippet}`)) found = { itemNumber: m[1]!, title: cleanProductTitle(r.title), basis: costco ? 'costco.com' : 'web' }
      }
    }
    if (!found || !found.title) continue
    const prev = best.get(found.itemNumber)
    if (!prev || RANK[found.basis] > RANK[prev.basis]) best.set(found.itemNumber, found)
  }
  return [...best.values()].sort((a, b) => RANK[b.basis] - RANK[a.basis]).slice(0, 6)
}

/** Stage 3. Stops after the first query that yields a Costco.com or specialist candidate. Nothing is stored. */
export async function searchPhotoCandidates(search: WebSearch, req: PhotoSearchRequest): Promise<ExternalCandidate[]> {
  const seen: SearchResult[] = []
  for (const query of photoSearchQueries(req)) {
    seen.push(...(await search.search(query)))
    const found = candidatesFromResults(seen)
    if (found.some((c) => c.basis !== 'web')) return found
  }
  return candidatesFromResults(seen)
}
