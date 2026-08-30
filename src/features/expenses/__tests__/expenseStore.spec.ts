import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { CommandQueue, createMemoryCommandStorage } from '../../../data/commandQueue'
import { createDemoRepository } from '../../../data/demoRepository'
import { createMemoryReceiptStore } from '../../../data/receipts'
import { createAppSession, setAppSessionForTesting } from '../../../data/session'
import type { Member } from '../../../data/repositories'
import { validateExpenseInput, useExpenseStore } from '../expenseStore'

const members: readonly Member[] = [
  { id: 'maya-p', displayName: 'Maya P.', initials: 'MP', isCurrentUser: true },
  { id: 'alex-r', displayName: 'Alex R.', initials: 'AR', isCurrentUser: false },
]

beforeEach(() => {
  setActivePinia(createPinia())
  setAppSessionForTesting(createAppSession({
    repository: createDemoRepository(),
    commandStorage: createMemoryCommandStorage(),
    receipts: createMemoryReceiptStore({ id: () => 'receipt-test', now: () => '2026-08-30T12:00:00.000Z' }),
  }))
})

describe('expense input validation', () => {
  it.each([
    ['JPY', '1200', 1200],
    ['USD', '12.34', 1234],
    ['BHD', '12.345', 12345],
    ['CLF', '12.3456', 123456],
  ] as const)('parses a positive exact %s total and derives equal allocations', (currency, amountText, minorAmount) => {
    const result = validateExpenseInput({
      groupId: 'lake-house-weekend', description: '  Cabin  ', date: '2026-08-30', currency, amountText, category: 'Lodging',
      participants: ['maya-p', 'alex-r'], payments: [{ participantId: 'maya-p', amountText }], split: { type: 'equal' }, attachmentRefs: [],
    }, members)

    expect(result).toMatchObject({ valid: true, draft: { description: 'Cabin', total: { currency, minorAmount } } })
    expect(result.draft?.allocations.reduce((sum, item) => sum + item.money.minorAmount, 0)).toBe(minorAmount)
  })

  it('returns field errors for invalid context, date, people, payments, and allocation inputs', () => {
    const result = validateExpenseInput({
      groupId: '', description: ' ', date: '2026-02-30', currency: 'USD', amountText: '0', category: '',
      participants: ['maya-p', 'maya-p', 'outsider'], payments: [{ participantId: 'outsider', amountText: '4.00' }],
      split: { type: 'percentage', values: { 'maya-p': '90' } }, attachmentRefs: [],
    }, members)

    expect(result.valid).toBe(false)
    expect(result.errors).toMatchObject({ context: expect.any(String), description: expect.any(String), date: expect.any(String), amount: expect.any(String), category: expect.any(String), participants: expect.any(String), payments: expect.any(String), split: expect.any(String) })
  })

  it('explicitly resets money-dependent payer and split inputs when currency changes', async () => {
    const store = useExpenseStore()
    await store.initialize({ origin: 'groups', groupId: 'lake-house-weekend' })
    store.editor.amountText = '10.00'
    store.editor.payments = [{ participantId: 'maya-p', amountText: '10.00' }]
    store.editor.split = { type: 'exact', values: { 'maya-p': '10.00' } }

    store.changeCurrency('BHD')

    expect(store.editor.amountText).toBe('')
    expect(store.editor.payments).toEqual([])
    expect(store.editor.split).toEqual({ type: 'equal' })
    expect(store.notice).toContain('Amount, payer amounts, and split values were reset')
  })
})

describe('expense store lifecycle', () => {
  it('hydrates an existing revision for edit without losing persisted premium fields', async () => {
    const store = useExpenseStore()
    await store.initialize({ origin: 'groups', groupId: 'lake-house-weekend', expenseId: 'cabin-deposit' })

    expect(store.mode).toBe('edit')
    expect(store.revision).toBe(1)
    expect(store.editor).toMatchObject({ description: 'Cabin deposit', currency: 'USD', category: 'Lodging', split: { type: 'equal' } })
    expect(store.editor.recurrence).toBeUndefined()
    expect(store.editor.attachmentRefs).toEqual([])
  })

  it('persists a command before returning and exposes a journal-projectable pending operation', async () => {
    const repository = createDemoRepository()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const session = createAppSession({ repository, commandStorage: createMemoryCommandStorage() })
    const queue = new CommandQueue({
      storage: createMemoryCommandStorage(),
      handlers: { 'expense.add': async (command) => {
        if (command.kind !== 'expense.add') throw new Error('Unexpected command kind')
        await blocked
        return repository.expenses.add(command)
      } },
    })
    setAppSessionForTesting({ ...session, queue })
    const store = useExpenseStore()
    await store.initialize({ origin: 'groups', groupId: 'lake-house-weekend' })
    store.editor.description = 'Ice'
    store.editor.amountText = '4.00'
    store.editor.category = 'Supplies'

    expect(store.submit('pending-ice')).toBe(true)
    expect(queue.get('pending-ice')).toMatchObject({ status: 'pending', envelope: { description: 'Ice' } })
    release()
    await queue.submit(queue.get('pending-ice')!.envelope).result()
    expect(queue.get('pending-ice')).toMatchObject({ status: 'fresh' })
  })

  it('retains a receipt after unavailable recognition and applies itemized allocations only after confirmation', async () => {
    const store = useExpenseStore()
    await store.initialize({ origin: 'groups', groupId: 'lake-house-weekend' })
    const before = store.editor.split

    await store.attachReceipt(new Blob(['receipt'], { type: 'image/jpeg' }), 'receipt.jpg')
    expect(store.editor.attachmentRefs).toEqual(['local-receipt:receipt-test'])
    expect(store.receiptMessage).toContain('not configured')
    expect(store.editor.split).toEqual(before)

    store.editor.amountText = '10.00'
    expect(store.confirmReceipt([
      { description: 'Snacks', amountText: '6.00', participantIds: ['maya-p', 'alex-r'] },
      { description: 'Ice', amountText: '4.00', participantIds: ['maya-p'] },
    ])).toBe(true)
    expect(store.editor.split).toMatchObject({ type: 'itemized', items: [{ description: 'Snacks' }, { description: 'Ice' }] })
  })
})
