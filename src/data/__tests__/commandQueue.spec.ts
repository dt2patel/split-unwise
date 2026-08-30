import { describe, expect, it } from 'vitest'
import { CommandConflictError, CommandFailedError, CommandQueue, createBrowserCommandStorage, createMemoryCommandStorage, type CommandQueueOptions, type CommandStorage } from '../commandQueue'
import { OperationReplayConflictError } from '../operationIdentity'
import type { CommandEnvelope, ExpenseAddCommand, ExpenseAddResult, ExpenseDeleteCommand, ExpenseDraft, ExpenseEditCommand, ExpenseEditResult, ExpenseRow } from '../repositories'

const addExpense = (operationId: string): ExpenseAddCommand => ({
  kind: 'expense.add',
  operationId,
  groupId: 'lake-house-weekend',
  description: 'Firewood',
  date: '2026-08-30',
  total: { currency: 'USD', minorAmount: 2400 },
  payments: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 2400 } }],
  allocations: [
    { participantId: 'maya-p', money: { currency: 'USD', minorAmount: 600 } },
    { participantId: 'jordan-k', money: { currency: 'USD', minorAmount: 600 } },
    { participantId: 'alex-r', money: { currency: 'USD', minorAmount: 600 } },
    { participantId: 'taylor-s', money: { currency: 'USD', minorAmount: 600 } },
  ],
  category: 'Supplies',
  splitMethod: { type: 'equal', participantIds: ['maya-p', 'jordan-k', 'alex-r', 'taylor-s'] },
  attachmentRefs: [],
})

const savedExpense = (operationId: string): Extract<ExpenseAddResult, { status: 'saved' }> => ({
  kind: 'expense.add',
  operationId,
  status: 'saved',
  expense: { ...addExpense(operationId), id: 'demo-expense-006', createdAt: '2026-08-30T12:00:00.000Z', updatedAt: '2026-08-30T12:00:00.000Z', revision: 1, syncState: 'fresh' },
})

const expenseDraft = (groupId = 'lake-house-weekend'): ExpenseDraft => {
  const { kind: _kind, operationId: _operationId, ...draft } = addExpense('draft-source')
  return { ...draft, groupId }
}

const editExpense = (operationId: string, expenseId = 'demo-expense-006', groupId = 'lake-house-weekend'): ExpenseEditCommand => ({
  kind: 'expense.edit', operationId, groupId, expenseId, expectedRevision: 1, draft: expenseDraft(groupId),
})

const deleteExpense = (operationId: string, expenseId = 'demo-expense-006', groupId = 'lake-house-weekend'): ExpenseDeleteCommand => ({
  kind: 'expense.delete', operationId, groupId, expenseId, expectedRevision: 1,
})

const expenseRow = (groupId = 'lake-house-weekend', id = 'demo-expense-006'): ExpenseRow => ({
  ...savedExpense('row-source').expense,
  groupId,
  id,
})

const savedEdit = (command: ExpenseEditCommand, row = expenseRow(command.groupId, command.expenseId)): ExpenseEditResult => ({
  kind: 'expense.edit', operationId: command.operationId, status: 'saved', expense: row,
})

const DEMO_UID = 'maya-p'

function createBoundQueue(options: CommandQueueOptions, originUid = DEMO_UID): CommandQueue {
  return new CommandQueue({ ...options, originUid } as CommandQueueOptions & { readonly originUid: string })
}

function createWebStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key) },
    setItem: (key, value) => { values.set(key, value) },
  }
}

