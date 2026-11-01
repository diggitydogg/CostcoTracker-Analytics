import { useCallback, useEffect, useMemo } from 'react'
import { suggestResponseSchema, type SuggestRequestItem, type SuggestResponse } from '../../analytics/categories/suggestProtocol'
import { useCloud } from '../../cloud/CloudContext'
import { useCloudDataset } from '../../cloud/CloudDatasetContext'
import type { OverridesStore } from '../../persistence/overridesStore'
import { Button, Notice } from '../cloud/primitives'
import { Dashboard } from './Dashboard'

const timeFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' })

/**
 * Cloud dashboard. The owner's full normalized dataset comes from the
 * in-memory session cache (CloudDatasetProvider): the first visit loads it
 * through the existing owner-only export endpoints (one request per page,
 * never per record); later visits reuse it. "Reload dashboard" re-reads D1
 * only — it does not ask the iPhone to refresh from Costco.
 */
export function CloudDashboard({ overridesStore, today }: { overridesStore?: OverridesStore; today?: string }) {
  const cache = useCloudDataset()
  if (!cache) throw new Error('CloudDashboard must be used inside <CloudDatasetProvider>')
  const { dataset, loading, error, loadedAt, stale, ensureLoaded, reload } = cache
  const { api, handle } = useCloud()
  // Owner-only AI category suggestions. Errors become plain messages (a lost session signs out as usual).
  const suggester = useCallback(
    async (items: SuggestRequestItem[]): Promise<SuggestResponse> => {
      let raw: unknown
      try {
        raw = await api.suggestCategories(items)
      } catch (e) {
        throw new Error(handle(e), { cause: e })
      }
      const parsed = suggestResponseSchema.safeParse(raw)
      if (!parsed.success) throw new Error('The AI suggestion response was not in the expected format.')
      return parsed.data as SuggestResponse
    },
    [api, handle],
  )
  useEffect(() => ensureLoaded(), [ensureLoaded])

  const tombstoned = dataset?.meta.counts.tombstoned ?? 0
  const source = useMemo(() => ({ source: 'cloud' as const, excludedTombstonedRecords: tombstoned }), [tombstoned])
  const reloadButton = (
    <Button onClick={reload} disabled={loading} title="Downloads the latest data from your cloud. It does not refresh from Costco.">
      {loading && dataset ? 'Reloading…' : 'Reload dashboard'}
    </Button>
  )

  return (
    <div className="space-y-4">
      {error && <Notice tone="error">{error}</Notice>}
      {stale && !loading && (
        <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-sky-300 bg-sky-50 px-4 py-2.5 text-sm text-sky-950">
          <span>Your cloud has new data since this dashboard was loaded.</span>
          <Button variant="primary" onClick={reload}>
            Reload dashboard
          </Button>
        </div>
      )}
      {!dataset && !error && (
        <p role="status" className="py-10 text-center text-sm text-slate-600">
          Loading your data…
        </p>
      )}
      {!dataset && error && <div>{reloadButton}</div>}
      {dataset && (
        <Dashboard
          data={dataset.data}
          source={source}
          suggester={suggester}
          {...(overridesStore ? { overridesStore } : {})}
          {...(today ? { today } : {})}
          toolbar={
            <>
              {loadedAt && <span className="text-xs text-slate-500">Loaded {timeFmt.format(loadedAt)}</span>}
              {reloadButton}
            </>
          }
        />
      )}
    </div>
  )
}
