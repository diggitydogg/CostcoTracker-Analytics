import { useCallback, useMemo, useRef, useState } from 'react'
import { matchRules } from '../../analytics/categories/engine'
import { batches, type CategorySuggestion, type SuggestRequestItem, type SuggestResponse } from '../../analytics/categories/suggestProtocol'
import { IDENTIFY_LIMITS, identityTexts, type IdentifyResponse, type ProductIdentity } from '../../analytics/products/identityProtocol'
import { AI_SUGGESTIONS } from './aiConfig'

/** Sends one batch (≤ 25 items) to the suggestion endpoint. */
export type BatchCategorySuggester = (items: SuggestRequestItem[]) => Promise<SuggestResponse>

/** Identifies one batch (≤ 10 items) by item number: cache first, then targeted web search. */
export type BatchIdentifier = (items: SuggestRequestItem[]) => Promise<IdentifyResponse>

export type SuggestionDecision = 'accepted' | 'changed' | 'left'

export type IdentificationSummary = {
  /** Items with a usable product identity (Costco.com or 2+ agreeing sources) found or confirmed this session. */
  identified: number
  /** Items with only one non-Costco source: shown as possible matches, never used for categorization. */
  provisional: number
  /** Of those, items the deterministic rules now categorize (no AI needed). */
  categorizedByRules: number
  /** Items no search result named by item number. */
  notFound: number
}

export type SuggestionSession = {
  /** Suggestions received in this review session, by item number. */
  suggestions: ReadonlyMap<string, CategorySuggestion>
  /** Items already sent (or being sent) in this session; never sent again unless they failed. */
  requested: ReadonlySet<string>
  /** Items whose batch failed, with the error shown to the owner. */
  failed: ReadonlyMap<string, string>
  decisions: ReadonlyMap<string, SuggestionDecision>
  running: boolean
  progress: { phase: 'identify' | 'suggest'; done: number; total: number } | null
  identification: IdentificationSummary
  /** Non-blocking notes from product identification (e.g. web search not configured). */
  notes: string[]
  errors: string[]
  usage: { requests: number; totalTokens: number | null }
  /** User-triggered only. Sends up to AI_SUGGESTIONS.maxItemsPerRun not-yet-requested items, one batch at a time. */
  run: (items: readonly SuggestRequestItem[], options?: { alreadyIdentified?: ReadonlySet<string> }) => Promise<void>
  /** Re-sends items whose batch failed (explicit user action). */
  retryFailed: (items: readonly SuggestRequestItem[]) => Promise<void>
  decide: (itemNumber: string, decision: SuggestionDecision) => void
}

/**
 * One AI review session (in memory, for as long as the dashboard is open).
 * Suggestions never touch analytics: only `decide` callers that write a
 * category override change anything, and that is the normal override path.
 */
