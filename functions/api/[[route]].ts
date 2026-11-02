/**
 * Cloudflare Pages Function entry: the only Cloudflare-specific file.
 * Every request under /api/* is handled by the portable app in server/app.ts.
 */
import { d1Database, type D1DatabaseLike } from '../../server/adapters/d1'
import type { AiBinding } from '../../server/ai/categorySuggest'
import { createApp } from '../../server/app'

/** Bindings from wrangler.toml / the Pages dashboard. `AI` (Workers AI) is optional. */
type Env = { DB: D1DatabaseLike; OWNER_ACCESS_KEY_SHA256?: string; AI?: AiBinding; SEARCH_API_KEY?: string }

export const onRequest = (context: { request: Request; env: Env }): Promise<Response> => {
  const app = createApp({
    db: d1Database(context.env.DB),
    env: {
      OWNER_ACCESS_KEY_SHA256: context.env.OWNER_ACCESS_KEY_SHA256,
      ...(context.env.AI ? { AI: context.env.AI } : {}),
      ...(context.env.SEARCH_API_KEY ? { SEARCH_API_KEY: context.env.SEARCH_API_KEY } : {}),
    },
  })
  return app(context.request)
}
