import { useCallback, useEffect, useState } from 'react'
import { useCloud } from './CloudContext'

/**
 * Loads data from the cloud API when mounted and whenever `reload()` is called.
 * Keeps the last good data visible if a refresh fails. `fetcher` must be stable
 * (wrap it in useCallback).
 */
export function useCloudResource<T>(fetcher: () => Promise<T>) {
  const { handle } = useCloud()
  const [version, setVersion] = useState(0)
  const [state, setState] = useState<{ data: T | null; error: string | null }>({ data: null, error: null })

  useEffect(() => {
    let cancelled = false
    fetcher().then(
      (data) => {
        if (!cancelled) setState({ data, error: null })
      },
      (error: unknown) => {
        if (!cancelled) setState((s) => ({ data: s.data, error: handle(error) }))
      },
    )
    return () => {
      cancelled = true
    }
  }, [fetcher, handle, version])

  const reload = useCallback(() => setVersion((v) => v + 1), [])
  return { data: state.data, error: state.error, reload }
}
