import { useId, useState, type FormEvent } from 'react'
import { Button, Notice } from './primitives'

/**
 * Owner sign-in with the access key. The key lives only in this form's state
 * while typing and is cleared as soon as it is submitted; it is never written
 * to storage. (A browser password manager may offer to save it; that is the
 * owner's choice and is where the key is meant to live.)
 */
export function LoginScreen({
  notice,
  onLogin,
  onOpenFile,
}: {
  notice: string | null
  onLogin: (accessKey: string) => Promise<string | null>
  onOpenFile: () => void
}) {
  const id = useId()
  const [accessKey, setAccessKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    const key = accessKey.trim()
    if (key.length === 0) {
      setError('Enter your access key.')
      return
    }
    setAccessKey('')
    setBusy(true)
    setError(null)
    const message = await onLogin(key)
    setBusy(false)
    if (message) setError(message)
  }

  return (
    <div className="mx-auto max-w-md space-y-5">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Sign in to your cloud</h2>
        <p className="mt-2 text-slate-700">
          Use the access key you created when you set up CostcoTracker Analytics. Only you can sign in; there are no
          other accounts.
        </p>
      </div>
      {notice && <Notice tone="info">{notice}</Notice>}
      <form onSubmit={submit} noValidate className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 @regular:p-5">
        <input type="text" name="username" autoComplete="username" value="owner" readOnly hidden />
        <label htmlFor={id} className="block text-sm font-medium">
          Access key
        </label>
        <input
          id={id}
          type="password"
          autoComplete="current-password"
          spellCheck={false}
          autoCapitalize="off"
          value={accessKey}
          onChange={(e) => setAccessKey(e.target.value)}
          aria-invalid={error !== null}
          aria-describedby={error ? `${id}-error` : undefined}
          className="block w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm"
        />
        {error && (
          <p id={`${id}-error`} role="alert" className="text-sm text-red-800">
            {error}
          </p>
        )}
        <Button type="submit" variant="primary" disabled={busy} className="w-full py-2">
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
      <p className="text-sm text-slate-600">
        Lost the key? Generate a new one with <code>npm run auth:generate-key</code> and replace the deployment secret.
        Browsers that are already signed in stay signed in until their session expires or you choose “Sign out
        everywhere”.
      </p>
      <p className="text-sm">
        <Button variant="quiet" className="px-0" onClick={onOpenFile}>
          Open an export file on this device instead
        </Button>
      </p>
    </div>
  )
}
