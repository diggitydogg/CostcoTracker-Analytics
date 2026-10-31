import type { ImportError } from '../domain/import/importExport'

export function ImportErrorPanel({ error, onDismiss }: { error: ImportError; onDismiss: () => void }) {
  const hidden = error.totalIssueCount - error.issues.length
  return (
    <section
      role="alert"
      aria-labelledby="import-error-title"
      className="rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-950"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 id="import-error-title" className="text-base font-semibold">
          {error.message}
        </h3>
        <button type="button" onClick={onDismiss} className="rounded px-2 py-1 text-red-900 underline hover:bg-red-100">
          Dismiss
        </button>
      </div>
      <p className="mt-1">{error.hint}</p>
      {error.issues.length > 0 && (
        <>
          <ul className="mt-3 max-h-72 space-y-1 overflow-auto rounded border border-red-200 bg-white p-3 font-mono text-xs">
            {error.issues.map((issue, i) => (
              <li key={i} className="break-words">
                <span className="font-semibold">{issue.path}</span>: {issue.message}
              </li>
            ))}
          </ul>
          {hidden > 0 && <p className="mt-2">…and {hidden} more {hidden === 1 ? 'problem' : 'problems'}.</p>}
        </>
      )}
    </section>
  )
}
