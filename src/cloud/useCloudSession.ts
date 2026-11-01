import { useCallback, useEffect, useRef, useState } from 'react'
import { CloudApiError, type CloudApi } from './api'

export type CloudSessionState =
  | { kind: 'checking' }
  /** The API answered and nobody is signed in. `notice` explains why, e.g. an expired session. */
  | { kind: 'signed-out'; notice: string | null }
  | { kind: 'signed-in'; formatVersion: number | null }
  /** No cloud API at this address (e.g. opened from a plain static host or offline). */
  | { kind: 'unreachable'; message: string }

export type CloudSession = {
  state: CloudSessionState
  /** Resolves to an error message, or null on success. The key is never stored. */
  login(accessKey: string): Promise<string | null>
  logout(): Promise<void>
  logoutEverywhere(): Promise<string | null>
  /** Panels call this on a 401: the session ended elsewhere or expired. */
  sessionLost(): void
  recheck(): void
}

export function describeError(error: unknown): string {
  if (error instanceof CloudApiError) return error.message
  return 'Something went wrong. Please try again.'
}

export function useCloudSession(api: CloudApi): CloudSession {
  const [state, setState] = useState<CloudSessionState>({ kind: 'checking' })
  const [attempt, setAttempt] = useState(0)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [session, health] = await Promise.all([api.session(), api.health().catch(() => null)])
        if (cancelled) return
        setState(
          session.authenticated
            ? { kind: 'signed-in', formatVersion: health?.formatVersion ?? null }
            : { kind: 'signed-out', notice: null },
        )
      } catch (error) {
        if (cancelled) return
        setState({
          kind: 'unreachable',
          message:
            error instanceof CloudApiError && error.isNetwork
              ? 'Your cloud could not be reached. Check your connection, then try again.'
              : 'This site is not connected to a CostcoTracker cloud. You can still open an export file on this device.',
        })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [api, attempt])

  const login = useCallback(
    async (accessKey: string) => {
      try {
        await api.login(accessKey)
        const health = await api.health().catch(() => null)
        if (mounted.current) setState({ kind: 'signed-in', formatVersion: health?.formatVersion ?? null })
        return null
      } catch (error) {
        if (error instanceof CloudApiError) {
          if (error.code === 'invalid_credentials') return 'That access key is not correct.'
          if (error.code === 'too_many_attempts') return 'Too many failed attempts. Wait 15 minutes, then try again.'
          if (error.code === 'not_configured') {
            return 'Sign-in is not set up on this cloud yet. Add the access-key digest to the deployment, then try again.'
          }
        }
        return describeError(error)
      }
    },
    [api],
  )

  const logout = useCallback(async () => {
    try {
      await api.logout()
    } catch {
      // Signing out locally still matters if the request fails; the cookie expires on its own.
    }
    setState({ kind: 'signed-out', notice: 'You are signed out.' })
  }, [api])

  const logoutEverywhere = useCallback(async () => {
    try {
      await api.logoutEverywhere()
      setState({ kind: 'signed-out', notice: 'You are signed out on every browser.' })
      return null
    } catch (error) {
      return describeError(error)
    }
  }, [api])

  const sessionLost = useCallback(() => {
    setState({ kind: 'signed-out', notice: 'Your session ended. Sign in again to continue.' })
  }, [])

  const recheck = useCallback(() => {
    setState({ kind: 'checking' })
    setAttempt((n) => n + 1)
  }, [])

  return { state, login, logout, logoutEverywhere, sessionLost, recheck }
}
