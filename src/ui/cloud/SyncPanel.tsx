import { useCallback, useEffect, useState } from 'react'
import type { Device, SyncRequest, SyncRun } from '../../cloud/api'
import { useCloud } from '../../cloud/CloudContext'
import { useCloudResource } from '../../cloud/useCloudResource'
import { REQUEST_STATUS_LABEL, RUN_STATUS_LABEL, formatDateTime, formatRelative, plural, runSummary } from './format'
import { Button, ConfirmAction, EmptyState, Notice, Section } from './primitives'

type Loaded = { requests: SyncRequest[]; runs: SyncRun[]; devices: Device[] }

const isOpen = (r: SyncRequest) => r.status === 'pending' || r.status === 'acknowledged'

export function SyncPanel({ pollMs = 15_000, onAddDevice }: { pollMs?: number; onAddDevice: () => void }) {
  const { api, handle } = useCloud()
  const fetcher = useCallback(async (): Promise<Loaded> => {
    const [requests, runs, devices] = await Promise.all([api.syncRequests(), api.runs(20), api.devices()])
    return { requests: requests.requests, runs: runs.runs, devices: devices.devices }
  }, [api])
  const { data, error: loadError, reload } = useCloudResource(fetcher)
  const [actionError, setActionError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const error = actionError ?? loadError

  const current = data?.requests.find(isOpen) ?? null

  // While a request is waiting, check back periodically (only while this page is open).
  useEffect(() => {
    if (!current || pollMs <= 0) return
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') reload()
    }, pollMs)
    return () => clearInterval(timer)
  }, [current, pollMs, reload])

  async function requestSync() {
    setBusy(true)
    setMessage(null)
    try {
      const result = await api.createSyncRequest()
      setMessage(
        result.created
          ? 'Request sent. Open CostcoTracker on your iPhone to start the sync.'
          : 'A request is already waiting for your iPhone. Open CostcoTracker to start it.',
      )
      setActionError(null)
      reload()
    } catch (e) {
      setActionError(handle(e))
    } finally {
      setBusy(false)
    }
  }

  const activeDevices = data?.devices.filter((d) => d.revoked_at === null) ?? []
  const deviceName = (id: string | null) => data?.devices.find((d) => d.id === id)?.name ?? 'iPhone'

  return (
    <div className="space-y-4">
      <Section
        title="Refresh from Costco"
        description={
          <>
            Your iPhone is the only place that signs in to Costco. This button leaves a request for CostcoTracker;
            your iPhone picks it up the next time the app is open (and sometimes in the background, when iOS allows).
            This website cannot wake your phone.
          </>
        }
      >
        <div className="space-y-3">
          {data && activeDevices.length === 0 && (
            <Notice tone="warning" title="No iPhone is connected yet">
              A request will wait until you connect CostcoTracker.{' '}
              <Button variant="quiet" className="px-0" onClick={onAddDevice}>
                Connect an iPhone
              </Button>
            </Notice>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="primary" onClick={() => void requestSync()} disabled={busy || data === null}>
              {busy ? 'Sending request…' : 'Refresh from Costco'}
            </Button>
            <Button onClick={reload}>Check status</Button>
          </div>
          {message && current && <Notice tone="success">{message}</Notice>}
          {error && <Notice tone="error">{error}</Notice>}
          {current && <CurrentRequest request={current} />}
        </div>
      </Section>

      <Section title="Sync history" description="Each time your iPhone (or an import from this website) sent data.">
        {!data ? (
          !error && <p className="text-sm text-slate-600">Loading…</p>
        ) : data.runs.length === 0 ? (
          <EmptyState>No syncs yet. They will appear here after CostcoTracker sends data, or after you import a file.</EmptyState>
        ) : (
          <ul className="space-y-3" aria-label="Sync history">
            {data.runs.map((run) => (
              <RunItem
                key={run.id}
                run={run}
                source={run.source === 'web-import' ? null : deviceName(run.device_id)}
                onConfirmRemovals={async () => {
                  try {
                    await api.confirmRemovals(run.id)
                    setActionError(null)
                    reload()
                  } catch (e) {
                    setActionError(handle(e))
                  }
                }}
              />
            ))}
          </ul>
        )}
      </Section>

      <Section title="Refresh requests" description="Requests expire if no iPhone picks them up within 7 days.">
        {!data ? null : data.requests.length === 0 ? (
          <EmptyState>No refresh requests yet.</EmptyState>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm" aria-label="Refresh requests">
            {data.requests.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>{formatDateTime(r.requested_at)}</span>
                <StatusBadge tone={requestTone(r.status)}>{REQUEST_STATUS_LABEL[r.status]}</StatusBadge>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}

function CurrentRequest({ request }: { request: SyncRequest }) {
  return request.status === 'pending' ? (
    <Notice tone="info" title="Waiting for CostcoTracker on your iPhone">
      Requested {formatRelative(request.requested_at)}. Open CostcoTracker on your iPhone to start the sync. This page
      checks back automatically while it is open.
    </Notice>
  ) : (
    <Notice tone="info" title="Your iPhone is syncing">
      CostcoTracker picked up the request{request.acknowledged_at ? ` ${formatRelative(request.acknowledged_at)}` : ''}.
      New data will appear in the sync history when it finishes.
    </Notice>
  )
}

function requestTone(status: SyncRequest['status']): 'neutral' | 'good' | 'warn' | 'bad' {
  return status === 'fulfilled' ? 'good' : status === 'expired' ? 'bad' : 'warn'
}

function StatusBadge({ tone, children }: { tone: 'neutral' | 'good' | 'warn' | 'bad'; children: string }) {
  const cls = {
    neutral: 'bg-slate-100 text-slate-800',
    good: 'bg-emerald-100 text-emerald-900',
    warn: 'bg-amber-100 text-amber-900',
    bad: 'bg-red-100 text-red-900',
  }[tone]
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${cls}`}>{children}</span>
}

function RunItem({
  run,
  source,
  onConfirmRemovals,
}: {
  run: SyncRun
  /** Device name, or null for a file imported through the website. */
  source: string | null
  onConfirmRemovals: () => Promise<void>
}) {
  const tone = run.status === 'completed' ? 'good' : run.status === 'needs_review' ? 'warn' : run.status === 'open' ? 'neutral' : 'bad'
  const pending = run.pendingRemovals
  const pendingTotal = pending ? pending.receipts + pending.returns + pending.priceAdjustments : 0
  return (
    <li className="rounded-md border border-slate-200 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{formatDateTime(run.started_at)}</span>
        <StatusBadge tone={tone}>{RUN_STATUS_LABEL[run.status]}</StatusBadge>
      </div>
      <p className="mt-1 text-slate-600">
        {source === null ? 'Imported from a file on this website' : `${source} · ${run.mode === 'full' ? 'Full check' : 'Quick sync'}`}
      </p>
      <p className="mt-1 tabular-nums">{runSummary(run)}</p>
      {run.status === 'needs_review' && pending && (
        <div className="mt-3 space-y-2">
          <Notice tone="warning" title={`${plural(pendingTotal, 'record')} disappeared from your iPhone`}>
            This full check found far fewer records than the cloud holds ({plural(pending.receipts, 'receipt')},{' '}
            {plural(pending.returns, 'return')}, {plural(pending.priceAdjustments, 'price adjustment')} missing). That
            can happen after reinstalling or restoring the app. Nothing was removed. If you are sure these records are
            gone for good, mark them as no longer on your iPhone; they stay in the cloud as history.
          </Notice>
          <ConfirmAction
            label="Review missing records"
            confirmLabel={`Mark ${plural(pendingTotal, 'record')} as gone`}
            question="They will be left out of counts and backups. A later sync that includes them brings them back."
            onConfirm={onConfirmRemovals}
          />
        </div>
      )}
    </li>
  )
}
