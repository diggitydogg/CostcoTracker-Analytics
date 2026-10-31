import type { ImportIssue } from '../src/domain/import/importExport'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly issues: ImportIssue[] = [],
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

const SECURITY_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...SECURITY_HEADERS, ...headers } })
}

export function errorResponse(error: ApiError): Response {
  return json(
    {
      error: {
        code: error.code,
        message: error.message,
        ...(error.issues.length > 0 ? { issues: error.issues.slice(0, 50), totalIssueCount: error.issues.length } : {}),
        ...error.extra,
      },
    },
    error.status,
  )
}

/** Reads and parses a JSON body, refusing anything over `maxBytes` before parsing. */
export async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > maxBytes) throw new ApiError(413, 'payload_too_large', `Request body exceeds ${maxBytes} bytes.`)
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    throw new ApiError(413, 'payload_too_large', `Request body exceeds ${maxBytes} bytes.`)
  }
  try {
    return JSON.parse(text)
  } catch {
    // Never echo the body: it may contain purchase data.
    throw new ApiError(400, 'invalid_json', 'Request body is not valid JSON.')
  }
}

export function parseWith<T>(
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } },
  value: unknown,
  code = 'invalid_request',
): T {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  throw new ApiError(
    400,
    code,
    'The request body is invalid.',
    result.error.issues.map((i) => ({ path: i.path.map(String).join('.') || '(body)', message: i.message })),
  )
}
