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

/**
 * Brave Search API adapter (https://api.search.brave.com, header
 * `X-Subscription-Token`). Requires the secret SEARCH_API_KEY.
 */
export function braveSearch(apiKey: string, fetchImpl: FetchFn = (i, init) => fetch(i, init)): WebSearch {
  return {
    name: 'brave',
    async search(query) {
      const qs = new URLSearchParams({ q: query, count: '8', safesearch: 'moderate', text_decorations: 'false' })
      const res = await fetchImpl(`https://api.search.brave.com/res/v1/web/search?${qs}`, {
        headers: { accept: 'application/json', 'x-subscription-token': apiKey },
      })
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

/**
 * The queries for one item, in order: item number plus receipt description,
 * then the quoted item number alone. Built only from those two values.
 */
export function searchQueries(itemNumber: string, receiptDescription: string): string[] {
  const desc = queryText(receiptDescription)
  return [`Costco ${itemNumber}${desc ? ` ${desc}` : ''}`, `Costco "${itemNumber}"`]
}

export type Candidate = { result: SearchResult; confidence: number }

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * Picks the result that identifies exactly this item number: it must appear
 * as a whole number in the title, URL or snippet. Costco's own pages rank
 * first. Returns null when no result mentions the item number.
 */
export function pickCandidate(itemNumber: string, results: readonly SearchResult[]): Candidate | null {
  const escaped = itemNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const exact = new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`)
  const matching = results.filter((r) => exact.test(r.title) || exact.test(r.url) || exact.test(r.snippet))
  if (matching.length === 0) return null
  const isCostco = (r: SearchResult) => /(^|\.)costco\.com$/.test(hostOf(r.url))
  const best = matching.find(isCostco) ?? matching[0]!
  // Corroboration by a second independent result raises confidence slightly.
  const corroborated = matching.length > 1
  const confidence = isCostco(best) ? 0.9 : corroborated ? 0.8 : 0.7
  return { result: best, confidence }
}

/** "Kirkland Signature Organic Quinoa, 4.5 lbs | Costco" → "Kirkland Signature Organic Quinoa, 4.5 lbs". */
export function cleanProductTitle(title: string): string {
  let t = title.replace(/\s+/g, ' ').trim()
  for (let i = 0; i < 2; i++) {
    t = t.replace(/\s*[|–—-]\s*(costco(\s+wholesale)?(\.com)?|costco\s+(insider|business center|deals?)|amazon\.com|walmart\.com|reddit|instacart)\s*$/i, '').trim()
  }
  t = t.replace(/^costco\s*[:|-]\s*/i, '').trim()
  return t.slice(0, 200)
}
