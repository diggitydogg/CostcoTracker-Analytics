import { useCallback, useEffect, useState } from 'react'
import type { Device } from '../../cloud/api'
import { useCloud } from '../../cloud/CloudContext'
import { useCloudResource } from '../../cloud/useCloudResource'
import { formatDateTime, formatRelative, formatTime } from './format'
import { Button, ConfirmAction, EmptyState, Notice, Section } from './primitives'

type Code = { code: string; expiresAt: string }

export function DevicesPanel({ now = () => new Date() }: { now?: () => Date }) {
  const { api, handle } = useCloud()
  const fetcher = useCallback(async () => (await api.devices()).devices, [api])
  const { data: devices, error: loadError, reload } = useCloudResource(fetcher)
  const [actionError, setActionError] = useState<string | null>(null)
  const [code, setCode] = useState<Code | null>(null)
  const [creating, setCreating] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [, setTick] = useState(0)
  const error = actionError ?? loadError

  // Keep the "expires in" text current while a code is shown.
  useEffect(() => {
    if (!code) return
    const timer = setInterval(() => setTick((t) => t + 1), 15_000)
    return () => clearInterval(timer)
  }, [code])

  async function createCode() {
    setCreating(true)
    setNotice(null)
    try {
      setCode(await api.createEnrollmentCode())
      setActionError(null)
    } catch (e) {
      setActionError(handle(e))
    } finally {
      setCreating(false)
    }
  }

  async function revoke(device: Device) {
    try {
      await api.revokeDevice(device.id)
      setNotice(`“${device.name}” was disconnected. It can no longer sync.`)
      setActionError(null)
      reload()
    } catch (e) {
      setActionError(handle(e))
    }
  }

  const expired = code !== null && new Date(code.expiresAt).getTime() <= now().getTime()
  const active = devices?.filter((d) => d.revoked_at === null) ?? []
  const revoked = devices?.filter((d) => d.revoked_at !== null) ?? []

  return (
    <div className="space-y-4">
      <Section
        title="Connect an iPhone"
        description="CostcoTracker on your iPhone sends your purchase data to this cloud. To connect it, create a one-time code here and enter it in the app."
      >
        <div className="space-y-3">
          <Button variant="primary" onClick={() => void createCode()} disabled={creating}>
            {creating ? 'Creating code…' : code ? 'Create a new code' : 'Create connection code'}
          </Button>
          {code && (
            <div className="rounded-lg border border-sky-200 bg-sky-50 p-4" data-testid="enrollment-code">
              {expired ? (
                <p className="text-sm font-medium text-red-900">
                  This code has expired and can no longer be used. Create a new one.
                </p>
              ) : (
                <>
                  <p className="text-sm text-sky-950">Your connection code</p>
                  <p
                    className="mt-1 font-mono text-2xl font-semibold tracking-wider whitespace-nowrap text-slate-900 sm:text-4xl sm:tracking-widest"
                    aria-label={`Connection code ${code.code.split('').join(' ')}`}
                  >
                    {code.code}
                  </p>
                  <p className="mt-2 text-sm text-sky-950">
                    Expires at {formatTime(code.expiresAt)} ({formatRelative(code.expiresAt, now())}). Works once.
                  </p>
                  <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-slate-800">
                    <li>Open CostcoTracker on your iPhone.</li>
                    <li>Go to cloud sync settings and choose to connect.</li>
                    <li>Enter this code and give the iPhone a name.</li>
                  </ol>
                  <p className="mt-3 text-xs text-slate-600">
                    Cloud sync in the iPhone app arrives in a CostcoTracker update. Until then, codes simply expire unused.
                  </p>
                </>
              )}
            </div>
          )}
        </div>
      </Section>

      <Section title="Connected iPhones" actions={<Button onClick={reload}>Refresh</Button>}>
        <div className="space-y-3">
          {notice && <Notice tone="success">{notice}</Notice>}
          {error && <Notice tone="error">{error}</Notice>}
          {devices === null ? (
            !error && <p className="text-sm text-slate-600">Loading…</p>
          ) : active.length === 0 ? (
            <EmptyState>No iPhones are connected yet.</EmptyState>
          ) : (
            <ul className="space-y-3" aria-label="Connected iPhones">
              {active.map((d) => (
                <li key={d.id} className="space-y-2 rounded-md border border-slate-200 p-3 text-sm">
                  <div>
                    <p className="font-medium break-words">{d.name}</p>
                    <p className="text-slate-600">
                      Connected {formatDateTime(d.created_at)} · Last sync{' '}
                      {d.last_seen_at ? formatDateTime(d.last_seen_at) : 'not yet'}
                    </p>
                  </div>
                  <ConfirmAction
                    label="Disconnect"
                    confirmLabel={`Disconnect ${d.name}`}
                    question={
                      <>
                        Disconnect <strong>{d.name}</strong>? It stops syncing immediately. Data it already sent stays
                        in the cloud. To reconnect, create a new code.
                      </>
                    }
                    onConfirm={() => revoke(d)}
                  />
                </li>
              ))}
            </ul>
          )}
          {revoked.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer text-slate-700">Disconnected iPhones ({revoked.length})</summary>
              <ul className="mt-2 space-y-1 text-slate-600">
                {revoked.map((d) => (
                  <li key={d.id}>
                    {d.name} — disconnected {formatDateTime(d.revoked_at)}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </Section>
    </div>
  )
}
