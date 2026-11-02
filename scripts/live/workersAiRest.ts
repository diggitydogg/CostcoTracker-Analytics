/**
 * Local stand-in for the Pages `AI` binding, for the live validator only.
 *
 * Production calls `env.AI.run(model, input)`. This adapter sends the
 * IDENTICAL model id and input to the Workers AI REST endpoint
 * (POST https://api.cloudflare.com/client/v4/accounts/<account>/ai/run/<model>)
 * and returns the same `result` object the binding returns ({ response, usage }).
 * No prompt, schema, model or validation logic lives here — those stay in
 * server/products/identify.ts and server/ai/config.ts.
 *
 * Needs CLOUDFLARE_ACCOUNT_ID and a CLOUDFLARE_API_TOKEN with the
 * "Workers AI" permission (Read is enough to run models).
 */
import type { AiBinding } from '../../server/ai/categorySuggest'
import type { FetchFn } from '../../server/products/search'

export function workersAiRest(accountId: string, token: string, fetchImpl: FetchFn = (i, init) => fetch(i, init)): AiBinding {
  return {
    async run(model, input) {
      const res = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(input),
      })
      type Envelope = { success?: boolean; result?: unknown; errors?: { code?: number; message?: string }[] }
      const body = (await res.json().catch(() => null)) as Envelope | null
      if (!res.ok || !body?.success) {
        const detail = body?.errors?.map((e) => `${e.code ?? ''} ${e.message ?? ''}`.trim()).join('; ') ?? ''
        throw new Error(`workers_ai_http_${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`)
      }
      return body.result
    },
  }
}
