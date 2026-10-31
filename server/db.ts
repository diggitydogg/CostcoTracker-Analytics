/**
 * Minimal SQL interface the API is written against. Implementations:
 * - `adapters/d1.ts`        Cloudflare D1 (production, `wrangler pages dev`)
 * - `adapters/nodeSqlite.ts` node:sqlite (tests; self-hosting path)
 * A Postgres adapter would only need these four methods (§13).
 */
export type SqlValue = string | number | null
export type Statement = { sql: string; params: SqlValue[] }

export interface SqlDatabase {
  all<T>(sql: string, params?: SqlValue[]): Promise<T[]>
  first<T>(sql: string, params?: SqlValue[]): Promise<T | null>
  run(sql: string, params?: SqlValue[]): Promise<{ changes: number }>
  /** Runs all statements in one transaction: all apply or none do. */
  batch(statements: Statement[]): Promise<{ changes: number }[]>
}

/** A constraint (UNIQUE/CHECK/FOREIGN KEY) rejected a write. */
export class ConstraintError extends Error {
  override name = 'ConstraintError'
}

export function sql(text: string, ...params: SqlValue[]): Statement {
  return { sql: text, params }
}

export function translateDbError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error)
  if (/constraint failed|SQLITE_CONSTRAINT/i.test(message)) throw new ConstraintError(message)
  throw error
}
