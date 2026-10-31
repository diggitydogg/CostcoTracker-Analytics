import fixture from '../fixtures/synthetic-export-v1.json'

/** A fresh deep copy of the synthetic V1 fixture, safe to mutate in a test. */
export function syntheticExport(): Record<string, unknown> & {
  receipts: Record<string, unknown>[]
  items: Record<string, unknown>[]
  returns: Record<string, unknown>[]
  priceAdjustments: Record<string, unknown>[]
} {
  return structuredClone(fixture) as never
}

export function syntheticExportText(mutate?: (data: ReturnType<typeof syntheticExport>) => void): string {
  const data = syntheticExport()
  mutate?.(data)
  return JSON.stringify(data)
}
