import { describe, expect, it } from 'vitest'
import { CommandConflictError, CommandFailedError, CommandQueue, createBrowserCommandStorage, createMemoryCommandStorage, type CommandOperation, type CommandQueueOptions, type CommandStorage } from '../commandQueue'
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

const savedEdit = (command: ExpenseEditCommand, row = { ...expenseRow(command.groupId, command.expenseId), revision: command.expectedRevision + 1 }): ExpenseEditResult => ({
  kind: 'expense.edit', operationId: command.operationId, status: 'saved', expense: row,
})

const DEMO_UID = 'maya-p'

function createBoundQueue(options: CommandQueueOptions, originPrincipalKey = DEMO_UID): CommandQueue {
  return new CommandQueue({ ...options, originPrincipalKey })
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

    expect(() => queue.submit(addExpense('unbound-submit'))).toThrow('authenticated principal')
    await expect(queue.resume()).rejects.toThrow('authenticated principal')
    expect(queue.snapshot()).toEqual([])
  })

  it('binds every operation to its authenticated origin owner', async () => {
    const queue = createBoundQueue({
      storage: createMemoryCommandStorage(),
      handlers: { 'expense.add': async (command) => savedExpense(command.operationId) },
    })

    await queue.submit(addExpense('owned-write')).result()

    expect(queue.get('owned-write')).toMatchObject({ originPrincipalKey: DEMO_UID, status: 'fresh' })
  })

  it('persists a versioned document under a principal-namespaced browser key and ignores obsolete account-agnostic data', async () => {
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

    expect(JSON.parse(browser.getItem('split-unwise:command-queue:v6:maya-p') ?? 'null')).toMatchObject({
      version: 6,
      principalKey: DEMO_UID,
      operations: [{ originPrincipalKey: DEMO_UID, envelope: { operationId: 'namespaced-write' } }],
    })
    expect(browser.getItem('split-unwise:command-queue:v1')).not.toBeNull()
  })

  it('does not start a handler until the pending envelope is durably saved', async () => {
    let releasePendingSave!: () => void
    const pendingSave = new Promise<void>((resolve) => { releasePendingSave = resolve })
    let writes = 0
    let handlerCalls = 0
    const storage: CommandStorage = {
      load: () => undefined,
      save: async () => {
        writes += 1
        if (writes === 1) await pendingSave
      },
    }
    const queue = createBoundQueue({
      storage,
      handlers: {
        'expense.add': async (command) => {
          handlerCalls += 1
          return savedExpense(command.operationId)
        },
      },
    })

    const handle = queue.submit(addExpense('durable-before-execute'))
    await Promise.resolve()
    await Promise.resolve()

    expect(writes).toBe(1)
    expect(handlerCalls).toBe(0)

    releasePendingSave()
    await expect(handle.result()).resolves.toMatchObject({ status: 'saved' })
    expect(handlerCalls).toBe(1)
  })

  it('serializes async queue documents so an older write cannot overwrite a newer snapshot', async () => {
    const releases: Array<() => void> = []
    const documents: Array<{ readonly operations: readonly CommandOperation[] }> = []
    const handlerCalls: string[] = []
    const storage: CommandStorage = {
      load: () => undefined,
      save: async (_scopeKey, document) => {
        documents.push(document)
        if (documents.length <= 2) await new Promise<void>((resolve) => { releases.push(resolve) })
      },
    }
    const queue = createBoundQueue({
      storage,
      handlers: {
        'expense.add': async (command) => {
          handlerCalls.push(command.operationId)
          return savedExpense(command.operationId)
        },
      },
    })

    const first = queue.submit(addExpense('serialized-first'))
    const second = queue.submit(addExpense('serialized-second'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(documents).toHaveLength(1)
    expect(handlerCalls).toEqual([])

    releases[0]()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(documents).toHaveLength(2)
    expect(documents[1].operations.map(({ envelope }) => envelope.operationId)).toEqual(['serialized-first', 'serialized-second'])
    expect(handlerCalls).toEqual(['serialized-first'])

    releases[1]()
    await Promise.all([first.result(), second.result()])
    expect(handlerCalls).toEqual(['serialized-first', 'serialized-second'])
  })

  it('returns a typed retryable nonexecuted failure when the pending save fails', async () => {
    let writes = 0
    let handlerCalls = 0
    const storage: CommandStorage = {
      load: () => undefined,
      save: async () => {
        writes += 1
        if (writes === 1) throw new Error('disk unavailable')
      },
    }
    const queue = createBoundQueue({
      storage,
      handlers: {
        'expense.add': async (command) => {
          handlerCalls += 1
          return savedExpense(command.operationId)
        },
      },
    })

    const handle = queue.submit(addExpense('pending-save-failed'))

    await expect(handle.result()).rejects.toMatchObject({
      name: 'CommandFailedError',
      code: 'persistence',
      retryable: true,
      executed: false,
    })
    expect(handlerCalls).toBe(0)
    expect(queue.get('pending-save-failed')).toMatchObject({
      status: 'failed',
      error: { code: 'persistence', retryable: true, executed: false },
    })
  })

  it('contains a repeated storage rejection without attempting to persist the nonexecuted failure', async () => {
    let writes = 0
    let handlerCalls = 0
    const storage: CommandStorage = {
      load: () => undefined,
      save: async () => {
        writes += 1
        throw new Error('storage remains unavailable')
      },
    }
    const queue = createBoundQueue({
      storage,
      handlers: {
        'expense.add': async (command) => {
          handlerCalls += 1
          return savedExpense(command.operationId)
        },
      },
    })

    await expect(queue.submit(addExpense('contained-storage-failure')).result()).rejects.toMatchObject({
      code: 'persistence', executed: false,
    })
    await Promise.resolve()

    expect(writes).toBe(1)
    expect(handlerCalls).toBe(0)
  })

  it('quarantines invalid and cross-owner records from a versioned document', () => {
    const quarantined: unknown[] = []
    const valid = { originPrincipalKey: DEMO_UID, submittedAt: '2026-08-31T20:00:00.000Z', status: 'pending', envelope: addExpense('valid-owned') }
    const storage = {
      load: () => ({
        version: 6,
        principalKey: DEMO_UID,
        operations: [
          valid,
          { ...valid, originPrincipalKey: 'someone-else', envelope: addExpense('cross-owner') },
          { ...valid, status: 'invented', envelope: addExpense('invalid-status') },
          { status: 'pending', envelope: addExpense('obsolete-unowned') },
        ],
      }),
      save: async () => undefined,
      quarantine: async (_scopeKey: string, records: readonly unknown[]) => { quarantined.push(...records) },
    } as unknown as CommandStorage
    let queue: CommandQueue | undefined

    expect(() => { queue = createBoundQueue({ storage, handlers: {} }) }).not.toThrow()
    expect(queue?.snapshot()).toEqual([valid])
    expect(quarantined).toHaveLength(3)
  })

  it('uses an opaque principal key in strict version-6 browser persistence', async () => {
    const principalKey = 'firebase:split-unwise-prod:user/maya@example.com'
    const browser = createWebStorage()
    const queue = createBoundQueue({
      storage: createBrowserCommandStorage({ storage: browser }),
      handlers: { 'expense.add': async (command) => savedExpense(command.operationId) },
    }, principalKey)

    await queue.submit(addExpense('principal-scoped-write')).result()

    const document = JSON.parse(browser.getItem(`split-unwise:command-queue:v6:${encodeURIComponent(principalKey)}`) ?? 'null')
    expect(document).toMatchObject({
      version: 6,
      principalKey,
      operations: [{ originPrincipalKey: principalKey, envelope: { operationId: 'principal-scoped-write' } }],
    })
  })

  it('propagates browser storage write failures to the queue', async () => {
    const browser = createWebStorage()
    browser.setItem = () => { throw new Error('quota exceeded') }
    const storage = createBrowserCommandStorage({ storage: browser })
    const principalKey = 'demo:local:browser-write-failure'
    const operation = { originPrincipalKey: principalKey, submittedAt: '2026-08-31T20:00:00.000Z', status: 'pending' as const, envelope: addExpense('browser-write-failure') }

    await expect(storage.save(principalKey, {
      version: 6,
      principalKey,
      operations: [operation],
    })).rejects.toThrow('quota exceeded')
  })

  it('quarantines version-2 owner documents instead of hydrating them into a principal scope', () => {
    const legacyDocument = {
      version: 2,
      originUid: DEMO_UID,
      operations: [{ originUid: DEMO_UID, status: 'pending', envelope: addExpense('legacy-owned-write') }],
    }
    const quarantined: unknown[] = []
    const storage = {
      load: () => legacyDocument,
      save: async () => undefined,
      quarantine: async (_scopeKey: string, records: readonly unknown[]) => { quarantined.push(...records) },
    } as CommandStorage

    const queue = createBoundQueue({ storage, handlers: {} })

    expect(queue.snapshot()).toEqual([])
    expect(quarantined).toEqual([legacyDocument])
  })

  it('does not finish binding until quarantine and sanitized persistence finish', async () => {
    const principalKey = 'demo:local:bind-awaits-cleanup'
    const invalid = { originPrincipalKey: 'another-principal', submittedAt: '2026-08-31T20:00:00.000Z', status: 'pending', envelope: addExpense('cross-principal') }
    let releaseQuarantine!: () => void
    let releaseSave!: () => void
    const quarantineGate = new Promise<void>((resolve) => { releaseQuarantine = resolve })
    const saveGate = new Promise<void>((resolve) => { releaseSave = resolve })
    const events: string[] = []
    const storage: CommandStorage = {
      load: () => ({ version: 6, principalKey, operations: [invalid] }),
      quarantine: async () => {
        events.push('quarantine-start')
        await quarantineGate
        events.push('quarantine-finish')
      },
      save: async () => {
        events.push('save-start')
        await saveGate
        events.push('save-finish')
      },
    }
    const queue = new CommandQueue({ storage, handlers: {} })

    const binding = queue.bind(principalKey) as unknown as Promise<void>

    expect(binding).toBeInstanceOf(Promise)
    expect(events).toEqual(['quarantine-start'])

    releaseQuarantine()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(events).toEqual(['quarantine-start', 'quarantine-finish', 'save-start'])

    let bound = false
    void binding.then(() => { bound = true })
    await Promise.resolve()
    expect(bound).toBe(false)

    releaseSave()
    await binding
    expect(events).toEqual(['quarantine-start', 'quarantine-finish', 'save-start', 'save-finish'])
  })

  it('does not execute a submitted command while principal cleanup is still binding', async () => {
    const principalKey = 'demo:local:binding-barrier'
    let releaseQuarantine!: () => void
    const quarantineGate = new Promise<void>((resolve) => { releaseQuarantine = resolve })
    let handlerCalls = 0
    const storage: CommandStorage = {
      load: () => ({
        version: 6,
        principalKey,
        operations: [{ originPrincipalKey: 'cross-principal', submittedAt: '2026-08-31T20:00:00.000Z', status: 'pending', envelope: addExpense('quarantined-before-submit') }],
      }),
      quarantine: async () => { await quarantineGate },
      save: async () => undefined,
    }
    const queue = new CommandQueue({
      storage,
      handlers: {
        'expense.add': async (command) => {
          handlerCalls += 1
          return savedExpense(command.operationId)
        },
      },
    })
    const binding = queue.bind(principalKey)

    const handle = queue.submit(addExpense('wait-for-principal-cleanup'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(handlerCalls).toBe(0)

    releaseQuarantine()
    await binding
    await expect(handle.result()).resolves.toMatchObject({ status: 'saved' })
    expect(handlerCalls).toBe(1)
  })

  it('quarantines persisted saved results with invalid targets or revision transitions', () => {
    const principalKey = 'demo:local:maya-p'
    const valid = {
      originPrincipalKey: principalKey, submittedAt: '2026-08-31T20:00:00.000Z',
      status: 'pending',
      envelope: addExpense('valid-v3-pending'),
    }
    const invalidAdd = {
      originPrincipalKey: principalKey, submittedAt: '2026-08-31T20:00:00.000Z',
      status: 'fresh',
      envelope: addExpense('persisted-bad-add'),
      result: {
        ...savedExpense('persisted-bad-add'),
        expense: { ...savedExpense('persisted-bad-add').expense, revision: 2 },
      },
    }
    const edit = editExpense('persisted-bad-edit')
    const invalidEdit = {
      originPrincipalKey: principalKey, submittedAt: '2026-08-31T20:00:00.000Z',
      status: 'fresh',
      envelope: edit,
      result: savedEdit(edit, { ...expenseRow(edit.groupId, edit.expenseId), revision: edit.expectedRevision }),
    }
    const deletion = deleteExpense('persisted-bad-delete')
    const invalidDelete = {
      originPrincipalKey: principalKey, submittedAt: '2026-08-31T20:00:00.000Z',
      status: 'fresh',
      envelope: deletion,
      result: {
        kind: 'expense.delete', operationId: deletion.operationId, status: 'saved',
        tombstone: { id: deletion.expenseId, groupId: deletion.groupId, revision: deletion.expectedRevision, deletedAt: '2026-08-30T13:00:00.000Z' },
      },
    }
    const defaultSplit: CommandEnvelope = {
      kind: 'group.default-split', operationId: 'persisted-bad-default-split', groupId: 'lake-house-weekend',
      expectedRevision: 1,
      defaultSplit: { type: 'equal', participantIds: ['maya-p', 'jordan-k'] },
    }
    const invalidDefaultSplit = {
      originPrincipalKey: principalKey, submittedAt: '2026-08-31T20:00:00.000Z',
      status: 'fresh',
      envelope: defaultSplit,
      result: { kind: 'group.default-split', operationId: defaultSplit.operationId, status: 'saved', resourceId: 'another-group' },
    }
    const invalid = [invalidAdd, invalidEdit, invalidDelete, invalidDefaultSplit]
    const quarantined: unknown[] = []
    const storage = {
      load: () => ({ version: 6, principalKey, operations: [valid, ...invalid] }),
      save: async () => undefined,
      quarantine: async (_scopeKey: string, records: readonly unknown[]) => { quarantined.push(...records) },
    } as CommandStorage

    const queue = createBoundQueue({ storage, handlers: {} }, principalKey)

    expect(queue.snapshot()).toEqual([valid])
    expect(quarantined).toEqual(invalid)
  })

  it('quarantines persisted shared defaults with extra fields or ratio keys that do not match participants', () => {
    const principalKey = 'demo:local:invalid-defaults'
    const makeOperation = (operationId: string, defaultSplit: unknown) => ({
      originPrincipalKey: principalKey,
      submittedAt: '2026-08-31T20:00:00.000Z',
      status: 'pending',
      envelope: { kind: 'group.default-split', operationId, groupId: 'lake-house-weekend', expectedRevision: 1, defaultSplit },
    })
    const invalid = [
      makeOperation('default-extra-field', { type: 'equal', participantIds: ['maya-p'], privateDraft: true }),
      makeOperation('default-extra-ratio', { type: 'percentage', participantIds: ['maya-p'], percentages: { 'maya-p': 100, 'alex-r': 0 } }),
    ]
    const quarantined: unknown[] = []
    const queue = createBoundQueue({
      storage: {
        load: () => ({ version: 6, principalKey, operations: invalid }),
        save: async () => undefined,
        quarantine: async (_scopeKey, records) => { quarantined.push(...records) },
      },
      handlers: {},
    }, principalKey)

    expect(queue.snapshot()).toEqual([])
    expect(quarantined).toEqual(invalid)
  })

  it('quarantines a persisted storage failure without a boolean execution marker', () => {
    const principalKey = 'demo:local:invalid-persistence-marker'
    const operation = {
      originPrincipalKey: principalKey, submittedAt: '2026-08-31T20:00:00.000Z',
      status: 'failed',
      envelope: addExpense('invalid-persistence-marker'),
      error: { code: 'persistence', message: 'disk unavailable', retryable: true, executed: 'false' },
    }
    const quarantined: unknown[] = []
    const storage: CommandStorage = {
      load: () => ({ version: 6, principalKey, operations: [operation] }),
      save: async () => undefined,
      quarantine: async (_scopeKey, records) => { quarantined.push(...records) },
    }

    const queue = createBoundQueue({ storage, handlers: {} }, principalKey)

    expect(queue.snapshot()).toEqual([])
    expect(quarantined).toEqual([operation])
  })

  it('accepts occurrence-scoped edits and quarantines obsolete single-scope records', () => {
    const quarantined: unknown[] = []
    const occurrence = {
      originPrincipalKey: DEMO_UID, submittedAt: '2026-08-31T20:00:00.000Z',
      status: 'pending',
      envelope: { ...addExpense('current-occurrence-scope'), occurrenceEditScope: 'occurrence' },
    }
    const obsolete = {
      originPrincipalKey: DEMO_UID, submittedAt: '2026-08-31T20:00:00.000Z',
      status: 'pending',
      envelope: { ...addExpense('obsolete-single-scope'), occurrenceEditScope: 'single' },
    }
    const storage = {
      load: () => ({ version: 6, principalKey: DEMO_UID, operations: [occurrence, obsolete] }),
      save: async () => undefined,
      quarantine: async (_scopeKey: string, records: readonly unknown[]) => { quarantined.push(...records) },
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
    await expect(queue.discard('discardable')).resolves.toBe(true)
    expect(queue.snapshot()).toEqual([])

    const conflicted = createBoundQueue({
      storage: createMemoryCommandStorage(),
      handlers: { 'expense.add': async () => { throw new CommandConflictError('remote changed', { revision: 2 }) } },
    })
    await expect(conflicted.submit(addExpense('keep-conflict')).result()).rejects.toThrow('remote changed')
    await expect(conflicted.discard('keep-conflict')).rejects.toThrow('Only failed operations can be discarded')
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

  it('does not publish a missing-handler failure before the pending envelope is durable', async () => {
    let releasePendingSave!: () => void
    const pendingSave = new Promise<void>((resolve) => { releasePendingSave = resolve })
    let writes = 0
    const storage: CommandStorage = {
      load: () => undefined,
      save: async () => {
        writes += 1
        if (writes === 1) await pendingSave
      },
    }
    const queue = createBoundQueue({ storage, handlers: {} })

    const handle = queue.submit(addExpense('missing-handler-after-persist'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(writes).toBe(1)
    expect(queue.get('missing-handler-after-persist')).toMatchObject({ status: 'pending' })

    releasePendingSave()
    await expect(handle.result()).rejects.toMatchObject({ code: 'handler-missing', executed: false })
    expect(queue.get('missing-handler-after-persist')).toMatchObject({ status: 'failed', error: { code: 'handler-missing', executed: false } })
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

  it.each([
    ['revision 2', { ...savedExpense('bad-add-transition'), expense: { ...savedExpense('bad-add-transition').expense, revision: 2 } }],
    ['a deletion marker', { ...savedExpense('bad-add-transition'), expense: { ...savedExpense('bad-add-transition').expense, deletedAt: '2026-08-30T13:00:00.000Z' } }],
  ] as const)('rejects a saved add result with %s', async (_label, result) => {
    const queue = createBoundQueue({
      storage: createMemoryCommandStorage(),
      handlers: { 'expense.add': async () => result },
    })

    await expect(queue.submit(addExpense('bad-add-transition')).result()).rejects.toMatchObject({ code: 'validation' })
    expect(queue.get('bad-add-transition')).toMatchObject({ status: 'failed', error: { code: 'validation' } })
  })

  it.each([
    ['the unchanged revision', { ...expenseRow(), revision: 1 }],
    ['a skipped revision', { ...expenseRow(), revision: 3 }],
    ['a deletion marker', { ...expenseRow(), revision: 2, deletedAt: '2026-08-30T13:00:00.000Z' }],
  ] as const)('rejects a saved edit result with %s', async (_label, resultExpense) => {
    const command = editExpense('bad-edit-transition')
    const queue = createBoundQueue({
      storage: createMemoryCommandStorage(),
      handlers: { 'expense.edit': async () => savedEdit(command, resultExpense) },
    })

    await expect(queue.submit(command).result()).rejects.toMatchObject({ code: 'validation' })
    expect(queue.get(command.operationId)).toMatchObject({ status: 'failed', error: { code: 'validation' } })
  })

  it.each([
    ['the unchanged revision', 1],
    ['a skipped revision', 3],
  ] as const)('rejects a saved delete tombstone with %s', async (_label, revision) => {
    const command = deleteExpense('bad-delete-transition')
    const queue = createBoundQueue({
      storage: createMemoryCommandStorage(),
      handlers: {
        'expense.delete': async () => ({
          kind: 'expense.delete', operationId: command.operationId, status: 'saved',
          tombstone: { id: command.expenseId, groupId: command.groupId, revision, deletedAt: '2026-08-30T13:00:00.000Z' },
        }),
      },
    })

    await expect(queue.submit(command).result()).rejects.toMatchObject({ code: 'validation' })
    expect(queue.get(command.operationId)).toMatchObject({ status: 'failed', error: { code: 'validation' } })
  })

  it('binds a saved default-split result to the command group', async () => {
    const command: CommandEnvelope = {
      kind: 'group.default-split', operationId: 'wrong-default-split-group', groupId: 'lake-house-weekend',
      expectedRevision: 1,
      defaultSplit: { type: 'equal', participantIds: ['maya-p', 'jordan-k'] },
    }
    const queue = createBoundQueue({
      storage: createMemoryCommandStorage(),
      handlers: {
        'group.default-split': async () => ({
          kind: 'group.default-split', operationId: command.operationId, status: 'saved', resourceId: 'another-group',
        }),
      },
    })

    await expect(queue.submit(command).result()).rejects.toMatchObject({ code: 'validation' })
    expect(queue.get(command.operationId)).toMatchObject({ status: 'failed', error: { code: 'validation' } })
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
    await expect(waitingQueue.markStale('write-firewood')).resolves.toMatchObject({ status: 'stale', result: { status: 'saved' } })
    await expect(waitingQueue.markFresh('write-firewood')).resolves.toMatchObject({ status: 'fresh', result: { status: 'saved' } })
  })

  it('does not resolve a saved result until the terminal queue state is durable', async () => {
    let releaseTerminalSave!: () => void
    const terminalSave = new Promise<void>((resolve) => { releaseTerminalSave = resolve })
    let writes = 0
    let handlerCalls = 0
    const storage: CommandStorage = {
      load: () => undefined,
      save: async () => {
        writes += 1
        if (writes === 2) await terminalSave
      },
    }
    const queue = createBoundQueue({
      storage,
      handlers: {
        'expense.add': async (command) => {
          handlerCalls += 1
          return savedExpense(command.operationId)
        },
      },
    })

    const result = queue.submit(addExpense('durable-terminal-result')).result()
    let settled = false
    void result.finally(() => { settled = true })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(handlerCalls).toBe(1)
    expect(writes).toBe(2)
    expect(settled).toBe(false)

    releaseTerminalSave()
    await expect(result).resolves.toMatchObject({ status: 'saved' })
  })

  it('does not publish or expose fresh state while the terminal save is blocked', async () => {
    let releaseTerminalSave!: () => void
    const terminalSave = new Promise<void>((resolve) => { releaseTerminalSave = resolve })
    let writes = 0
    const storage: CommandStorage = {
      load: () => undefined,
      save: async () => {
        writes += 1
        if (writes === 2) await terminalSave
      },
    }
    const queue = createBoundQueue({
      storage,
      handlers: { 'expense.add': async (command) => savedExpense(command.operationId) },
    })
    const observed: string[] = []
    queue.subscribe((operation) => observed.push(operation.status))

    const result = queue.submit(addExpense('terminal-state-hidden')).result()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(writes).toBe(2)
    expect(queue.get('terminal-state-hidden')).toMatchObject({ status: 'pending' })
    expect(observed).toEqual(['pending'])

    releaseTerminalSave()
    await expect(result).resolves.toMatchObject({ status: 'saved' })
    expect(queue.get('terminal-state-hidden')).toMatchObject({ status: 'fresh' })
    expect(observed).toEqual(['pending', 'fresh'])
  })

  it('returns a typed executed persistence failure when the terminal save rejects', async () => {
    let writes = 0
    let handlerCalls = 0
    const storage: CommandStorage = {
      load: () => undefined,
      save: async () => {
        writes += 1
        if (writes === 2) throw new Error('terminal storage unavailable')
      },
    }
    const queue = createBoundQueue({
      storage,
      handlers: {
        'expense.add': async (command) => {
          handlerCalls += 1
          return savedExpense(command.operationId)
        },
      },
    })

    await expect(queue.submit(addExpense('terminal-save-failed')).result()).rejects.toMatchObject({
      code: 'persistence', retryable: true, executed: true,
    })
    expect(handlerCalls).toBe(1)
    expect(writes).toBe(2)
    expect(queue.get('terminal-save-failed')).toMatchObject({
      status: 'failed', error: { code: 'persistence', retryable: true, executed: true },
    })
  })

  it('never publishes a saved state when terminal persistence rejects', async () => {
    let writes = 0
    const storage: CommandStorage = {
      load: () => undefined,
      save: async () => {
        writes += 1
        if (writes === 2) throw new Error('terminal storage unavailable')
      },
    }
    const queue = createBoundQueue({
      storage,
      handlers: { 'expense.add': async (command) => savedExpense(command.operationId) },
    })
    const observed: string[] = []
    queue.subscribe((operation) => observed.push(operation.status))

    await expect(queue.submit(addExpense('terminal-rejection-hidden')).result()).rejects.toMatchObject({
      code: 'persistence', executed: true,
    })

    expect(observed).toEqual(['pending', 'failed'])
    expect(queue.get('terminal-rejection-hidden')).toMatchObject({ status: 'failed' })
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
      originPrincipalKey: DEMO_UID, submittedAt: '2026-08-31T20:00:00.000Z',
      status: 'conflicted',
      envelope: command,
      error: { code: 'conflict', message: 'remote changed', retryable: false },
      conflict: { remote: { id: command.expenseId, groupId: command.groupId } },
    }
    const quarantined: unknown[] = []
    const storage = {
      load: () => ({ version: 6, principalKey: DEMO_UID, operations: [operation] }),
      save: async () => undefined,
      quarantine: async (_scopeKey: string, records: readonly unknown[]) => { quarantined.push(...records) },
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
    const pending = { originPrincipalKey: DEMO_UID, submittedAt: '2026-08-31T20:00:00.000Z', status: 'pending' as const, envelope: addExpense('reload-safe') }
    const storage = createMemoryCommandStorage({
      [DEMO_UID]: { version: 6, principalKey: DEMO_UID, operations: [pending] },
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
      version: 6,
      principalKey: DEMO_UID,
      operations: [expect.objectContaining({ originPrincipalKey: DEMO_UID, submittedAt: '2026-08-31T20:00:00.000Z', status: 'fresh', envelope: expect.objectContaining({ operationId: 'reload-safe' }) })],
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
    await expect(kindQueue.submit({ kind: 'comment.add', operationId: 'replay-kind', groupId: 'lake-house-weekend', expenseId: 'groceries', body: 'Different kind', attachmentRefs: [] }).result()).rejects.toBeInstanceOf(CommandConflictError)
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

  it('does not expose a handler failure until the failed queue state is durable', async () => {
    let releaseFailedSave!: () => void
    const failedSave = new Promise<void>((resolve) => { releaseFailedSave = resolve })
    let writes = 0
    const storage: CommandStorage = {
      load: () => undefined,
      save: async () => {
        writes += 1
        if (writes === 2) await failedSave
      },
    }
    const queue = createBoundQueue({
      storage,
      handlers: {
        'expense.add': async () => { throw Object.assign(new Error('offline'), { code: 'unavailable' }) },
      },
    })

    const result = queue.submit(addExpense('durable-handler-failure')).result()
    let settled = false
    void result.catch(() => undefined).finally(() => { settled = true })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(writes).toBe(2)
    expect(settled).toBe(false)

    releaseFailedSave()
    await expect(result).rejects.toMatchObject({ code: 'network', retryable: true })
  })

  it('converts failed-state persistence rejection into a typed executed storage failure', async () => {
    let writes = 0
    const storage: CommandStorage = {
      load: () => undefined,
      save: async () => {
        writes += 1
        if (writes === 2) throw new Error('cannot persist failed state')
      },
    }
    const queue = createBoundQueue({
      storage,
      handlers: {
        'expense.add': async () => { throw Object.assign(new Error('offline'), { code: 'unavailable' }) },
      },
    })

    await expect(queue.submit(addExpense('failed-state-save-failed')).result()).rejects.toMatchObject({
      code: 'persistence', retryable: true, executed: true,
    })
    expect(writes).toBe(2)
    expect(queue.get('failed-state-save-failed')).toMatchObject({
      status: 'failed', error: { code: 'persistence', retryable: true, executed: true },
    })
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
    await expect(queue.acknowledge('acknowledge-fresh')).resolves.toBe(true)
    expect(queue.snapshot()).toEqual([])
    expect(observedSnapshots.at(-1)).toBe(0)
  })

  it('does not report discard success until the removal is durable', async () => {
    let releaseRemoval!: () => void
    const removalGate = new Promise<void>((resolve) => { releaseRemoval = resolve })
    let blockWrites = false
    const storage: CommandStorage = {
      load: () => undefined,
      save: async () => { if (blockWrites) await removalGate },
    }
    const queue = createBoundQueue({
      storage,
      handlers: { 'expense.add': async () => { throw Object.assign(new Error('invalid'), { code: 'invalid-argument' }) } },
    })
    await expect(queue.submit(addExpense('durable-discard')).result()).rejects.toMatchObject({ code: 'validation' })
    blockWrites = true

    const removal = queue.discard('durable-discard') as unknown as Promise<boolean>

    expect(removal).toBeInstanceOf(Promise)
    expect(queue.get('durable-discard')).toMatchObject({ status: 'failed' })

    releaseRemoval()
    await expect(removal).resolves.toBe(true)
    expect(queue.get('durable-discard')).toBeUndefined()
  })

  it('does not report acknowledgement success until the removal is durable', async () => {
    let releaseRemoval!: () => void
    const removalGate = new Promise<void>((resolve) => { releaseRemoval = resolve })
    let blockWrites = false
    const storage: CommandStorage = {
      load: () => undefined,
      save: async () => { if (blockWrites) await removalGate },
    }
    const queue = createBoundQueue({
      storage,
      handlers: { 'expense.add': async (command) => savedExpense(command.operationId) },
    })
    await queue.submit(addExpense('durable-acknowledgement')).result()
    blockWrites = true

    const removal = queue.acknowledge('durable-acknowledgement') as unknown as Promise<boolean>

    expect(removal).toBeInstanceOf(Promise)
    expect(queue.get('durable-acknowledgement')).toMatchObject({ status: 'fresh' })

    releaseRemoval()
    await expect(removal).resolves.toBe(true)
    expect(queue.get('durable-acknowledgement')).toBeUndefined()
  })

  it('does not publish read-state changes until each state is durable', async () => {
    let releaseWrite!: () => void
    let writeGate = Promise.resolve()
    let blockWrites = false
    const storage: CommandStorage = {
      load: () => undefined,
      save: async () => { if (blockWrites) await writeGate },
    }
    const queue = createBoundQueue({
      storage,
      handlers: { 'expense.add': async (command) => savedExpense(command.operationId) },
    })
    await queue.submit(addExpense('durable-read-state')).result()

    writeGate = new Promise<void>((resolve) => { releaseWrite = resolve })
    blockWrites = true
    const stale = queue.markStale('durable-read-state') as unknown as Promise<CommandOperation>
    expect(stale).toBeInstanceOf(Promise)
    expect(queue.get('durable-read-state')).toMatchObject({ status: 'fresh' })
    releaseWrite()
    await expect(stale).resolves.toMatchObject({ status: 'stale' })

    writeGate = new Promise<void>((resolve) => { releaseWrite = resolve })
    const fresh = queue.markFresh('durable-read-state') as unknown as Promise<CommandOperation>
    expect(queue.get('durable-read-state')).toMatchObject({ status: 'stale' })
    releaseWrite()
    await expect(fresh).resolves.toMatchObject({ status: 'fresh' })
  })
})
