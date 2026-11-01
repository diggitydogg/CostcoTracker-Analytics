/**
 * Category engine: overrides first, then deterministic description rules,
 * then the explicit Uncategorized fallback. No network, no paid API.
 *
 * Overrides are keyed by itemNumber and live outside the purchase records, so
 * setting or removing one never changes historical data — only how the item
 * is grouped. A future AI suggester may only ever see itemNumber + description
 * (CategorySuggester), and its output must be stored as an override after the
 * user reviews it; this module never calls one.
 */
import { z } from 'zod'
import { DEFAULT_RULES, type CategoryRule } from './rules'
import { CATEGORY_IDS, UNCATEGORIZED, isValidAssignment, type CategoryId } from './taxonomy'

export type CategorySource = 'override' | 'rule' | 'fallback'

export type CategoryAssignment = {
  categoryId: CategoryId
  subcategoryId: string | null
  source: CategorySource
  /** Rule that matched (source "rule"), for explainability. */
  ruleId: string | null
  /** The phrase of that rule that matched. */
  matchedPhrase: string | null
}

export type CategoryOverride = { categoryId: CategoryId; subcategoryId?: string | null }
/** itemNumber → user-chosen category. */
export type CategoryOverrides = Readonly<Record<string, CategoryOverride>>

/** Future, optional and reviewable: may only receive item number + description. */
export type CategorySuggester = (item: { itemNumber: string; description: string }) => Promise<CategoryOverride | null>

/** Upper-cases and splits a description into alphanumeric tokens. */
export function tokenize(description: string): string[] {
  return description.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim().split(' ').filter(Boolean)
}

/** Display form of a description: trimmed, single spaces, original casing. */
export function normalizeDescription(description: string): string {
  return description.replace(/\s+/g, ' ').trim()
}

type CompiledPhrase = { text: string; tokens: { value: string; prefix: boolean }[]; atStart: boolean; atEnd: boolean }
type CompiledRule = { rule: CategoryRule; phrases: CompiledPhrase[] }

const compiledCache = new WeakMap<readonly CategoryRule[], CompiledRule[]>()

function compile(rules: readonly CategoryRule[]): CompiledRule[] {
  let compiled = compiledCache.get(rules)
  if (!compiled) {
    compiled = rules.map((rule) => ({
      rule,
      phrases: rule.phrases.map((text) => {
        // "^" / "$" anchor a phrase to the start / end of the description, so
        // "^KS BATH$" matches only a description that is exactly those tokens.
        const atStart = text.startsWith('^')
        const atEnd = text.endsWith('$')
        const body = text.slice(atStart ? 1 : 0, atEnd ? -1 : undefined)
        return {
          text,
          atStart,
          atEnd,
          tokens: body.split(' ').map((t) => (t.endsWith('*') ? { value: t.slice(0, -1), prefix: true } : { value: t, prefix: false })),
        }
      }),
    }))
    compiledCache.set(rules, compiled)
  }
  return compiled
}

function phraseMatches(tokens: readonly string[], phrase: CompiledPhrase): boolean {
  const n = phrase.tokens.length
  if (tokens.length < n) return false
  const first = phrase.atEnd ? tokens.length - n : 0
  const last = phrase.atStart ? 0 : tokens.length - n
  for (let start = Math.max(0, first); start <= last; start++) {
    let ok = true
    for (let k = 0; k < n; k++) {
      const want = phrase.tokens[k]!
      const got = tokens[start + k]!
      if (want.prefix ? !got.startsWith(want.value) : got !== want.value) {
        ok = false
        break
      }
    }
    if (ok) return true
  }
  return false
}

/** Applies the first matching rule to a description, or null. */
export function matchRules(
  description: string,
  rules: readonly CategoryRule[] = DEFAULT_RULES,
): { rule: CategoryRule; phrase: string } | null {
  const tokens = tokenize(description)
  if (tokens.length === 0) return null
  for (const { rule, phrases } of compile(rules)) {
    for (const phrase of phrases) {
      if (phraseMatches(tokens, phrase)) return { rule, phrase: phrase.text }
    }
  }
  return null
}

/**
 * Categorizes one item. `descriptions` are the item's description variants,
 * most recent first; the first one any rule matches decides.
 */
export function categorize(
  itemNumber: string,
  descriptions: readonly string[],
  overrides: CategoryOverrides = {},
  rules: readonly CategoryRule[] = DEFAULT_RULES,
): CategoryAssignment {
  const override = Object.prototype.hasOwnProperty.call(overrides, itemNumber) ? overrides[itemNumber] : undefined
  if (override && isValidAssignment(override.categoryId, override.subcategoryId)) {
    return {
      categoryId: override.categoryId,
      subcategoryId: override.subcategoryId ?? null,
      source: 'override',
      ruleId: null,
      matchedPhrase: null,
    }
  }
  for (const description of descriptions) {
    const match = matchRules(description, rules)
    if (match) {
      return {
        categoryId: match.rule.categoryId,
        subcategoryId: match.rule.subcategoryId ?? null,
        source: 'rule',
        ruleId: match.rule.id,
        matchedPhrase: match.phrase,
      }
    }
  }
  return { categoryId: UNCATEGORIZED, subcategoryId: null, source: 'fallback', ruleId: null, matchedPhrase: null }
}

// ── Override import/export (for a future review UI) ──────────────────────────

export const CATEGORY_OVERRIDES_FORMAT = 'costcotracker-category-overrides' as const

const overrideSchema = z
  .object({
    categoryId: z.enum(CATEGORY_IDS as [CategoryId, ...CategoryId[]]),
    subcategoryId: z.string().nullable().optional(),
  })
  .refine((o) => isValidAssignment(o.categoryId, o.subcategoryId), { error: 'Unknown subcategory for this category.' })

export const categoryOverridesFileSchema = z.object({
  format: z.literal(CATEGORY_OVERRIDES_FORMAT),
  version: z.literal(1),
  overrides: z.record(z.string().min(1), overrideSchema),
})

export function serializeCategoryOverrides(overrides: CategoryOverrides): string {
  const sorted = Object.fromEntries(Object.entries(overrides).sort(([a], [b]) => (a < b ? -1 : 1)))
  return JSON.stringify({ format: CATEGORY_OVERRIDES_FORMAT, version: 1, overrides: sorted }, null, 2)
}

export function parseCategoryOverrides(text: string): { ok: true; overrides: CategoryOverrides } | { ok: false; error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: 'The file is not valid JSON.' }
  }
  const result = categoryOverridesFileSchema.safeParse(raw)
  if (!result.success) return { ok: false, error: 'The file is not a valid category overrides file.' }
  return { ok: true, overrides: result.data.overrides as CategoryOverrides }
}

/** Returns a new overrides object; never mutates the input. Pass null to remove. */
export function withOverride(overrides: CategoryOverrides, itemNumber: string, value: CategoryOverride | null): CategoryOverrides {
  const next = { ...overrides }
  if (value === null) delete next[itemNumber]
  else next[itemNumber] = value
  return next
}