describe('CommandQueue', () => {
  it('rejects submit and resume before an authenticated owner is bound', async () => {
    const queue = new CommandQueue({
      storage: createMemoryCommandStorage(),
      handlers: { 'expense.add': async (command) => savedExpense(command.operationId) },
    })

    expect(() => queue.submit(addExpense('unbound-submit'))).toThrow('authenticated owner')
    await expect(queue.resume()).rejects.toThrow('authenticated owner')
    expect(queue.snapshot()).toEqual([])
  })

  it('binds every operation to its authenticated origin owner', async () => {
    const queue = createBoundQueue({
      storage: createMemoryCommandStorage(),
      handlers: { 'expense.add': async (command) => savedExpense(command.operationId) },
    })

    await queue.submit(addExpense('owned-write')).result()

    expect(queue.get('owned-write')).toMatchObject({ originUid: DEMO_UID, status: 'fresh' })
  })

  it('persists a versioned document under a UID-namespaced browser key and ignores obsolete account-agnostic data', async () => {
    const browser = createWebStorage()
    browser.setItem('split-unwise:command-queue:v1', JSON.stringify([
      { status: 'pending', envelope: addExpense('obsolete-write') },
    ]))
    const queue = createBoundQueue({
      storage: createBrowserCommandStorage({ storage: browser }),
      handlers: { 'expense.add': async (command) => savedExpense(command.operationId) },
    })

    expect(queue.snapshot()).toEqual([])
    await queue.submit(addExpense('namespaced-write')).result()

    expect(JSON.parse(browser.getItem('split-unwise:command-queue:v2:maya-p') ?? 'null')).toMatchObject({
      version: 2,
      originUid: DEMO_UID,
      operations: [{ originUid: DEMO_UID, envelope: { operationId: 'namespaced-write' } }],
    })
    expect(browser.getItem('split-unwise:command-queue:v1')).not.toBeNull()
  })

  it('quarantines invalid and cross-owner records from a versioned document', () => {
    const quarantined: unknown[] = []
    const valid = { originUid: DEMO_UID, status: 'pending', envelope: addExpense('valid-owned') }
    const storage = {
      load: () => ({
        version: 2,
        originUid: DEMO_UID,
        operations: [
          valid,
          { ...valid, originUid: 'someone-else', envelope: addExpense('cross-owner') },
          { ...valid, status: 'invented', envelope: addExpense('invalid-status') },
          { status: 'pending', envelope: addExpense('obsolete-unowned') },
        ],
      }),
      save: () => undefined,
      quarantine: (_originUid: string, records: readonly unknown[]) => quarantined.push(...records),
    } as unknown as CommandStorage
    let queue: CommandQueue | undefined

    expect(() => { queue = createBoundQueue({ storage, handlers: {} }) }).not.toThrow()
    expect(queue?.snapshot()).toEqual([valid])
    expect(quarantined).toHaveLength(3)
  })

  it('accepts occurrence-scoped edits and quarantines obsolete single-scope records', () => {
    const quarantined: unknown[] = []
    const occurrence = {
      originUid: DEMO_UID,
      status: 'pending',
      envelope: { ...addExpense('current-occurrence-scope'), occurrenceEditScope: 'occurrence' },
    }
    const obsolete = {
      originUid: DEMO_UID,
      status: 'pending',
      envelope: { ...addExpense('obsolete-single-scope'), occurrenceEditScope: 'single' },
    }
    const storage = {
      load: () => ({ version: 2, originUid: DEMO_UID, operations: [occurrence, obsolete] }),
      save: () => undefined,
      quarantine: (_originUid: string, records: readonly unknown[]) => quarantined.push(...records),
    } as unknown as CommandStorage

    const queue = createBoundQueue({ storage, handlers: {} })

    expect(queue.snapshot()).toEqual([occurrence])
    expect(quarantined).toEqual([obsolete])
  })

  it('returns defensive snapshots and discards failed drafts only', async () => {
    const queue = createBoundQueue({
      storage: createMemoryCommandStorage(),
      handlers: { 'expense.add': async () => { throw new Error('offline') } },
    })
    await expect(queue.submit(addExpense('discardable')).result()).rejects.toThrow('offline')

    const snapshot = queue.snapshot()
    expect(snapshot).toEqual([expect.objectContaining({ status: 'failed', error: expect.objectContaining({ code: 'unknown' }) })])
    expect(queue.discard('discardable')).toBe(true)
    expect(queue.snapshot()).toEqual([])

    const conflicted = createBoundQueue({
      storage: createMemoryCommandStorage(),
      handlers: { 'expense.add': async () => { throw new CommandConflictError('remote changed', { revision: 2 }) } },
    })
    await expect(conflicted.submit(addExpense('keep-conflict')).result()).rejects.toThrow('remote changed')
    expect(() => conflicted.discard('keep-conflict')).toThrow('Only failed operations can be discarded')
    expect(conflicted.snapshot()).toHaveLength(1)
  })

  it('turns a not-supported handler result into a typed failed operation', async () => {
    const queue = createBoundQueue({
      storage: createMemoryCommandStorage(),
      handlers: {
        'expense.add': async (command) => ({
          kind: 'expense.add', operationId: command.operationId, status: 'not-supported', reason: 'Provider unavailable',
        }),
      },
    })

    await expect(queue.submit(addExpense('unsupported')).result()).rejects.toMatchObject({
      name: 'CommandFailedError',
      code: 'not-supported',
    } satisfies Partial<CommandFailedError>)
    expect(queue.get('unsupported')).toMatchObject({ status: 'failed', error: { code: 'not-supported', message: 'Provider unavailable' } })
  })

  it('rejects a saved add result whose expense belongs to another group', async () => {
    const queue = createBoundQueue({
      storage: createMemoryCommandStorage(),
      handlers: { 'expense.add': async (command) => ({
        ...savedExpense(command.operationId),
        expense: expenseRow('another-group'),
      }) },
    })

    await expect(queue.submit(addExpense('wrong-add-group')).result()).rejects.toMatchObject({ code: 'validation' })
    expect(queue.get('wrong-add-group')).toMatchObject({ status: 'failed', error: { code: 'validation', retryable: false } })
  })

  it.each([
    ['another group', expenseRow('another-group', 'demo-expense-006')],
    ['another expense', expenseRow('lake-house-weekend', 'another-expense')],
  ])('rejects a saved edit result for %s', async (_label, row) => {
    const command = editExpense('wrong-edit-identity')
    const queue = createBoundQueue({
      storage: createMemoryCommandStorage(),
      handlers: { 'expense.edit': async () => savedEdit(command, row) },
    })

    await expect(queue.submit(command).result()).rejects.toMatchObject({ code: 'validation' })
    expect(queue.get(command.operationId)).toMatchObject({ status: 'failed', error: { code: 'validation', retryable: false } })
  })

  it('uses an operation ID once while exposing pending and fresh states', async () => {
    const queue = createBoundQueue({
      storage: createMemoryCommandStorage(),
      handlers: { 'expense.add': async (command) => savedExpense(command.operationId) },
    })
    let calls = 0
    let release: (value: string) => void = () => undefined
    const completion = new Promise<ExpenseAddResult>((resolve) => { release = () => resolve(savedExpense('write-firewood')) })

    const waitingQueue = createBoundQueue({
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
    const queue = createBoundQueue({
      storage: createMemoryCommandStorage(),
      handlers: {
        'expense.add': async (command) => {
          calls += 1
          if (calls === 1) throw Object.assign(new Error('offline'), { code: 'unavailable' })
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
    const queue = createBoundQueue({
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

  it.each([
    ['edit with an incomplete remote', editExpense('bad-edit-remote'), { id: 'demo-expense-006', groupId: 'lake-house-weekend' }],
    ['edit with a cross-group remote', editExpense('cross-group-edit-remote'), expenseRow('another-group', 'demo-expense-006')],
    ['delete with a different-expense remote', deleteExpense('wrong-delete-remote'), expenseRow('lake-house-weekend', 'another-expense')],
  ] as const)('does not expose a malformed conflict remote for %s', async (_label, command, remote) => {
    const queue = createBoundQueue({
      storage: createMemoryCommandStorage(),
      handlers: {
        'expense.edit': async () => { throw new CommandConflictError('remote changed', { remote }) },
        'expense.delete': async () => { throw new CommandConflictError('remote changed', { remote }) },
      },
    })

    await expect(queue.submit(command as CommandEnvelope).result()).rejects.toBeInstanceOf(CommandConflictError)

    const operation = queue.get(command.operationId)
    expect(operation).toMatchObject({ status: 'conflicted', error: { code: 'conflict', retryable: false } })
    expect(operation && operation.status === 'conflicted' ? operation.conflict : undefined).not.toHaveProperty('remote')
  })

  it.each([
    ['edit', editExpense('valid-edit-remote')],
    ['delete', deleteExpense('valid-delete-remote')],
  ] as const)('keeps a complete identity-matched %s conflict remote', async (_label, command) => {
    const remote = expenseRow(command.groupId, command.expenseId)
    const queue = createBoundQueue({
      storage: createMemoryCommandStorage(),
      handlers: {
        'expense.edit': async () => { throw new CommandConflictError('remote changed', { remote }) },
        'expense.delete': async () => { throw new CommandConflictError('remote changed', { remote }) },
      },
    })

    await expect(queue.submit(command as CommandEnvelope).result()).rejects.toBeInstanceOf(CommandConflictError)

    expect(queue.get(command.operationId)).toMatchObject({
      status: 'conflicted',
      conflict: { remote: { groupId: command.groupId, id: command.expenseId, revision: 1 } },
    })
  })

  it('quarantines a persisted conflict with an invalid edit remote', () => {
    const command = editExpense('persisted-invalid-remote')
    const operation = {
      originUid: DEMO_UID,
      status: 'conflicted',
      envelope: command,
      error: { code: 'conflict', message: 'remote changed', retryable: false },
      conflict: { remote: { id: command.expenseId, groupId: command.groupId } },
    }
    const quarantined: unknown[] = []
    const storage = {
      load: () => ({ version: 2, originUid: DEMO_UID, operations: [operation] }),
      save: () => undefined,
      quarantine: (_originUid: string, records: readonly unknown[]) => quarantined.push(...records),
    } as unknown as CommandStorage

    const queue = createBoundQueue({ storage, handlers: {} })

    expect(queue.snapshot()).toEqual([])
    expect(quarantined).toEqual([operation])
  })

  it('isolates a throwing listener from a successful side effect and other listeners', async () => {
    let calls = 0
    const observed: string[] = []
    const queue = createBoundQueue({
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
    const pending = { originUid: DEMO_UID, status: 'pending' as const, envelope: addExpense('reload-safe') }
    const storage = createMemoryCommandStorage({
      [DEMO_UID]: { version: 2, originUid: DEMO_UID, operations: [pending] },
    })
    let calls = 0
    const handler = async (command: { readonly operationId: string }): Promise<ExpenseAddResult> => {
      calls += 1
      return savedExpense(command.operationId)
    }
    const reloaded = createBoundQueue({ storage, handlers: { 'expense.add': handler } })
    expect(reloaded.get('reload-safe')).toMatchObject({ status: 'pending', envelope: { operationId: 'reload-safe' } })
    await reloaded.resume()
    await expect(reloaded.submit(addExpense('reload-safe')).result()).resolves.toMatchObject({ status: 'saved' })

    expect(calls).toBe(1)
    expect(storage.load(DEMO_UID)).toMatchObject({
      version: 2,
      originUid: DEMO_UID,
      operations: [expect.objectContaining({ originUid: DEMO_UID, status: 'fresh', envelope: expect.objectContaining({ operationId: 'reload-safe' }) })],
    })
  })

  it('rejects a changed payload, group, or kind without mutating the original completed operation', async () => {
    let calls = 0
    const queue = createBoundQueue({
      storage: createMemoryCommandStorage(),
      handlers: { 'expense.add': async (command) => { calls += 1; return savedExpense(command.operationId) } },
    })
    await queue.submit(addExpense('replay-identity')).result()

    await expect(queue.submit({ ...addExpense('replay-identity'), description: 'Changed payload' }).result()).rejects.toBeInstanceOf(CommandConflictError)
    expect(queue.get('replay-identity')).toMatchObject({ status: 'fresh', envelope: { description: 'Firewood' }, result: { status: 'saved' } })
    expect(calls).toBe(1)

    const groupQueue = createBoundQueue({ storage: createMemoryCommandStorage(), handlers: { 'expense.add': async (command) => savedExpense(command.operationId) } })
    await groupQueue.submit(addExpense('replay-group')).result()
    await expect(groupQueue.submit({ ...addExpense('replay-group'), groupId: 'other-group' }).result()).rejects.toBeInstanceOf(CommandConflictError)
    expect(groupQueue.get('replay-group')).toMatchObject({ status: 'fresh', envelope: { groupId: 'lake-house-weekend' } })

    const kindQueue = createBoundQueue({ storage: createMemoryCommandStorage(), handlers: { 'expense.add': async (command) => savedExpense(command.operationId) } })
    await kindQueue.submit(addExpense('replay-kind')).result()
    await expect(kindQueue.submit({ kind: 'comment.add', operationId: 'replay-kind', groupId: 'lake-house-weekend', expenseId: 'groceries', body: 'Different kind' }).result()).rejects.toBeInstanceOf(CommandConflictError)
    expect(kindQueue.get('replay-kind')).toMatchObject({ status: 'fresh', envelope: { kind: 'expense.add' } })
  })

  it('keeps the original pending handler authoritative when a changed replay is rejected', async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    const queue = createBoundQueue({
      storage: createMemoryCommandStorage(),
      handlers: { 'expense.add': async (command) => {
        calls += 1
        await blocked
        return savedExpense(command.operationId)
      } },
    })
    const original = queue.submit(addExpense('pending-replay'))

    const replay = queue.submit({ ...addExpense('pending-replay'), description: 'Changed while pending' })
    await expect(replay.result()).rejects.toBeInstanceOf(CommandConflictError)
    expect(queue.get('pending-replay')).toMatchObject({ status: 'pending', envelope: { description: 'Firewood' } })

    release()
    await expect(original.result()).resolves.toMatchObject({ status: 'saved', expense: { description: 'Firewood' } })
    expect(queue.get('pending-replay')).toMatchObject({ status: 'fresh', envelope: { description: 'Firewood' } })
    expect(calls).toBe(1)
  })

  it('maps a handler replay conflict to conflicted rather than retryable failed', async () => {
    let calls = 0
    const queue = createBoundQueue({
      storage: createMemoryCommandStorage(),
      handlers: { 'expense.add': async () => { calls += 1; throw new OperationReplayConflictError() } },
    })

    await expect(queue.submit(addExpense('handler-replay-conflict')).result()).rejects.toBeInstanceOf(CommandConflictError)
    expect(queue.get('handler-replay-conflict')).toMatchObject({ status: 'conflicted' })
    expect(calls).toBe(1)
    await expect(queue.retry('handler-replay-conflict').result()).rejects.toThrow('Only failed operations can be retried')
  })

  it.each([
    ['network', Object.assign(new Error('offline'), { code: 'firestore/unavailable' }), true, 'failed'],
    ['permission-denied', Object.assign(new Error('forbidden'), { code: 'permission-denied' }), false, 'failed'],
    ['validation', Object.assign(new Error('bad input'), { code: 'invalid-argument' }), false, 'failed'],
    ['conflict', Object.assign(new Error('remote changed'), { code: 'aborted' }), false, 'conflicted'],
    ['unknown', new Error('unexpected'), false, 'failed'],
  ] as const)('maps %s failures with correct retryability', async (code, thrown, retryable, status) => {
    const queue = createBoundQueue({
      storage: createMemoryCommandStorage(),
      handlers: { 'expense.add': async () => { throw thrown } },
    })

    await expect(queue.submit(addExpense(`typed-${code}`)).result()).rejects.toThrow()

    expect(queue.get(`typed-${code}`)).toMatchObject({ status, error: { code, retryable } })
  })

  it('retries network failures but refuses non-retryable failures', async () => {
    let networkCalls = 0
    const networkQueue = createBoundQueue({
      storage: createMemoryCommandStorage(),
      handlers: { 'expense.add': async (command) => {
        networkCalls += 1
        if (networkCalls === 1) throw Object.assign(new Error('offline'), { code: 'unavailable' })
        return savedExpense(command.operationId)
      } },
    })
    const permissionQueue = createBoundQueue({
      storage: createMemoryCommandStorage(),
      handlers: { 'expense.add': async () => { throw Object.assign(new Error('forbidden'), { code: 'permission-denied' }) } },
    })

    await expect(networkQueue.submit(addExpense('retry-network')).result()).rejects.toThrow('offline')
    await expect(networkQueue.retry('retry-network').result()).resolves.toMatchObject({ status: 'saved' })
    await expect(permissionQueue.submit(addExpense('do-not-retry-permission')).result()).rejects.toThrow('forbidden')
    await expect(permissionQueue.retry('do-not-retry-permission').result()).rejects.toThrow('not retryable')
    expect(networkCalls).toBe(2)
  })

  it('acknowledges only terminal journal records and notifies subscribers after removal', async () => {
    const queue = createBoundQueue({
      storage: createMemoryCommandStorage(),
      handlers: { 'expense.add': async (command) => savedExpense(command.operationId) },
    })
    const observedSnapshots: number[] = []
    queue.subscribe(() => observedSnapshots.push(queue.snapshot().length))
    await queue.submit(addExpense('acknowledge-fresh')).result()

    expect(typeof (queue as unknown as { acknowledge?: unknown }).acknowledge).toBe('function')
    expect((queue as unknown as { acknowledge(operationId: string): boolean }).acknowledge('acknowledge-fresh')).toBe(true)
    expect(queue.snapshot()).toEqual([])
    expect(observedSnapshots.at(-1)).toBe(0)
  })
})
