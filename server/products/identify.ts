/**
 * Product identification (owner-only, POST /api/products/identify).
 *
 * Brave web search is a TRANSIENT discovery step; D1 holds only OUR OWN
 * resolved product catalog (product_identities):
 *
 *   1. Local catalog lookup by item number. A resolved item number is answered
 *      from D1 and is never searched again. A recent unresolved attempt is not
 *      retried before its retry_after.
 *   2. Unknown item number → targeted search ("Costco <item#> <desc>", then
 *      "Costco \"<item#>\""). A result counts only if it names the exact item
 *      number; the evidence class decides the outcome (see search.ts).
 *   3. Strong evidence (Costco.com page, or 2+ independent agreeing sites) →
 *      canonical name (optionally AI-normalized), brand and product type are
 *      resolved during this request and saved as our own record.
 *      Weak evidence (one non-Costco source) or nothing → saved only as
 *      "unresolved" (outcome + retry time, no product details).
 *   4. Search results (titles, snippets, URLs, thumbnails, ranking) live only
 *      in memory for this request and are discarded.
 *
 * Categorization happens afterwards in the dashboard (deterministic rules on
 * the canonical name; AI suggestions with owner review for what remains).
 */
import { cleanDescription, type SuggestRequestItem } from '../../src/analytics/categories/suggestProtocol'
import {
  isUsableIdentity,
  type IdentifyResponse,
  type IdentifyResult,
  type ProductIdentity,
  type ResolutionBasis,
  type UnresolvedResult,
} from '../../src/analytics/products/identityProtocol'
import type { AiBinding } from '../ai/categorySuggest'
import { PRODUCT_NORMALIZATION_MODEL } from '../ai/config'
import type { SqlDatabase } from '../db'
import { cleanProductTitle, pickCandidate, searchQueries, type Candidate, type WebSearch } from './search'

/** An unresolved item number (weak evidence or nothing found) is not searched again for this long. */
export const UNRESOLVED_RETRY_MS = 30 * 24 * 60 * 60 * 1000

type Row = {
  item_number: string
  status: 'resolved' | 'unresolved'
  receipt_description: string
  canonical_name: string | null
  brand: string | null
  product_type: string | null
  confidence: number
  resolution_basis: ResolutionBasis | null
  last_outcome: 'provisional' | 'not_found' | null
  method: string
  resolved_at: string | null
  last_attempt_at: string
  retry_after: string | null
}

const COLUMNS =
  'item_number, status, receipt_description, canonical_name, brand, product_type, confidence, resolution_basis, last_outcome, method, resolved_at, last_attempt_at, retry_after'

function rowToIdentity(r: Row): ProductIdentity | null {
  if (r.status !== 'resolved' || !r.canonical_name || !r.resolution_basis || !r.resolved_at) return null
  return {
    itemNumber: r.item_number,
    status: 'resolved',
    receiptDescription: r.receipt_description,
    canonicalName: r.canonical_name,
    brand: r.brand,
    productType: r.product_type,
    confidence: r.confidence,
    basis: r.resolution_basis,
    method: r.method,
    resolvedAt: r.resolved_at,
  }
}

function rowToResult(r: Row): IdentifyResult {
  const identity = rowToIdentity(r)
  if (identity) return { ...identity, cached: true }
  return { itemNumber: r.item_number, status: 'unresolved', outcome: r.last_outcome ?? 'not_found', candidateName: null, retryAfter: r.retry_after ?? '', cached: true }
}

/** Our resolved catalog (what the dashboard loads with the dataset). */
export async function listIdentities(db: SqlDatabase): Promise<ProductIdentity[]> {
  const rows = await db.all<Row>(`SELECT ${COLUMNS} FROM product_identities WHERE status = 'resolved' ORDER BY item_number LIMIT 20000`)
  return rows.map(rowToIdentity).filter((i): i is ProductIdentity => i !== null)
}

export type Normalized = { normalizedName: string; brand: string | null; productType: string | null }

const short = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null
  const t = cleanDescription(v).slice(0, max).trim()
  return t && !/^(null|none|unknown|n\/a)$/i.test(t) ? t : null
}

/**
 * The production normalization prompt. It only renames/describes an already
 * identified item; it never decides identity or confidence.
 */
