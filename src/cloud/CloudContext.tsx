import { createContext, useCallback, useContext } from 'react'
import { CloudApiError, type CloudApi } from './api'

export type CloudContextValue = { api: CloudApi; sessionLost: () => void }

export const CloudContext = createContext<CloudContextValue | null>(null)

/**
 * Access to the API plus a `handle` helper: it reports a lost session to the
 * shell (which shows the sign-in screen) and turns other failures into a
 * user-facing message. Messages never contain purchase data.
 */
export function useCloud() {
  const value = useContext(CloudContext)
  if (!value) throw new Error('useCloud must be used inside <CloudContext.Provider>')
  const { api, sessionLost } = value
  const handle = useCallback(
    (error: unknown): string => {
      if (error instanceof CloudApiError && error.status === 401) {
        sessionLost()
        return 'Your session ended. Sign in again to continue.'
      }
      if (error instanceof CloudApiError) return error.message
      return 'Something went wrong. Please try again.'
    },
    [sessionLost],
  )
  return { api, handle }
}
