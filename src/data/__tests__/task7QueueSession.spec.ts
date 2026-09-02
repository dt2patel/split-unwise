import { describe, expect, it } from 'vitest'
import { CommandQueue, COMMAND_QUEUE_STORAGE_VERSION, createMemoryCommandStorage, type CommandStorage } from '../commandQueue'
import { createDemoRepository } from '../demoRepository'
import { appPrincipalKey, createAppSession, StaleAppSessionError } from '../session'
import type { AppRepository, CommandEnvelope } from '../repositories'
import { createMemoryReceiptStore, type ReceiptProvider } from '../receipts'

const principal = { mode: 'demo' as const, projectId: 'split-unwise-demo', uid: 'maya-p' }
const principalKey = appPrincipalKey(principal)

describe('Task 7 queue schema and identity', () => {
  it('keeps the Task 7 protocol valid under schema v6 and quarantines a complete v5 document', () => {
    const legacy = { version: 5, principalKey, operations: [] }
    const quarantined: unknown[] = []
    const queue = new CommandQueue({
      handlers: {},
      storage: {
        load: () => legacy,
        save: async () => undefined,
        quarantine: async (_scope, records) => { quarantined.push(...records) },
      },
    })

    void queue.bind(principalKey)

    expect(COMMAND_QUEUE_STORAGE_VERSION).toBe(6)
    expect(queue.snapshot()).toEqual([])
    expect(quarantined).toEqual([legacy])
  })

  it('persists the queue submission timestamp independently of an expense date', async () => {
    const storage = createMemoryCommandStorage()
    const repository = createDemoRepository()
    const queue = new CommandQueue({
      originPrincipalKey: principalKey,
      storage,
      now: () => '2026-08-31T20:15:30.000Z',
      handlers: { 'comment.add': (command) => repository.comments.add(command as Extract<CommandEnvelope, { kind: 'comment.add' }>) },
    })

    await queue.submit(commentAdd('timestamped-submission')).result()

    expect(queue.get('timestamped-submission')).toMatchObject({ submittedAt: '2026-08-31T20:15:30.000Z' })
    expect(storage.load(principalKey)).toMatchObject({
      version: 6,
      operations: [expect.objectContaining({ submittedAt: '2026-08-31T20:15:30.000Z' })],
    })
  })

  it('rejects any prepared financial mutation beyond declared local attachment promotion', async () => {
    const repository = createDemoRepository()
    const original = expenseAdd('financial-intent')
    let calls = 0
    const queue = new CommandQueue({
      originPrincipalKey: principalKey,
      storage: createMemoryCommandStorage(),
      prepare: async (command) => command.kind === 'expense.add'
        ? { ...command, total: { ...command.total, minorAmount: command.total.minorAmount + 100 } }
        : command,
      handlers: { 'expense.add': async (command) => { calls += 1; return repository.expenses.add(command as Extract<CommandEnvelope, { kind: 'expense.add' }>) } },
    })

    await expect(queue.submit(original).result()).rejects.toMatchObject({ code: 'validation' })
    expect(calls).toBe(0)
    expect(queue.get(original.operationId)).toMatchObject({ status: 'failed', error: { code: 'validation' } })
  })

  it('passes preparation a clone so in-place mutation cannot rewrite the stored intent or bypass equivalence', async () => {
    const original = expenseAdd('mutating-preparer')
    let calls = 0
    const queue = new CommandQueue({
      originPrincipalKey: principalKey,
      storage: createMemoryCommandStorage(),
      prepare: async (command) => {
        if (command.kind === 'expense.add') (command.total as { minorAmount: number }).minorAmount += 100
        return command
      },
      handlers: { 'expense.add': async () => { calls += 1; throw new Error('must not run') } },
    })

    await expect(queue.submit(original).result()).rejects.toMatchObject({ code: 'validation' })
    expect(calls).toBe(0)
    expect(queue.get(original.operationId)?.envelope).toMatchObject({ total: { minorAmount: 2400 } })
    expect(original.total.minorAmount).toBe(2400)
  })

  it('permits only local-to-remote substitutions at the same attachment positions', async () => {
    const repository = createDemoRepository()
    const original = { ...expenseAdd('attachment-promotion'), attachmentRefs: ['local-receipt:one', 'remote-receipt:kept'] }
    let received: CommandEnvelope | undefined
    const queue = new CommandQueue({
      originPrincipalKey: principalKey,
      storage: createMemoryCommandStorage(),
      prepare: async (command) => command.kind === 'expense.add'
        ? { ...command, attachmentRefs: ['remote-receipt:one', 'remote-receipt:changed'] }
        : command,
      handlers: { 'expense.add': async (command) => { received = command; return repository.expenses.add(command as Extract<CommandEnvelope, { kind: 'expense.add' }>) } },
    })

    await expect(queue.submit(original).result()).rejects.toMatchObject({ code: 'validation' })
    expect(received).toBeUndefined()
  })

  it('retains the declared source while passing an explicit cross-context move to the repository', async () => {
    let writes = 0
    let calls = 0
    let received: Extract<CommandEnvelope, { kind: 'expense.edit' }> | undefined
    const queue = new CommandQueue({
      originPrincipalKey: principalKey,
      storage: { load: () => undefined, save: async () => { writes += 1 } },
      handlers: { 'expense.edit': async (command) => {
        if (command.kind !== 'expense.edit') throw new Error('Unexpected command')
        calls += 1
        received = command
        return {
          kind: command.kind, operationId: command.operationId, status: 'saved',
          expense: {
            id: 'moved-expense', groupId: command.draft.groupId, description: command.draft.description, date: command.draft.date,
            total: command.draft.total, payments: command.draft.payments, allocations: command.draft.allocations,
            category: command.draft.category, splitMethod: command.draft.splitMethod, attachmentRefs: command.draft.attachmentRefs,
            createdAt: '2026-09-01T12:00:00.000Z', updatedAt: '2026-09-01T12:00:00.000Z',
            createdBy: { id: 'maya-p', displayName: 'Maya P.' }, updatedBy: { id: 'maya-p', displayName: 'Maya P.' },
            revision: 1, syncState: 'fresh',
          },
        }
      } },
    })
    const { kind: _kind, operationId: _operationId, ...draft } = expenseAdd('draft-source')

    const result = await queue.submit({
      kind: 'expense.edit', operationId: 'cross-group-draft', groupId: 'lake-house-weekend', expenseId: 'groceries', expectedRevision: 1,
      draft: { ...draft, groupId: 'another-group' },
    }).result()

    expect(result).toMatchObject({ status: 'saved', expense: { id: 'moved-expense', groupId: 'another-group', revision: 1 } })
    expect(received).toMatchObject({ groupId: 'lake-house-weekend', draft: { groupId: 'another-group' } })
    expect(calls).toBe(1)
    expect(writes).toBeGreaterThan(0)
  })

  it('quarantines a hydrated execution envelope that changes immutable comment semantics', async () => {
    const envelope = commentAdd('corrupt-execution')
    const operation = {
      originPrincipalKey: principalKey,
      submittedAt: '2026-08-31T20:00:00.000Z',
      status: 'pending' as const,
      envelope,
      executionEnvelope: { ...envelope, body: 'Changed after submission' },
    }
    const quarantined: unknown[] = []
    const queue = new CommandQueue({
      originPrincipalKey: principalKey,
      storage: {
        load: () => ({ version: 6, principalKey, operations: [operation] }),
        save: async () => undefined,
        quarantine: async (_scope, records) => { quarantined.push(...records) },
      },
      handlers: {},
    })

    expect(queue.snapshot()).toEqual([])
    expect(quarantined).toEqual([operation])
  })

  it.each([
    ['blank comment', { kind: 'comment.add', operationId: 'invalid-comment', groupId: 'lake-house-weekend', expenseId: 'groceries', body: '  ', attachmentRefs: [] }],
    ['missing comment attachment list', { kind: 'comment.add', operationId: 'missing-attachments', groupId: 'lake-house-weekend', expenseId: 'groceries', body: 'Hello' }],
    ['malformed read-all cutoff', { kind: 'notification.read-all', operationId: 'invalid-cutoff', cutoff: { createdAt: 'today', id: 'notification-a' } }],
    ['malformed preferences', { kind: 'notification.preferences', operationId: 'invalid-prefs', preferences: { emailEnabled: 'yes', pushEnabled: false } }],
  ])('rejects the full %s envelope before persistence or handler execution', async (_label, malformed) => {
    let writes = 0
    let calls = 0
    const queue = new CommandQueue({
      originPrincipalKey: principalKey,
      storage: { load: () => undefined, save: async () => { writes += 1 } },
      handlers: new Proxy({}, { get: () => async () => { calls += 1; throw new Error('must not run') } }),
    })

    await expect(queue.submit(malformed as CommandEnvelope).result()).rejects.toMatchObject({ code: 'validation' })
    expect(writes).toBe(0)
    expect(calls).toBe(0)
    expect(queue.snapshot()).toEqual([])
  })

  it('rejects a saved comment result whose operation, target, or activity identity does not match', async () => {
    const command = commentAdd('comment-result-identity')
    const repository = createDemoRepository()
    const real = await repository.comments.add(command)
    if (real.status !== 'saved') throw new Error('Expected comment save')
    const queue = new CommandQueue({
      originPrincipalKey: principalKey,
      storage: createMemoryCommandStorage(),
      handlers: {
        'comment.add': async () => ({
          ...real,
          comment: { ...real.comment, expenseId: 'dinner' },
        }),
      },
    })

    await expect(queue.submit(command).result()).rejects.toMatchObject({ code: 'validation' })
    expect(queue.get(command.operationId)).toMatchObject({ status: 'failed', error: { code: 'validation' } })
  })

  it('accepts an author tombstone whose comment retains its immutable creation operation identity', async () => {
    const repository = createDemoRepository()
    const added = await repository.comments.add(commentAdd('comment-created-before-delete'))
    if (added.status !== 'saved') throw new Error('Expected comment save')
    const queue = new CommandQueue({
      originPrincipalKey: principalKey,
      storage: createMemoryCommandStorage(),
      handlers: { 'comment.delete': async (command) => {
        if (command.kind !== 'comment.delete') throw new Error('Wrong command')
        return repository.comments.delete(command)
      } },
    })

    await expect(queue.submit({
      kind: 'comment.delete', operationId: 'comment-delete-operation', groupId: added.comment.groupId,
      expenseId: added.comment.expenseId, commentId: added.comment.commentId,
    }).result()).resolves.toMatchObject({
      status: 'saved',
      comment: { operationId: 'comment-created-before-delete', deletedAt: expect.any(String) },
      activity: { operationId: 'comment-delete-operation', kind: 'comment.deleted' },
    })
  })

  it('validates notification read identity and replays a persisted saved comment without duplication', async () => {
    const repository = createDemoRepository()
    const storage = createMemoryCommandStorage()
    let calls = 0
    const handlers = {
      'comment.add': async (envelope: CommandEnvelope) => {
        if (envelope.kind !== 'comment.add') throw new Error('Wrong command')
        calls += 1
        return repository.comments.add(envelope)
      },
      'notification.read': async (envelope: CommandEnvelope) => {
        if (envelope.kind !== 'notification.read') throw new Error('Wrong command')
        const result = await repository.notifications.markRead(envelope)
        return result.status === 'saved' ? { ...result, notification: { ...result.notification, notificationId: 'notification-b' } } : result
      },
    }
    const first = new CommandQueue({ originPrincipalKey: principalKey, storage, handlers })
    await expect(first.submit(commentAdd('persisted-comment')).result()).resolves.toMatchObject({ status: 'saved' })

    const reloaded = new CommandQueue({ originPrincipalKey: principalKey, storage, handlers })
    await reloaded.resume()
    await expect(reloaded.submit(commentAdd('persisted-comment')).result()).resolves.toMatchObject({ status: 'saved' })
    expect(calls).toBe(1)

    await expect(reloaded.submit({ kind: 'notification.read', operationId: 'wrong-notification-result', notificationId: 'notification-a' }).result()).rejects.toMatchObject({ code: 'validation' })
  })
})

