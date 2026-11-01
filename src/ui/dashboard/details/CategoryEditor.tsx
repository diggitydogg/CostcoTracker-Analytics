import { useState } from 'react'
import { CATEGORIES, categoryLabel, isValidAssignment, subcategoryLabel, type CategoryId, type ItemStats } from '../../../analytics'
import { useDashboard } from '../context'
import { Badge } from '../ui'

/**
 * Shows how an item is categorized and lets the owner override it. An
 * override is stored separately (by item number) and never changes a record;
 * the engine applies it when building the snapshot.
 */
export function CategoryEditor({ item }: { item: ItemStats }) {
  const { overrides } = useDashboard()
  const a = item.category
  const [categoryId, setCategoryId] = useState<CategoryId>(a.categoryId)
  const [subcategoryId, setSubcategoryId] = useState<string>(a.subcategoryId ?? '')
  const subs = (CATEGORIES.find((c) => c.id === categoryId)?.subcategories ?? []) as readonly { id: string; label: string }[]
  const sub = subcategoryId && subs.some((x) => x.id === subcategoryId) ? subcategoryId : null
  const unchanged = a.source === 'override' && a.categoryId === categoryId && (a.subcategoryId ?? null) === sub
  const current = `${categoryLabel(a.categoryId)}${a.subcategoryId ? ` › ${subcategoryLabel(a.categoryId, a.subcategoryId)}` : ''}`

  return (
    <div className="space-y-3 text-sm">
      <p className="flex flex-wrap items-center gap-2" data-testid="category-current">
        <span className="font-medium text-slate-900">{current}</span>
        {a.source === 'override' ? (
          <Badge tone="violet">Set manually</Badge>
        ) : a.source === 'rule' ? (
          <Badge>Automatic</Badge>
        ) : (
          <Badge tone="amber">No rule matched</Badge>
        )}
        {a.source === 'rule' && a.matchedPhrase && <span className="text-xs text-slate-500">matched “{a.matchedPhrase.replace(/\*/g, '…')}”</span>}
      </p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (isValidAssignment(categoryId, sub)) overrides.setOverride(item.itemNumber, { categoryId, subcategoryId: sub })
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="text-xs text-slate-500">Category</span>
          <select
            value={categoryId}
            onChange={(e) => {
              setCategoryId(e.target.value as CategoryId)
              setSubcategoryId('')
            }}
            className="rounded-md border border-slate-300 bg-white px-2 py-1.5"
          >
            {CATEGORIES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        {subs.length > 0 && (
          <label className="flex flex-col gap-1">
            <span className="text-xs text-slate-500">Subcategory</span>
            <select value={sub ?? ''} onChange={(e) => setSubcategoryId(e.target.value)} className="rounded-md border border-slate-300 bg-white px-2 py-1.5">
              <option value="">None</option>
              {subs.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="submit" disabled={unchanged} className="rounded-md bg-slate-900 px-3 py-1.5 font-medium text-white hover:bg-slate-800 disabled:opacity-40">
          Save category
        </button>
        {a.source === 'override' && (
          <button
            type="button"
            onClick={() => {
              overrides.setOverride(item.itemNumber, null)
            }}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 hover:bg-slate-100"
          >
            Use automatic category
          </button>
        )}
      </form>
      <p className="text-xs text-slate-500">
        {overrides.persistent
          ? 'Your choice is saved in this browser only and applies to every purchase of this item number. Purchase records are not changed.'
          : 'This browser cannot save your choice; it applies in this tab only. Purchase records are not changed.'}
      </p>
      {overrides.error && (
        <p role="status" className="text-xs text-amber-800">
          {overrides.error}
        </p>
      )}
    </div>
  )
}
