import { useState, type ButtonHTMLAttributes, type ReactNode } from 'react'

type Variant = 'primary' | 'secondary' | 'danger' | 'quiet'

const VARIANT: Record<Variant, string> = {
  primary: 'bg-sky-700 text-white hover:bg-sky-800',
  secondary: 'border border-slate-300 bg-white text-slate-900 hover:bg-slate-100',
  danger: 'bg-red-700 text-white hover:bg-red-800',
  quiet: 'text-slate-700 underline hover:bg-slate-100',
}

export function Button({
  variant = 'secondary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      {...props}
      className={`rounded-md px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${VARIANT[variant]} ${className}`}
    />
  )
}

type Tone = 'info' | 'success' | 'warning' | 'error'
const TONE: Record<Tone, string> = {
  info: 'border-sky-300 bg-sky-50 text-sky-950',
  success: 'border-emerald-300 bg-emerald-50 text-emerald-950',
  warning: 'border-amber-300 bg-amber-50 text-amber-950',
  error: 'border-red-300 bg-red-50 text-red-950',
}

export function Notice({ tone, children, title }: { tone: Tone; children?: ReactNode; title?: string }) {
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`rounded-md border px-4 py-3 text-sm ${TONE[tone]}`}>
      {title && <p className="font-semibold">{title}</p>}
      {children && <div className={title ? 'mt-1' : ''}>{children}</div>}
    </div>
  )
}

export function Section({
  title,
  description,
  actions,
  children,
}: {
  title: string
  description?: ReactNode
  actions?: ReactNode
  children: ReactNode
}) {
  const id = `section-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
  return (
    <section aria-labelledby={id} className="rounded-lg border border-slate-200 bg-white p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id={id} className="text-base font-semibold">
            {title}
          </h3>
          {description && <div className="mt-1 text-sm text-slate-600">{description}</div>}
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  )
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="rounded-md border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-600">{children}</p>
}

/**
 * A dangerous action that needs an explicit second click. The confirmation
 * text states exactly what will happen.
 */
export function ConfirmAction({
  label,
  confirmLabel,
  question,
  onConfirm,
  disabled,
}: {
  label: string
  confirmLabel: string
  question: ReactNode
  onConfirm: () => Promise<void> | void
  disabled?: boolean
}) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  if (!confirming) {
    return (
      <Button variant="secondary" className="border-red-300 text-red-800 hover:bg-red-50" disabled={disabled} onClick={() => setConfirming(true)}>
        {label}
      </Button>
    )
  }
  return (
    <div className="flex w-full flex-wrap items-center gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-950">
      <span className="min-w-0 flex-1 basis-48">{question}</span>
      <Button
        variant="danger"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          try {
            await onConfirm()
          } finally {
            setBusy(false)
            setConfirming(false)
          }
        }}
      >
        {confirmLabel}
      </Button>
      <Button onClick={() => setConfirming(false)} disabled={busy}>
        Cancel
      </Button>
    </div>
  )
}