export function useSuggestionSession(
  suggester: BatchCategorySuggester,
  identifier?: BatchIdentifier,
  onIdentities?: (found: ProductIdentity[]) => void,
): SuggestionSession {
  const [suggestions, setSuggestions] = useState<ReadonlyMap<string, CategorySuggestion>>(new Map())
  const [requested, setRequested] = useState<ReadonlySet<string>>(new Set())
  const [failed, setFailed] = useState<ReadonlyMap<string, string>>(new Map())
  const [decisions, setDecisions] = useState<ReadonlyMap<string, SuggestionDecision>>(new Map())
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<SuggestionSession['progress']>(null)
  const [identification, setIdentification] = useState<IdentificationSummary>({ identified: 0, provisional: 0, categorizedByRules: 0, notFound: 0 })
  const [notes, setNotes] = useState<string[]>([])
  const [errors, setErrors] = useState<string[]>([])
  const [usage, setUsage] = useState<{ requests: number; totalTokens: number | null }>({ requests: 0, totalTokens: null })
  // Synchronous guards: a double click can never send a batch twice.
  const requestedRef = useRef(new Set<string>())
  const runningRef = useRef(false)

  const process = useCallback(
    async (all: readonly SuggestRequestItem[], alreadyIdentified: ReadonlySet<string> = new Set()) => {
      if (runningRef.current || all.length === 0) return
      runningRef.current = true
      setRunning(true)
      setErrors([])
      setNotes([])
      for (const i of all) requestedRef.current.add(i.itemNumber)
      setRequested(new Set(requestedRef.current))
      let items: readonly SuggestRequestItem[] = all
      try {
        // Phase 1 — identify by item number (cache first, web search for unknown items).
        const toIdentify = identifier ? all.filter((i) => !alreadyIdentified.has(i.itemNumber)) : []
        if (identifier && toIdentify.length > 0) {
          setProgress({ phase: 'identify', done: 0, total: toIdentify.length })
          const found: ProductIdentity[] = []
          let notFound = 0
          let provisional = 0
          let done = 0
          for (const batch of batches(toIdentify, IDENTIFY_LIMITS.maxItemsPerRequest)) {
            try {
              const res = await identifier(batch)
              if (!res.searchConfigured) setNotes((n) => (n.some((x) => x.startsWith('Web search')) ? n : [...n, 'Web search is not set up, so only previously identified products were used.']))
              for (const r of res.results) {
                if (r.status === 'identified' || r.status === 'provisional') found.push(r)
                if (r.status === 'provisional') provisional += 1
                else if (r.status === 'not_found') notFound += 1
              }
            } catch (error) {
              // Identification is an optimization: on failure the AI step still runs.
              const message = error instanceof Error ? error.message : 'The request failed.'
              setNotes((n) => (n.includes(`Product lookup: ${message}`) ? n : [...n, `Product lookup: ${message}`]))
            }
            done += batch.length
            setProgress({ phase: 'identify', done, total: toIdentify.length })
          }
          onIdentities?.(found)
          // Items the deterministic rules can now categorize from the identified name skip the AI.
          const byRules = new Set(found.filter((f) => identityTexts(f).some((t) => matchRules(t) !== null)).map((f) => f.itemNumber))
          items = all.filter((i) => !byRules.has(i.itemNumber))
          setIdentification((s) => ({
            identified: s.identified + found.length - provisional,
            provisional: s.provisional + provisional,
            categorizedByRules: s.categorizedByRules + byRules.size,
            notFound: s.notFound + notFound,
          }))
        }
      } catch {
        items = all
      }
      if (items.length === 0) {
        runningRef.current = false
        setRunning(false)
        setProgress(null)
        return
      }
      // Phase 2 — AI suggestions for what the rules still cannot place (owner review unchanged).
      setFailed((f) => {
        const next = new Map(f)
        for (const i of items) next.delete(i.itemNumber)
        return next
      })
      setProgress({ phase: 'suggest', done: 0, total: items.length })
      let done = 0
      try {
        for (const batch of batches(items)) {
          try {
            const response = await suggester(batch)
            const wanted = new Set(batch.map((b) => b.itemNumber))
            setSuggestions((prev) => {
              const next = new Map(prev)
              for (const s of response.suggestions) if (wanted.has(s.itemNumber)) next.set(s.itemNumber, s)
              return next
            })
            setUsage((u) => ({
              requests: u.requests + 1,
              totalTokens: response.usage?.totalTokens === undefined ? u.totalTokens : (u.totalTokens ?? 0) + response.usage.totalTokens,
            }))
          } catch (error) {
            // Keep everything received so far; mark this batch as failed and carry on.
            const message = error instanceof Error ? error.message : 'The request failed.'
            for (const b of batch) requestedRef.current.delete(b.itemNumber)
            setRequested(new Set(requestedRef.current))
            setFailed((f) => {
              const next = new Map(f)
              for (const b of batch) next.set(b.itemNumber, message)
              return next
            })
            setErrors((e) => (e.includes(message) ? e : [...e, message]))
          }
          done += batch.length
          setProgress({ phase: 'suggest', done, total: items.length })
        }
      } finally {
        runningRef.current = false
        setRunning(false)
      }
    },
    [suggester, identifier, onIdentities],
  )

  const run = useCallback(
    (items: readonly SuggestRequestItem[], options: { alreadyIdentified?: ReadonlySet<string> } = {}) =>
      process(items.filter((i) => !requestedRef.current.has(i.itemNumber)).slice(0, AI_SUGGESTIONS.maxItemsPerRun), options.alreadyIdentified),
    [process],
  )

  const retryFailed = useCallback(
    (items: readonly SuggestRequestItem[]) =>
      // Retries only the AI step; these items were already identified (or not) in the first run.
      process(
        items.filter((i) => failed.has(i.itemNumber) && !requestedRef.current.has(i.itemNumber)).slice(0, AI_SUGGESTIONS.maxItemsPerRun),
        new Set(items.map((i) => i.itemNumber)),
      ),
    [process, failed],
  )

  const decide = useCallback((itemNumber: string, decision: SuggestionDecision) => {
    setDecisions((d) => new Map(d).set(itemNumber, decision))
  }, [])

  return useMemo(
    () => ({ suggestions, requested, failed, decisions, running, progress, identification, notes, errors, usage, run, retryFailed, decide }),
    [suggestions, requested, failed, decisions, running, progress, identification, notes, errors, usage, run, retryFailed, decide],
  )
}
