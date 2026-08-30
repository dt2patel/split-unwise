import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { CommandQueue, createMemoryCommandStorage } from '../../../data/commandQueue'
import { createDemoRepository } from '../../../data/demoRepository'
import { createAppSession, setAppSessionForTesting } from '../../../data/session'
import type { ExpenseAddCommand } from '../../../data/repositories'
import { useGroupStore } from '../groupStore'

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

beforeEach(() => { setActivePinia(createPinia()) })

describe('pending journal projection', () => {
  it('survives a store reload and reconciles the same row after save', async () => {
    const repository = createDemoRepository()
    const storage = createMemoryCommandStorage()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const queue = new CommandQueue({ storage, handlers: { 'expense.add': async (envelope) => {
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
  })

  it('retains failed rows for retry and removes only a failed draft on discard', async () => {
    const repository = createDemoRepository()
    let attempts = 0
    const queue = new CommandQueue({ storage: createMemoryCommandStorage(), handlers: { 'expense.add': async (envelope) => {
      if (envelope.kind !== 'expense.add') throw new Error('Unexpected command')
      attempts += 1
      if (attempts < 2 || envelope.operationId === 'discard-ice') throw new Error('offline')
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
})