export const NORMALIZATION_SYSTEM_PROMPT = [
  'You normalize product identities for a personal Costco spending dashboard.',
  'Each input has a Costco item number, its abbreviated receipt description, and the title and snippet of a public web page that mentions that exact item number. The product is already identified; only name it well.',
  'For each item return:',
  '- normalizedName: a clean, human-readable catalog name, as a shopper would say it, at most 100 characters.',
  '  * Keep the full brand name. Write "Kirkland Signature" in full; never shorten it to "KS" or "Kirkland".',
  '  * Keep meaningful descriptors and product or model names, e.g. Organic, Extra Crispy, Hand Soap, Unscented, flavor, variety, model numbers.',
  '  * Spell words out; never abbreviate them (Chocolate, not "Choc"; Tortellini, not "Tort"). Expand receipt abbreviations when the page text makes the full word clear.',
  '  * Remove promotional and price text: prices, "$X off", "Sale", "Deal", "Save", "Instant Savings", "Online Only", store or website names, item numbers.',
  '  * Package size or count may be omitted when it does not materially distinguish the product; keep it when it does (e.g. a 2-pack versus a single).',
  '  * Prefer the complete descriptive name over a short label: "Kirkland Signature Tortellini Pasta Salad with Mozzarella Pearls and Dressing", not "KS Tort Pasta".',
  '- brand: the full brand name, or null if not clear.',
  '- productType: a short generic noun phrase such as "portable power station", "bidet toilet seat", "red wine", "indoor/outdoor mat", at most 40 characters, or null.',
  'Use only the given text. Do not invent details that are not in it. Return exactly one entry per input itemNumber.',
].join('\n')

/** One Workers AI call that turns search results into clean name / brand / product type. Never trusted blindly. */
export async function normalizeWithAi(
  ai: AiBinding,
  found: readonly { itemNumber: string; receiptDescription: string; candidate: Candidate }[],
): Promise<Map<string, Normalized>> {
  const payload = found.map((f) => ({
    itemNumber: f.itemNumber,
    receiptDescription: f.receiptDescription,
    resultTitle: f.candidate.result.title,
    resultSnippet: f.candidate.result.snippet.slice(0, 300),
  }))
  const raw = await ai.run(PRODUCT_NORMALIZATION_MODEL, {
    messages: [
      {
        role: 'system',
        content: NORMALIZATION_SYSTEM_PROMPT,
      },
      { role: 'user', content: `Normalize these ${payload.length} items. Return JSON {"items":[...]}.\n${JSON.stringify(payload)}` },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                itemNumber: { type: 'string' },
                normalizedName: { type: 'string' },
                brand: { type: ['string', 'null'] },
                productType: { type: ['string', 'null'] },
              },
              required: ['itemNumber', 'normalizedName', 'brand', 'productType'],
            },
          },
        },
        required: ['items'],
      },
    },
    temperature: 0,
    max_tokens: 1024,
  })
  let value: unknown = raw && typeof raw === 'object' && 'response' in raw ? (raw as { response: unknown }).response : raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      value = null
    }
  }
  const list = value && typeof value === 'object' && Array.isArray((value as { items?: unknown }).items) ? (value as { items: unknown[] }).items : []
  const wanted = new Set(found.map((f) => f.itemNumber))
  const out = new Map<string, Normalized>()
  for (const e of list) {
    if (!e || typeof e !== 'object') continue
    const x = e as Record<string, unknown>
    const itemNumber = typeof x.itemNumber === 'string' ? x.itemNumber : null
    const name = short(x.normalizedName, 120)
    if (!itemNumber || !wanted.has(itemNumber) || out.has(itemNumber) || !name) continue
    out.set(itemNumber, { normalizedName: name, brand: short(x.brand, 60), productType: short(x.productType, 60) })
  }
  return out
}

export type StrongCandidate = { itemNumber: string; receiptDescription: string; candidate: Candidate }

/**
 * The optional AI normalization step exactly as identification runs it: only
 * for strong candidates, one call, and on any failure no normalization at all
 * (the cleaned search title is used instead). Never changes confidence.
 */
export async function normalizeStrongCandidates(ai: AiBinding | undefined, strong: readonly StrongCandidate[]): Promise<Map<string, Normalized>> {
  if (!ai || strong.length === 0) return new Map()
  try {
    return await normalizeWithAi(ai, strong)
  } catch (error) {
    console.error('normalize_error', error instanceof Error ? error.name : 'unknown')
    return new Map()
  }
}

/** The local catalog record we save for a strong candidate (AI-normalized name if available, else the cleaned search title). */
export function toResolvedIdentity(f: StrongCandidate, n: Normalized | undefined, at: string): ProductIdentity {
  return {
    itemNumber: f.itemNumber,
    status: 'resolved',
    receiptDescription: f.receiptDescription,
    canonicalName: n?.normalizedName ?? (cleanProductTitle(f.candidate.result.title) || f.receiptDescription),
    brand: n?.brand ?? null,
    productType: n?.productType ?? null,
    confidence: f.candidate.confidence,
    basis: f.candidate.evidence as ResolutionBasis,
    method: n ? 'web-search+ai' : 'web-search',
    resolvedAt: at,
  }
}

export type IdentifyDeps = { db: SqlDatabase; search: WebSearch | null; ai?: AiBinding | undefined; now: Date }

