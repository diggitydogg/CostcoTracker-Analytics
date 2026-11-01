import { normalizeWarehouse } from '../../../analytics'

/** Warehouse text for a return/adjustment row; the iOS placeholder "Warehouse" means the name was not recorded. */
export function warehouseText(raw: string | null): string {
  if (raw === null || normalizeWarehouse(raw) === '') return 'Warehouse not recorded'
  if (normalizeWarehouse(raw) === 'WAREHOUSE') return 'Warehouse not recorded'
  return raw.replace(/\s+/g, ' ').trim()
}