describe('Task 7 session races', () => {
  it('promotes a claimed local comment attachment while retaining its durable original envelope', async () => {
    const repository = createDemoRepository()
    const storage = createMemoryCommandStorage()
    const receipts = createMemoryReceiptStore({ id: () => 'comment-attachment' })
    const reference = await receipts.put(new Blob(['image'], { type: 'image/jpeg' }), { fileName: 'comment.jpg' })
    const provider: ReceiptProvider = {
      async upload(groupId, localReference) {
        expect({ groupId, localReference }).toEqual({ groupId: 'lake-house-weekend', localReference: reference })
        return { status: 'uploaded', attachmentRef: 'remote-receipt:comment-attachment' }
      },
      async recognize() { return { status: 'unavailable', reason: 'Not used.' } },
      async delete() { /* not used */ },
    }
    const session = createAppSession({ repository, principal, commandStorage: storage, receipts, receiptProvider: provider })
    await session.ready
    await receipts.claim(reference, 'comment-attachment-command')

    await expect(session.queue.submit({
      ...commentAdd('comment-attachment-command'), attachmentRefs: [reference],
    }).result()).resolves.toMatchObject({
      status: 'saved', comment: { attachmentRefs: ['remote-receipt:comment-attachment'] },
    })
    expect(session.queue.get('comment-attachment-command')?.envelope).toMatchObject({ attachmentRefs: [reference] })
  })

  it('suppresses a late comment completion after the full principal session freezes', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const source = createDemoRepository()
    const repository: AppRepository = {
      ...source,
      comments: {
        ...source.comments,
        async listForExpense(groupId, expenseId) {
          await gate
          return source.comments.listForExpense(groupId, expenseId)
        },
      },
    }
    const session = createAppSession({ repository, principal, commandStorage: createMemoryCommandStorage() })
    await session.ready

    const pending = session.repository.comments.listForExpense('lake-house-weekend', 'groceries')
    session.freeze()
    release()

    await expect(pending).rejects.toBeInstanceOf(StaleAppSessionError)
  })

  it('activates cached repository reads without waiting for a resumed network mutation', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const pending = { originPrincipalKey: principalKey, submittedAt: '2026-08-31T20:00:00.000Z', status: 'pending' as const, envelope: commentAdd('resumed-comment') }
    const storage: CommandStorage = {
      load: () => ({ version: 6, principalKey, operations: [pending] }),
      save: async () => undefined,
    }
    const source = createDemoRepository()
    const repository: AppRepository = {
      ...source,
      commands: {
        async execute(command) {
          if (command.operationId === 'resumed-comment') await gate
          return source.commands.execute(command)
        },
      },
    }
    const session = createAppSession({ repository, principal, commandStorage: storage })
    let ready = false
    void session.ready.then(() => { ready = true })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(ready).toBe(true)
    await expect(session.repository.groups.getById('lake-house-weekend')).resolves.toMatchObject({ id: 'lake-house-weekend' })
    expect(session.queue.get('resumed-comment')).toMatchObject({ status: 'pending' })

    release()
    await expect(session.queue.submit(commentAdd('resumed-comment')).result()).resolves.toMatchObject({ status: 'saved' })
  })

  it('consumes a stale-session rejection from a resumed background write and leaves it adoptable', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const pending = {
      originPrincipalKey: principalKey,
      submittedAt: '2026-08-31T20:00:00.000Z',
      status: 'pending' as const,
      envelope: commentAdd('resumed-stale-comment'),
    }
    const storage = createMemoryCommandStorage({ [principalKey]: { version: 6, principalKey, operations: [pending] } })
    const source = createDemoRepository()
    const repository: AppRepository = {
      ...source,
      commands: {
        async execute(command) {
          if (command.operationId === 'resumed-stale-comment') await gate
          return source.commands.execute(command)
        },
      },
    }
    const session = createAppSession({ repository, principal, commandStorage: storage })
    await session.ready

    session.freeze()
    release()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(storage.load(principalKey)).toMatchObject({ operations: [expect.objectContaining({ status: 'pending', envelope: expect.objectContaining({ operationId: 'resumed-stale-comment' }) })] })
  })

  it('does not let a frozen old queue overwrite a newer same-principal fresh completion', async () => {
    let releaseOld!: () => void
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve })
    let announceOldStarted!: () => void
    const oldStarted = new Promise<void>((resolve) => { announceOldStarted = resolve })
    let announceOldReturned!: () => void
    const oldReturned = new Promise<void>((resolve) => { announceOldReturned = resolve })
    const pending = {
      originPrincipalKey: principalKey,
      submittedAt: '2026-08-31T20:00:00.000Z',
      status: 'pending' as const,
      envelope: commentAdd('shared-storage-race'),
    }
    const storage = createMemoryCommandStorage({ [principalKey]: { version: 6, principalKey, operations: [pending] } })
    const source = createDemoRepository()
    const delayedRepository: AppRepository = {
      ...source,
      commands: {
        async execute(command) {
          announceOldStarted()
          await oldGate
          const result = await source.commands.execute(command)
          announceOldReturned()
          return result
        },
      },
    }
    const oldSession = createAppSession({ repository: delayedRepository, principal, commandStorage: storage })
    await oldSession.ready
    await oldStarted
    const newSession = createAppSession({ repository: source, principal, commandStorage: storage })
    await newSession.ready
    await expect(newSession.queue.submit(commentAdd('shared-storage-race')).result()).resolves.toMatchObject({ status: 'saved' })

    oldSession.freeze()
    releaseOld()
    await oldReturned
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(storage.load(principalKey)).toMatchObject({ operations: [expect.objectContaining({ status: 'fresh', envelope: expect.objectContaining({ operationId: 'shared-storage-race' }) })] })
  })

  it('does not let a frozen old queue persist a late network failure over a newer same-principal completion', async () => {
    let releaseOld!: () => void
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve })
    let announceOldStarted!: () => void
    const oldStarted = new Promise<void>((resolve) => { announceOldStarted = resolve })
    const pending = {
      originPrincipalKey: principalKey,
      submittedAt: '2026-08-31T20:00:00.000Z',
      status: 'pending' as const,
      envelope: commentAdd('shared-storage-network-race'),
    }
    const storage = createMemoryCommandStorage({ [principalKey]: { version: 6, principalKey, operations: [pending] } })
    const source = createDemoRepository()
    const rejectingRepository: AppRepository = {
      ...source,
      commands: {
        async execute() {
          announceOldStarted()
          await oldGate
          throw Object.assign(new Error('Old server rejected after replacement'), { code: 'unavailable' })
        },
      },
    }
    const oldSession = createAppSession({ repository: rejectingRepository, principal, commandStorage: storage })
    await oldSession.ready
    await oldStarted
    const newSession = createAppSession({ repository: source, principal, commandStorage: storage })
    await newSession.ready
    await expect(newSession.queue.submit(commentAdd('shared-storage-network-race')).result()).resolves.toMatchObject({ status: 'saved' })

    oldSession.freeze()
    releaseOld()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(storage.load(principalKey)).toMatchObject({ operations: [expect.objectContaining({ status: 'fresh', envelope: expect.objectContaining({ operationId: 'shared-storage-network-race' }) })] })
  })

  it('does not let a frozen old receipt preparation failure overwrite a newer same-principal completion', async () => {
    let releaseOldUpload!: () => void
    const oldUploadGate = new Promise<void>((resolve) => { releaseOldUpload = resolve })
    let announceOldUpload!: () => void
    const oldUploadStarted = new Promise<void>((resolve) => { announceOldUpload = resolve })
    const oldReceipts = createMemoryReceiptStore({ id: () => 'shared-preparation-race' })
    const newReceipts = createMemoryReceiptStore({ id: () => 'shared-preparation-race' })
    const oldReference = await oldReceipts.put(new Blob(['receipt'], { type: 'image/jpeg' }), { fileName: 'receipt.jpg' })
    const newReference = await newReceipts.put(new Blob(['receipt'], { type: 'image/jpeg' }), { fileName: 'receipt.jpg' })
    expect(newReference).toBe(oldReference)
    const envelope = { ...commentAdd('shared-preparation-race'), attachmentRefs: [oldReference] }
    const pending = {
      originPrincipalKey: principalKey,
      submittedAt: '2026-08-31T20:00:00.000Z',
      status: 'pending' as const,
      envelope,
    }
    const storage = createMemoryCommandStorage({ [principalKey]: { version: 6, principalKey, operations: [pending] } })
    const oldProvider: ReceiptProvider = {
      async upload() {
        announceOldUpload()
        await oldUploadGate
        throw Object.assign(new Error('Old receipt upload rejected after replacement'), { code: 'unavailable' })
      },
      async recognize() { return { status: 'unavailable', reason: 'Not used.' } },
      async delete() { /* no remote asset */ },
    }
    const newProvider: ReceiptProvider = {
      async upload() { return { status: 'uploaded', attachmentRef: 'remote-receipt:shared-preparation-race' } },
      async recognize() { return { status: 'unavailable', reason: 'Not used.' } },
      async delete() { /* no remote asset */ },
    }
    const source = createDemoRepository()
    const oldSession = createAppSession({ repository: source, principal, commandStorage: storage, receipts: oldReceipts, receiptProvider: oldProvider })
    await oldSession.ready
    await oldUploadStarted
    const newSession = createAppSession({ repository: source, principal, commandStorage: storage, receipts: newReceipts, receiptProvider: newProvider })
    await newSession.ready
    await expect(newSession.queue.submit(envelope).result()).resolves.toMatchObject({ status: 'saved' })

    oldSession.freeze()
    releaseOldUpload()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(storage.load(principalKey)).toMatchObject({ operations: [expect.objectContaining({ status: 'fresh', envelope: expect.objectContaining({ operationId: envelope.operationId }) })] })
  })
})

function commentAdd(operationId: string) {
  return {
    kind: 'comment.add' as const,
    operationId,
    groupId: 'lake-house-weekend',
    expenseId: 'groceries',
    body: 'A durable comment',
    attachmentRefs: [],
  }
}

function expenseAdd(operationId: string) {
  const participantIds = ['maya-p', 'jordan-k', 'alex-r', 'taylor-s'] as const
  return {
    kind: 'expense.add' as const,
    operationId,
    groupId: 'lake-house-weekend',
    description: 'Firewood',
    date: '2026-08-31',
    total: { currency: 'USD' as const, minorAmount: 2400 },
    payments: [{ participantId: 'maya-p', money: { currency: 'USD' as const, minorAmount: 2400 } }],
    allocations: participantIds.map((participantId) => ({ participantId, money: { currency: 'USD' as const, minorAmount: 600 } })),
    category: 'Supplies',
    splitMethod: { type: 'equal' as const, participantIds },
    attachmentRefs: [],
  }
}
