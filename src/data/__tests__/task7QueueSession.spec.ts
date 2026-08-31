import { describe, expect, it } from 'vitest'
import { CommandQueue, COMMAND_QUEUE_STORAGE_VERSION, createMemoryCommandStorage, type CommandStorage } from '../commandQueue'
import { createDemoRepository } from '../demoRepository'
import { appPrincipalKey, createAppSession, StaleAppSessionError } from '../session'
import type { AppRepository, CommandEnvelope } from '../repositories'
import { createMemoryReceiptStore, type ReceiptProvider } from '../receipts'

const principal = { mode: 'demo' as const, projectId: 'split-unwise-demo', uid: 'maya-p' }
const principalKey = appPrincipalKey(principal)

describe('Task 7 queue schema and identity', () => {
  it('deliberately migrates to schema v4 and quarantines a complete v3 document', () => {
    const legacy = { version: 3, principalKey, operations: [] }
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

    expect(COMMAND_QUEUE_STORAGE_VERSION).toBe(4)
    expect(queue.snapshot()).toEqual([])
    expect(quarantined).toEqual([legacy])
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
    const pending = { originPrincipalKey: principalKey, status: 'pending' as const, envelope: commentAdd('resumed-comment') }
    const storage: CommandStorage = {
      load: () => ({ version: 4, principalKey, operations: [pending] }),
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
