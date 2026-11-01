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
