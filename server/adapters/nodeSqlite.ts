/**
 * node:sqlite adapter. Used by tests (real SQL, real migrations, no network)
 * and as the starting point for self-hosting off Cloudflare.
 */
import type { DatabaseSync } from 'node:sqlite'
import { translateDbError, type SqlDatabase, type SqlValue, type Statement } from '../db'

// Loaded at runtime (Node >= 22.3) rather than imported, so browser-oriented
// test bundles (jsdom UI tests driving the real API) can use this adapter too.
const builtin = <T,>(id: string): T => (process as unknown as { getBuiltinModule(id: string): T }).getBuiltinModule(id)

export type NodeSqlite = SqlDatabase & { raw: DatabaseSync; close(): void }

export function nodeSqliteDatabase(path = ':memory:'): NodeSqlite {
  const { DatabaseSync } = builtin<typeof import('node:sqlite')>('node:sqlite')
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
  const { readFileSync, readdirSync } = builtin<typeof import('node:fs')>('node:fs')
  const { join } = builtin<typeof import('node:path')>('node:path')
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  for (const file of files) db.raw.exec(readFileSync(join(dir, file), 'utf8'))
  return files
}

/** Applies already-loaded migration SQL (e.g. bundled with `?raw`), in order. */
export function applyMigrationSql(db: NodeSqlite, sqlTexts: string[]): void {
  for (const text of sqlTexts) db.raw.exec(text)
}
