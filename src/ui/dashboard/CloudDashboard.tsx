import { useCallback, useMemo } from 'react'
import { fetchCloudDataset } from '../../cloud/cloudDataset'
import { useCloud } from '../../cloud/CloudContext'
import { useCloudResource } from '../../cloud/useCloudResource'
import type { OverridesStore } from '../../persistence/overridesStore'
import { Button, Notice } from '../cloud/primitives'
import { Dashboard } from './Dashboard'

/**
 * Cloud dashboard: loads the owner's full normalized dataset once through the
 * existing owner-only export endpoints (one request per page, never per
 * record), then hands it to the same Dashboard used for local files.
 */
export function CloudDashboard({ overridesStore, today }: { overridesStore?: OverridesStore; today?: string }) {
  const { api } = useCloud()
  const fetcher = useCallback(() => fetchCloudDataset(api), [api])
  const { data, error, reload } = useCloudResource(fetcher)
  const tombstoned = data?.meta.counts.tombstoned ?? 0
  const source = useMemo(() => ({ source: 'cloud' as const, excludedTombstonedRecords: tombstoned }), [tombstoned])
  return (
    <div className="space-y-4">
      {error && <Notice tone="error">{error}</Notice>}
      {!data && !error && (
        <p role="status" className="py-10 text-center text-sm text-slate-600">
          Loading your data…
        </p>
      )}
      {data && (
        <Dashboard
          data={data.data}
          source={source}
          {...(overridesStore ? { overridesStore } : {})}
          {...(today ? { today } : {})}
          toolbar={<Button onClick={reload}>Refresh</Button>}
        />
      )}
    </div>
  )
}
