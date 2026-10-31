/**
 * node:sqlite adapter. Used by tests (real SQL, real migrations, no network)
 * and as the starting point for self-hosting off Cloudflare.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { translateDbError, type SqlDatabase, type SqlValue, type Statement } from '../db'

export type NodeSqlite = SqlDatabase & { raw: DatabaseSync; close(): void }

export function nodeSqliteDatabase(path = ':memory:'): NodeSqlite {
  const raw = new DatabaseSync(path)
  raw.exec('PRAGMA foreign_keys = ON') // D1 enforces foreign keys by default.
  const call = <T>(fn: () => T): T => {
    try {
      return fn()
    } catch (e) {
      return translateDbError(e)
    }
  }
  return {
    raw,
    close: () => raw.close(),
    async all<T>(s: string, p: SqlValue[] = []) {
      return call(() => raw.prepare(s).all(...p) as T[])
    },
    async first<T>(s: string, p: SqlValue[] = []) {
      return call(() => (raw.prepare(s).get(...p) as T | undefined) ?? null)
    },
    async run(s: string, p: SqlValue[] = []) {
      return call(() => ({ changes: Number(raw.prepare(s).run(...p).changes) }))
    },
    async batch(statements: Statement[]) {
      return call(() => {
        raw.exec('BEGIN')
        try {
          const out = statements.map((st) => ({ changes: Number(raw.prepare(st.sql).run(...st.params).changes) }))
          raw.exec('COMMIT')
          return out
        } catch (e) {
          raw.exec('ROLLBACK')
          throw e
        }
      })
    },
  }
}

/** Applies `migrations/*.sql` in name order (what `wrangler d1 migrations apply` does). */
export function applyMigrations(db: NodeSqlite, dir: string): string[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  for (const file of files) db.raw.exec(readFileSync(join(dir, file), 'utf8'))
  return files
}
