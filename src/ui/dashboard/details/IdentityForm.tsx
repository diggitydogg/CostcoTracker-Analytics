import { useId, useState } from 'react'
import { OWNER_IDENTITY_LIMITS } from '../../../analytics/products/identityProtocol'
import type { IdentityFields } from '../context'

const btn = 'rounded-md px-2.5 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40'
const input = 'w-full min-w-0 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900'

const clean = (v: string) => v.replace(/\s+/g, ' ').trim()
const looksLikeLink = (v: string) => /:\/\/|^www\.|\bwww\.[a-z0-9-]+\./i.test(v)

/**
 * The owner's product identity for one item number: name (required), brand and
 * type (optional). Prefilled values are only a starting point; nothing is
 * saved until the owner submits.
 */
export function IdentityForm({
  itemName,
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  itemName: string
  initial: Partial<IdentityFields>
  submitLabel: string
  onSubmit: (fields: IdentityFields) => Promise<void>
  onCancel: () => void
}) {
  const id = useId()
  const [name, setName] = useState(initial.canonicalName ?? '')
  const [brand, setBrand] = useState(initial.brand ?? '')
  const [type, setType] = useState(initial.productType ?? '')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    const fields: IdentityFields = { canonicalName: clean(name), brand: clean(brand) || null, productType: clean(type) || null }
    if (!fields.canonicalName) return setError('Enter the product name.')
    if ([fields.canonicalName, fields.brand, fields.productType].some((v) => v && looksLikeLink(v))) return setError('Enter a product name, not a web address.')
    setSaving(true)
    setError(null)
    try {
      await onSubmit(fields)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save. Try again.')
      setSaving(false)
    }
  }

  return (
    <form
      aria-label={`Product identity for ${itemName}`}
      // Its own size container: in a narrow table cell or pane the fields stack; with room, brand and type sit side by side.
      className="@container mt-2 space-y-2 rounded-md border border-slate-200 bg-slate-50 p-2"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <div className="grid grid-cols-1 gap-2 @pair:grid-cols-2">
        <label htmlFor={`${id}-name`} className="flex flex-col text-xs text-slate-600 @pair:col-span-2">
          Product name (required)
          <input id={`${id}-name`} className={input} value={name} maxLength={OWNER_IDENTITY_LIMITS.maxNameLength} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label htmlFor={`${id}-brand`} className="flex flex-col text-xs text-slate-600">
          Brand (optional)
          <input id={`${id}-brand`} className={input} value={brand} maxLength={OWNER_IDENTITY_LIMITS.maxBrandLength} onChange={(e) => setBrand(e.target.value)} />
        </label>
        <label htmlFor={`${id}-type`} className="flex flex-col text-xs text-slate-600">
          Product type (optional)
          <input id={`${id}-type`} className={input} value={type} maxLength={OWNER_IDENTITY_LIMITS.maxTypeLength} onChange={(e) => setType(e.target.value)} placeholder="e.g. rain boots" />
        </label>
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-700">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-1.5">
        <button type="submit" disabled={saving} className={`${btn} bg-slate-900 text-white hover:bg-slate-800`}>
          {saving ? 'Saving…' : submitLabel}
        </button>
        <button type="button" disabled={saving} onClick={onCancel} className={`${btn} border border-slate-300 bg-white hover:bg-slate-100`}>
          Cancel
        </button>
      </div>
    </form>
  )
}
