import { describe, expect, it } from 'vitest'
import { CommandConflictError, CommandQueue, createMemoryCommandStorage } from '../commandQueue'
import { OperationReplayConflictError } from '../operationIdentity'
import type { ExpenseAddCommand, ExpenseAddResult } from '../repositories'

const addExpense = (operationId: string): ExpenseAddCommand => ({
  kind: 'expense.add',
  operationId,
  groupId: 'lake-house-weekend',
  description: 'Firewood',
  date: '2026-08-30',
  total: { currency: 'USD', minorAmount: 2400 },
  payerId: 'maya-p',
  allocations: [
    { participantId: 'maya-p', money: { currency: 'USD', minorAmount: 600 } },
    { participantId: 'jordan-k', money: { currency: 'USD', minorAmount: 600 } },
    { participantId: 'alex-r', money: { currency: 'USD', minorAmount: 600 } },
    { participantId: 'taylor-s', money: { currency: 'USD', minorAmount: 600 } },
  ],
  category: 'Supplies',
})

const savedExpense = (operationId: string): ExpenseAddResult => ({
  kind: 'expense.add',
  operationId,
  status: 'saved',
  expense: { ...addExpense(operationId), id: 'demo-expense-006', createdAt: '2026-08-30T12:00:00.000Z', syncState: 'fresh' },
})

