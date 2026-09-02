import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { CommandQueue, createMemoryCommandStorage } from '../../../data/commandQueue'
import { createDemoRepository } from '../../../data/demoRepository'
import { createMemoryReceiptStore, type LocalReceiptReference, type ReceiptAsset, type ReceiptBlobStore, type ReceiptDurability, type ReceiptProvider, type ReceiptRecognitionResult } from '../../../data/receipts'
import { createAppSession, setAppSessionForTesting } from '../../../data/session'
import type { AppRepository, Group, Member } from '../../../data/repositories'
import { createInterleavingIndexedDb } from '../../../data/__tests__/indexedDbInterleaving'
import { createIndexedDbReceiptStore } from '../../../data/receipts'
import { validateExpenseInput, useExpenseStore } from '../expenseStore'
import { storeTransactionImportDraft } from '../../transactions/transactionImportDrafts'

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

  it('builds a reimbursement draft from exact amounts each participant should receive', () => {
    const result = validateExpenseInput({
      groupId: 'lake-house-weekend', description: 'Flight refund', date: '2026-08-30', currency: 'USD', amountText: '300.00', category: 'Transport',
      participants: ['maya-p', 'alex-r'], payments: [{ participantId: 'maya-p', amountText: '300.00' }],
      split: { type: 'reimbursement', values: { 'maya-p': '100.00', 'alex-r': '200.00' } }, attachmentRefs: [],
    }, members)

    expect(result).toMatchObject({
      valid: true,
      draft: {
        reimbursement: true,
        splitMethod: { type: 'exact' },
        allocations: [
          { participantId: 'maya-p', money: { currency: 'USD', minorAmount: 10000 } },
          { participantId: 'alex-r', money: { currency: 'USD', minorAmount: 20000 } },
        ],
      },
    })
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
  it('consumes an imported transaction once and prefills a dirty draft without queuing a ledger command', async () => {
    const session = createAppSession({ repository: createDemoRepository(), commandStorage: createMemoryCommandStorage() })
    setAppSessionForTesting(session)
    const principal = await session.principal
    const draftId = storeTransactionImportDraft(principal, {
      fingerprint: `transaction-v1:${'b'.repeat(64)}`,
      date: '2026-08-29', description: 'Train tickets', money: { currency: 'EUR', minorAmount: 1890 }, sourceRow: 4,
    }, { storage: sessionStorage, id: () => '123e4567-e89b-42d3-a456-426614174010' })
    const store = useExpenseStore()

    await store.initialize({ origin: 'account', importDraftId: draftId, today: '2026-08-31' })

    expect(store.editor).toMatchObject({ description: 'Train tickets', date: '2026-08-29', currency: 'EUR', amountText: '18.90', category: 'Other' })
    expect(store.notice).toContain('Review the imported transaction')
    expect(store.isDirty).toBe(true)
    expect(session.queue.snapshot()).toEqual([])

    await store.initialize({ origin: 'account', importDraftId: draftId, today: '2026-08-31' })
    expect(store.editor.description).toBe('')
    expect(store.editor.amountText).toBe('')
    expect(session.queue.snapshot()).toEqual([])
  })

  it('seeds a new group draft from the versioned shared default without changing payers', async () => {
    const repository = createDemoRepository()
    await repository.groups.setDefaultSplit({
      kind: 'group.default-split', operationId: 'editor-default', groupId: 'lake-house-weekend', expectedRevision: 1,
      defaultSplit: { type: 'percentage', participantIds: ['maya-p', 'alex-r'], percentages: { 'maya-p': 40, 'alex-r': 60 } },
    })
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))
    const store = useExpenseStore()

    await store.initialize({ origin: 'groups', groupId: 'lake-house-weekend', today: '2026-08-31' })

    expect(store.editor.participants).toEqual(['maya-p', 'alex-r'])
    expect(store.editor.split).toEqual({ type: 'percentage', values: { 'maya-p': '40', 'alex-r': '60' } })
    expect(store.editor.payments).toEqual([{ participantId: 'maya-p', amountText: '' }])
  })

  it('never lets an invalid shared default block or overwrite an existing expense edit', async () => {
    const base = createDemoRepository()
    const repository: AppRepository = {
      ...base,
      groups: {
        ...base.groups,
        async getSettings(groupId) {
          return { schemaVersion: 1, groupId, revision: 2, defaultSplit: { type: 'equal', participantIds: ['retired-member'] } }
        },
      },
    }
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))
    const store = useExpenseStore()

    await store.initialize({ origin: 'groups', groupId: 'lake-house-weekend', expenseId: 'cabin-deposit' })

    expect(store.loadError).toBe('')
    expect(store.mode).toBe('edit')
    expect(store.editor.description).toBe('Cabin deposit')
    expect(store.editor.participants).toEqual(['maya-p', 'jordan-k', 'alex-r', 'taylor-s'])
  })

  it('opens another active group member\'s expense for collaborative editing', async () => {
    const repository = createDemoRepository({ currentUserId: 'alex-r' })
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))
    const store = useExpenseStore()

    await store.initialize({ origin: 'groups', groupId: 'lake-house-weekend', expenseId: 'groceries' })

    expect(store.loadError).toBe('')
    expect(store.mode).toBe('edit')
    expect(store.editor.description).toBe('Groceries')
  })

  it('keeps the source context in a move command and navigates to the newly created target expense', async () => {
    const base = createDemoRepository()
    const currentUser = await base.app.getCurrentUser()
    const original = await base.expenses.getById('lake-house-weekend', 'groceries')
    if (!original) throw new Error('Expected the seeded expense')
    const target: Group = {
      id: 'target-trip', kind: 'group', name: 'Target trip', currency: 'USD',
      memberIds: (await base.groups.listMembers('lake-house-weekend')).map(({ id }) => id), syncState: 'fresh',
    }
    const repository: AppRepository = {
      ...base,
      groups: {
        ...base.groups,
        async list() { return [...await base.groups.list(), target] },
        async getById(groupId) { return groupId === target.id ? target : base.groups.getById(groupId) },
        async listMembers(groupId) { return groupId === target.id ? base.groups.listMembers('lake-house-weekend') : base.groups.listMembers(groupId) },
        async getSettings(groupId) { return groupId === target.id ? { schemaVersion: 1, groupId, revision: 1 } : base.groups.getSettings(groupId) },
      },
    }
    let submitted: Extract<import('../../../data/repositories').CommandEnvelope, { kind: 'expense.edit' }> | undefined
    const queue = new CommandQueue({
      storage: createMemoryCommandStorage(),
      handlers: { 'expense.edit': async (command) => {
        if (command.kind !== 'expense.edit') throw new Error('Unexpected command kind')
        submitted = command
        return {
          kind: command.kind, operationId: command.operationId, status: 'saved',
          expense: {
            ...original, ...command.draft, id: 'expense-move-target', groupId: command.draft.groupId,
            createdAt: '2026-09-01T12:00:00.000Z', updatedAt: '2026-09-01T12:00:00.000Z',
            createdBy: { id: currentUser.id, displayName: currentUser.displayName },
            updatedBy: { id: currentUser.id, displayName: currentUser.displayName }, revision: 1, syncState: 'fresh',
          },
        }
      } },
    })
    queue.bind(currentUser.id)
    const session = createAppSession({ repository, commandStorage: createMemoryCommandStorage() })
    setAppSessionForTesting({ ...session, queue })
    const store = useExpenseStore()
    await store.initialize({ origin: 'groups', groupId: original.groupId, expenseId: original.id })

    await expect(store.selectContext(target.id)).resolves.toBe(true)
    expect(store.returnPath).toBe('/tabs/groups/target-trip')
    completeValidEditor(store)
    expect(await store.submit('move-from-editor')).toBe(true)
    await queue.submit(queue.get('move-from-editor')!.envelope).result()
    await eventually(() => store.saveState === 'saved')

    expect(submitted).toMatchObject({
      kind: 'expense.edit', groupId: original.groupId, expenseId: original.id,
      draft: { groupId: target.id },
    })
    expect(store.returnPath).toBe('/tabs/groups/expenses/expense-move-target?groupId=target-trip')
    expect(store.notice).toContain('moved')
  })

  it('does not let a recurring expense move away from its series context', async () => {
    const base = createDemoRepository()
    const target: Group = {
      id: 'target-trip', kind: 'group', name: 'Target trip', currency: 'USD',
      memberIds: (await base.groups.listMembers('lake-house-weekend')).map(({ id }) => id), syncState: 'fresh',
    }
    const repository: AppRepository = {
      ...base,
      groups: {
        ...base.groups,
        async list() { return [...await base.groups.list(), target] },
        async listMembers(groupId) { return groupId === target.id ? base.groups.listMembers('lake-house-weekend') : base.groups.listMembers(groupId) },
        async getSettings(groupId) { return groupId === target.id ? { schemaVersion: 1, groupId, revision: 1 } : base.groups.getSettings(groupId) },
      },
    }
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))
    const store = useExpenseStore()
    await store.initialize({ origin: 'groups', groupId: 'lake-house-weekend', expenseId: 'cabin-deposit' })

    await expect(store.selectContext(target.id)).resolves.toBe(false)
    expect(store.editor.groupId).toBe('lake-house-weekend')
    expect(store.errors.context).toMatch(/recurring/i)
  })

  it('requires source receipts to be removed before moving into another context', async () => {
    const base = createDemoRepository()
    const target: Group = {
      id: 'target-trip', kind: 'group', name: 'Target trip', currency: 'USD',
      memberIds: (await base.groups.listMembers('lake-house-weekend')).map(({ id }) => id), syncState: 'fresh',
    }
    const repository: AppRepository = {
      ...base,
      groups: {
        ...base.groups,
        async list() { return [...await base.groups.list(), target] },
        async listMembers(groupId) { return groupId === target.id ? base.groups.listMembers('lake-house-weekend') : base.groups.listMembers(groupId) },
        async getSettings(groupId) { return groupId === target.id ? { schemaVersion: 1, groupId, revision: 1 } : base.groups.getSettings(groupId) },
      },
      expenses: {
        ...base.expenses,
        async getById(groupId, expenseId) {
          const expense = await base.expenses.getById(groupId, expenseId)
          return expense && expenseId === 'groceries' ? { ...expense, attachmentRefs: ['asset-existing-receipt'] } : expense
        },
      },
    }
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))
    const store = useExpenseStore()
    await store.initialize({ origin: 'groups', groupId: 'lake-house-weekend', expenseId: 'groceries' })

    await expect(store.selectContext(target.id)).resolves.toBe(false)
    expect(store.editor.groupId).toBe('lake-house-weekend')
    expect(store.errors.context).toMatch(/remove.*receipt/i)

    store.editor.attachmentRefs = []
    await expect(store.selectContext(target.id)).resolves.toBe(true)
  })

  it('ignores a stale initialization that resolves after a newer route context', async () => {
    const base = createDemoRepository()
    const slow = deferred<Group | undefined>()
    const currentUser = await base.app.getCurrentUser()
    const fastGroup: Group = { id: 'fast-context', kind: 'group', name: 'Fast context', currency: 'USD', memberIds: [currentUser.id], syncState: 'fresh' }
    const slowGroup: Group = { ...fastGroup, id: 'slow-context', name: 'Slow context' }
    const repository: AppRepository = {
      ...base,
      groups: {
        ...base.groups,
        async list() { return [slowGroup, fastGroup] },
        async getById(groupId) { return groupId === slowGroup.id ? slow.promise : groupId === fastGroup.id ? fastGroup : undefined },
        async listMembers() { return [currentUser] },
        async getSettings(groupId) { return { schemaVersion: 1, groupId, revision: 1 } },
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
    const slowGroup: Group = { id: 'slow-context', kind: 'group', name: 'Slow context', currency: 'EUR', memberIds: [currentUser.id], syncState: 'fresh' }
    const repository: AppRepository = {
      ...base,
      groups: {
        ...base.groups,
        async list() { return [...await base.groups.list(), slowGroup] },
        async listMembers(groupId) { return groupId === slowGroup.id ? slowMembers.promise : base.groups.listMembers(groupId) },
        async getSettings(groupId) { return groupId === slowGroup.id ? { schemaVersion: 1, groupId, revision: 1 } : base.groups.getSettings(groupId) },
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

  it('lets only the latest context selection commit when selections resolve out of order', async () => {
    const base = createDemoRepository()
    const currentUser = await base.app.getCurrentUser()
    const firstMembers = deferred<readonly Member[]>()
    const secondMembers = deferred<readonly Member[]>()
    const firstGroup: Group = { id: 'first-context', kind: 'group', name: 'First context', currency: 'EUR', memberIds: [currentUser.id], syncState: 'fresh' }
    const secondGroup: Group = { id: 'second-context', kind: 'group', name: 'Second context', currency: 'BHD', memberIds: [currentUser.id], syncState: 'fresh' }
    const repository: AppRepository = {
      ...base,
      groups: {
        ...base.groups,
        async list() { return [...await base.groups.list(), firstGroup, secondGroup] },
        async listMembers(groupId) {
          if (groupId === firstGroup.id) return firstMembers.promise
          if (groupId === secondGroup.id) return secondMembers.promise
          return base.groups.listMembers(groupId)
        },
        async getSettings(groupId) { return groupId === firstGroup.id || groupId === secondGroup.id ? { schemaVersion: 1, groupId, revision: 1 } : base.groups.getSettings(groupId) },
      },
    }
    setAppSessionForTesting(createAppSession({ repository, commandStorage: createMemoryCommandStorage() }))
    const store = useExpenseStore()
    await store.initialize({ origin: 'groups', groupId: 'lake-house-weekend' })

    const first = store.selectContext(firstGroup.id)
    const second = store.selectContext(secondGroup.id)
    secondMembers.resolve([currentUser])
    await expect(second).resolves.toBe(true)
    firstMembers.resolve([currentUser])

    await expect(first).resolves.toBe(false)
    expect(store.editor.groupId).toBe(secondGroup.id)
    expect(store.contextName).toBe(secondGroup.name)
    expect(store.editor.currency).toBe('BHD')
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
    expect(await store.submit('recurring-without-scope')).toBe(false)
    expect(store.errors.recurrence).toContain('occurrence or future')
    expect(session.queue.get('recurring-without-scope')).toBeUndefined()
  })

  it('treats a persisted future edit scope as history and requires a fresh choice when reopened', async () => {
    const base = createDemoRepository()
    const repository: AppRepository = {
      ...base,
      expenses: {
        ...base.expenses,
        async getById(groupId, expenseId) {
          const expense = await base.expenses.getById(groupId, expenseId)
          return expense?.id === 'cabin-deposit'
            ? {
                ...expense,
                occurrenceEditScope: 'future',
                recurrence: { frequency: 'monthly', anchor: { month: 8, day: 30 }, timeZone: 'America/Chicago' },
              }
            : expense
        },
      },
    }
    const session = createAppSession({ repository, commandStorage: createMemoryCommandStorage() })
    setAppSessionForTesting(session)
    const store = useExpenseStore()

    await store.initialize({ origin: 'groups', groupId: 'lake-house-weekend', expenseId: 'cabin-deposit' })

    expect(await repository.expenses.getById('lake-house-weekend', 'cabin-deposit')).toMatchObject({ occurrenceEditScope: 'future' })
    expect(store.recurringTemplateId).toBe('cabin-deposit-monthly')
    expect(store.editor.recurrence).toEqual({ frequency: 'monthly', anchor: { month: 8, day: 30 }, timeZone: 'America/Chicago' })
    expect(store.editor.occurrenceEditScope).toBeUndefined()
    expect(await store.submit('reopened-recurring-without-scope')).toBe(false)
    expect(store.errors.recurrence).toContain('occurrence or future')
    expect(session.queue.get('reopened-recurring-without-scope')).toBeUndefined()
  })

  it('clears the prior editor scope when the same store reopens a recurring expense', async () => {
    const store = useExpenseStore()
    await store.initialize({ origin: 'groups', groupId: 'lake-house-weekend', expenseId: 'cabin-deposit' })
    store.editor.occurrenceEditScope = 'future'

    await store.initialize({ origin: 'groups', groupId: 'lake-house-weekend', expenseId: 'cabin-deposit' })

    expect(store.editor.occurrenceEditScope).toBeUndefined()
  })

  it('does not carry a recurring edit schedule into a later add draft in the same store', async () => {
    const session = createAppSession({ repository: createDemoRepository(), commandStorage: createMemoryCommandStorage() })
    setAppSessionForTesting(session)
    const store = useExpenseStore()
    await store.initialize({ origin: 'groups', groupId: 'lake-house-weekend', expenseId: 'cabin-deposit' })
    store.editor.recurrence = { frequency: 'monthly', anchor: { month: 8, day: 30 }, timeZone: 'America/Chicago' }
    store.editor.occurrenceEditScope = 'future'

    await store.initialize({ origin: 'groups', groupId: 'lake-house-weekend', today: '2026-09-01' })

    expect(store.mode).toBe('add')
    expect(store.editor.recurrence).toBeUndefined()
    expect(store.editor.occurrenceEditScope).toBeUndefined()
    completeValidEditor(store)
    expect(await store.submit('fresh-add-after-recurring-edit')).toBe(true)
    expect(session.queue.get('fresh-add-after-recurring-edit')?.envelope).toMatchObject({ kind: 'expense.add' })
    expect(session.queue.get('fresh-add-after-recurring-edit')?.envelope).not.toHaveProperty('recurrence')
    expect(session.queue.get('fresh-add-after-recurring-edit')?.envelope).not.toHaveProperty('occurrenceEditScope')
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
    const original = await repository.expenses.getById('lake-house-weekend', 'groceries')
    if (!original) throw new Error('Expected seeded expense')
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

    expect(await store.submit('pending-ice')).toBe(true)
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
    expect(store.receiptDurability).toEqual({
      status: 'local-only',
      reason: 'Receipt is stored only on this device until upload succeeds.',
    })
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

  it('keeps a queued receipt when slow recognition completes after the composer leaves', async () => {
    const recognition = deferred<ReceiptRecognitionResult>()
    const recognitionStarted = deferred<void>()
    const receipts = createMemoryReceiptStore({ id: () => 'command-owned-receipt' })
    const session = createAppSession({
      repository: createDemoRepository(), commandStorage: createMemoryCommandStorage(), receipts,
      receiptProvider: {
        async upload() { return { status: 'unavailable', reason: 'Upload unavailable.' } },
        recognize() { recognitionStarted.resolve(); return recognition.promise },
        async delete() { /* no remote asset exists */ },
      },
    })
    setAppSessionForTesting(session)
    const store = useExpenseStore()
    await store.initialize({ origin: 'groups', groupId: 'lake-house-weekend' })

    const attachment = store.attachReceipt(new Blob(['receipt'], { type: 'image/jpeg' }), 'receipt.jpg')
    await recognitionStarted.promise
    completeValidEditor(store)
    expect(await store.submit('receipt-owned-by-command')).toBe(true)
    store.leaveEditor()
    recognition.resolve({ status: 'unavailable', reason: 'Recognition unavailable.' })

    await expect(attachment).resolves.toBe(false)
    await expect(session.queue.submit(session.queue.get('receipt-owned-by-command')!.envelope).result()).resolves.toMatchObject({ status: 'saved' })
    await expect(receipts.get('local-receipt:command-owned-receipt')).resolves.toMatchObject({
      durability: { status: 'upload-unavailable', reason: 'Upload unavailable.' },
    })
  })

  it('does not queue an expense when IndexedDB cleanup deletes its receipt before claim', async () => {
    const reference: LocalReceiptReference = 'local-receipt:delete-first'
    const database = createInterleavingIndexedDb([receiptAsset(reference, new Blob(['receipt'], { type: 'image/jpeg' }), 'receipt.jpg')])
    const receipts = createIndexedDbReceiptStore({ indexedDb: database.factory })
    const session = createAppSession({ repository: createDemoRepository(), commandStorage: createMemoryCommandStorage(), receipts })
    setAppSessionForTesting(session)
    const store = useExpenseStore()
    await store.initialize({ origin: 'groups', groupId: 'lake-house-weekend' })
    completeValidEditor(store)
    store.editor.attachmentRefs = [reference]

    const cleanup = receipts.delete(reference)
    const submission = store.submit('deleted-before-claim')
    await database.runToIdle()

    await cleanup
    await expect(Promise.resolve(submission)).resolves.toBe(false)
    expect(session.queue.snapshot()).toEqual([])
    expect(store.errorSummary).toContain('receipt')
  })

  it('lets only the latest receipt attachment commit when local writes resolve out of order', async () => {
    const firstWrite = deferred<LocalReceiptReference>()
    const deleted: LocalReceiptReference[] = []
    const assets = new Map<LocalReceiptReference, ReceiptAsset>()
    let writeCount = 0
    const receipts: ReceiptBlobStore = {
      async put(blob, metadata) {
        writeCount += 1
        const reference = writeCount === 1 ? await firstWrite.promise : 'local-receipt:second-write'
        assets.set(reference, receiptAsset(reference, blob, metadata.fileName))
        return reference
      },
      async get(reference) { return assets.get(reference) },
      async delete(reference) { deleted.push(reference); assets.delete(reference) },
      async setDurability(reference, durability) {
        const asset = assets.get(reference)
        if (asset) assets.set(reference, { ...asset, durability })
      },
      async claim() { return true },
    }
    setAppSessionForTesting(createAppSession({
      repository: createDemoRepository(), commandStorage: createMemoryCommandStorage(), receipts,
    }))
    const store = useExpenseStore()
    await store.initialize({ origin: 'groups', groupId: 'lake-house-weekend' })

    const first = store.attachReceipt(new Blob(['first'], { type: 'image/jpeg' }), 'first.jpg')
    const second = store.attachReceipt(new Blob(['second'], { type: 'image/jpeg' }), 'second.jpg')
    await expect(second).resolves.toBe(true)
    firstWrite.resolve('local-receipt:first-write')

    await expect(first).resolves.toBe(false)
    expect(store.editor.attachmentRefs).toEqual(['local-receipt:second-write'])
    expect(store.receiptPreview?.reference).toBe('local-receipt:second-write')
    expect(deleted).toEqual(['local-receipt:first-write'])
  })

  it('keeps newer receipt recognition when an older provider response arrives last', async () => {
    const firstRecognition = deferred<ReceiptRecognitionResult>()
    const secondRecognition = deferred<ReceiptRecognitionResult>()
    const firstStarted = deferred<void>()
    const secondStarted = deferred<void>()
    const ids = ['first-recognition', 'second-recognition']
    const receipts = createMemoryReceiptStore({ id: () => ids.shift() ?? 'unexpected-receipt' })
    const provider: ReceiptProvider = {
      async upload() { return { status: 'unavailable', reason: 'Upload unavailable.' } },
      recognize(reference) {
        if (reference === 'local-receipt:first-recognition') { firstStarted.resolve(); return firstRecognition.promise }
        secondStarted.resolve()
        return secondRecognition.promise
      },
      async delete() { /* no remote asset exists */ },
    }
    setAppSessionForTesting(createAppSession({
      repository: createDemoRepository(), commandStorage: createMemoryCommandStorage(), receipts, receiptProvider: provider,
    }))
    const store = useExpenseStore()
    await store.initialize({ origin: 'groups', groupId: 'lake-house-weekend' })

    const first = store.attachReceipt(new Blob(['first'], { type: 'image/jpeg' }), 'first.jpg')
    await firstStarted.promise
    const second = store.attachReceipt(new Blob(['second'], { type: 'image/jpeg' }), 'second.jpg')
    await secondStarted.promise
    secondRecognition.resolve({ status: 'suggestions', source: 'provider', items: [{ description: 'New item', amountText: '12.00' }] })
    await expect(second).resolves.toBe(true)
    firstRecognition.resolve({ status: 'suggestions', source: 'provider', items: [{ description: 'Stale item', amountText: '99.00' }] })

    await expect(first).resolves.toBe(false)
    expect(store.editor.attachmentRefs).toEqual(['local-receipt:first-recognition', 'local-receipt:second-recognition'])
    expect(store.receiptPreview?.reference).toBe('local-receipt:second-recognition')
    expect(store.receiptSuggestions).toEqual([{ description: 'New item', amountText: '12.00' }])
  })

  it('invalidates recognition when its selected receipt is removed', async () => {
    const recognition = deferred<ReceiptRecognitionResult>()
    const recognitionStarted = deferred<void>()
    const receipts = createMemoryReceiptStore({ id: () => 'removed-during-recognition' })
    const provider: ReceiptProvider = {
      async upload() { return { status: 'unavailable', reason: 'Upload unavailable.' } },
      recognize() { recognitionStarted.resolve(); return recognition.promise },
      async delete() { /* no remote asset exists */ },
    }
    setAppSessionForTesting(createAppSession({
      repository: createDemoRepository(), commandStorage: createMemoryCommandStorage(), receipts, receiptProvider: provider,
    }))
    const store = useExpenseStore()
    await store.initialize({ origin: 'groups', groupId: 'lake-house-weekend' })

    const attachment = store.attachReceipt(new Blob(['receipt'], { type: 'image/jpeg' }), 'receipt.jpg')
    await recognitionStarted.promise
    await store.removeReceipt('local-receipt:removed-during-recognition')
    recognition.resolve({ status: 'suggestions', source: 'provider', items: [{ description: 'Removed item', amountText: '10.00' }] })

    await expect(attachment).resolves.toBe(false)
    expect(store.editor.attachmentRefs).toEqual([])
    expect(store.receiptPreview).toBeUndefined()
    expect(store.receiptDurability).toBeUndefined()
    expect(store.receiptSuggestions).toEqual([])
    expect(store.receiptMessage).toBe('')
  })

  it('surfaces the persisted provider upload reason after local saving remains available', async () => {
    const receipts = createMemoryReceiptStore({ id: () => 'offline-durability' })
    const session = createAppSession({
      repository: createDemoRepository(), commandStorage: createMemoryCommandStorage(), receipts,
      receiptProvider: {
        async upload() { return { status: 'unavailable', reason: 'No network. Receipt remains only on this device.' } },
        async recognize() { return { status: 'unavailable', reason: 'Recognition unavailable.' } },
        async delete() { /* no remote asset exists */ },
      },
    })
    setAppSessionForTesting(session)
    const store = useExpenseStore()
    await store.initialize({ origin: 'groups', groupId: 'lake-house-weekend' })
    await store.attachReceipt(new Blob(['receipt'], { type: 'image/jpeg' }), 'receipt.jpg')
    completeValidEditor(store)

    expect(await store.submit('offline-receipt-save')).toBe(true)
    const operation = session.queue.get('offline-receipt-save')
    if (!operation) throw new Error('Expected persisted receipt operation')
    await session.queue.submit(operation.envelope).result()
    await eventually(() => store.receiptDurability?.status === 'upload-unavailable')

    expect(store.saveState).toBe('saved')
    expect(store.receiptDurability).toEqual({
      status: 'upload-unavailable',
      reason: 'No network. Receipt remains only on this device.',
    })
    expect(store.editor.attachmentRefs).toEqual(['local-receipt:offline-durability'])
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

function receiptAsset(reference: LocalReceiptReference, blob: Blob, fileName: string): ReceiptAsset {
  const durability: ReceiptDurability = {
    status: 'local-only',
    reason: 'Receipt is stored only on this device until upload succeeds.',
  }
  return { reference, blob, fileName, mimeType: blob.type, size: blob.size, createdAt: '2026-08-30T12:00:00.000Z', durability, commandOperationIds: [] }
}

async function eventually(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (condition()) return
    await Promise.resolve()
  }
  throw new Error('Expected asynchronous store state was not observed')
}
