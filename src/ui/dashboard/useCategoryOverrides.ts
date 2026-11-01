import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { withOverride, type CategoryOverride, type CategoryOverrides } from '../../analytics'
import type { OverridesStore } from '../../persistence/overridesStore'
import type { OverridesState } from './context'

const EMPTY: CategoryOverrides = {}

/**
 * Category overrides kept in this browser (IndexedDB). Changes apply
 * immediately; saving happens in the background and a failure is reported
 * without losing the change for this tab.
 */
export function useCategoryOverrides(store: OverridesStore): OverridesState & { loaded: boolean } {
  const [overrides, setOverrides] = useState<CategoryOverrides>(EMPTY)
  const [loaded, setLoaded] = useState(!store.isAvailable())
  const [error, setError] = useState<string | null>(null)
  const latest = useRef(overrides)
  const touched = useRef(false)

  useEffect(() => {
    let cancelled = false
    if (!store.isAvailable()) return
    store.load().then((r) => {
      if (cancelled) return
      // A change made before loading finished wins over the stored value.
      if (r.status === 'loaded' && !touched.current) {
        latest.current = r.overrides
        setOverrides(r.overrides)
      }
      if (r.status === 'corrupt') setError('Saved category choices on this device could not be read and were ignored.')
      if (r.status === 'unavailable') setError('Category choices cannot be saved in this browser; they apply to this tab only.')
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [store])

  const setOverride = useCallback(
    (itemNumber: string, value: CategoryOverride | null) => {
      touched.current = true
      const next = withOverride(latest.current, itemNumber, value)
      latest.current = next
      setOverrides(next)
      if (store.isAvailable()) {
        store.save(next).then(
          () => setError(null),
          () => setError('Your category choice applies in this tab but could not be saved on this device.'),
        )
      }
    },
    [store],
  )

  const persistent = store.isAvailable()
  return useMemo(() => ({ overrides, setOverride, persistent, error, loaded }), [overrides, setOverride, persistent, error, loaded])
}
