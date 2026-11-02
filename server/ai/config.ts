/**
 * AI category suggestion settings — the ONE place to change the model.
 *
 * Provider: Cloudflare Workers AI, through the Pages Functions binding `AI`.
 * In production that binding is configured on the Pages project in the
 * Cloudflare dashboard (Settings → Bindings → Workers AI, name `AI`); see
 * docs/AI_CATEGORY_SUGGESTIONS.md. No third-party API keys.
 *
 * Model: Meta Llama 3.3 70B Instruct (FP8, fast) on Workers AI.
 * - Listed in Cloudflare's Workers AI JSON Mode documentation as supporting
 *   `response_format: { type: "json_schema", json_schema: <schema> }`, which
 *   this feature relies on for structured output. (Native `@cf/` models take
 *   the schema bare under `json_schema`, without OpenAI's `name` wrapper.)
 * - A generally available instruction-tuned model (not a beta or preview),
 *   large enough to recognize retail brands and Costco-style abbreviations.
 * To switch models, change CATEGORY_SUGGESTION_MODEL to another Workers AI
 * text-generation model that Cloudflare lists as supporting JSON Mode;
 * nothing else depends on it.
 */
export const CATEGORY_SUGGESTION_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast'

/**
 * Model used to normalize web-search results into a clean product name, brand
 * and product type (product identification). Same JSON-Mode model by default.
 */
export const PRODUCT_NORMALIZATION_MODEL = CATEGORY_SUGGESTION_MODEL

export const CATEGORY_SUGGESTION_MODEL_OPTIONS = {
  /** Low temperature: classification, not creativity. */
  temperature: 0.1,
  /** Enough for 25 short JSON entries. */
  max_tokens: 2048,
} as const

/**
 * Best-effort request limit per Workers isolate (no D1 schema change):
 * at most this many suggestion requests in the window. Each request is at
 * most 25 items, and the dashboard sends at most 4 requests per click.
 */
export const CATEGORY_SUGGESTION_RATE_LIMIT = { maxRequests: 12, windowMs: 5 * 60 * 1000 } as const

/**
 * Model that reads visual evidence from a product photo (photo matching).
 * Meta Llama 4 Scout 17B on Workers AI: natively multimodal (image + text),
 * generally available, no separate license-acceptance call. Runs in the
 * owner's own Cloudflare account like every other model here. The image is
 * passed as an OpenAI-style `image_url` data URI in the user message (one
 * adapter: server/products/photo.ts → buildEvidenceInput). Change only here.
 */
export const PHOTO_EVIDENCE_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct'

/** Best-effort per-isolate limits for owner-triggered photo matching (each click = 1 vision call + at most 1 search request). */
export const PHOTO_EVIDENCE_RATE_LIMIT = { maxRequests: 20, windowMs: 10 * 60 * 1000 } as const
export const PHOTO_SEARCH_RATE_LIMIT = { maxRequests: 20, windowMs: 10 * 60 * 1000 } as const