const UPSERT = `INSERT INTO product_identities (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (item_number) DO UPDATE SET status = excluded.status, receipt_description = excluded.receipt_description,
    canonical_name = excluded.canonical_name, brand = excluded.brand, product_type = excluded.product_type,
    confidence = excluded.confidence, resolution_basis = excluded.resolution_basis, last_outcome = excluded.last_outcome,
    method = excluded.method, resolved_at = excluded.resolved_at, last_attempt_at = excluded.last_attempt_at,
    retry_after = excluded.retry_after
  WHERE product_identities.status <> 'resolved'`

export async function identifyItems(deps: IdentifyDeps, items: readonly SuggestRequestItem[]): Promise<IdentifyResponse> {
  const { db, search, ai, now } = deps
  const numbers = items.map((i) => i.itemNumber)
  const rows = await db.all<Row>(`SELECT ${COLUMNS} FROM product_identities WHERE item_number IN (${numbers.map(() => '?').join(', ')})`, numbers)
  const local = new Map(rows.map((r) => [r.item_number, r]))
  const results = new Map<string, IdentifyResponse['results'][number]>()
  const toSearch: SuggestRequestItem[] = []

  for (const item of items) {
    const row = local.get(item.itemNumber)
    // Resolved → our own record, forever. Unresolved → wait for retry_after (or forever without a provider).
    const settled = row && (row.status === 'resolved' || !search || (row.retry_after !== null && row.retry_after > now.toISOString()))
    if (row && settled) results.set(item.itemNumber, rowToResult(row))
    else if (!search) results.set(item.itemNumber, { itemNumber: item.itemNumber, status: 'unavailable', reason: 'Web search is not configured.' })
    else toSearch.push(item)
  }

  // Transient discovery: search results exist only in this loop's memory.
  const strong: StrongCandidate[] = []
  const weak: { itemNumber: string; receiptDescription: string; outcome: 'provisional' | 'not_found'; candidateName: string | null }[] = []
  for (const item of toSearch) {
    const receiptDescription = item.descriptions[0]!
    try {
      let candidate: Candidate | null = null
      for (const query of searchQueries(item.itemNumber, receiptDescription)) {
        candidate = pickCandidate(item.itemNumber, await search!.search(query))
        if (candidate) break
      }
      if (candidate && candidate.evidence !== 'single-source') strong.push({ itemNumber: item.itemNumber, receiptDescription, candidate })
      else
        weak.push({
          itemNumber: item.itemNumber,
          receiptDescription,
          outcome: candidate ? 'provisional' : 'not_found',
          candidateName: candidate ? cleanProductTitle(candidate.result.title) || null : null,
        })
    } catch (error) {
      console.error('search_error', error instanceof Error ? error.message.slice(0, 40) : 'unknown')
      results.set(item.itemNumber, { itemNumber: item.itemNumber, status: 'unavailable', reason: 'The web search failed. You can try again later.' })
    }
  }

  // Resolve strong candidates into our own record (optional AI clean-up, one call; never changes confidence).
  const normalized = await normalizeStrongCandidates(ai, strong)

  const at = now.toISOString()
  const retryAfter = new Date(now.getTime() + UNRESOLVED_RETRY_MS).toISOString()
  const resolved: ProductIdentity[] = strong.map((f) => toResolvedIdentity(f, normalized.get(f.itemNumber), at))
  const unresolved: UnresolvedResult[] = weak.map((w) => ({
    itemNumber: w.itemNumber,
    status: 'unresolved',
    outcome: w.outcome,
    candidateName: w.candidateName, // shown to the owner now; never stored
    retryAfter,
    cached: false,
  }))

  // Persist ONLY our own outcome. Columns hold no search-result content by construction.
  const statements = [
    ...resolved.map((r) => ({
      sql: UPSERT,
      params: [r.itemNumber, 'resolved', r.receiptDescription, r.canonicalName, r.brand, r.productType, r.confidence, r.basis, null, r.method, at, at, null],
    })),
    ...weak.map((w) => ({
      sql: UPSERT,
      params: [w.itemNumber, 'unresolved', w.receiptDescription, null, null, null, 0, null, w.outcome, 'web-search', null, at, retryAfter],
    })),
  ]
  if (statements.length > 0) await db.batch(statements)
  for (const r of resolved) results.set(r.itemNumber, { ...r, cached: false })
  for (const u of unresolved) results.set(u.itemNumber, u)
  return { searchConfigured: search !== null, results: items.map((i) => results.get(i.itemNumber)!) }
}

/** Resolved, usable identities for the AI suggestion prompt. */
export async function identitiesFor(db: SqlDatabase, itemNumbers: readonly string[]): Promise<Map<string, ProductIdentity>> {
  if (itemNumbers.length === 0) return new Map()
  const rows = await db.all<Row>(
    `SELECT ${COLUMNS} FROM product_identities WHERE status = 'resolved' AND item_number IN (${itemNumbers.map(() => '?').join(', ')})`,
    [...itemNumbers],
  )
  return new Map(
    rows
      .map((r) => rowToIdentity(r) ?? undefined)
      .filter(isUsableIdentity)
      .map((i) => [i.itemNumber, i]),
  )
}
