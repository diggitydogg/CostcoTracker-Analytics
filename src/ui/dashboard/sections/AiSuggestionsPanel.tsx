import { useMemo, useState } from 'react'
import { CATEGORIES, categoryLabel, isValidAssignment, subcategoryLabel, type CategoryId } from '../../../analytics'
import { buildSuggestionItems, type CategorySuggestion } from '../../../analytics/categories/suggestProtocol'
import { resolutionBasisShortLabel } from '../../../analytics/products/identityProtocol'
import { AI_SUGGESTIONS } from '../aiConfig'
import { aiCandidates } from '../derive'
import { useDashboard } from '../context'
import { count, share } from '../format'
import { Badge, Panel, Segmented, TableWrap, th } from '../ui'
import { IdentityForm } from '../details/IdentityForm'


const btn = 'rounded-md px-2.5 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40'

/**
 * Optional AI category suggestions (cloud mode). Flow: deterministic rules →
 * AI suggestion → owner review → the existing category override. Nothing is
 * changed until the owner accepts or changes a suggestion; "Leave
 * uncategorized" writes nothing.
 */
export function AiSuggestionsPanel() {
  const { s, ai, overrides, catalog } = useDashboard()
  const [view, setView] = useState<'all' | 'uncertain'>('all')
  const [editing, setEditing] = useState<string | null>(null)
  // Owner-confirmed identities: the row whose form is open, and the items confirmed in this session.
  const [confirming, setConfirming] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState<string[]>([])
  const candidates = useMemo(() => aiCandidates(s.items.items), [s])
  const requestItems = useMemo(() => buildSuggestionItems(candidates), [candidates])
  // Items whose product identity is already cached skip the lookup step.
  const alreadyIdentified = useMemo(() => new Set(candidates.filter((c) => c.identity !== null).map((c) => c.itemNumber)), [candidates])
  if (!ai) return null

  const pending = requestItems.filter((i) => !ai.requested.has(i.itemNumber) && !ai.suggestions.has(i.itemNumber))
  const nextRun = Math.min(pending.length, AI_SUGGESTIONS.maxItemsPerRun)
  const candidateSet = new Set(candidates.map((c) => c.itemNumber))
  // Review rows: suggestions for items that are still automatically Uncategorized and not yet decided.
  const rows = [...ai.suggestions.values()].filter((sg) => candidateSet.has(sg.itemNumber) && !ai.decisions.has(sg.itemNumber))
  const isHigh = (sg: CategorySuggestion) => sg.categoryId !== null && sg.confidence >= AI_SUGGESTIONS.highConfidence
  const shown = view === 'uncertain' ? rows.filter((r) => !isHigh(r)) : rows
  const high = rows.filter(isHigh)
  const decided = [...ai.decisions.values()]
  const tally = (d: string) => decided.filter((x) => x === d).length
  const failedItems = requestItems.filter((i) => ai.failed.has(i.itemNumber))
  const receiptText = new Map(requestItems.map((i) => [i.itemNumber, i.descriptions[0]!]))
  const confirmedNotes = confirmed.flatMap((n) => {
    const it = s.items.byItemNumber.get(n)
    if (!it?.identity || it.identity.basis !== 'owner-confirmed') return []
    const c = it.category
    const now =
      c.source === 'rule'
        ? ` Now ${categoryLabel(c.categoryId)}${c.subcategoryId ? ` › ${subcategoryLabel(c.categoryId, c.subcategoryId)}` : ''} by the description rules.`
        : c.source === 'override'
          ? ' Your own category choice is unchanged.'
          : ' Still Uncategorized: review its AI suggestion or choose a category.'
    return [{ itemNumber: n, text: `Saved “${it.identity.canonicalName}” (#${n}) to your catalog as Owner confirmed.${now}` }]
  })

  const accept = (sg: CategorySuggestion) => {
    if (sg.categoryId === null || !isValidAssignment(sg.categoryId, sg.subcategoryId)) return
    // Exactly what a manual choice in the item drawer writes.
    overrides.setOverride(sg.itemNumber, { categoryId: sg.categoryId, subcategoryId: sg.subcategoryId })
    ai.decide(sg.itemNumber, 'accepted')
  }

  return (
    <Panel
      title="AI category suggestions"
      subtitle="Optional. First looks up each Uncategorized item number once with a targeted web search (item number and receipt description only). Search results are used only to resolve the product and are not kept; only your own catalog record is saved, so each item number is looked up once. Items the rules can then categorize are done; the rest go to Workers AI in your own Cloudflare account for a suggestion. No prices, dates, stores or receipts are sent. AI suggestions change nothing until you accept them."
      actions={
        <button
          type="button"
          disabled={ai.running || nextRun === 0}
          onClick={() => void ai.run(pending, { alreadyIdentified })}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {ai.running ? 'Suggesting…' : 'Suggest categories with AI'}
        </button>
      }
    >
      <p className="text-sm text-slate-700" data-testid="ai-status">
        {pending.length === 0
          ? rows.length + decided.length > 0
            ? 'Every Uncategorized item has been sent in this session.'
            : 'There are no Uncategorized items to suggest categories for.'
          : `${count(pending.length)} Uncategorized ${pending.length === 1 ? 'item has' : 'items have'} not been sent yet${
              pending.length > nextRun ? `; each click sends up to ${count(AI_SUGGESTIONS.maxItemsPerRun)}` : ''
            }.`}
        {candidates.length > requestItems.length && ` ${count(candidates.length - requestItems.length)} cannot be sent (no description or an unusual item number).`}
      </p>

      {ai.progress && ai.running && (
        <div role="status" className="mt-2 text-sm text-slate-700">
          {ai.progress.phase === 'identify' ? 'Looking up products by item number…' : 'Asking the AI…'} {count(ai.progress.done)} of {count(ai.progress.total)} items
          <div className="mt-1 h-1.5 rounded-full bg-slate-100">
            <div className="h-1.5 rounded-full bg-sky-700" style={{ width: `${(ai.progress.done / Math.max(1, ai.progress.total)) * 100}%` }} />
          </div>
        </div>
      )}

      {(ai.identification.identified > 0 || ai.identification.provisional > 0 || ai.identification.notFound > 0) && (
        <p className="mt-2 text-sm text-slate-700" data-testid="identification-summary">
          Product lookup this session: {count(ai.identification.identified)} identified by item number
          {ai.identification.categorizedByRules > 0 && ` (${count(ai.identification.categorizedByRules)} now categorized by the description rules from the identified product name)`}
          {ai.identification.provisional > 0 && `, ${count(ai.identification.provisional)} possible ${ai.identification.provisional === 1 ? 'match' : 'matches'} from a single unconfirmed source (not used)`}
          {ai.identification.notFound > 0 && `, ${count(ai.identification.notFound)} not found`}.
        </p>
      )}
      {confirmedNotes.length > 0 && (
        <ul role="status" className="mt-2 space-y-0.5 text-sm text-emerald-900" data-testid="confirmed-identities">
          {confirmedNotes.map((n) => (
            <li key={n.itemNumber}>{n.text}</li>
          ))}
        </ul>
      )}
      {ai.notes.length > 0 && (
        <p role="status" className="mt-1 text-xs text-slate-500">
          {ai.notes.join(' ')}
        </p>
      )}

      {ai.errors.length > 0 && !ai.running && (
        <div role="alert" className="mt-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950">
          <p>
            Some items could not be classified ({count(failedItems.length)}). Suggestions already received are kept. {ai.errors.join(' ')}
          </p>
          {failedItems.length > 0 && (
            <button type="button" className={`${btn} mt-1 border border-amber-400 bg-white`} onClick={() => void ai.retryFailed(failedItems)}>
              Retry failed items ({count(Math.min(failedItems.length, AI_SUGGESTIONS.maxItemsPerRun))})
            </button>
          )}
        </div>
      )}

      {rows.length + decided.length > 0 && (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Segmented
              label="Which suggestions"
              value={view}
              onChange={setView}
              options={[
                { id: 'all', label: `All to review ${count(rows.length)}` },
                { id: 'uncertain', label: `Only uncertain ${count(rows.length - high.length)}` },
              ]}
            />
            <button
              type="button"
              disabled={high.length === 0}
              onClick={() => high.forEach(accept)}
              className={`${btn} border border-emerald-400 bg-emerald-50 text-emerald-900 hover:bg-emerald-100`}
            >
              Accept all high-confidence ({count(high.length)})
            </button>
          </div>
          <p className="text-xs text-slate-500">
            High confidence = {share(AI_SUGGESTIONS.highConfidence, 0)} or more (a dashboard setting, not something the AI is told). Nothing is accepted unless you click.
            Reviewed: {count(tally('accepted'))} accepted · {count(tally('changed'))} changed · {count(tally('left'))} left uncategorized.
            {ai.usage.totalTokens !== null && ` AI usage this session: ${count(ai.usage.requests)} requests, ${count(ai.usage.totalTokens)} tokens.`}
          </p>

          {shown.length === 0 ? (
            <p className="rounded-md border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-600">Nothing left to review here.</p>
          ) : (
            <TableWrap label="AI suggestions table">
              <table className="w-full min-w-[48rem] text-sm">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th scope="col" className={th}>Costco description</th>
                    <th scope="col" className={th}>Suggestion</th>
                    <th scope="col" className={th}>Confidence</th>
                    <th scope="col" className={th}>Reason</th>
                    <th scope="col" className={th}>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((sg) => {
                    const item = s.items.byItemNumber.get(sg.itemNumber)
                    const name = item?.displayDescription ?? `Item ${sg.itemNumber}`
                    return (
                      <tr key={sg.itemNumber} className="border-b border-slate-100 align-top last:border-0" data-testid={`suggestion-${sg.itemNumber}`}>
                        <td className="px-2 py-2">
                          <span className="block font-medium text-slate-900">{name}</span>
                          <span className="text-xs text-slate-500">#{sg.itemNumber}</span>
                          {item?.identity ? (
                            <span className="block text-xs text-slate-600">
                              In your catalog as {item.identity.canonicalName} ({resolutionBasisShortLabel(item.identity.basis)})
                            </span>
                          ) : (
                            <>
                              {ai.possibleMatches.get(sg.itemNumber) && (
                                <span className="block text-xs text-slate-600">
                                  Possible match (one unconfirmed source, not saved or used): {ai.possibleMatches.get(sg.itemNumber)}
                                </span>
                              )}
                              {catalog && receiptText.has(sg.itemNumber) && confirming !== sg.itemNumber && (
                                <button
                                  type="button"
                                  onClick={() => setConfirming(sg.itemNumber)}
                                  aria-label={`Confirm identity for ${name}`}
                                  className={`${btn} mt-1 border border-sky-300 bg-white text-sky-900 hover:bg-sky-50`}
                                >
                                  Confirm identity
                                </button>
                              )}
                              {catalog && confirming === sg.itemNumber && (
                                <IdentityForm
                                  itemName={name}
                                  initial={{ canonicalName: ai.possibleMatches.get(sg.itemNumber) ?? '' }}
                                  submitLabel="Save to my catalog"
                                  onCancel={() => setConfirming(null)}
                                  onSubmit={async (fields) => {
                                    await catalog.confirm(sg.itemNumber, receiptText.get(sg.itemNumber)!, fields)
                                    setConfirming(null)
                                    setConfirmed((c) => [...c.filter((x) => x !== sg.itemNumber), sg.itemNumber])
                                  }}
                                />
                              )}
                            </>
                          )}
                        </td>
                        <td className="px-2 py-2">
                          {sg.categoryId === null ? (
                            <span className="italic text-slate-500">No suggestion (AI abstained)</span>
                          ) : (
                            `${categoryLabel(sg.categoryId)}${sg.subcategoryId ? ` › ${subcategoryLabel(sg.categoryId, sg.subcategoryId)}` : ''}`
                          )}
                        </td>
                        <td className="whitespace-nowrap px-2 py-2 tabular-nums">
                          {sg.categoryId === null ? '—' : share(sg.confidence, 0)}
                          {isHigh(sg) && (
                            <span className="ml-1.5">
                              <Badge tone="green">High</Badge>
                            </span>
                          )}
                        </td>
                        <td className="max-w-[18rem] px-2 py-2 text-slate-600">{sg.reason || '—'}</td>
                        <td className="px-2 py-2">
                          {editing === sg.itemNumber ? (
                            <ChangeForm
                              initial={sg}
                              itemName={name}
                              onCancel={() => setEditing(null)}
                              onSave={(categoryId, subcategoryId) => {
                                overrides.setOverride(sg.itemNumber, { categoryId, subcategoryId })
                                ai.decide(sg.itemNumber, 'changed')
                                setEditing(null)
                              }}
                            />
                          ) : (
                            <div className="flex flex-wrap justify-end gap-1.5">
                              <button
                                type="button"
                                disabled={sg.categoryId === null}
                                onClick={() => accept(sg)}
                                aria-label={`Accept suggestion for ${name}`}
                                className={`${btn} bg-slate-900 text-white hover:bg-slate-800`}
                              >
                                Accept
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditing(sg.itemNumber)}
                                aria-label={`Change category for ${name}`}
                                className={`${btn} border border-slate-300 bg-white hover:bg-slate-100`}
                              >
                                Change
                              </button>
                              <button
                                type="button"
                                onClick={() => ai.decide(sg.itemNumber, 'left')}
                                aria-label={`Leave ${name} uncategorized`}
                                className={`${btn} border border-slate-300 bg-white hover:bg-slate-100`}
                              >
                                Leave uncategorized
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </TableWrap>
          )}
        </div>
      )}
      {!overrides.persistent && <p className="mt-2 text-xs text-amber-800">This browser cannot save category choices; accepted suggestions apply in this tab only.</p>}
    </Panel>
  )
}

function ChangeForm({
  initial,
  itemName,
  onSave,
  onCancel,
}: {
  initial: CategorySuggestion
  itemName: string
  onSave: (categoryId: CategoryId, subcategoryId: string | null) => void
  onCancel: () => void
}) {
  const [categoryId, setCategoryId] = useState<CategoryId>(initial.categoryId ?? 'grocery')
  const [sub, setSub] = useState<string>(initial.subcategoryId ?? '')
  const subs = (CATEGORIES.find((c) => c.id === categoryId)?.subcategories ?? []) as readonly { id: string; label: string }[]
  const subcategoryId = sub && subs.some((x) => x.id === sub) ? sub : null
  return (
    <form
      className="flex flex-wrap items-end justify-end gap-1.5"
      aria-label={`Choose a category for ${itemName}`}
      onSubmit={(e) => {
        e.preventDefault()
        if (isValidAssignment(categoryId, subcategoryId)) onSave(categoryId, subcategoryId)
      }}
    >
      <label className="flex flex-col text-xs text-slate-500">
        Category
        <select value={categoryId} onChange={(e) => (setCategoryId(e.target.value as CategoryId), setSub(''))} className="rounded-md border border-slate-300 bg-white px-1.5 py-1 text-sm text-slate-900">
          {CATEGORIES.filter((c) => c.id !== 'uncategorized').map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      {subs.length > 0 && (
        <label className="flex flex-col text-xs text-slate-500">
          Subcategory
          <select value={subcategoryId ?? ''} onChange={(e) => setSub(e.target.value)} className="rounded-md border border-slate-300 bg-white px-1.5 py-1 text-sm text-slate-900">
            <option value="">None</option>
            {subs.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <button type="submit" className={`${btn} bg-slate-900 text-white`}>
        Save
      </button>
      <button type="button" onClick={onCancel} className={`${btn} border border-slate-300 bg-white`}>
        Cancel
      </button>
    </form>
  )
}
