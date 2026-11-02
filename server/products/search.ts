/**
 * Targeted public web search for one Costco item number.
 *
 * Only a search API is called: costco.com (or any result page) is never
 * fetched or scraped. A result counts as an identification only when its
 * title, URL or snippet contains the exact item number, so we identify the
 * same Costco item, not something that merely sounds similar.
 */

export type SearchResult = { title: string; url: string; snippet: string; imageUrl: string | null }

/** A web search provider (portable; tests use a fake). */
export type WebSearch = { name: string; search(query: string): Promise<SearchResult[]> }

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>

const strip = (s: unknown): string =>
  typeof s === 'string'
    ? s
        .replace(/<[^>]*>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim()
    : ''

/** On HTTP 429 (per-second rate limit) wait this long, then retry that query once. */
export const RATE_LIMIT_RETRY_MS = 1100

/**
 * Brave Search API adapter (https://api.search.brave.com, header
 * `X-Subscription-Token`). Requires the secret SEARCH_API_KEY.
 * A 429 is retried once after RATE_LIMIT_RETRY_MS; any other failure throws.
 */
export function braveSearch(
  apiKey: string,
  fetchImpl: FetchFn = (i, init) => fetch(i, init),
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): WebSearch {
  return {
    name: 'brave',
    async search(query) {
      const qs = new URLSearchParams({ q: query, count: '8', safesearch: 'moderate', text_decorations: 'false' })
      const send = () =>
        fetchImpl(`https://api.search.brave.com/res/v1/web/search?${qs}`, {
          headers: { accept: 'application/json', 'x-subscription-token': apiKey },
        })
      let res = await send()
      if (res.status === 429) {
        await sleep(RATE_LIMIT_RETRY_MS)
        res = await send()
      }
      if (!res.ok) throw new Error(`search_http_${res.status}`)
      const body = (await res.json()) as { web?: { results?: unknown[] } }
      return (body.web?.results ?? []).flatMap((r) => {
        if (!r || typeof r !== 'object') return []
        const x = r as { title?: unknown; url?: unknown; description?: unknown; thumbnail?: { src?: unknown } }
        const url = typeof x.url === 'string' && /^https:\/\//.test(x.url) ? x.url : null
        if (!url) return []
        const image = typeof x.thumbnail?.src === 'string' && /^https:\/\//.test(x.thumbnail.src) ? x.thumbnail.src : null
        return [{ title: strip(x.title), url, snippet: strip(x.description), imageUrl: image }]
      })
    },
  }
}

/** Removes characters that could change the meaning of a query. */
const queryText = (s: string) => s.replace(/["*]/g, ' ').replace(/\s+/g, ' ').trim()

/** The Costco-specialist site targeted with Brave's `site:` operator (a search query, never a fetch). */
export const SPECIALIST_SEARCH_SITE = 'app.warehouserunner.com'

/** Hard bound on Brave queries for one item number. */
export const MAX_QUERIES_PER_ITEM = 3

/**
 * The queries for one item, in order, each sent only while the item is still
 * unresolved:
 * 1. item number plus receipt description;
 * 2. a Brave `site:` query for Warehouse Runner with the item number ONLY;
 * 3. the quoted item number alone.
 * Built only from those two values.
 */
export function searchQueries(itemNumber: string, receiptDescription: string): string[] {
  const desc = queryText(receiptDescription)
  return [`Costco ${itemNumber}${desc ? ` ${desc}` : ''}`, `site:${SPECIALIST_SEARCH_SITE} ${itemNumber}`, `Costco "${itemNumber}"`]
}

/** Strong evidence resolves an item; single-source evidence never does. */
export const isStrong = (c: Candidate | null): boolean => !!c && c.evidence !== 'single-source'

/**
 * Runs the queries for one item in order and stops as soon as the evidence is
 * strong. Every query's results are judged by the same exact-item-number and
 * specialist-page checks (pickCandidate) over all results seen so far: a result
 * is never trusted because of the query that returned it. At most
 * MAX_QUERIES_PER_ITEM queries. Results live only in this call's memory.
 */
export async function lookupCandidate(
  search: WebSearch,
  itemNumber: string,
  receiptDescription: string,
  hooks: { beforeQuery?: (query: string, index: number) => Promise<void> | void; onResults?: (query: string, results: SearchResult[]) => void } = {},
): Promise<{ candidate: Candidate | null; queries: string[] }> {
  const seen = new Map<string, SearchResult>()
  const queries: string[] = []
  let candidate: Candidate | null = null
  for (const query of searchQueries(itemNumber, receiptDescription).slice(0, MAX_QUERIES_PER_ITEM)) {
    await hooks.beforeQuery?.(query, queries.length)
    queries.push(query)
    const results = await search.search(query)
    hooks.onResults?.(query, results)
    for (const r of results) if (!seen.has(r.url)) seen.set(r.url, r)
    candidate = pickCandidate(itemNumber, [...seen.values()])
    if (isStrong(candidate)) break
  }
  return { candidate, queries }
}

/**
 * How strong the evidence for an identity is:
 * - `costco.com`: Costco's own page names this exact item number;
 * - `costco-specialist`: a Costco-specific product database's page for exactly this
 *   item number (Warehouse Runner's `/costco/<itemNumber>` product pages), as
 *   returned by the search API. Such sites are never fetched directly;
 * - `corroborated`: two or more independent sites name it and their titles agree;
 * - `single-source`: only one ordinary site (or disagreeing sites): provisional, not used automatically.
 */
export type Evidence = 'costco.com' | 'costco-specialist' | 'corroborated' | 'single-source'

/** Confidence comes ONLY from the evidence class; nothing downstream (including AI) may raise it. */
export const EVIDENCE_CONFIDENCE: Record<Evidence, number> = {
  'costco.com': 0.9,
  'costco-specialist': 0.85,
  corroborated: 0.8,
  'single-source': 0.4,
}

export type Candidate = {
  result: SearchResult
  confidence: number
  evidence: Evidence
  /** Distinct hosts whose result names the exact item number. */
  sources: number
  /** For `corroborated`: the independent result that agrees with `result`. */
  corroboratingUrl: string | null
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

/**
 * The site a host belongs to, so subdomains of one site count as ONE source
 * (app.warehouserunner.com and warehouserunner.com are the same site).
 * Approximates the registrable domain: last two labels, or three for
 * country-code second levels such as "co.uk".
 */
export function siteOf(host: string): string {
  const labels = host.split('.').filter(Boolean)
  const n = labels.length >= 3 && labels.at(-1)!.length === 2 && /^(co|com|org|net|gov|ac|edu)$/.test(labels.at(-2)!) ? 3 : 2
  return labels.slice(-n).join('.')
}

/** Costco-specialist product databases trusted as exact-SKU evidence (exact hostnames only). */
const SPECIALIST_HOSTS = new Set(['app.warehouserunner.com', 'warehouserunner.com'])

/**
 * Whether a search result is a Costco-specialist PRODUCT page for exactly this
 * item number: an exact trusted hostname and the path `/costco/<itemNumber>`,
 * optionally followed by `-<slug>` and/or a trailing slash. Category, store,
 * search and deal-list pages never qualify, and neither does another item's page.
 */
export function isSpecialistProductPage(itemNumber: string, url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || !SPECIALIST_HOSTS.has(u.hostname.toLowerCase())) return false
  const escaped = itemNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^/costco/${escaped}(-[^/]*)?/?$`).test(u.pathname)
}

const STOP = new Set(['COSTCO', 'WHOLESALE', 'ITEM', 'THE', 'AND', 'FOR', 'WITH', 'PACK', 'COUNT', 'SHOP', 'BUY', 'DEALS', 'DEAL', 'SALE', 'PRICE'])
/** Significant title words: letters, ≥ 3 characters, not boilerplate. */
const words = (title: string) => new Set(title.toUpperCase().split(/[^A-Z0-9]+/).filter((w) => w.length >= 3 && /[A-Z]/.test(w) && !STOP.has(w)))
/** Two titles agree when they share at least two significant words. */
export function titlesAgree(a: string, b: string): boolean {
  const wa = words(a)
  let shared = 0
  for (const w of words(b)) if (wa.has(w)) shared += 1
  return shared >= 2
}

/**
 * Picks the result that identifies exactly this item number: it must appear
 * as a whole number in the title, URL or snippet. Returns null when no
 * result mentions the item number. Evidence (and therefore confidence):
 * Costco's own page > a Costco-specialist product page for this item number
 * > two agreeing independent sites > one other site.
 */
export function pickCandidate(itemNumber: string, results: readonly SearchResult[]): Candidate | null {
  const escaped = itemNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const exact = new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`)
  const matching = results.filter((r) => exact.test(r.title) || exact.test(r.url) || exact.test(r.snippet))
  if (matching.length === 0) return null
  // One result per site: several pages (or subdomains) of one site are not independent sources.
  const bySite = new Map<string, SearchResult>()
  for (const r of matching) {
    const site = siteOf(hostOf(r.url))
    if (!bySite.has(site)) bySite.set(site, r)
  }
  const sources = bySite.size
  const costco = matching.find((r) => {
    const h = hostOf(r.url)
    return h === 'costco.com' || h.endsWith('.costco.com')
  })
  if (costco) return { result: costco, confidence: EVIDENCE_CONFIDENCE['costco.com'], evidence: 'costco.com', sources, corroboratingUrl: null }
  const specialist = matching.find((r) => isSpecialistProductPage(itemNumber, r.url))
  if (specialist) {
    return { result: specialist, confidence: EVIDENCE_CONFIDENCE['costco-specialist'], evidence: 'costco-specialist', sources, corroboratingUrl: null }
  }
  const [first, ...others] = [...bySite.values()]
  const agreeing = others.find((o) => titlesAgree(first!.title, o.title))
  if (agreeing) return { result: first!, confidence: EVIDENCE_CONFIDENCE.corroborated, evidence: 'corroborated', sources, corroboratingUrl: agreeing.url }
  return { result: first!, confidence: EVIDENCE_CONFIDENCE['single-source'], evidence: 'single-source', sources, corroboratingUrl: null }
}

/** "Kirkland Signature Organic Quinoa, 4.5 lbs | Costco" → "Kirkland Signature Organic Quinoa, 4.5 lbs". */
export function cleanProductTitle(title: string): string {
  let t = title.replace(/\s+/g, ' ').trim()
  for (let i = 0; i < 2; i++) {
    t = t.replace(/\s*[|–—-]\s*(costco(\s+wholesale)?(\.com)?|costco\s+(insider|business center|deals?)|warehouse\s*runner|amazon\.com|walmart\.com|reddit|instacart)\s*$/i, '').trim()
    t = t.replace(/\s*[|–—-]\s*image\s+\d+\s*$/i, '').trim()
  }
  t = t.replace(/^costco\s*[:|-]\s*/i, '').trim()
  return t.slice(0, 200)
}
