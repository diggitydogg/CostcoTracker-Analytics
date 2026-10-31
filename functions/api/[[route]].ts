/**
 * Cloudflare Pages Function entry: the only Cloudflare-specific file.
 * Every request under /api/* is handled by the portable app in server/app.ts.
 */
import { d1Database, type D1DatabaseLike } from '../../server/adapters/d1'
import { createApp } from '../../server/app'

type Env = { DB: D1DatabaseLike; OWNER_ACCESS_KEY_SHA256?: string }

export const onRequest = (context: { request: Request; env: Env }): Promise<Response> => {
  const app = createApp({
    db: d1Database(context.env.DB),
    env: { OWNER_ACCESS_KEY_SHA256: context.env.OWNER_ACCESS_KEY_SHA256 },
  })
  return app(context.request)
}
