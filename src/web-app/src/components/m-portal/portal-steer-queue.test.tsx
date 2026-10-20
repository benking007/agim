import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import i18n, { syncI18nLanguage } from '@/i18n'
import { PortalSteerQueue } from './portal-steer-queue'

describe('PortalSteerQueue', () => {
  it('renders nothing when empty', () => {
    const { container } = render(
      <PortalSteerQueue
        dark={false}
        items={[]}
        onSend={() => {}}
        onDismiss={() => {}}
        onReedit={() => {}}
      />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('steers, deletes, and re-edits a queued line', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    const onDismiss = vi.fn()
    const onReedit = vi.fn()
    render(
      <PortalSteerQueue
        dark={false}
        items={[{ id: 'q1', text: 'also run tests' }]}
        onSend={onSend}
        onDismiss={onDismiss}
        onReedit={onReedit}
      />,
    )
    expect(screen.getByTestId('portal-steer-queue')).toBeInTheDocument()
    expect(screen.getByText('also run tests')).toBeInTheDocument()
    await user.click(screen.getByTestId('steer-queue-send'))
    expect(onSend).toHaveBeenCalledWith('q1')
    await user.click(screen.getByTestId('steer-queue-dismiss'))
    expect(onDismiss).toHaveBeenCalledWith('q1')
    await user.click(screen.getByTestId('steer-queue-more'))
    await user.click(await screen.findByRole('menuitem', { name: /re-edit|重新编辑/i }))
    expect(onReedit).toHaveBeenCalledWith('q1')
  })

  it('labels Steer in Chinese when the locale is zh', async () => {
    syncI18nLanguage('zh')
    await i18n.loadLanguages(['zh'])
    render(
      <PortalSteerQueue
        dark={false}
        items={[{ id: 'q1', text: '补充一句' }]}
        onSend={() => {}}
        onDismiss={() => {}}
        onReedit={() => {}}
      />,
    )
    expect(screen.getByTestId('steer-queue-send')).toHaveTextContent('吸入本轮')
    syncI18nLanguage('en')
  })
})
