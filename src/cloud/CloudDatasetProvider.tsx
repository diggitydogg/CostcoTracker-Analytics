import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { useCloud } from './CloudContext'
import { CloudDatasetContext, type CloudDatasetState } from './CloudDatasetContext'
import { identitiesResponseSchema, type ProductIdentities, type ProductIdentity } from '../analytics/products/identityProtocol'
import type { CloudApi } from './api'
import { fetchCloudDataset } from './cloudDataset'

/** Cached identities are optional: any failure (e.g. an older deployment) simply means none. */
async function loadIdentities(api: CloudApi): Promise<ProductIdentities> {
  try {
    const parsed = identitiesResponseSchema.safeParse(await api.productIdentities())
    return parsed.success ? Object.fromEntries(parsed.data.identities.map((i) => [i.itemNumber, i])) : {}
  } catch {
    return {}
  }
}

/** Holds the in-memory dataset cache described in CloudDatasetContext.ts. */
export function CloudDatasetProvider({ children }: { children: ReactNode }) {
  const { api, handle } = useCloud()
  const [state, setState] = useState<CloudDatasetState>({ dataset: null, loading: false, error: null, loadedAt: null, stale: false, identities: {} })
  const requested = useRef(false)
  const generation = useRef(0)
  const loadedSeq = useRef<number | null>(null)
  /** Generation of a fetch that was already in flight when the cloud changed. */
  const staleGeneration = useRef(-1)

  const fetchNow = useCallback(() => {
    requested.current = true
    const gen = ++generation.current
    setState((s) => ({ ...s, loading: true, error: null }))
    Promise.all([fetchCloudDataset(api), loadIdentities(api)]).then(
      ([dataset, identities]) => {
        if (gen !== generation.current) return
        loadedSeq.current = dataset.meta.changeSeq
        setState({ dataset, loading: false, error: null, loadedAt: new Date(), stale: staleGeneration.current === gen, identities })
      },
      (error: unknown) => {
        if (gen !== generation.current) return
        // Keep the last good copy visible if a reload fails.
        setState((s) => ({ ...s, loading: false, error: handle(error) }))
      },
    )
  }, [api, handle])

  const ensureLoaded = useCallback(() => {
    if (!requested.current) fetchNow()
  }, [fetchNow])

  const markStale = useCallback(() => {
    // A fetch already in flight may have read the cloud before the change.
    staleGeneration.current = generation.current
    setState((s) => (s.dataset && !s.stale ? { ...s, stale: true } : s))
  }, [])

  const noteChangeSeq = useCallback(
    (changeSeq: number) => {
      if (loadedSeq.current !== null && changeSeq > loadedSeq.current) markStale()
    },
    [markStale],
  )

  const addIdentities = useCallback((found: readonly ProductIdentity[]) => {
    if (found.length === 0) return
    setState((s) => ({ ...s, identities: { ...s.identities, ...Object.fromEntries(found.map((f) => [f.itemNumber, f])) } }))
  }, [])

  const removeIdentity = useCallback((itemNumber: string) => {
    setState((s) => {
      if (!(itemNumber in s.identities)) return s
      const rest = { ...s.identities }
      delete rest[itemNumber]
      return { ...s, identities: rest }
    })
  }, [])

  const value = useMemo(
    () => ({ ...state, ensureLoaded, reload: fetchNow, markStale, noteChangeSeq, addIdentities, removeIdentity }),
    [state, ensureLoaded, fetchNow, markStale, noteChangeSeq, addIdentities, removeIdentity],
  )
  return <CloudDatasetContext.Provider value={value}>{children}</CloudDatasetContext.Provider>
}

