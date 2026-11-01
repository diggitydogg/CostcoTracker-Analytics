import { lazy, Suspense, type ComponentProps } from 'react'

/**
 * The dashboard is loaded as its own chunk, so the sign-in and management
 * screens stay small. Same origin only (CSP script-src 'self').
 */
const DashboardChunk = lazy(() => import('./Dashboard').then((m) => ({ default: m.Dashboard })))
const CloudDashboardChunk = lazy(() => import('./CloudDashboard').then((m) => ({ default: m.CloudDashboard })))

const loading = (
  <p role="status" className="py-10 text-center text-sm text-slate-600">
    Loading the dashboard…
  </p>
)

export function LazyDashboard(props: ComponentProps<typeof DashboardChunk>) {
  return (
    <Suspense fallback={loading}>
      <DashboardChunk {...props} />
    </Suspense>
  )
}

export function LazyCloudDashboard(props: ComponentProps<typeof CloudDashboardChunk>) {
  return (
    <Suspense fallback={loading}>
      <CloudDashboardChunk {...props} />
    </Suspense>
  )
}
