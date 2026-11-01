import { useMemo, useState } from 'react'
import { categoryLabel, categoryTrends, type CategoryId } from '../../../analytics'
import { SERIES } from '../charts/palette'
import { useDashboard } from '../context'
import { count, money, moneyWhole, share } from '../format'
import { Badge, BarList, DrillLink, Panel, TableWrap, td, tdNum, th, thNum } from '../ui'

const TREND_ROWS = 8

export function CategoriesSection() {
  const { s, open } = useDashboard()
  const cats = s.categories.categories
  const [selected, setSelected] = useState<CategoryId | null>(cats[0]?.categoryId ?? null)
  const current = cats.find((c) => c.categoryId === selected) ?? cats[0] ?? null
  const trends = useMemo(() => categoryTrends(s.index, s.items), [s])
  const completeYear = new Map(s.spending.yearly.map((y) => [y.year, y.complete]))
  const uncategorized = useMemo(
    () =>
      s.categories.uncategorized.itemNumbers
        .map((n) => s.items.byItemNumber.get(n)!)
        .sort((a, b) => b.totalSpentCents - a.totalSpentCents || (a.itemNumber < b.itemNumber ? -1 : 1)),
    [s],
  )
  const bySource = s.categories.bySource

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <Panel
          title="Spend by category"
          subtitle={`Share of gross purchases. ${count(bySource.rule)} items categorized by description rules, ${count(bySource.override)} set by you, ${count(bySource.fallback)} uncategorized.`}
          className="lg:col-span-2"
        >
          <BarList
            label="Categories"
            rows={cats.map((c) => ({
              key: c.categoryId,
              label: <span className={c.categoryId === current?.categoryId ? 'font-semibold' : ''}>{c.label}</span>,
              accessibleLabel: `${c.label}, ${moneyWhole(c.spendCents)}, ${share(c.spendShare)}`,
              value: moneyWhole(c.spendCents),
              fraction: c.spendShare,
              onClick: () => setSelected(c.categoryId),
            }))}
          />
        </Panel>

        {current && (
          <Panel title={current.label} subtitle={`${count(current.itemNumbers.length)} items · ${count(current.lineCount)} item lines · ${share(current.spendShare)} of spend`} className="lg:col-span-3">
            <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
              <div>
                <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">Subcategories</h4>
                {current.subcategories.length <= 1 && current.subcategories[0]?.subcategoryId === null ? (
                  <p className="text-sm text-slate-600">No subcategories.</p>
                ) : (
                  <BarList
                    label={`${current.label} subcategories`}
                    color={SERIES.aqua}
                    rows={current.subcategories.map((sub) => ({
                      key: sub.subcategoryId ?? 'general',
                      label: sub.label,
                      value: moneyWhole(sub.spendCents),
                      fraction: current.spendCents > 0 ? sub.spendCents / current.spendCents : null,
                    }))}
                  />
                )}
              </div>
              <div>
                <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">Top items</h4>
                <ol className="space-y-1.5 text-sm">
                  {current.topItems.map((n) => {
                    const i = s.items.byItemNumber.get(n)!
                    return (
                      <li key={n} className="flex items-baseline justify-between gap-3 border-b border-slate-100 pb-1.5">
                        <span className="min-w-0 truncate">
                          <DrillLink onClick={() => open({ kind: 'item', itemNumber: n })}>{i.displayDescription}</DrillLink>
                          {i.category.source === 'override' && (
                            <span className="ml-1.5">
                              <Badge tone="violet">Manual</Badge>
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 tabular-nums">{money(i.totalSpentCents)}</span>
                      </li>
                    )
                  })}
                </ol>
              </div>
            </div>
          </Panel>
        )}
      </div>

      {trends.years.length > 1 && (
        <Panel title="Category trends by year" subtitle="Share of each year's purchases. Partial years are marked; shares compare composition, not totals.">
          <TableWrap label="Category trends table">
            <table className="w-full min-w-[36rem] text-sm">
              <thead>
                <tr className="border-b border-slate-200">
                  <th scope="col" className={th}>Category</th>
                  {trends.years.map((y) => (
                    <th key={y} scope="col" className={thNum}>
                      {y}
                      {!completeYear.get(y) && <span className="font-normal text-slate-400"> (partial)</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {trends.rows.slice(0, TREND_ROWS).map((r) => (
                  <tr key={r.categoryId} className="border-b border-slate-100 last:border-0">
                    <td className={td}>{categoryLabel(r.categoryId)}</td>
                    {r.byYear.map((c, i) => (
                      <td key={trends.years[i]} className={tdNum} title={money(c.spendCents)}>
                        <span className="font-medium">{share(c.share, 0)}</span>
                        <span className="block text-xs text-slate-500">{moneyWhole(c.spendCents)}</span>
                      </td>
                    ))}
                  </tr>
                ))}
                {trends.rows.length > TREND_ROWS && (
                  <tr>
                    <td className={`${td} text-xs text-slate-500`} colSpan={trends.years.length + 1}>
                      {count(trends.rows.length - TREND_ROWS)} smaller categories not shown.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </TableWrap>
        </Panel>
      )}

      <Panel
        title="Uncategorized items"
        subtitle={`${count(s.categories.uncategorized.itemCount)} items, ${share(s.categories.uncategorized.spendShare)} of spend. Open an item to choose its category; your choice is saved in this browser.`}
      >
        {uncategorized.length === 0 ? (
          <p className="text-sm text-slate-600">Every purchased item has a category.</p>
        ) : (
          <ul className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm md:grid-cols-2 xl:grid-cols-3">
            {uncategorized.slice(0, 30).map((i) => (
              <li key={i.itemNumber} className="flex items-baseline justify-between gap-3 border-b border-slate-100 pb-1.5">
                <span className="min-w-0 truncate">
                  <DrillLink onClick={() => open({ kind: 'item', itemNumber: i.itemNumber })} label={`Set category for ${i.displayDescription}`}>
                    {i.displayDescription}
                  </DrillLink>
                </span>
                <span className="shrink-0 tabular-nums text-slate-700">{money(i.totalSpentCents)}</span>
              </li>
            ))}
          </ul>
        )}
        {uncategorized.length > 30 && <p className="mt-2 text-xs text-slate-500">Showing the 30 with the most spend. Use the Items tab to filter by Uncategorized.</p>}
      </Panel>
    </div>
  )
}
