import { describe, expect, it } from 'vitest'
import { createDemoRepository } from '../demoRepository'
import { createMemoryCommandStorage } from '../commandQueue'
import { createAppSession, getAppSession, setAppSessionForTesting } from '../session'
import { createMemoryReceiptStore, type LocalReceiptReference, type ReceiptProvider } from '../receipts'
import type { CommandEnvelope, Member } from '../repositories'

describe('app data session', () => {
  it('waits for the repository identity before binding and resuming its queue', async () => {
    const demo = createDemoRepository()
    let releaseIdentity!: (member: Member) => void
    const identity = new Promise<Member>((resolve) => { releaseIdentity = resolve })
    const repository = {
      ...demo,
      app: { ...demo.app, getCurrentUser: () => identity },
    }
    const session = createAppSession({ repository, commandStorage: createMemoryCommandStorage() })

    expect(session.ready).toBeInstanceOf(Promise)
    expect(() => session.queue.submit({
      kind: 'profile.update', operationId: 'too-early', displayName: 'Maya Patel',
    })).toThrow('authenticated owner')

    releaseIdentity(await demo.app.getCurrentUser())
    await session.ready
    await session.queue.submit({ kind: 'profile.update', operationId: 'after-ready', displayName: 'Maya Patel' }).result()
    expect(session.queue.get('after-ready')).toMatchObject({ originUid: 'maya-p', status: 'fresh' })
  })

  it('uses the actual stable demo user ID as its only storage namespace', async () => {
    const repository = createDemoRepository()
    const currentUser = await repository.app.getCurrentUser()
    const storage = createMemoryCommandStorage()
    const session = createAppSession({ repository, commandStorage: storage })

    await session.ready
    await session.queue.submit({ kind: 'profile.update', operationId: 'demo-owned', displayName: 'Maya Patel' }).result()

    expect(storage.load(currentUser.id)).toMatchObject({
      version: 2,
      originUid: currentUser.id,
      operations: [{ originUid: currentUser.id, envelope: { operationId: 'demo-owned' } }],
    })
    expect(storage.load('someone-else')).toBeUndefined()
  })

  it('promotes local add-expense receipts before repository execution without rewriting the durable command', async () => {
    const demo = createDemoRepository()
    const storage = createMemoryCommandStorage()
    const events: string[] = []
    const executed: CommandEnvelope[] = []
    const repository = {
      ...demo,
      commands: { execute: async (command: CommandEnvelope) => {
        events.push('execute')
        executed.push(JSON.parse(JSON.stringify(command)) as CommandEnvelope)
        return demo.commands.execute(command)
      } },
    }
    const provider = receiptProvider(async (groupId, reference) => {
      events.push(`upload:${groupId}:${reference}`)
      return { status: 'uploaded', attachmentRef: 'remote-receipt:receipt-001' }
    })
    const session = createAppSession({
      repository,
      commandStorage: storage,
      receipts: createMemoryReceiptStore(),
      receiptProvider: provider,
    })
    await session.ready

    const handle = session.queue.submit(expenseAdd('promote-add', ['local-receipt:receipt-001', 'remote-receipt:existing']))
    expect(session.queue.get('promote-add')?.envelope).toMatchObject({ attachmentRefs: ['local-receipt:receipt-001', 'remote-receipt:existing'] })
    await expect(handle.result()).resolves.toMatchObject({
      status: 'saved',
      expense: { attachmentRefs: ['remote-receipt:receipt-001', 'remote-receipt:existing'] },
    })

    expect(events).toEqual(['upload:lake-house-weekend:local-receipt:receipt-001', 'execute'])
    expect(executed[0]).toMatchObject({ attachmentRefs: ['remote-receipt:receipt-001', 'remote-receipt:existing'] })
    expect(session.queue.get('promote-add')?.envelope).toMatchObject({ attachmentRefs: ['local-receipt:receipt-001', 'remote-receipt:existing'] })
    expect(storage.load('maya-p')).toMatchObject({
      operations: [{ envelope: { attachmentRefs: ['local-receipt:receipt-001', 'remote-receipt:existing'] } }],
    })
  })

  it('keeps an unavailable local receipt fallback honest when editing an expense', async () => {
    const demo = createDemoRepository()
    const existing = await demo.expenses.getById('lake-house-weekend', 'groceries')
    if (!existing) throw new Error('Missing fixture expense')
    const executed: CommandEnvelope[] = []
    const repository = {
      ...demo,
      commands: { execute: async (command: CommandEnvelope) => {
        executed.push(JSON.parse(JSON.stringify(command)) as CommandEnvelope)
        return demo.commands.execute(command)
      } },
    }
    const provider = receiptProvider(async () => ({ status: 'unavailable', reason: 'Offline; receipt remains on this device.' }))
    const session = createAppSession({ repository, commandStorage: createMemoryCommandStorage(), receiptProvider: provider })
    await session.ready

    const command: Extract<CommandEnvelope, { kind: 'expense.edit' }> = {
      kind: 'expense.edit',
      operationId: 'fallback-edit',
      groupId: existing.groupId,
      expenseId: existing.id,
      expectedRevision: existing.revision,
      draft: {
        groupId: existing.groupId,
        description: existing.description,
        date: existing.date,
        total: existing.total,
        payments: existing.payments,
        allocations: existing.allocations,
        category: existing.category,
        splitMethod: existing.splitMethod,
        attachmentRefs: ['local-receipt:offline-edit'],
      },
    }
    await expect(session.queue.submit(command).result()).resolves.toMatchObject({
      status: 'saved',
      expense: { attachmentRefs: ['local-receipt:offline-edit'] },
    })

    expect(executed[0]).toMatchObject({ draft: { attachmentRefs: ['local-receipt:offline-edit'] } })
    expect(session.queue.get('fallback-edit')?.envelope).toMatchObject({ draft: { attachmentRefs: ['local-receipt:offline-edit'] } })
  })

  it('shares one repository and queue across feature consumers', () => {
    setAppSessionForTesting(createAppSession({ commandStorage: createMemoryCommandStorage() }))
    const first = getAppSession()
    const second = getAppSession()
    expect(second.repository).toBe(first.repository)
    expect(second.queue).toBe(first.queue)
    setAppSessionForTesting(undefined)
  })

  it('provides deterministic repository and storage seams for tests', async () => {
    const repository = createDemoRepository()
    const session = createAppSession({ repository, commandStorage: createMemoryCommandStorage() })
    setAppSessionForTesting(session)

    await session.ready

    const operation = getAppSession().queue.submit({
      kind: 'expense.add', operationId: 'session-add', groupId: 'lake-house-weekend', description: 'Ice', date: '2026-08-30',
      total: { currency: 'USD', minorAmount: 400 }, payments: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 400 } }],
      allocations: [
        { participantId: 'maya-p', money: { currency: 'USD', minorAmount: 100 } },
        { participantId: 'jordan-k', money: { currency: 'USD', minorAmount: 100 } },
        { participantId: 'alex-r', money: { currency: 'USD', minorAmount: 100 } },
        { participantId: 'taylor-s', money: { currency: 'USD', minorAmount: 100 } },
      ],
      category: 'Supplies', splitMethod: { type: 'equal', participantIds: ['maya-p', 'jordan-k', 'alex-r', 'taylor-s'] }, attachmentRefs: [],
    })

    await expect(operation.result()).resolves.toMatchObject({ status: 'saved', expense: { description: 'Ice' } })
    await expect(repository.expenses.listForGroup('lake-house-weekend')).resolves.toHaveLength(6)
    setAppSessionForTesting(undefined)
  })
})

function expenseAdd(operationId: string, attachmentRefs: readonly string[]): Extract<CommandEnvelope, { kind: 'expense.add' }> {
  return {
    kind: 'expense.add', operationId, groupId: 'lake-house-weekend', description: 'Ice', date: '2026-08-30',
    total: { currency: 'USD', minorAmount: 400 }, payments: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 400 } }],
    allocations: [
      { participantId: 'maya-p', money: { currency: 'USD', minorAmount: 100 } },
      { participantId: 'jordan-k', money: { currency: 'USD', minorAmount: 100 } },
      { participantId: 'alex-r', money: { currency: 'USD', minorAmount: 100 } },
      { participantId: 'taylor-s', money: { currency: 'USD', minorAmount: 100 } },
    ],
    category: 'Supplies', splitMethod: { type: 'equal', participantIds: ['maya-p', 'jordan-k', 'alex-r', 'taylor-s'] }, attachmentRefs,
  }
}

function receiptProvider(upload: ReceiptProvider['upload']): ReceiptProvider {
  return {
    upload,
    async recognize(_reference: LocalReceiptReference) { return { status: 'unavailable', reason: 'Not used in session promotion.' } },
    async delete() { /* no remote cleanup in this controlled provider */ },
  }
}
