import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { CommandQueue, createMemoryCommandStorage } from '../../../data/commandQueue'
import { createDemoRepository } from '../../../data/demoRepository'
import { createAppSession, setAppSessionForTesting } from '../../../data/session'
import type { CommandOperation } from '../../../data/commandQueue'
import type { ExpenseAddCommand, ExpenseDraft, ExpenseEditCommand, ExpenseRow } from '../../../data/repositories'
import { useGroupStore } from '../groupStore'

const ORIGIN_UID = 'maya-p'

const command = (operationId: string): ExpenseAddCommand => ({
  kind: 'expense.add', operationId, groupId: 'lake-house-weekend', description: 'Ice', date: '2026-08-30', total: { currency: 'USD', minorAmount: 400 },
  payments: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 400 } }],
  allocations: [
    { participantId: 'maya-p', money: { currency: 'USD', minorAmount: 100 } },
    { participantId: 'jordan-k', money: { currency: 'USD', minorAmount: 100 } },
    { participantId: 'alex-r', money: { currency: 'USD', minorAmount: 100 } },
    { participantId: 'taylor-s', money: { currency: 'USD', minorAmount: 100 } },
  ],
  category: 'Supplies', splitMethod: { type: 'equal', participantIds: ['maya-p', 'jordan-k', 'alex-r', 'taylor-s'] }, attachmentRefs: [],
})

const draftFor = (expense: ExpenseRow, description = expense.description): ExpenseDraft => ({
  groupId: expense.groupId,
  description,
  date: expense.date,
  total: { ...expense.total },
  payments: expense.payments.map((payment) => ({ participantId: payment.participantId, money: { ...payment.money } })),
  allocations: expense.allocations.map((allocation) => ({ participantId: allocation.participantId, money: { ...allocation.money } })),
  category: expense.category,
  splitMethod: JSON.parse(JSON.stringify(expense.splitMethod)),
  attachmentRefs: [...expense.attachmentRefs],
})

const editCommand = (operationId: string, expense: ExpenseRow, expectedRevision: number, description: string): ExpenseEditCommand => ({
  kind: 'expense.edit', operationId, groupId: expense.groupId, expenseId: expense.id, expectedRevision, draft: draftFor(expense, description),
})

beforeEach(() => { setActivePinia(createPinia()) })

