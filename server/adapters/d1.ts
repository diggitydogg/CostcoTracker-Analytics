import { translateDbError, type SqlDatabase, type SqlValue, type Statement } from '../db'

/** The subset of the Cloudflare D1 binding API this adapter uses. */
export interface D1PreparedStatementLike {
  bind(...values: SqlValue[]): D1PreparedStatementLike
  all<T>(): Promise<{ results: T[] }>
  first<T>(): Promise<T | null>
  run(): Promise<{ meta: { changes: number } }>
}
export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike
  batch(statements: D1PreparedStatementLike[]): Promise<{ meta: { changes: number } }[]>
}

export function d1Database(db: D1DatabaseLike): SqlDatabase {
  const prep = (s: string, p: SqlValue[] = []) => (p.length > 0 ? db.prepare(s).bind(...p) : db.prepare(s))
  return {
    async all<T>(s: string, p?: SqlValue[]) {
      try {
        return (await prep(s, p).all<T>()).results
      } catch (e) {
        return translateDbError(e)
      }
    },
    async first<T>(s: string, p?: SqlValue[]) {
      try {
        return await prep(s, p).first<T>()
      } catch (e) {
        return translateDbError(e)
      }
    },
    async run(s: string, p?: SqlValue[]) {
      try {
        return { changes: (await prep(s, p).run()).meta.changes }
      } catch (e) {
        return translateDbError(e)
      }
    },
    async batch(statements: Statement[]) {
      if (statements.length === 0) return []
      try {
        // D1 executes a batch as a single implicit transaction.
        const results = await db.batch(statements.map((st) => prep(st.sql, st.params)))
        return results.map((r) => ({ changes: r.meta.changes }))
      } catch (e) {
        return translateDbError(e)
      }
    },
  }
}
