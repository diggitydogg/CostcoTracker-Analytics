import { useCallback, useMemo, useRef, useState } from 'react'
import { batches, type CategorySuggestion, type SuggestRequestItem, type SuggestResponse } from '../../analytics/categories/suggestProtocol'
import { AI_SUGGESTIONS } from './aiConfig'

/** Sends one batch (≤ 25 items) to the suggestion endpoint. */
export type BatchCategorySuggester = (items: SuggestRequestItem[]) => Promise<SuggestResponse>

export type SuggestionDecision = 'accepted' | 'changed' | 'left'

export type SuggestionSession = {
  /** Suggestions received in this review session, by item number. */
  suggestions: ReadonlyMap<string, CategorySuggestion>
  /** Items already sent (or being sent) in this session; never sent again unless they failed. */
  requested: ReadonlySet<string>
  /** Items whose batch failed, with the error shown to the owner. */
  failed: ReadonlyMap<string, string>
  decisions: ReadonlyMap<string, SuggestionDecision>
  running: boolean
  progress: { done: number; total: number } | null
  errors: string[]
  usage: { requests: number; totalTokens: number | null }
  /** User-triggered only. Sends up to AI_SUGGESTIONS.maxItemsPerRun not-yet-requested items, one batch at a time. */
  run: (items: readonly SuggestRequestItem[]) => Promise<void>
  /** Re-sends items whose batch failed (explicit user action). */
  retryFailed: (items: readonly SuggestRequestItem[]) => Promise<void>
  decide: (itemNumber: string, decision: SuggestionDecision) => void
}

/**
 * One AI review session (in memory, for as long as the dashboard is open).
 * Suggestions never touch analytics: only `decide` callers that write a
 * category override change anything, and that is the normal override path.
 */
export function useSuggestionSession(suggester: BatchCategorySuggester): SuggestionSession {
  const [suggestions, setSuggestions] = useState<ReadonlyMap<string, CategorySuggestion>>(new Map())
  const [requested, setRequested] = useState<ReadonlySet<string>>(new Set())
  const [failed, setFailed] = useState<ReadonlyMap<string, string>>(new Map())
  const [decisions, setDecisions] = useState<ReadonlyMap<string, SuggestionDecision>>(new Map())
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const [usage, setUsage] = useState<{ requests: number; totalTokens: number | null }>({ requests: 0, totalTokens: null })
  // Synchronous guards: a double click can never send a batch twice.
  const requestedRef = useRef(new Set<string>())
  const runningRef = useRef(false)

  const process = useCallback(
    async (items: readonly SuggestRequestItem[]) => {
      if (runningRef.current || items.length === 0) return
      runningRef.current = true
      setRunning(true)
      setErrors([])
      for (const i of items) requestedRef.current.add(i.itemNumber)
      setRequested(new Set(requestedRef.current))
      setFailed((f) => {
        const next = new Map(f)
        for (const i of items) next.delete(i.itemNumber)
        return next
      })
      setProgress({ done: 0, total: items.length })
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
          setProgress({ done, total: items.length })
        }
      } finally {
        runningRef.current = false
        setRunning(false)
      }
    },
    [suggester],
  )

  const run = useCallback(
    (items: readonly SuggestRequestItem[]) =>
      process(items.filter((i) => !requestedRef.current.has(i.itemNumber)).slice(0, AI_SUGGESTIONS.maxItemsPerRun)),
    [process],
  )

  const retryFailed = useCallback(
    (items: readonly SuggestRequestItem[]) => process(items.filter((i) => failed.has(i.itemNumber) && !requestedRef.current.has(i.itemNumber)).slice(0, AI_SUGGESTIONS.maxItemsPerRun)),
    [process, failed],
  )

  const decide = useCallback((itemNumber: string, decision: SuggestionDecision) => {
    setDecisions((d) => new Map(d).set(itemNumber, decision))
  }, [])

  return useMemo(
    () => ({ suggestions, requested, failed, decisions, running, progress, errors, usage, run, retryFailed, decide }),
    [suggestions, requested, failed, decisions, running, progress, errors, usage, run, retryFailed, decide],
  )
}