describe('pending journal projection', () => {
  it('waits for queue identity hydration before reading a persisted pending journal', async () => {
    const baseRepository = createDemoRepository()
    let groupReads = 0
    const repository = {
      ...baseRepository,
      groups: {
        ...baseRepository.groups,
        async getById(groupId: string) {
          groupReads += 1
          return baseRepository.groups.getById(groupId)
        },
      },
    }
    const pending: CommandOperation = { originUid: ORIGIN_UID, status: 'pending', envelope: command('hydrated-pending') }
    const queue = new CommandQueue({ storage: storageWith([pending]), handlers: {}, })
    let releaseIdentity!: () => void
    const ready = new Promise<void>((resolve) => {
      releaseIdentity = () => { queue.bind(ORIGIN_UID); resolve() }
    })
    const baseSession = createAppSession({ repository, commandStorage: createMemoryCommandStorage() })
    setAppSessionForTesting({ ...baseSession, queue, ready })
    const store = useGroupStore()

    const loading = store.loadGroup('lake-house-weekend')
    await Promise.resolve()
    expect(groupReads).toBe(0)

    releaseIdentity()
    await loading
    expect(store.journalExpenses[0]).toMatchObject({ description: 'Ice', syncState: 'pending', clientOperationId: 'hydrated-pending' })
  })

  it('survives a store reload and reconciles the same row after save', async () => {
    const repository = createDemoRepository()
    const storage = createMemoryCommandStorage()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const queue = new CommandQueue({ originUid: ORIGIN_UID, storage, handlers: { 'expense.add': async (envelope) => {
      if (envelope.kind !== 'expense.add') throw new Error('Unexpected command')
      await blocked
      return repository.expenses.add(envelope)
    } } })
    setAppSessionForTesting({ ...createAppSession({ repository, commandStorage: storage }), queue })
    const first = useGroupStore()
    await first.loadGroup('lake-house-weekend')
    const handle = queue.submit(command('pending-ice'))
    expect(first.journalExpenses[0]).toMatchObject({ id: 'pending:pending-ice', description: 'Ice', syncState: 'pending', clientOperationId: 'pending-ice' })

    setActivePinia(createPinia())
    const reloaded = useGroupStore()
    await reloaded.loadGroup('lake-house-weekend')
    expect(reloaded.journalExpenses[0]).toMatchObject({ description: 'Ice', syncState: 'pending' })

    release()
    await handle.result()
    expect(reloaded.journalExpenses[0]).toMatchObject({ id: 'demo-expense-006', description: 'Ice', syncState: 'fresh' })
    expect(reloaded.journalExpenses.filter(({ description }) => description === 'Ice')).toHaveLength(1)

    await reloaded.loadGroup('lake-house-weekend')
    expect(queue.get('pending-ice')).toBeUndefined()
    expect(reloaded.journalExpenses.filter(({ description }) => description === 'Ice')).toHaveLength(1)
  })

  it('retains failed rows for retry and removes only a failed draft on discard', async () => {
    const repository = createDemoRepository()
    let attempts = 0
    const queue = new CommandQueue({ originUid: ORIGIN_UID, storage: createMemoryCommandStorage(), handlers: { 'expense.add': async (envelope) => {
      if (envelope.kind !== 'expense.add') throw new Error('Unexpected command')
      attempts += 1
      if (attempts < 2 || envelope.operationId === 'discard-ice') throw Object.assign(new Error('offline'), { code: 'unavailable' })
      return repository.expenses.add(envelope)
    } } })
    setAppSessionForTesting({ ...createAppSession({ repository, commandStorage: createMemoryCommandStorage() }), queue })
    const store = useGroupStore()
    await store.loadGroup('lake-house-weekend')
    await expect(queue.submit(command('retry-ice')).result()).rejects.toThrow('offline')
    expect(store.journalExpenses[0]).toMatchObject({ syncState: 'failed', clientOperationId: 'retry-ice' })

    await store.retryOperation('retry-ice').result()
    expect(store.journalExpenses[0]).toMatchObject({ syncState: 'fresh', description: 'Ice' })

    await expect(queue.submit(command('discard-ice')).result()).rejects.toThrow('offline')
    expect(store.journalExpenses.some(({ clientOperationId }) => clientOperationId === 'discard-ice')).toBe(true)
    expect(store.discardFailedOperation('discard-ice')).toBe(true)
    expect(store.journalExpenses.some(({ clientOperationId }) => clientOperationId === 'discard-ice')).toBe(false)
  })

  it('applies a confirmed delete tombstone even when an older saved edit appears later in the queue', async () => {
    const repository = createDemoRepository()
    const groceries = await repository.expenses.getById('lake-house-weekend', 'groceries')
    if (!groceries) throw new Error('Missing fixture expense')
    const oldEdit = { ...groceries, description: 'Older groceries', revision: 2 }
    const operations: readonly CommandOperation[] = [
      {
        originUid: ORIGIN_UID,
        status: 'fresh',
        envelope: { kind: 'expense.delete', operationId: 'delete-groceries', groupId: groceries.groupId, expenseId: groceries.id, expectedRevision: 2 },
        result: { kind: 'expense.delete', operationId: 'delete-groceries', status: 'saved', tombstone: { id: groceries.id, groupId: groceries.groupId, revision: 3, deletedAt: '2026-08-30T13:00:00.000Z' } },
      },
      {
        originUid: ORIGIN_UID,
        status: 'fresh',
        envelope: editCommand('older-edit', groceries, 1, oldEdit.description),
        result: { kind: 'expense.edit', operationId: 'older-edit', status: 'saved', expense: oldEdit },
      },
    ]
    const queue = new CommandQueue({ originUid: ORIGIN_UID, storage: storageWith(operations), handlers: {} })
    setAppSessionForTesting({ ...createAppSession({ repository, commandStorage: createMemoryCommandStorage() }), queue })
    const store = useGroupStore()

    await store.loadGroup('lake-house-weekend')

    expect(store.journalExpenses.some(({ id }) => id === groceries.id)).toBe(false)
  })

  it('keeps an acknowledged tombstone watermark ahead of an older saved version', async () => {
    const baseRepository = createDemoRepository()
    const groceries = await baseRepository.expenses.getById('lake-house-weekend', 'groceries')
    if (!groceries) throw new Error('Missing fixture expense')
    const repository = {
      ...baseRepository,
      expenses: {
        ...baseRepository.expenses,
        async listForGroup(groupId: string) {
          return (await baseRepository.expenses.listForGroup(groupId)).filter(({ id }) => id !== groceries.id)
        },
      },
    }
    const olderEdit = { ...groceries, description: 'Older groceries', revision: 2 }
    const operations: readonly CommandOperation[] = [
      {
        originUid: ORIGIN_UID,
        status: 'fresh',
        envelope: editCommand('older-edit-before-delete', groceries, 1, olderEdit.description),
        result: { kind: 'expense.edit', operationId: 'older-edit-before-delete', status: 'saved', expense: olderEdit },
      },
      {
        originUid: ORIGIN_UID,
        status: 'fresh',
        envelope: { kind: 'expense.delete', operationId: 'acknowledged-delete', groupId: groceries.groupId, expenseId: groceries.id, expectedRevision: 2 },
        result: { kind: 'expense.delete', operationId: 'acknowledged-delete', status: 'saved', tombstone: { id: groceries.id, groupId: groceries.groupId, revision: 3, deletedAt: '2026-08-30T13:00:00.000Z' } },
      },
    ]
    const queue = new CommandQueue({ originUid: ORIGIN_UID, storage: storageWith(operations), handlers: {} })
    setAppSessionForTesting({ ...createAppSession({ repository, commandStorage: createMemoryCommandStorage() }), queue })
    const store = useGroupStore()

    await store.loadGroup('lake-house-weekend')

    expect(queue.get('acknowledged-delete')).toBeUndefined()
    expect(queue.get('older-edit-before-delete')).toBeUndefined()
    expect(store.journalExpenses.some(({ id }) => id === groceries.id)).toBe(false)

    setActivePinia(createPinia())
    const reloaded = useGroupStore()
    await reloaded.loadGroup('lake-house-weekend')
    expect(reloaded.journalExpenses.some(({ id }) => id === groceries.id)).toBe(false)
  })

  it('selects the highest confirmed expense revision independent of queue order and clears acknowledged overlays', async () => {
    const repository = createDemoRepository()
    const groceries = await repository.expenses.getById('lake-house-weekend', 'groceries')
    if (!groceries) throw new Error('Missing fixture expense')
    const revisionFour = { ...groceries, description: 'Newest groceries', revision: 4, updatedAt: '2026-08-30T14:00:00.000Z' }
    const revisionTwo = { ...groceries, description: 'Old groceries', revision: 2, updatedAt: '2026-08-30T12:00:00.000Z' }
    const operations: readonly CommandOperation[] = [
      {
        originUid: ORIGIN_UID,
        status: 'fresh',
        envelope: editCommand('newest-first', groceries, 3, revisionFour.description),
        result: { kind: 'expense.edit', operationId: 'newest-first', status: 'saved', expense: revisionFour },
      },
      {
        originUid: ORIGIN_UID,
        status: 'stale',
        envelope: editCommand('older-last', groceries, 1, revisionTwo.description),
        result: { kind: 'expense.edit', operationId: 'older-last', status: 'saved', expense: revisionTwo },
      },
    ]
    const queue = new CommandQueue({ originUid: ORIGIN_UID, storage: storageWith(operations), handlers: {} })
    setAppSessionForTesting({ ...createAppSession({ repository, commandStorage: createMemoryCommandStorage() }), queue })
    const store = useGroupStore()

    await store.loadGroup('lake-house-weekend')

    expect(store.journalExpenses.filter(({ id }) => id === groceries.id)).toHaveLength(1)
    expect(store.journalExpenses.find(({ id }) => id === groceries.id)).toMatchObject({ description: 'Newest groceries', revision: 4, syncState: 'fresh' })
    expect(store.journalExpenses.find(({ id }) => id === groceries.id)?.clientOperationId).toBeUndefined()
  })

  it('derives current-user nets from the reconciled pending journal rather than repository rows', async () => {
    const repository = createDemoRepository()
    const groceries = await repository.expenses.getById('lake-house-weekend', 'groceries')
    if (!groceries) throw new Error('Missing fixture expense')
    const localDraft: ExpenseDraft = {
      ...draftFor(groceries, 'Tiny groceries'),
      total: { currency: 'USD', minorAmount: 400 },
      payments: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 400 } }],
      allocations: [
        { participantId: 'maya-p', money: { currency: 'USD', minorAmount: 100 } },
        { participantId: 'jordan-k', money: { currency: 'USD', minorAmount: 100 } },
        { participantId: 'alex-r', money: { currency: 'USD', minorAmount: 100 } },
        { participantId: 'taylor-s', money: { currency: 'USD', minorAmount: 100 } },
      ],
    }
    const operation: CommandOperation = {
      originUid: ORIGIN_UID,
      status: 'pending',
      envelope: { kind: 'expense.edit', operationId: 'pending-net-edit', groupId: groceries.groupId, expenseId: groceries.id, expectedRevision: 1, draft: localDraft },
    }
    const queue = new CommandQueue({ originUid: ORIGIN_UID, storage: storageWith([operation]), handlers: {} })
    setAppSessionForTesting({ ...createAppSession({ repository, commandStorage: createMemoryCommandStorage() }), queue })
    const store = useGroupStore()

    await store.loadGroup('lake-house-weekend')

    expect(store.journalExpenses.find(({ id }) => id === groceries.id)).toMatchObject({ description: 'Tiny groceries', syncState: 'pending' })
    expect(store.currentUserNets).toEqual([{ currency: 'USD', minorAmount: -8825 }])
  })

  it('shows both conflict versions and reloads the remote version without retrying the conflicted command', async () => {
    const repository = createDemoRepository()
    const groceries = await repository.expenses.getById('lake-house-weekend', 'groceries')
    if (!groceries) throw new Error('Missing fixture expense')
    const queue = new CommandQueue({
      originUid: ORIGIN_UID,
      storage: createMemoryCommandStorage(),
      handlers: { 'expense.edit': async (envelope) => {
        if (envelope.kind !== 'expense.edit') throw new Error('Unexpected command')
        return repository.expenses.edit(envelope)
      } },
    })
    setAppSessionForTesting({ ...createAppSession({ repository, commandStorage: createMemoryCommandStorage() }), queue })
    const conflictWrite: ExpenseEditCommand = {
      ...editCommand('conflict-reload', groceries, 0, 'My grocery draft'),
      draft: {
        ...draftFor(groceries, 'My grocery draft'),
        total: { currency: 'USD', minorAmount: 400 },
        payments: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 400 } }],
        allocations: [
          { participantId: 'maya-p', money: { currency: 'USD', minorAmount: 100 } },
          { participantId: 'jordan-k', money: { currency: 'USD', minorAmount: 100 } },
          { participantId: 'alex-r', money: { currency: 'USD', minorAmount: 100 } },
          { participantId: 'taylor-s', money: { currency: 'USD', minorAmount: 100 } },
        ],
      },
    }
    await expect(queue.submit(conflictWrite).result()).rejects.toThrow('changed remotely')
    const store = useGroupStore()
    await store.loadGroup('lake-house-weekend')

    expect(store.journalExpenses.find(({ id }) => id === groceries.id)).toMatchObject({
      description: 'My grocery draft',
      syncState: 'conflicted',
      retryable: false,
      conflictRemote: { description: 'Groceries', revision: 1 },
    })
    const conflictedRow = store.journalExpenses.find(({ id }) => id === groceries.id)
    if (!conflictedRow) throw new Error('Missing conflicted row')
    expect(store.positionFor(conflictedRow).money).toEqual({ currency: 'USD', minorAmount: 12750 })

    const remoteAdvance = await repository.expenses.edit(editCommand('remote-after-load', groceries, 1, 'Latest remote groceries'))
    expect(remoteAdvance).toMatchObject({ status: 'saved', expense: { revision: 2 } })

    await expect(store.reloadRemoteConflict('conflict-reload')).resolves.toBe(true)
    expect(store.journalExpenses.find(({ id }) => id === groceries.id)).toMatchObject({ description: 'Latest remote groceries', revision: 2, syncState: 'fresh' })
    expect(store.journalExpenses.find(({ id }) => id === groceries.id)?.conflictRemote).toBeUndefined()
  })

  it('retains a conflicted draft as a stable new edit intent against the remote revision', async () => {
    const repository = createDemoRepository({ now: () => '2026-08-30T14:00:00.000Z' })
    const groceries = await repository.expenses.getById('lake-house-weekend', 'groceries')
    if (!groceries) throw new Error('Missing fixture expense')
    const queue = new CommandQueue({
      originUid: ORIGIN_UID,
      storage: createMemoryCommandStorage(),
      handlers: { 'expense.edit': async (envelope) => {
        if (envelope.kind !== 'expense.edit') throw new Error('Unexpected command')
        return repository.expenses.edit(envelope)
      } },
    })
    setAppSessionForTesting({ ...createAppSession({ repository, commandStorage: createMemoryCommandStorage() }), queue })
    await expect(queue.submit(editCommand('conflict-retain', groceries, 0, 'Keep my groceries')).result()).rejects.toThrow('changed remotely')
    const store = useGroupStore()
    await store.loadGroup('lake-house-weekend')

    const remoteAdvance = await repository.expenses.edit(editCommand('remote-before-retain', groceries, 1, 'Latest remote groceries'))
    expect(remoteAdvance).toMatchObject({ status: 'saved', expense: { revision: 2 } })

    const retained = await store.retainAndSaveLocal('conflict-retain')
    expect(retained?.operationId).toBe('conflict-retain.retain-local.r2')
    await retained?.result()

    await expect(repository.expenses.getById(groceries.groupId, groceries.id)).resolves.toMatchObject({ description: 'Keep my groceries', revision: 3 })
    expect(store.journalExpenses.filter(({ id }) => id === groceries.id)).toHaveLength(1)
    expect(store.journalExpenses.find(({ id }) => id === groceries.id)).toMatchObject({ description: 'Keep my groceries', revision: 3, syncState: 'fresh' })
  })

  it('retains a conflicted delete intent by deleting against the latest repository revision', async () => {
    const repository = createDemoRepository({ now: () => '2026-08-30T14:00:00.000Z' })
    const groceries = await repository.expenses.getById('lake-house-weekend', 'groceries')
    if (!groceries) throw new Error('Missing fixture expense')
    await repository.expenses.edit(editCommand('remote-before-delete-conflict', groceries, 1, 'Remote revision two'))
    const queue = new CommandQueue({
      originUid: ORIGIN_UID,
      storage: createMemoryCommandStorage(),
      handlers: { 'expense.delete': async (envelope) => {
        if (envelope.kind !== 'expense.delete') throw new Error('Unexpected command')
        return repository.expenses.delete(envelope)
      } },
    })
    setAppSessionForTesting({ ...createAppSession({ repository, commandStorage: createMemoryCommandStorage() }), queue })
    await expect(queue.submit({ kind: 'expense.delete', operationId: 'conflict-delete', groupId: groceries.groupId, expenseId: groceries.id, expectedRevision: 1 }).result()).rejects.toThrow('changed remotely')
    const store = useGroupStore()
    await store.loadGroup('lake-house-weekend')

    expect(store.journalExpenses.find(({ id }) => id === groceries.id)).toMatchObject({
      syncState: 'conflicted',
      conflictIntent: 'delete',
      conflictRemote: { description: 'Remote revision two', revision: 2 },
    })

    const revisionTwo = await repository.expenses.getById(groceries.groupId, groceries.id)
    if (!revisionTwo) throw new Error('Missing revision two')
    await repository.expenses.edit(editCommand('remote-after-delete-conflict', revisionTwo, 2, 'Remote revision three'))

    const retainedDelete = await store.deleteAgainstRemoteRevision('conflict-delete')
    expect(retainedDelete?.operationId).toBe('conflict-delete.delete-remote.r3')
    await retainedDelete?.result()

    await expect(repository.expenses.getById(groceries.groupId, groceries.id)).resolves.toMatchObject({ revision: 4, deletedAt: '2026-08-30T14:00:00.000Z' })
    expect(store.journalExpenses.some(({ id }) => id === groceries.id)).toBe(false)
  })

  it('marks only retryable failures as retryable journal rows', async () => {
    const repository = createDemoRepository()
    const retryable = {
      originUid: ORIGIN_UID, status: 'failed', envelope: command('network-failure'), error: { code: 'network', message: 'offline', retryable: true },
    } as CommandOperation
    const finalFailure = {
      originUid: ORIGIN_UID, status: 'failed', envelope: command('validation-failure'), error: { code: 'validation', message: 'invalid', retryable: false },
    } as CommandOperation
    const queue = new CommandQueue({ originUid: ORIGIN_UID, storage: storageWith([retryable, finalFailure]), handlers: {} })
    setAppSessionForTesting({ ...createAppSession({ repository, commandStorage: createMemoryCommandStorage() }), queue })
    const store = useGroupStore()

    await store.loadGroup('lake-house-weekend')

    expect(store.journalExpenses.find(({ clientOperationId }) => clientOperationId === 'network-failure')?.retryable).toBe(true)
    expect(store.journalExpenses.find(({ clientOperationId }) => clientOperationId === 'validation-failure')?.retryable).toBe(false)
    expect(store.discardFailedOperation('validation-failure')).toBe(true)
    expect(store.journalExpenses.some(({ clientOperationId }) => clientOperationId === 'validation-failure')).toBe(false)
  })
})

function storageWith(operations: readonly CommandOperation[]) {
  return createMemoryCommandStorage({
    [ORIGIN_UID]: { version: 2, originUid: ORIGIN_UID, operations },
  })
}
