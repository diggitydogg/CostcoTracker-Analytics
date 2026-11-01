import { IDBFactory } from 'fake-indexeddb'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { LocalFileApp } from '../../LocalFileApp'
import { createDatasetStore } from '../../persistence/datasetStore'
import { syntheticExportText } from '../../test/fixtures'

describe('local analytics preview', () => {
  it('previews analytics for an imported file', async () => {
    const user = userEvent.setup()
    render(<LocalFileApp store={createDatasetStore(new IDBFactory())} />)
    await user.upload(await screen.findByLabelText(/choose export file/i), new File([syntheticExportText()], 'export.json', { type: 'application/json' }))
    await user.click(await screen.findByRole('button', { name: 'Analytics preview' }))
    const preview = await screen.findByTestId('analytics-preview')
    expect(within(preview).getByRole('region', { name: 'Spending' })).toHaveTextContent('Gross purchases')
    expect(within(preview).getByRole('region', { name: 'Personal Costco inflation' })).toHaveTextContent(
      /Needs priced purchases|Not enough repeat-price data/,
    )
    expect(within(preview).getByRole('region', { name: 'Data notes' })).toHaveTextContent('synthetic')
  })
})
