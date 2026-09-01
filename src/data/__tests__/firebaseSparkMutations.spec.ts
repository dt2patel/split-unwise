import { describe, expect, it } from 'vitest'
import * as sparkMutations from '../firebaseSparkMutations'
import { buildFirebaseProfile, buildSparkExpenseRecord, buildSparkInvitation, normalizeSparkGroup } from '../firebaseSparkMutations'
import type { ActorSnapshot, CommentAddCommand, CommentDeleteCommand, ExpenseAddCommand, ExpenseDeleteCommand, ExpenseEditCommand } from '../repositories'
import type { OperationIdentity } from '../operationIdentity'

const fill = (bytes: Uint8Array) => bytes.fill(11)

describe('Firebase Spark mutations', () => {
  it('derives a bounded public profile from the authenticated Firebase identity', () => {
    expect(buildFirebaseProfile({ uid: 'user-a', displayName: '  Maya   Patel  ', email: 'maya@example.com', photoURL: null })).toEqual({
      displayName: 'Maya Patel', initials: 'MP', avatarUrl: null,
    })
    expect(buildFirebaseProfile({ uid: 'user-b', displayName: null, email: 'friend.name@example.com', photoURL: null })).toEqual({
      displayName: 'friend.name', initials: 'F', avatarUrl: null,
    })
  })

  it('normalizes a supported group and derives a replay-stable strict ID', () => {
    expect(normalizeSparkGroup({ operationId: 'group-12345678-1234-1234-1234-123456789012', name: '  Chicago Weekend  ', currency: 'usd' })).toEqual({
      groupId: 'grp-group-12345678-1234-1234-1234-123456789012',
      name: 'Chicago Weekend', currency: 'USD',
    })
    expect(() => normalizeSparkGroup({ operationId: 'bad id', name: 'Trip', currency: 'USD' })).toThrow('operation')
  })

  it('makes the SHA-256 capability document ID match the private fragment token', async () => {
    const invitation = await buildSparkInvitation({ groupId: 'group-a', canonicalOrigin: 'https://split-unwise-aditya.web.app', random: fill, now: new Date('2026-09-01T00:00:00.000Z') })
    expect(invitation.capability).toBe('firebase-client')
    expect(invitation.invitationId).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(invitation.link).toBe('https://split-unwise-aditya.web.app/invite/join#token=CwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCws')
    expect(invitation.expiresAt).toBe('2026-09-08T00:00:00.000Z')
  })

  it('normalizes every client split into one immutable exact-allocation Spark expense record', () => {
    const command: ExpenseAddCommand = {
      kind: 'expense.add', operationId: 'expense-operation-1', groupId: 'group-a', description: '  Dinner   downtown ', date: '2026-09-01',
      total: { currency: 'USD', minorAmount: 4200 },
      payments: [{ participantId: 'owner', money: { currency: 'USD', minorAmount: 4200 } }],
      allocations: [
        { participantId: 'owner', money: { currency: 'USD', minorAmount: 1800 } },
        { participantId: 'friend', money: { currency: 'USD', minorAmount: 2400 } },
      ],
      category: 'Food', splitMethod: { type: 'percentage', participantIds: ['owner', 'friend'], percentages: { owner: 42.8571428571, friend: 57.1428571429 } },
      notes: '  Team dinner  ', attachmentRefs: [],
    }
    const identity: OperationIdentity = {
      userId: 'owner', operationId: command.operationId, kind: 'expense.add', groupId: 'group-a', requestFingerprint: 'a'.repeat(64),
      resourceId: `operation-${'b'.repeat(48)}`,
    }
    const committedAt = { kind: 'server-timestamp' }

    const record = buildSparkExpenseRecord(command, { id: 'owner', displayName: 'Owner Account' }, identity, committedAt)

    expect(record.expenseId).toBe(`expense-${'b'.repeat(48)}`)
    expect(record.expenseDocument).toEqual({
      id: record.expenseId, groupId: 'group-a', operationId: 'expense-operation-1', requestFingerprint: 'a'.repeat(64), resourceToken: 'b'.repeat(48),
      lastOperationId: 'expense-operation-1', lastRequestFingerprint: 'a'.repeat(64), lastResourceToken: 'b'.repeat(48),
      description: 'Dinner downtown', date: '2026-09-01', total: { currency: 'USD', minorAmount: 4200 },
      payments: [{ participantId: 'owner', money: { currency: 'USD', minorAmount: 4200 } }],
      allocations: [
        { participantId: 'owner', money: { currency: 'USD', minorAmount: 1800 } },
        { participantId: 'friend', money: { currency: 'USD', minorAmount: 2400 } },
      ],
      payerIds: ['owner'], participantIds: ['owner', 'friend'], involvedMemberIds: ['friend', 'owner'],
      category: 'Food', splitType: 'percentage', splitMethod: { type: 'exact', allocations: [
        { participantId: 'owner', money: { currency: 'USD', minorAmount: 1800 } },
        { participantId: 'friend', money: { currency: 'USD', minorAmount: 2400 } },
      ] }, notes: 'Team dinner', attachmentRefs: [],
      createdAt: committedAt, createdBy: { id: 'owner', displayName: 'Owner Account' }, updatedAt: committedAt, updatedBy: { id: 'owner', displayName: 'Owner Account' }, revision: 1,
    })
  })

  it('rejects Spark expense bundles that cannot be verified by the bounded rules path', () => {
    const base: ExpenseAddCommand = {
      kind: 'expense.add', operationId: 'expense-operation-2', groupId: 'group-a', description: 'Dinner', date: '2026-09-01',
      total: { currency: 'USD', minorAmount: 1000 }, payments: [{ participantId: 'owner', money: { currency: 'USD', minorAmount: 1000 } }],
      allocations: [{ participantId: 'owner', money: { currency: 'USD', minorAmount: 1000 } }], category: 'Food', splitMethod: { type: 'equal', participantIds: ['owner'] }, attachmentRefs: [],
    }
    const identity: OperationIdentity = { userId: 'owner', operationId: base.operationId, kind: 'expense.add', groupId: 'group-a', requestFingerprint: 'c'.repeat(64), resourceId: `operation-${'d'.repeat(48)}` }
    const actor = { id: 'owner', displayName: 'Owner Account' }

    expect(() => buildSparkExpenseRecord({ ...base, recurrence: { frequency: 'monthly', anchor: { month: 9, day: 1 }, timeZone: 'America/Chicago' } }, actor, identity, 'now')).toThrow(/recurring/i)
    expect(() => buildSparkExpenseRecord({ ...base, attachmentRefs: ['local-receipt:a'] }, actor, identity, 'now')).toThrow(/attachment/i)
    expect(() => buildSparkExpenseRecord(base, actor, { ...identity, userId: 'other' }, 'now')).toThrow(/identity/i)
    expect(() => buildSparkExpenseRecord({ ...base, allocations: Array.from({ length: 7 }, (_, index) => ({ participantId: `member-${index}`, money: { currency: 'USD' as const, minorAmount: index === 0 ? 1000 : 0 } })), splitMethod: { type: 'exact', allocations: Array.from({ length: 7 }, (_, index) => ({ participantId: `member-${index}`, money: { currency: 'USD' as const, minorAmount: index === 0 ? 1000 : 0 } })) } }, actor, identity, 'now')).toThrow(/six/i)
  })

  it('builds replay-bound edit and soft-delete records while preserving every prior revision', () => {
    const addCommand: ExpenseAddCommand = {
      kind: 'expense.add', operationId: 'create-expense', groupId: 'group-a', description: 'Original dinner', date: '2026-09-01',
      total: { currency: 'USD', minorAmount: 4200 }, payments: [{ participantId: 'owner', money: { currency: 'USD', minorAmount: 4200 } }],
      allocations: [{ participantId: 'owner', money: { currency: 'USD', minorAmount: 1800 } }, { participantId: 'friend', money: { currency: 'USD', minorAmount: 2400 } }],
      category: 'Food', splitMethod: { type: 'exact', allocations: [{ participantId: 'owner', money: { currency: 'USD', minorAmount: 1800 } }, { participantId: 'friend', money: { currency: 'USD', minorAmount: 2400 } }] },
      notes: 'Original note', attachmentRefs: [],
    }
    const creator: ActorSnapshot = { id: 'owner', displayName: 'Owner Account' }
    const createdAt = { kind: 'created-at', toDate: () => new Date('2026-09-01T10:00:00.000Z') }
    const creationIdentity: OperationIdentity = { userId: 'owner', operationId: addCommand.operationId, kind: 'expense.add', groupId: 'group-a', requestFingerprint: 'a'.repeat(64), resourceId: `operation-${'b'.repeat(48)}` }
    const current = buildSparkExpenseRecord(addCommand, creator, creationIdentity, createdAt).expenseDocument
    const editCommand: ExpenseEditCommand = {
      kind: 'expense.edit', operationId: 'edit-expense', groupId: 'group-a', expenseId: String(current.id), expectedRevision: 1,
      draft: {
        groupId: 'group-a', description: 'Updated dinner', date: '2026-09-02', total: { currency: 'USD', minorAmount: 5000 },
        payments: [{ participantId: 'owner', money: { currency: 'USD', minorAmount: 5000 } }],
        allocations: [{ participantId: 'owner', money: { currency: 'USD', minorAmount: 2500 } }, { participantId: 'friend', money: { currency: 'USD', minorAmount: 2500 } }],
        category: 'Dining', splitMethod: { type: 'equal', participantIds: ['owner', 'friend'] }, attachmentRefs: [],
      },
    }
    const editIdentity: OperationIdentity = { userId: 'owner', operationId: editCommand.operationId, kind: 'expense.edit', groupId: 'group-a', requestFingerprint: 'c'.repeat(64), resourceId: `operation-${'d'.repeat(48)}` }
    const updatedAt = { kind: 'updated-at', toDate: () => new Date('2026-09-02T10:00:00.000Z') }
    const buildMutation = (sparkMutations as unknown as { buildSparkExpenseMutationRecord: SparkMutationBuilder }).buildSparkExpenseMutationRecord

    const edit = buildMutation(editCommand, current, current, { actor: creator, canManage: false }, editIdentity, updatedAt)

    expect(edit.revisionId).toBe('d'.repeat(48))
    expect(edit.headDocument).toMatchObject({
      id: current.id, description: 'Original dinner', revision: 1, headRevision: 2, headDeleted: false,
      lastOperationId: 'edit-expense', lastRequestFingerprint: 'c'.repeat(64), lastResourceToken: 'd'.repeat(48),
    })
    expect(edit.revisionDocument).toMatchObject({
      groupId: 'group-a', expenseId: current.id, revision: 2, operationId: 'edit-expense', action: 'updated',
      actor: creator, createdAt: updatedAt,
    })
    expect(edit.revisionDocument.expense).toMatchObject({
      id: current.id, groupId: 'group-a', operationId: 'create-expense', requestFingerprint: 'a'.repeat(64), resourceToken: 'b'.repeat(48),
      lastOperationId: 'edit-expense', lastRequestFingerprint: 'c'.repeat(64), lastResourceToken: 'd'.repeat(48),
      description: 'Updated dinner', total: { currency: 'USD', minorAmount: 5000 }, splitType: 'equal',
      splitMethod: { type: 'exact', allocations: editCommand.draft.allocations }, createdAt, createdBy: creator, updatedAt, updatedBy: creator, revision: 2,
    })
    expect(edit.revisionDocument.expense).not.toHaveProperty('notes')

    const deleteCommand: ExpenseDeleteCommand = { kind: 'expense.delete', operationId: 'delete-expense', groupId: 'group-a', expenseId: String(current.id), expectedRevision: 2 }
    const deleteIdentity: OperationIdentity = { userId: 'owner', operationId: deleteCommand.operationId, kind: 'expense.delete', groupId: 'group-a', requestFingerprint: 'e'.repeat(64), resourceId: `operation-${'f'.repeat(48)}` }
    const deletedAt = { kind: 'deleted-at', toDate: () => new Date('2026-09-03T10:00:00.000Z') }
    const editedExpense = edit.revisionDocument.expense as Readonly<Record<string, unknown>>
    const removed = buildMutation(deleteCommand, edit.headDocument, editedExpense, { actor: creator, canManage: false }, deleteIdentity, deletedAt)

    expect(removed.headDocument).toMatchObject({
      description: 'Original dinner', revision: 1, headRevision: 3, headDeleted: true,
      lastOperationId: 'delete-expense', lastRequestFingerprint: 'e'.repeat(64), lastResourceToken: 'f'.repeat(48),
    })
    expect(removed.revisionDocument).toMatchObject({ revision: 3, operationId: 'delete-expense', action: 'deleted', actor: creator, createdAt: deletedAt })
    expect(removed.revisionDocument.expense).toMatchObject({
      lastOperationId: 'delete-expense', lastRequestFingerprint: 'e'.repeat(64), lastResourceToken: 'f'.repeat(48),
      description: 'Updated dinner', revision: 3, updatedAt: deletedAt, updatedBy: creator, deletedAt,
    })
  })

  it('rejects stale or unauthorized Spark mutations before constructing an audit record', () => {
    const add: ExpenseAddCommand = {
      kind: 'expense.add', operationId: 'create-owned', groupId: 'group-a', description: 'Owned expense', date: '2026-09-01',
      total: { currency: 'USD', minorAmount: 1000 }, payments: [{ participantId: 'owner', money: { currency: 'USD', minorAmount: 1000 } }],
      allocations: [{ participantId: 'owner', money: { currency: 'USD', minorAmount: 1000 } }], category: 'Food',
      splitMethod: { type: 'equal', participantIds: ['owner'] }, attachmentRefs: [],
    }
    const creator = { id: 'owner', displayName: 'Owner Account' }
    const current = buildSparkExpenseRecord(add, creator, { userId: 'owner', operationId: add.operationId, kind: 'expense.add', groupId: 'group-a', requestFingerprint: '1'.repeat(64), resourceId: `operation-${'2'.repeat(48)}` }, { toDate: () => new Date('2026-09-01T10:00:00.000Z') }).expenseDocument
    const stale: ExpenseDeleteCommand = { kind: 'expense.delete', operationId: 'stale-delete', groupId: 'group-a', expenseId: String(current.id), expectedRevision: 2 }
    const friendCommand: ExpenseDeleteCommand = { ...stale, operationId: 'friend-delete', expectedRevision: 1 }
    const buildMutation = (sparkMutations as unknown as { buildSparkExpenseMutationRecord: SparkMutationBuilder }).buildSparkExpenseMutationRecord

    expect(() => buildMutation(stale, current, current, { actor: creator, canManage: false }, { userId: 'owner', operationId: stale.operationId, kind: stale.kind, groupId: 'group-a', requestFingerprint: '3'.repeat(64), resourceId: `operation-${'4'.repeat(48)}` }, 'deleted')).toThrow(/changed remotely/i)
    expect(() => buildMutation(friendCommand, current, current, { actor: { id: 'friend', displayName: 'Friend Account' }, canManage: false }, { userId: 'friend', operationId: friendCommand.operationId, kind: friendCommand.kind, groupId: 'group-a', requestFingerprint: '5'.repeat(64), resourceId: `operation-${'6'.repeat(48)}` }, 'deleted')).toThrow(/author|manager/i)
    expect(() => buildMutation({ ...friendCommand, operationId: 'manager-delete' }, current, current, { actor: { id: 'manager', displayName: 'Manager Account' }, canManage: true }, { userId: 'manager', operationId: 'manager-delete', kind: friendCommand.kind, groupId: 'group-a', requestFingerprint: '7'.repeat(64), resourceId: `operation-${'8'.repeat(48)}` }, 'deleted')).not.toThrow()
  })

  it('builds replay-bound Spark comments and companion activity records', () => {
    const command: CommentAddCommand = {
      kind: 'comment.add', operationId: 'comment-add', groupId: 'group-a', expenseId: 'expense-a', body: '  Dessert was worth it.  ', attachmentRefs: [],
    }
    const actor = { id: 'friend', displayName: 'Friend Account' }
    const identity: OperationIdentity = { userId: 'friend', operationId: command.operationId, kind: command.kind, groupId: command.groupId, requestFingerprint: 'a'.repeat(64), resourceId: `operation-${'b'.repeat(48)}` }
    const createdAt = { kind: 'comment-created' }
    const buildComment = (sparkMutations as unknown as { buildSparkCommentRecord: SparkCommentBuilder }).buildSparkCommentRecord

    const record = buildComment(command, actor, identity, createdAt)

    expect(record.commentId).toBe(`comment-${'b'.repeat(48)}`)
    expect(record.activityId).toBe(`activity-${'b'.repeat(48)}`)
    expect(record.commentDocument).toEqual({
      groupId: 'group-a', expenseId: 'expense-a', operationId: 'comment-add', requestFingerprint: 'a'.repeat(64), resourceToken: 'b'.repeat(48),
      lastOperationId: 'comment-add', lastRequestFingerprint: 'a'.repeat(64), lastResourceToken: 'b'.repeat(48),
      author: actor, body: 'Dessert was worth it.', attachmentRefs: [], createdAt,
    })
    expect(record.activityDocument).toEqual({
      groupId: 'group-a', operationId: 'comment-add', kind: 'comment.added', subject: { kind: 'comment', id: record.commentId, label: 'Dessert was worth it.' },
      actor, expenseId: 'expense-a', commentId: record.commentId, createdAt,
    })
    expect(() => buildComment({ ...command, operationId: 'with-file', attachmentRefs: ['asset-a'] }, actor, { ...identity, operationId: 'with-file' }, createdAt)).toThrow(/attachment/i)
  })

  it('builds author-only replay-bound Spark comment soft deletes', () => {
    const add: CommentAddCommand = { kind: 'comment.add', operationId: 'comment-add', groupId: 'group-a', expenseId: 'expense-a', body: 'Delete this', attachmentRefs: [] }
    const author = { id: 'friend', displayName: 'Friend Account' }
    const addIdentity: OperationIdentity = { userId: 'friend', operationId: add.operationId, kind: add.kind, groupId: add.groupId, requestFingerprint: 'c'.repeat(64), resourceId: `operation-${'d'.repeat(48)}` }
    const buildComment = (sparkMutations as unknown as { buildSparkCommentRecord: SparkCommentBuilder }).buildSparkCommentRecord
    const current = buildComment(add, author, addIdentity, { kind: 'created' }).commentDocument
    const command: CommentDeleteCommand = { kind: 'comment.delete', operationId: 'comment-delete', groupId: 'group-a', expenseId: 'expense-a', commentId: `comment-${'d'.repeat(48)}` }
    const identity: OperationIdentity = { userId: 'friend', operationId: command.operationId, kind: command.kind, groupId: command.groupId, requestFingerprint: 'e'.repeat(64), resourceId: `operation-${'f'.repeat(48)}` }
    const deletedAt = { kind: 'comment-deleted' }
    const buildDelete = (sparkMutations as unknown as { buildSparkCommentDeleteRecord: SparkCommentDeleteBuilder }).buildSparkCommentDeleteRecord

    const removed = buildDelete(command, current, author, identity, deletedAt)

    expect(removed.commentDocument).toEqual({
      ...current, lastOperationId: 'comment-delete', lastRequestFingerprint: 'e'.repeat(64), lastResourceToken: 'f'.repeat(48), deletedAt,
    })
    expect(removed.activityId).toBe(`activity-${'f'.repeat(48)}`)
    expect(removed.activityDocument).toMatchObject({ operationId: 'comment-delete', kind: 'comment.deleted', actor: author, expenseId: 'expense-a', commentId: command.commentId, createdAt: deletedAt })
    expect(() => buildDelete(command, current, { id: 'owner', displayName: 'Owner Account' }, { ...identity, userId: 'owner' }, deletedAt)).toThrow(/author/i)
  })
})

type SparkMutationBuilder = (
  command: ExpenseEditCommand | ExpenseDeleteCommand,
  head: Readonly<Record<string, unknown>>,
  current: Readonly<Record<string, unknown>>,
  authorization: { readonly actor: ActorSnapshot; readonly canManage: boolean },
  identity: OperationIdentity,
  committedAt: unknown,
) => {
  readonly headDocument: Readonly<Record<string, unknown>>
  readonly revisionId: string
  readonly revisionDocument: Readonly<Record<string, unknown>> & { readonly expense: Readonly<Record<string, unknown>> }
}

type SparkCommentBuilder = (
  command: CommentAddCommand,
  actor: ActorSnapshot,
  identity: OperationIdentity,
  committedAt: unknown,
) => {
  readonly commentId: string
  readonly commentDocument: Readonly<Record<string, unknown>>
  readonly activityId: string
  readonly activityDocument: Readonly<Record<string, unknown>>
}

type SparkCommentRecord = ReturnType<SparkCommentBuilder>

type SparkCommentDeleteBuilder = (
  command: CommentDeleteCommand,
  current: Readonly<Record<string, unknown>>,
  actor: ActorSnapshot,
  identity: OperationIdentity,
  committedAt: unknown,
) => SparkCommentRecord
