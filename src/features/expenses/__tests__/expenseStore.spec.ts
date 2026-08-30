import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { CommandQueue, createMemoryCommandStorage } from '../../../data/commandQueue'
import { createDemoRepository } from '../../../data/demoRepository'
import { createMemoryReceiptStore, type ReceiptProvider, type ReceiptRecognitionResult } from '../../../data/receipts'
import { createAppSession, setAppSessionForTesting } from '../../../data/session'
import type { AppRepository, Group, Member } from '../../../data/repositories'
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
  it('ignores a stale initialization that resolves after a newer route context', async () => {
    const base = createDemoRepository()
    const slow = deferred<Group | undefined>()
    const currentUser = await base.app.getCurrentUser()
    const fastGroup: Group = { id: 'fast-context', name: 'Fast context', currency: 'USD', memberIds: [currentUser.id], syncState: 'fresh' }
    const slowGroup: Group = { ...fastGroup, id: 'slow-context', name: 'Slow context' }
    const repository: AppRepository = {
      ...base,
      groups: {
        ...base.groups,
        async list() { return [slowGroup, fastGroup] },
        async getById(groupId) { return groupId === slowGroup.id ? slow.promise : groupId === fastGroup.id ? fastGroup : undefined },
        async listMembers() { return [currentUser] },
      },
    }
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))
    const store = useExpenseStore()

    const first = store.initialize({ origin: 'groups', groupId: slowGroup.id, today: '2026-08-30' })
    await Promise.resolve()
    await store.initialize({ origin: 'home', groupId: fastGroup.id, today: '2026-08-31' })
    slow.resolve(slowGroup)
    await first

    expect(store.editor.groupId).toBe('fast-context')
    expect(store.contextName).toBe('Fast context')
    expect(store.origin).toBe('home')
    expect(store.editor.date).toBe('2026-08-31')
  })

  it('ignores a context selection that resolves after the editor route changes', async () => {
    const base = createDemoRepository()
    const currentUser = await base.app.getCurrentUser()
    const slowMembers = deferred<readonly Member[]>()
    const slowGroup: Group = { id: 'slow-context', name: 'Slow context', currency: 'EUR', memberIds: [currentUser.id], syncState: 'fresh' }
    const repository: AppRepository = {
      ...base,
      groups: {
        ...base.groups,
        async list() { return [...await base.groups.list(), slowGroup] },
        async listMembers(groupId) { return groupId === slowGroup.id ? slowMembers.promise : base.groups.listMembers(groupId) },
      },
    }
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))
    const store = useExpenseStore()
    await store.initialize({ origin: 'groups', groupId: 'lake-house-weekend' })

    const selection = store.selectContext(slowGroup.id)
    await Promise.resolve()
    await store.initialize({ origin: 'home', today: '2026-08-31' })
    slowMembers.resolve([currentUser])

    await expect(selection).resolves.toBe(false)
    expect(store.origin).toBe('home')
    expect(store.editor.groupId).toBe('')
    expect(store.contextName).toBe('')
  })

  it('accepts only one save while an attempt is pending and keeps its operation ID', async () => {
    const repository = createDemoRepository()
    const gate = deferred<void>()
    const queue = new CommandQueue({ storage: createMemoryCommandStorage(), handlers: { 'expense.add': async (command) => {
      if (command.kind !== 'expense.add') throw new Error('Unexpected command kind')
      await gate.promise
      return repository.expenses.add(command)
    } } })
    queue.bind('maya-p')
    setAppSessionForTesting({ ...createAppSession({ repository, commandStorage: createMemoryCommandStorage() }), queue })
    const store = useExpenseStore()
    await store.initialize({ origin: 'groups', groupId: 'lake-house-weekend' })
    completeValidEditor(store)

    expect(await store.submit('single-flight')).toBe(true)
    expect(await store.submit('duplicate-attempt')).toBe(false)
    expect(store.lastOperationId).toBe('single-flight')
    expect(queue.snapshot().map(({ envelope }) => envelope.operationId)).toEqual(['single-flight'])
    gate.resolve()
    await queue.submit(queue.get('single-flight')!.envelope).result()
  })

  it('does not let an old save completion mutate a reinitialized editor context', async () => {
    const repository = createDemoRepository()
    const gate = deferred<void>()
    const queue = new CommandQueue({ storage: createMemoryCommandStorage(), handlers: { 'expense.add': async (command) => {
      if (command.kind !== 'expense.add') throw new Error('Unexpected command kind')
      await gate.promise
      return repository.expenses.add(command)
    } } })
    queue.bind('maya-p')
    setAppSessionForTesting({ ...createAppSession({ repository, commandStorage: createMemoryCommandStorage() }), queue })
    const store = useExpenseStore()
    await store.initialize({ origin: 'groups', groupId: 'lake-house-weekend' })
    completeValidEditor(store)
    expect(await store.submit('old-context-save')).toBe(true)

    await store.initialize({ origin: 'home', today: '2026-08-31' })
    gate.resolve()
    await queue.submit(queue.get('old-context-save')!.envelope).result()
    await Promise.resolve()

    expect(store.origin).toBe('home')
    expect(store.editor.groupId).toBe('')
    expect(store.saveState).toBe('idle')
    expect(store.notice).toBe('')
  })

  it('never falls through to Add when edit hydration lacks a revision', async () => {
    const session = createAppSession({ repository: createDemoRepository(), commandStorage: createMemoryCommandStorage() })
    setAppSessionForTesting(session)
    const store = useExpenseStore()
    await store.initialize({ origin: 'groups', groupId: 'lake-house-weekend', expenseId: 'missing-expense' })
    completeValidEditor(store)

    expect(await store.submit('unsafe-edit')).toBe(false)
    expect(session.queue.snapshot()).toEqual([])
    expect(store.errorSummary).toContain('revision')
  })

  it('requires occurrence or future scope before saving any recurring-instance edit', async () => {
    const session = createAppSession({ repository: createDemoRepository(), commandStorage: createMemoryCommandStorage() })
    setAppSessionForTesting(session)
    const store = useExpenseStore()
    await store.initialize({ origin: 'groups', groupId: 'lake-house-weekend', expenseId: 'cabin-deposit' })

    expect(store.recurringTemplateId).toBe('cabin-deposit-monthly')
    expect(store.editor.occurrenceEditScope).toBeUndefined()
    expect(store.submit('recurring-without-scope')).toBe(false)
    expect(store.errors.recurrence).toContain('occurrence or future')
    expect(session.queue.get('recurring-without-scope')).toBeUndefined()
  })

  it('hydrates an existing revision for edit without losing persisted premium fields', async () => {
    const store = useExpenseStore()
    await store.initialize({ origin: 'groups', groupId: 'lake-house-weekend', expenseId: 'cabin-deposit' })

    expect(store.mode).toBe('edit')
    expect(store.revision).toBe(1)
    expect(store.editor).toMatchObject({ description: 'Cabin deposit', currency: 'USD', category: 'Lodging', split: { type: 'equal' } })
    expect(store.editor.recurrence).toBeUndefined()
    expect(store.editor.attachmentRefs).toEqual([])
  })

  it('restores a durable local receipt preview when an editor is reopened', async () => {
    const repository = createDemoRepository()
    const receipts = createMemoryReceiptStore({ id: () => 'restored-receipt', now: () => '2026-08-30T12:00:00.000Z' })
    const reference = await receipts.put(new Blob(['image'], { type: 'image/jpeg' }), { fileName: 'receipt.jpg' })
    const original = await repository.expenses.getById('lake-house-weekend', 'cabin-deposit')
    if (!original) throw new Error('Expected cabin expense')
    await repository.expenses.edit({
      kind: 'expense.edit', operationId: 'attach-local-receipt', groupId: original.groupId, expenseId: original.id, expectedRevision: original.revision,
      draft: {
        groupId: original.groupId, description: original.description, date: original.date, total: original.total, payments: original.payments,
        allocations: original.allocations, category: original.category, splitMethod: original.splitMethod, attachmentRefs: [reference],
      },
    })
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage(), receipts }))
    const store = useExpenseStore()

    await store.initialize({ origin: 'groups', groupId: original.groupId, expenseId: original.id })

    expect((store as unknown as { receiptPreview?: { reference: string; blob: Blob } }).receiptPreview).toMatchObject({ reference, blob: expect.any(Blob) })
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
    queue.bind('maya-p')
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

  it('retains the local image and manual item entry when recognition fails', async () => {
    const receipts = createMemoryReceiptStore({ id: () => 'failed-recognition', now: () => '2026-08-30T12:00:00.000Z' })
    setAppSessionForTesting(createAppSession({
      repository: createDemoRepository(),
      commandStorage: createMemoryCommandStorage(),
      receipts,
      receiptProvider: {
        async upload() { return { status: 'unavailable', reason: 'Upload unavailable.' } },
        async recognize() { throw new Error('Provider timed out') },
        async delete() { /* no remote receipt was created */ },
      },
    }))
    const store = useExpenseStore()
    await store.initialize({ origin: 'groups', groupId: 'lake-house-weekend' })

    await expect(store.attachReceipt(new Blob(['receipt'], { type: 'image/jpeg' }), 'receipt.jpg')).resolves.toBe(true)

    expect(store.editor.attachmentRefs).toEqual(['local-receipt:failed-recognition'])
    expect(store.receiptPreview).toMatchObject({ reference: 'local-receipt:failed-recognition' })
    expect(store.receiptMessage).toContain('enter items manually')
    expect(store.receiptSuggestions).toEqual([])
  })

  it('does not apply receipt recognition after the editor route changes', async () => {
    const recognition = deferred<ReceiptRecognitionResult>()
    const receiptProvider: ReceiptProvider = {
      async upload() { return { status: 'unavailable', reason: 'Upload unavailable.' } },
      recognize: () => recognition.promise,
      async delete() { /* no remote receipt was created */ },
    }
    setAppSessionForTesting(createAppSession({
      repository: createDemoRepository(), commandStorage: createMemoryCommandStorage(),
      receipts: createMemoryReceiptStore({ id: () => 'stale-recognition', now: () => '2026-08-30T12:00:00.000Z' }),
      receiptProvider,
    }))
    const store = useExpenseStore()
    await store.initialize({ origin: 'groups', groupId: 'lake-house-weekend' })

    const attachment = store.attachReceipt(new Blob(['receipt'], { type: 'image/jpeg' }), 'receipt.jpg')
    await Promise.resolve()
    await Promise.resolve()
    await store.initialize({ origin: 'home', today: '2026-08-31' })
    recognition.resolve({ status: 'suggestions', source: 'provider', items: [{ description: 'Stale item', amountText: '10.00' }] })

    await expect(attachment).resolves.toBe(false)
    expect(store.origin).toBe('home')
    expect(store.editor.attachmentRefs).toEqual([])
    expect(store.receiptPreview).toBeUndefined()
    expect(store.receiptSuggestions).toEqual([])
    expect(store.receiptMessage).toBe('')
  })
})

function completeValidEditor(store: ReturnType<typeof useExpenseStore>): void {
  store.editor.description = 'Ice'
  store.editor.amountText = '4.00'
  store.editor.category = 'Supplies'
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
