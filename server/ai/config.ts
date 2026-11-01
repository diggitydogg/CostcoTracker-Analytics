/**
 * AI category suggestion settings — the ONE place to change the model.
 *
 * Provider: Cloudflare Workers AI, through the Pages Functions binding `AI`
 * (wrangler.toml `[ai] binding = "AI"`). No third-party API keys.
 *
 * Model: Meta Llama 3.1 70B Instruct on Workers AI.
 * - Listed by Cloudflare as supporting JSON Mode (`response_format` with a
 *   JSON Schema), which this feature relies on for structured output.
 * - A stable, generally available instruction-tuned model (not a beta or
 *   preview), and large enough to recognize retail brands and Costco-style
 *   abbreviations far better than 8B models.
 * To switch models, change CATEGORY_SUGGESTION_MODEL to another Workers AI
 * text-generation model that supports JSON Mode; nothing else depends on it.
 */
export const CATEGORY_SUGGESTION_MODEL = '@cf/meta/llama-3.1-70b-instruct'

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
