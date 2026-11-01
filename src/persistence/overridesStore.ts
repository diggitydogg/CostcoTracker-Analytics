/**
 * On-device persistence for category overrides (itemNumber → category).
 *
 * Overrides are user settings, not purchase data: they never modify an
 * imported record, and they are applied by the analytics engine at snapshot
 * time. They are kept in this browser's IndexedDB (the app database, so
 * "Forget imported data" removes them too), never uploaded, and stored in the
 * engine's versioned overrides-file format so they are validated on load.
 */
import { parseCategoryOverrides, serializeCategoryOverrides, type CategoryOverrides } from '../analytics'
import { SETTINGS_STORE, withAppStore } from './appDb'

const KEY = 'categoryOverrides'

export type OverridesLoadResult =
  | { status: 'loaded'; overrides: CategoryOverrides }
  | { status: 'none' }
  | { status: 'unavailable' }
  | { status: 'corrupt' }

export type OverridesStore = {
  isAvailable(): boolean
  load(): Promise<OverridesLoadResult>
  save(overrides: CategoryOverrides): Promise<void>
}

export function createOverridesStore(factory: IDBFactory | null = globalThis.indexedDB ?? null): OverridesStore {
  return {
    isAvailable: () => factory !== null,
    async load() {
      if (!factory) return { status: 'unavailable' }
      let raw: unknown
      try {
        raw = await withAppStore(factory, SETTINGS_STORE, 'readonly', (s) => s.get(KEY))
      } catch {
        return { status: 'unavailable' }
      }
      if (raw === undefined) return { status: 'none' }
      if (typeof raw !== 'string') return { status: 'corrupt' }
      const parsed = parseCategoryOverrides(raw)
      return parsed.ok ? { status: 'loaded', overrides: parsed.overrides } : { status: 'corrupt' }
    },
    async save(overrides) {
      await withAppStore(factory, SETTINGS_STORE, 'readwrite', (s) => s.put(serializeCategoryOverrides(overrides), KEY))
    },
  }
}
