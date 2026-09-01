import { deleteApp, getApps, initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { executeLedgerCommand, LedgerError } from '../ledger.js'

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST)
const suite = enabled ? describe : describe.skip
const projectId = 'demo-split-unwise'
const appName = 'split-unwise-functions-tests'

suite('ledger against the Firestore emulator', () => {
  const app = getApps().find(({ name }) => name === appName) ?? initializeApp({ projectId }, appName)
  const db = getFirestore(app)

  beforeAll(() => { db.settings({ ignoreUndefinedProperties: false }) })
  beforeEach(async () => {
    const response = await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: 'DELETE' })
    if (!response.ok) throw new Error(`Could not clear emulator: ${response.status}`)
    await Promise.all([
      db.doc('users/owner').set({ displayName: 'Owner', initials: 'O' }),
      db.doc('users/member').set({ displayName: 'Member', initials: 'M' }),
      db.doc('users/removed').set({ displayName: 'Removed', initials: 'R' }),
      db.doc('groups/group-a').set({ name: 'Group A', currency: 'USD', memberIds: ['owner', 'member'] }),
      db.doc('groups/group-a/members/owner').set({ status: 'active', role: 'owner', canManage: true }),
      db.doc('groups/group-a/members/member').set({ status: 'active', role: 'member', canManage: false }),
      db.doc('groups/group-a/members/removed').set({ status: 'removed', role: 'member', canManage: false }),
      db.doc('groups/group-a/balance/current').set({ groupId: 'group-a', balanceRevision: 0, simplifyDebtsEnabled: true, pairwise: [], simplified: [] }),
    ])
  })
  afterAll(async () => deleteApp(app))

  it('deduplicates twenty concurrent identical commands into one immutable revision and activity', async () => {
    const request = addRequest('same-operation')
    const results = await Promise.all(Array.from({ length: 20 }, () => executeLedgerCommand(db, 'owner', request, new Date('2026-08-31T12:00:00.000Z'))))
    expect(new Set(results.map((result) => JSON.stringify(result))).size).toBe(1)
    const [expenses, activity, operations] = await Promise.all([
      db.collection('groups/group-a/expenses').get(),
      db.collection('groups/group-a/activity').get(),
      db.collection('users/owner/operations').get(),
    ])
    expect(expenses.size).toBe(1)
    expect(activity.size).toBe(1)
    expect(operations.size).toBe(1)
    expect((await expenses.docs[0].ref.collection('revisions').get()).size).toBe(1)
    expect((await db.doc('groups/group-a/balance/current').get()).data()).toMatchObject({ balanceRevision: 1, simplified: [{ fromParticipantId: 'member', toParticipantId: 'owner', money: { currency: 'USD', minorAmount: 500 } }] })
    expect(operations.docs[0].data()).not.toHaveProperty('expiresAt')
  }, 30_000)

  it('rejects changed-payload collisions and removed-member replay', async () => {
    const request = addRequest('collision-operation')
    await executeLedgerCommand(db, 'owner', request)
    await expect(executeLedgerCommand(db, 'owner', { ...request, command: { ...request.command, description: 'Changed' } })).rejects.toMatchObject({ code: 'already-exists' })
    await db.doc('groups/group-a/members/owner').update({ status: 'removed' })
    await expect(executeLedgerCommand(db, 'owner', request)).rejects.toMatchObject({ code: 'permission-denied' })
  })

  it('propagates a profile rename to active member snapshots and only the active friendship counterpart projection', async () => {
    await Promise.all([
      db.doc('groups/group-a/members/owner').update({ displayName: 'Owner', initials: 'O' }),
      db.doc('users/owner/groups/group-a').set({ groupId: 'group-a', status: 'active', contextLabel: 'Group A' }),
      db.doc('users/member/groups/group-a').set({ groupId: 'group-a', status: 'active', contextLabel: 'Group A' }),
      db.doc('groups/friendship-active').set({ kind: 'friendship', name: 'Member', memberIds: ['owner', 'member'] }),
      db.doc('groups/friendship-active/members/owner').set({ status: 'active', displayName: 'Owner', initials: 'O' }),
      db.doc('groups/friendship-active/members/member').set({ status: 'active', displayName: 'Member', initials: 'M' }),
      db.doc('users/owner/groups/friendship-active').set({ groupId: 'friendship-active', status: 'active', contextLabel: 'Member' }),
      db.doc('users/member/groups/friendship-active').set({ groupId: 'friendship-active', status: 'active', contextLabel: 'Owner', updatedAt: '2026-08-01T00:00:00.000Z' }),
      db.doc('groups/friendship-removed').set({ kind: 'friendship', name: 'Removed', memberIds: ['owner', 'removed'] }),
      db.doc('groups/friendship-removed/members/owner').set({ status: 'removed', displayName: 'Owner', initials: 'O' }),
      db.doc('groups/friendship-removed/members/removed').set({ status: 'active', displayName: 'Removed', initials: 'R' }),
      db.doc('users/owner/groups/friendship-removed').set({ groupId: 'friendship-removed', status: 'removed', contextLabel: 'Removed' }),
      db.doc('users/removed/groups/friendship-removed').set({ groupId: 'friendship-removed', status: 'active', contextLabel: 'Owner', updatedAt: '2026-08-01T00:00:00.000Z' }),
    ])
    const request = { schemaVersion: 1, command: { kind: 'profile.update', operationId: 'rename-owner', displayName: 'Renamed Owner', initials: 'RO' } }
    const committedAt = '2026-09-01T16:00:00.000Z'

    const first = await executeLedgerCommand(db, 'owner', request, new Date(committedAt))
    const replay = await executeLedgerCommand(db, 'owner', request, new Date('2026-09-01T17:00:00.000Z'))

    expect(replay).toEqual(first)
    expect((await db.doc('users/owner').get()).data()).toMatchObject({ displayName: 'Renamed Owner', initials: 'RO', updatedAt: committedAt })
    expect((await db.doc('groups/group-a/members/owner').get()).data()).toMatchObject({ status: 'active', displayName: 'Renamed Owner', initials: 'RO' })
    expect((await db.doc('groups/friendship-active/members/owner').get()).data()).toMatchObject({ status: 'active', displayName: 'Renamed Owner', initials: 'RO' })
    expect((await db.doc('groups/friendship-removed/members/owner').get()).data()).toMatchObject({ status: 'removed', displayName: 'Owner', initials: 'O' })
    expect((await db.doc('users/member/groups/friendship-active').get()).data()).toMatchObject({ contextLabel: 'Renamed Owner', updatedAt: committedAt })
    expect((await db.doc('users/owner/groups/friendship-active').get()).data()).toMatchObject({ contextLabel: 'Member' })
    expect((await db.doc('users/member/groups/group-a').get()).data()).toMatchObject({ contextLabel: 'Group A' })
    expect((await db.doc('users/removed/groups/friendship-removed').get()).data()).toMatchObject({ contextLabel: 'Owner', updatedAt: '2026-08-01T00:00:00.000Z' })
    expect((await db.doc('groups/friendship-active').get()).data()).toMatchObject({ name: 'Member' })
    expect((await db.collection('users/owner/operations').get()).size).toBe(1)
  })

  it('rejects inactive participants, unsafe totals, and stale revisions', async () => {
    const inactive = addRequest('inactive-operation')
    inactive.command.allocations = [{ participantId: 'owner', money: { currency: 'USD', minorAmount: 500 } }, { participantId: 'removed', money: { currency: 'USD', minorAmount: 500 } }]
    inactive.command.splitMethod = { type: 'equal', participantIds: ['owner', 'removed'] }
    await expect(executeLedgerCommand(db, 'owner', inactive)).rejects.toMatchObject({ code: 'invalid-argument' })
    const invalid = addRequest('invalid-operation')
    invalid.command.total.minorAmount = 0
    await expect(executeLedgerCommand(db, 'owner', invalid)).rejects.toBeInstanceOf(LedgerError)
    const saved = await executeLedgerCommand(db, 'owner', addRequest('edit-source'))
    const expense = saved.expense as Record<string, unknown>
    const { kind: _kind, operationId: _operationId, ...draft } = addRequest('draft').command
    await expect(executeLedgerCommand(db, 'owner', { schemaVersion: 1, command: { kind: 'expense.edit', operationId: 'stale-edit', groupId: 'group-a', expenseId: expense.id, expectedRevision: 99, draft } })).rejects.toMatchObject({ code: 'failed-precondition' })
  })

  it('records a confirmed settlement against the exact balance revision and updates debts', async () => {
    await executeLedgerCommand(db, 'owner', addRequest('expense-before-settlement'))
    const result = await executeLedgerCommand(db, 'member', { schemaVersion: 1, command: { kind: 'settlement.record', operationId: 'settlement-operation', groupId: 'group-a', expectedBalanceRevision: 1, basis: { kind: 'simplified', senderId: 'member', recipientId: 'owner', currency: 'USD', debtMinor: 500 }, money: { currency: 'USD', minorAmount: 200 }, method: 'cash', occurredOn: '2026-08-31', outsidePaymentConfirmed: true } })
    expect(result).toMatchObject({ status: 'saved', balanceSnapshot: { balanceRevision: 2, simplified: [{ fromParticipantId: 'member', toParticipantId: 'owner', money: { minorAmount: 300 } }] } })
    await expect(executeLedgerCommand(db, 'member', { schemaVersion: 1, command: { kind: 'settlement.record', operationId: 'stale-settlement', groupId: 'group-a', expectedBalanceRevision: 1, basis: { kind: 'simplified', senderId: 'member', recipientId: 'owner', currency: 'USD', debtMinor: 500 }, money: { currency: 'USD', minorAmount: 100 }, method: 'cash', occurredOn: '2026-08-31', outsidePaymentConfirmed: true } })).rejects.toMatchObject({ code: 'failed-precondition' })
  })

  it('lets an active member version debt simplification without changing the saved default split', async () => {
    const defaultSplit = { type: 'shares', participantIds: ['owner', 'member'], shares: { owner: 2, member: 1 } }
    const pairwise = [{ fromParticipantId: 'member', toParticipantId: 'owner', money: { currency: 'USD', minorAmount: 500 } }]
    const simplified = [{ fromParticipantId: 'member', toParticipantId: 'owner', money: { currency: 'USD', minorAmount: 500 } }]
    await Promise.all([
      db.doc('groups/group-a/settings/defaults').set({ schemaVersion: 1, groupId: 'group-a', revision: 4, defaultSplit, simplifyDebtsEnabled: true }),
      db.doc('groups/group-a/balance/current').set({ groupId: 'group-a', balanceRevision: 7, simplifyDebtsEnabled: true, pairwise, simplified }),
    ])
    const request = { schemaVersion: 1, command: { kind: 'group.simplify-debts', operationId: 'simplify-off', groupId: 'group-a', expectedRevision: 4, simplifyDebtsEnabled: false } }

    await expect(executeLedgerCommand(db, 'member', request, new Date('2026-08-31T15:00:00.000Z'))).resolves.toEqual({
      kind: 'group.simplify-debts', operationId: 'simplify-off', status: 'saved', resourceId: 'group-a',
    })
    await expect(executeLedgerCommand(db, 'member', request, new Date('2026-08-31T15:00:01.000Z'))).resolves.toEqual({
      kind: 'group.simplify-debts', operationId: 'simplify-off', status: 'saved', resourceId: 'group-a',
    })
    expect((await db.doc('groups/group-a/settings/defaults').get()).data()).toMatchObject({ revision: 5, defaultSplit, simplifyDebtsEnabled: false })
    expect((await db.doc('groups/group-a/balance/current').get()).data()).toEqual({ groupId: 'group-a', balanceRevision: 8, simplifyDebtsEnabled: false, pairwise, simplified })
    const activity = await db.collection('groups/group-a/activity').get()
    expect(activity.docs.map((document) => document.data())).toEqual([expect.objectContaining({
      operationId: 'simplify-off', kind: 'group.event', actor: { id: 'member', displayName: 'Member' },
      subject: { kind: 'group', id: 'group-a', label: 'Simplify debts disabled' },
    })])
    await expect(executeLedgerCommand(db, 'member', { schemaVersion: 1, command: { ...request.command, operationId: 'simplify-stale' } })).rejects.toMatchObject({ code: 'failed-precondition' })
  })
})

function addRequest(operationId: string): { schemaVersion: 1; command: any } {
  return { schemaVersion: 1, command: { kind: 'expense.add', operationId, groupId: 'group-a', description: 'Dinner', date: '2026-08-31', total: { currency: 'USD', minorAmount: 1000 }, payments: [{ participantId: 'owner', money: { currency: 'USD', minorAmount: 1000 } }], allocations: [{ participantId: 'owner', money: { currency: 'USD', minorAmount: 500 } }, { participantId: 'member', money: { currency: 'USD', minorAmount: 500 } }], category: 'Dining', splitMethod: { type: 'equal', participantIds: ['owner', 'member'] }, attachmentRefs: [] } }
}
