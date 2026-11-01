import { useCallback, useMemo } from 'react'
import { fetchCloudDataset } from '../../cloud/cloudDataset'
import { useCloud } from '../../cloud/CloudContext'
import { useCloudResource } from '../../cloud/useCloudResource'
import { Button, Notice } from '../cloud/primitives'
import { AnalyticsPreview } from './AnalyticsPreview'

/** Cloud tab: loads the owner's dataset once through the export endpoints and previews the analytics. */
export function CloudInsightsPanel() {
  const { api } = useCloud()
  const fetcher = useCallback(() => fetchCloudDataset(api), [api])
  const { data, error, reload } = useCloudResource(fetcher)
  const source = useMemo(
    () => ({ source: 'cloud' as const, excludedTombstonedRecords: data?.meta.counts.tombstoned ?? 0 }),
    [data],
  )
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={reload}>Refresh</Button>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {!data && !error && (
        <p role="status" className="text-sm text-slate-600">
          Loading your data…
        </p>
      )}
      {data && <AnalyticsPreview data={data.data} source={source} />}
    </div>
  )
}
