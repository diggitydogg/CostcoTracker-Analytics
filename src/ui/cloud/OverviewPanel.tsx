import { useCallback, useEffect, useState } from 'react'
import type { Device, ExportMeta, SyncRun } from '../../cloud/api'
import { useCloud } from '../../cloud/CloudContext'
import { useCloudDataset } from '../../cloud/CloudDatasetContext'
import { useCloudResource } from '../../cloud/useCloudResource'
import { RUN_STATUS_LABEL, formatDateTime, plural } from './format'
import { Button, ConfirmAction, Notice, Section } from './primitives'

type Loaded = { meta: ExportMeta; lastRun: SyncRun | null; devices: Device[] }

export function OverviewPanel({
  formatVersion,
  onLogout,
  onLogoutEverywhere,
}: {
  formatVersion: number | null
  onLogout: () => Promise<void>
  onLogoutEverywhere: () => Promise<string | null>
}) {
  const { api } = useCloud()
  const [signOutError, setSignOutError] = useState<string | null>(null)
  const fetcher = useCallback(async (): Promise<Loaded> => {
    const [meta, runs, devices] = await Promise.all([api.exportMeta(), api.runs(1), api.devices()])
    return { meta, lastRun: runs.runs[0] ?? null, devices: devices.devices }
  }, [api])
  const { data, error, reload } = useCloudResource(fetcher)
  // Tell the dashboard's cached copy when the cloud has changed since it was loaded.
  const noteChangeSeq = useCloudDataset()?.noteChangeSeq
  const changeSeq = data?.meta.changeSeq
  useEffect(() => {
    if (changeSeq !== undefined) noteChangeSeq?.(changeSeq)
  }, [changeSeq, noteChangeSeq])

  const activeDevices = data?.devices.filter((d) => d.revoked_at === null) ?? []

  return (
    <div className="space-y-4">
      <Section
        title="Cloud status"
        description="Your analytics data is stored in your own Cloudflare account. Costco sign-in details stay on your iPhone."
        actions={<Button onClick={reload}>Refresh</Button>}
      >
        {error && <Notice tone="error">{error}</Notice>}
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm @regular:grid-cols-2">
          <Fact label="Connection" value={error ? 'Could not load status' : data ? 'Connected' : 'Checking…'} />
          <Fact label="Signed in as" value="Owner (this browser)" />
          <Fact label="Data format" value={formatVersion ? `Export version ${formatVersion}` : '—'} />
          <Fact label="iPhones connected" value={data ? plural(activeDevices.length, 'device') : '—'} />
          <Fact
            label="Last sync"
            value={
              data
                ? data.lastRun
                  ? `${formatDateTime(data.lastRun.started_at)} · ${RUN_STATUS_LABEL[data.lastRun.status]}`
                  : 'No syncs yet'
                : '—'
            }
          />
          <Fact label="Currency" value={data?.meta.currency ?? (data ? 'Not set yet' : '—')} />
        </dl>
      </Section>

      <Section title="Stored in the cloud" description="Counts of records currently kept in your cloud database.">
        {data ? (
          <dl className="grid grid-cols-2 gap-3 @wide:grid-cols-4" data-testid="cloud-counts">
            <Count label="Receipts / orders" value={data.meta.counts.receipts} />
            <Count label="Items" value={data.meta.counts.items} />
            <Count label="Returns" value={data.meta.counts.returns} />
            <Count label="Price adjustments" value={data.meta.counts.priceAdjustments} />
          </dl>
        ) : (
          !error && <p className="text-sm text-slate-600">Loading…</p>
        )}
        {data && data.meta.counts.tombstoned > 0 && (
          <p className="mt-3 text-sm text-slate-600">
            {plural(data.meta.counts.tombstoned, 'record')} no longer on your iPhone {data.meta.counts.tombstoned === 1 ? 'is' : 'are'}{' '}
            kept as history and left out of these counts and of backups.
          </p>
        )}
      </Section>

      <Section title="Sign out">
        <div className="flex flex-wrap items-start gap-3">
          <Button onClick={() => void onLogout()}>Sign out of this browser</Button>
          <ConfirmAction
            label="Sign out everywhere"
            confirmLabel="Sign out all browsers"
            question="This signs out every browser, including this one. Your iPhone stays connected."
            onConfirm={async () => setSignOutError(await onLogoutEverywhere())}
          />
        </div>
        {signOutError && (
          <div className="mt-3">
            <Notice tone="error">{signOutError}</Notice>
          </div>
        )}
      </Section>
    </div>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-slate-600">{label}</dt>
      <dd className="font-medium break-words">{value}</dd>
    </div>
  )
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-slate-200 p-3">
      <dt className="text-sm text-slate-600">{label}</dt>
      <dd className="mt-1 text-xl font-semibold tabular-nums">{value.toLocaleString()}</dd>
    </div>
  )
}
