/**
 * Product identification settings.
 *
 * Search provider: the Brave Search API, chosen because it is a plain HTTPS
 * JSON API usable from Cloudflare Pages Functions with a single secret.
 * Configure with the secret SEARCH_API_KEY (`wrangler pages secret put
 * SEARCH_API_KEY`, or the Pages dashboard → Settings → Variables and
 * Secrets). Without it, identification serves the local product catalog only and the
 * rest of the app is unaffected. Swapping providers means adding another
 * `WebSearch` adapter in search.ts and choosing it in `searchFromEnv`.
 */
import { braveSearch, type FetchFn, type WebSearch } from './search'

/** Best-effort per-isolate limit on identify requests (each ≤ 10 items, ≤ 30 Brave queries). */
export const IDENTIFY_RATE_LIMIT = { maxRequests: 10, windowMs: 10 * 60 * 1000 } as const

/** Best-effort per-isolate limit on owner catalog edits (confirm / edit / remove one item each). */
export const CATALOG_WRITE_RATE_LIMIT = { maxRequests: 60, windowMs: 10 * 60 * 1000 } as const

export function searchFromEnv(env: { SEARCH_API_KEY?: string | undefined }, fetchImpl?: FetchFn): WebSearch | null {
  const key = env.SEARCH_API_KEY?.trim()
  return key ? braveSearch(key, fetchImpl) : null
}