describe('CommandQueue', () => {
  it('uses an operation ID once while exposing pending and fresh states', async () => {
    const queue = new CommandQueue({
      storage: createMemoryCommandStorage(),
      handlers: { 'expense.add': async (command) => savedExpense(command.operationId) },
    })
    let calls = 0
    let release: (value: string) => void = () => undefined
    const completion = new Promise<ExpenseAddResult>((resolve) => { release = () => resolve(savedExpense('write-firewood')) })

    const waitingQueue = new CommandQueue({
      storage: createMemoryCommandStorage(),
      handlers: { 'expense.add': async () => { calls += 1; return completion } },
    })
    const first = waitingQueue.submit(addExpense('write-firewood'))

    expect(waitingQueue.get('write-firewood')).toMatchObject({ status: 'pending' })
    release('saved')
    await expect(first.result()).resolves.toMatchObject({ status: 'saved' })
    await expect(waitingQueue.submit(addExpense('write-firewood')).result()).resolves.toMatchObject({ status: 'saved' })
    expect(calls).toBe(1)
    expect(waitingQueue.get('write-firewood')).toMatchObject({ status: 'fresh', result: { status: 'saved' } })
    expect(waitingQueue.markStale('write-firewood')).toMatchObject({ status: 'stale', result: { status: 'saved' } })
    expect(waitingQueue.markFresh('write-firewood')).toMatchObject({ status: 'fresh', result: { status: 'saved' } })
  })

  it('retries only failed operations and publishes each retry transition', async () => {
    const queue = new CommandQueue({
      storage: createMemoryCommandStorage(),
      handlers: {
        'expense.add': async (command) => {
          calls += 1
          if (calls === 1) throw new Error('offline')
          return savedExpense(command.operationId)
        },
      },
    })
    const states: string[] = []
    queue.subscribe((operation) => states.push(operation.status))
    let calls = 0

    await expect(queue.submit(addExpense('retryable-write')).result()).rejects.toThrow('offline')

    expect(queue.get('retryable-write')).toMatchObject({ status: 'failed' })
    await expect(queue.retry('retryable-write').result()).resolves.toMatchObject({ status: 'saved' })
    await expect(queue.retry('retryable-write').result()).rejects.toThrow('Only failed operations can be retried')
    expect(calls).toBe(2)
    expect(states).toEqual(['pending', 'failed', 'pending', 'fresh'])
  })

  it('retains a conflict without retrying its operation', async () => {
    const queue = new CommandQueue({
      storage: createMemoryCommandStorage(),
      handlers: {
        'expense.add': async () => {
          calls += 1
          throw new CommandConflictError('remote revision changed', { revision: 'remote-2' })
        },
      },
    })
    let calls = 0

    await expect(queue.submit(addExpense('conflicted-write')).result()).rejects.toThrow('remote revision changed')

    expect(queue.get('conflicted-write')).toMatchObject({
      status: 'conflicted',
      conflict: { revision: 'remote-2' },
    })
    await expect(queue.retry('conflicted-write').result()).rejects.toThrow('Only failed operations can be retried')
    expect(calls).toBe(1)
  })

  it('isolates a throwing listener from a successful side effect and other listeners', async () => {
    let calls = 0
    const observed: string[] = []
    const queue = new CommandQueue({
      storage: createMemoryCommandStorage(),
      handlers: { 'expense.add': async (command) => { calls += 1; return savedExpense(command.operationId) } },
    })
    queue.subscribe(() => { throw new Error('render failed') })
    queue.subscribe((operation) => observed.push(operation.status))

    await expect(queue.submit(addExpense('listener-isolation')).result()).resolves.toMatchObject({ status: 'saved' })

    expect(calls).toBe(1)
    expect(queue.get('listener-isolation')).toMatchObject({ status: 'fresh' })
    expect(observed).toEqual(['pending', 'fresh'])
    await expect(queue.retry('listener-isolation').result()).rejects.toThrow('Only failed operations can be retried')
  })

  it('persists a pending envelope and resumes it after re-instantiation without repeating the operation ID', async () => {
    const storage = createMemoryCommandStorage()
    let calls = 0
    const handler = async (command: { readonly operationId: string }): Promise<ExpenseAddResult> => {
      calls += 1
      return savedExpense(command.operationId)
    }
    storage.save([{ status: 'pending', envelope: addExpense('reload-safe') }])

    const reloaded = new CommandQueue({ storage, handlers: { 'expense.add': handler } })
    expect(reloaded.get('reload-safe')).toMatchObject({ status: 'pending', envelope: { operationId: 'reload-safe' } })
    await reloaded.resume()
    await expect(reloaded.submit(addExpense('reload-safe')).result()).resolves.toMatchObject({ status: 'saved' })

    expect(calls).toBe(1)
    expect(storage.load()).toEqual([expect.objectContaining({ status: 'fresh', envelope: expect.objectContaining({ operationId: 'reload-safe' }) })])
  })

  it('conflicts changed payload, group, or kind for an existing operation ID without running a second handler', async () => {
    let calls = 0
    const queue = new CommandQueue({
      storage: createMemoryCommandStorage(),
      handlers: { 'expense.add': async (command) => { calls += 1; return savedExpense(command.operationId) } },
    })
    await queue.submit(addExpense('replay-identity')).result()

    await expect(queue.submit({ ...addExpense('replay-identity'), description: 'Changed payload' }).result()).rejects.toBeInstanceOf(CommandConflictError)
    expect(queue.get('replay-identity')).toMatchObject({ status: 'conflicted' })
    expect(calls).toBe(1)
    await expect(queue.retry('replay-identity').result()).rejects.toThrow('Only failed operations can be retried')

    const groupQueue = new CommandQueue({ storage: createMemoryCommandStorage(), handlers: { 'expense.add': async (command) => savedExpense(command.operationId) } })
    await groupQueue.submit(addExpense('replay-group')).result()
    await expect(groupQueue.submit({ ...addExpense('replay-group'), groupId: 'other-group' }).result()).rejects.toBeInstanceOf(CommandConflictError)

    const kindQueue = new CommandQueue({ storage: createMemoryCommandStorage(), handlers: { 'expense.add': async (command) => savedExpense(command.operationId) } })
    await kindQueue.submit(addExpense('replay-kind')).result()
    await expect(kindQueue.submit({ kind: 'comment.add', operationId: 'replay-kind', groupId: 'lake-house-weekend', expenseId: 'groceries', body: 'Different kind' }).result()).rejects.toBeInstanceOf(CommandConflictError)
  })

  it('maps a handler replay conflict to conflicted rather than retryable failed', async () => {
    let calls = 0
    const queue = new CommandQueue({
      storage: createMemoryCommandStorage(),
      handlers: { 'expense.add': async () => { calls += 1; throw new OperationReplayConflictError() } },
    })

    await expect(queue.submit(addExpense('handler-replay-conflict')).result()).rejects.toBeInstanceOf(CommandConflictError)
    expect(queue.get('handler-replay-conflict')).toMatchObject({ status: 'conflicted' })
    expect(calls).toBe(1)
    await expect(queue.retry('handler-replay-conflict').result()).rejects.toThrow('Only failed operations can be retried')
  })
})
