import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { buildSuggestionItems } from '../../analytics/categories/suggestProtocol'
import {
  canSaveIdentity,
  combineEvidence,
  confidenceLabel,
  confirmMatch,
  decide,
  evidenceFromText,
  matchLocal,
  mergeExternal,
  needsExternal,
  photoSearchRequest,
  type ConfirmedPhotoMatch,
  type MatchableItem,
  type MatchSource,
  type PhotoEvidence,
  type PhotoMatchCandidate,
  type PhotoMatchResult,
} from '../../analytics/products/photoMatch'
import { useDashboard } from '../dashboard/context'
import { IdentityForm } from '../dashboard/details/IdentityForm'
import { count, date, share } from '../dashboard/format'
import { Badge } from '../dashboard/ui'
import { ModalSheet } from '../layout/ModalSheet'
import { browserDeviceReader, type DeviceReader } from './deviceReader'
import type { OnDeviceRead } from './onDevice'
import { PhotoInputError } from './prepareImage'

type Image = { dataUrl: string; canvas?: HTMLCanvasElement }
type Step =
  | { kind: 'pick'; notice?: string }
  | { kind: 'working'; image: Image | null; label: string; progress: number | null }
  | { kind: 'result'; image: Image | null; result: PhotoMatchResult; aiUsed: boolean; searchNote: string | null }

const btn = 'inline-flex min-h-11 items-center justify-center rounded-md px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40'
const primary = `${btn} bg-slate-900 text-white hover:bg-slate-800`
const secondary = `${btn} border border-slate-300 bg-white text-slate-900 hover:bg-slate-100`

const SOURCE_TEXT: Record<MatchSource, string> = {
  'on-device': 'text or barcode read on this device',
  typed: 'text you typed',
  image: 'AI description of the photo',
  'local-catalog': 'your purchases and catalog',
  external: 'a Costco product listing',
}

/**
 * Find an item from a photo (cloud mode). A blocking task, so a modal sheet at
 * every width. Deterministic evidence first: barcodes and text are read on
 * this device and matched against the owner's own purchases in the browser.
 * Only if that cannot identify the item — and only when the owner asks — the
 * photo goes to Workers AI in the owner's Cloudflare account; a web search
 * with the generic product text follows only if still needed. Nothing is
 * saved unless the owner confirms; existing identities are never overwritten.
 */
export function PhotoMatchSheet({
  onClose,
  onOpenItem,
  device = browserDeviceReader,
  now = () => new Date(),
}: {
  onClose: () => void
  onOpenItem: (match: ConfirmedPhotoMatch) => void
  device?: DeviceReader
  now?: () => Date
}) {
  const { s, photo, catalog } = useDashboard()
  const [step, setStep] = useState<Step>({ kind: 'pick' })
  const [saving, setSaving] = useState<string | null>(null)
  const [typed, setTyped] = useState('')
  const cameraRef = useRef<HTMLInputElement>(null)
  const libraryRef = useRef<HTMLInputElement>(null)
  const ids = useId()
  // The run in flight; a newer action (or closing) makes older results stale.
  const runRef = useRef(0)
  // The device evidence of the current photo, kept so the AI step can add to it.
  const deviceEvidence = useRef<PhotoEvidence | null>(null)

  useEffect(() => () => device.release(), [device])

  const items = useMemo<MatchableItem[]>(
    () => s.items.items.map((i) => ({ itemNumber: i.itemNumber, descriptions: i.descriptions, identity: i.identity, purchaseEvents: i.purchaseEvents, lastPurchaseDate: i.lastPurchaseDate })),
    [s],
  )

  const finish = useCallback(
    (run: number, image: Image | null, result: PhotoMatchResult, aiUsed: boolean, searchNote: string | null = null) => {
      if (run === runRef.current) setStep({ kind: 'result', image, result, aiUsed, searchNote })
    },
    [],
  )

  /** Stage 1a + 2: read on the device, match locally. No network. */
  const analyzeOnDevice = async (file: File) => {
    const run = ++runRef.current
    setStep({ kind: 'working', image: null, label: 'Preparing the photo…', progress: null })
    let image: Image
    try {
      image = await device.prepare(file)
    } catch (e) {
      if (run === runRef.current) setStep({ kind: 'pick', notice: e instanceof PhotoInputError ? e.message : 'That photo could not be opened. Try another one.' })
      return
    }
    if (run !== runRef.current) return
    setStep({ kind: 'working', image, label: 'Reading text and barcodes on this device…', progress: 0 })
    let read: OnDeviceRead = { lines: [], barcodes: [] }
    try {
      read = await device.read(image, (p) => run === runRef.current && setStep({ kind: 'working', image, label: 'Reading text and barcodes on this device…', progress: p }))
    } catch {
      // On-device reading unavailable (e.g. the OCR files could not load): carry on with nothing read.
    }
    const evidence = evidenceFromText(read.lines, read.barcodes, 'on-device')
    deviceEvidence.current = evidence
    finish(run, image, decide(evidence, matchLocal(evidence, items), false), false)
  }

  /** Stage 1b + 2 + 3: only on request — AI description of the photo, then (if still needed) search. */
  const analyzeWithAi = async (image: Image) => {
    if (!photo) return
    const run = ++runRef.current
    setStep({ kind: 'working', image, label: 'Analyzing the photo in your Cloudflare account…', progress: null })
    let evidence: PhotoEvidence
    try {
      const ai = await photo.evidence(image.dataUrl)
      evidence = deviceEvidence.current ? combineEvidence(deviceEvidence.current, ai) : ai
    } catch (e) {
      const previous = deviceEvidence.current
      if (run === runRef.current) {
        const fallback = previous ? decide(previous, matchLocal(previous, items), false) : null
        if (fallback) setStep({ kind: 'result', image, result: fallback, aiUsed: false, searchNote: `Photo analysis failed: ${e instanceof Error ? e.message : 'please try again.'}` })
      }
      return
    }
    const local = matchLocal(evidence, items)
    const query = photoSearchRequest(evidence)
    if (!needsExternal(evidence, local) || !query) return finish(run, image, decide(evidence, local, false), true)
    setStep({ kind: 'working', image, label: 'Searching Costco product listings…', progress: null })
    try {
      const found = await photo.search(query)
      if (!found.searchConfigured) return finish(run, image, decide(evidence, local, false), true, 'Web search is not set up on this cloud, so only your purchases were checked.')
      finish(run, image, decide(evidence, mergeExternal(evidence, local, found.candidates, items), true), true)
    } catch (e) {
      finish(run, image, decide(evidence, local, false), true, `The product search failed (${e instanceof Error ? e.message : 'try again later'}); only your purchases were checked.`)
    }
  }

  /** Deterministic fallback: the item number or text the owner types (e.g. from Live Text). */
  const analyzeTyped = () => {
    const text = typed.trim()
    if (!text) return
    const run = ++runRef.current
    const evidence = evidenceFromText([text], [], 'typed')
    deviceEvidence.current = null
    finish(run, null, decide(evidence, matchLocal(evidence, items), false), false)
  }

  const reset = () => {
    runRef.current++
    deviceEvidence.current = null
    setSaving(null)
    setStep({ kind: 'pick' })
  }

  const open = (c: PhotoMatchCandidate) => {
    const m = confirmMatch(c, now())
    if (m) onOpenItem(m)
  }

  const receiptText = (itemNumber: string) =>
    buildSuggestionItems([{ itemNumber, descriptions: s.items.byItemNumber.get(itemNumber)?.descriptions ?? [] }])[0]?.descriptions[0] ?? null

  const onFile = (input: HTMLInputElement | null) => {
    const file = input?.files?.[0]
    if (input) input.value = '' // allow choosing the same photo again
    if (file) void analyzeOnDevice(file)
  }

  const pickers = (
    <div className="flex flex-wrap gap-2">
      <button type="button" className={primary} onClick={() => cameraRef.current?.click()}>
        Take photo
      </button>
      <button type="button" className={secondary} onClick={() => libraryRef.current?.click()}>
        Choose photo
      </button>
      {/* Standard file inputs: on iPhone "Take photo" opens the camera, "Choose photo" the library. */}
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden aria-label="Take a photo of the item" onChange={(e) => onFile(e.currentTarget)} />
      <input ref={libraryRef} type="file" accept="image/*" hidden aria-label="Choose a photo of the item" onChange={(e) => onFile(e.currentTarget)} />
    </div>
  )

  const typedForm = (
    <form
      className="space-y-1.5"
      onSubmit={(e) => {
        e.preventDefault()
        analyzeTyped()
      }}
    >
      <label htmlFor={`${ids}-typed`} className="block text-sm text-slate-700">
        Or type the item number or the text you see on the tag or package
      </label>
      <div className="flex flex-wrap gap-2">
        <input
          id={`${ids}-typed`}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          maxLength={120}
          inputMode="text"
          enterKeyHint="search"
          autoComplete="off"
          className="min-h-11 min-w-0 flex-1 basis-48 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm"
          placeholder="e.g. 1234567 or Kirkland olive oil"
        />
        <button type="submit" className={secondary} disabled={typed.trim() === ''}>
          Find
        </button>
      </div>
    </form>
  )

  return (
    <ModalSheet title="Find an item from a photo" onClose={onClose}>
      {step.kind === 'pick' && (
        <div className="space-y-4">
          <p className="max-w-readable text-sm text-slate-700">
            Photograph the item’s label, package or the shelf tag. Text and barcodes are read on this device and matched against your own purchases; nothing is sent
            anywhere for that.
          </p>
          {step.notice && (
            <p role="alert" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
              {step.notice}
            </p>
          )}
          {pickers}
          {typedForm}
        </div>
      )}

      {step.kind === 'working' && (
        <div className="space-y-3">
          {step.image && <Preview image={step.image} />}
          <div role="status" aria-live="polite" className="text-sm text-slate-700">
            {step.label}
            {step.progress !== null && ` ${share(step.progress, 0)}`}
            <div className="mt-1.5 h-1.5 rounded-full bg-slate-100" aria-hidden>
              <div className="h-1.5 rounded-full bg-sky-700" style={{ width: `${Math.round((step.progress ?? 0.15) * 100)}%` }} />
            </div>
          </div>
          <button type="button" className={secondary} onClick={reset}>
            Cancel
          </button>
        </div>
      )}

      {step.kind === 'result' && (
        <div className="space-y-4">
          {/* Once there is a result, the photo is secondary: a smaller thumbnail keeps the result first on a phone. */}
          {step.image && <Preview image={step.image} compact />}
          <ResultSummary result={step.result} aiUsed={step.aiUsed} />
          {step.searchNote && <p className="max-w-readable text-xs text-slate-600">{step.searchNote}</p>}

          {step.result.candidates.length > 0 && (
            <ul aria-label="Matching items" className="space-y-3">
              {step.result.candidates.map((c) => (
                <li key={c.itemNumber ?? c.canonicalName}>
                  <CandidateCard
                    candidate={c}
                    onOpen={() => open(c)}
                    onSave={catalog && canSaveIdentity(c) && receiptText(c.itemNumber!) ? () => setSaving(c.itemNumber) : null}
                  />
                  {saving === c.itemNumber && catalog && (
                    <IdentityForm
                      itemName={c.canonicalName}
                      initial={{ canonicalName: step.result.evidence.productName ?? c.canonicalName, brand: step.result.evidence.brand, productType: step.result.evidence.productType }}
                      submitLabel="Save to my catalog"
                      onCancel={() => setSaving(null)}
                      onSubmit={async (fields) => {
                        await catalog.confirm(c.itemNumber!, receiptText(c.itemNumber!)!, fields)
                        setSaving(null)
                        open(c)
                      }}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}

          <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-3">
            {photo && step.image && !step.aiUsed && step.result.status !== 'match' && (
              <div className="space-y-1.5">
                <p className="max-w-readable text-sm text-slate-700">
                  Not identified on this device? The photo — and nothing else — can be sent to Workers AI in your own Cloudflare account to describe the product. Your
                  purchases are not sent.
                </p>
                <button type="button" className={secondary} onClick={() => void analyzeWithAi(step.image!)}>
                  Analyze photo with AI
                </button>
              </div>
            )}
            {pickers}
            {typedForm}
          </div>
        </div>
      )}
    </ModalSheet>
  )
}

function Preview({ image, compact = false }: { image: Image; compact?: boolean }) {
  return (
    <figure className="flex justify-center rounded-lg border border-slate-200 bg-white p-2">
      {/* Exactly the image that is analyzed (re-encoded, without metadata). */}
      <img src={image.dataUrl} alt="The photo being matched" className={`${compact ? 'max-h-28' : 'max-h-56'} w-auto max-w-full rounded object-contain`} />
    </figure>
  )
}

function ResultSummary({ result, aiUsed }: { result: PhotoMatchResult; aiUsed: boolean }) {
  const e = result.evidence
  const read =
    e.source === 'typed'
      ? 'Matched the text you typed.'
      : [
          aiUsed ? 'Read on this device and described by AI in your Cloudflare account' : 'Read on this device',
          e.numbers.length ? `numbers ${e.numbers.slice(0, 3).join(', ')}` : null,
          e.barcodes.length ? `${count(e.barcodes.length)} barcode${e.barcodes.length === 1 ? '' : 's'}` : null,
          e.productName ? `“${[e.brand, e.productName].filter(Boolean).join(' ')}”` : null,
          !e.numbers.length && !e.barcodes.length && !e.productName ? `${count(e.visibleText.length)} line${e.visibleText.length === 1 ? '' : 's'} of text` : null,
        ]
          .filter(Boolean)
          .join(' · ') + '.'
  const heading: Record<PhotoMatchResult['status'], string> = {
    match: 'This looks like your item',
    candidates: 'A few possible matches — choose the right one',
    'low-confidence': 'Only weak matches — check carefully',
    none: result.searchedExternally ? 'No matching product found' : 'No match in your purchases',
    unreadable: 'Couldn’t read this photo',
  }
  return (
    <div role="status" aria-live="polite" className="space-y-1">
      <h3 className="text-[0.9375rem] font-semibold text-slate-900">{heading[result.status]}</h3>
      <p className="max-w-readable text-xs text-slate-600">{read}</p>
      {result.status === 'unreadable' && (
        <p className="max-w-readable text-sm text-slate-700">Get closer to the label or shelf tag, with good light, and hold steady — or type the item number below.</p>
      )}
      {result.status === 'none' && (
        <p className="max-w-readable text-sm text-slate-700">Try a photo of the shelf tag or the front of the package, or type the item number.</p>
      )}
    </div>
  )
}

function CandidateCard({ candidate: c, onOpen, onSave }: { candidate: PhotoMatchCandidate; onOpen: () => void; onSave: (() => void) | null }) {
  const id = useId()
  const label = confidenceLabel(c.confidence)
  return (
    <article aria-labelledby={id} className="space-y-2 rounded-lg border border-slate-200 bg-white p-3">
      <div className="min-w-0">
        <h4 id={id} className="text-sm font-semibold break-words text-slate-900">
          {c.canonicalName}
        </h4>
        <p className="text-xs text-slate-500">
          {c.itemNumber ? `Item #${c.itemNumber}` : 'Item number unknown'}
          {c.brand && ` · ${c.brand}`}
        </p>
      </div>
      <p className="flex flex-wrap items-center gap-1.5 text-xs">
        <Badge tone={c.confidence >= 0.75 ? 'green' : c.confidence >= 0.45 ? 'amber' : 'slate'}>
          {label} · {share(c.confidence, 0)}
        </Badge>
        {c.ownerConfirmed && <Badge tone="sky">Owner confirmed</Badge>}
      </p>
      <ul className="list-disc space-y-0.5 pl-5 text-xs text-slate-700">
        {c.reasons.map((r) => (
          <li key={r} className="break-words">
            {r}
          </li>
        ))}
      </ul>
      <p className="text-xs text-slate-600">
        Based on {c.sources.map((x) => SOURCE_TEXT[x]).join(', ')}.{' '}
        {c.purchases === null
          ? 'Not in your purchases.'
          : c.purchases.purchaseEvents === 0
            ? 'No purchase record — seen only in returns or price adjustments.'
            : `Bought ${count(c.purchases.purchaseEvents)} ${c.purchases.purchaseEvents === 1 ? 'time' : 'times'}${c.purchases.lastPurchaseDate ? `, last on ${date(c.purchases.lastPurchaseDate)}` : ''}.`}
      </p>
      {(c.purchases !== null || onSave) && (
        <div className="flex flex-wrap gap-2">
          {c.purchases !== null && (
            <button type="button" className={primary} onClick={onOpen} aria-label={`This is it: open ${c.canonicalName}`}>
              This is it — open item
            </button>
          )}
          {onSave && (
            <button type="button" className={secondary} onClick={onSave} aria-label={`Save ${c.canonicalName} as my product identity`}>
              Save as my product…
            </button>
          )}
        </div>
      )}
    </article>
  )
}
