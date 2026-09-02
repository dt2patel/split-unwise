import { describe, expect, it } from 'vitest'
import {
  decodeActivity,
  decodeComment,
  decodeExpense,
  decodeExpenseRevision,
  decodeMember,
  decodeNotification,
} from '../firebaseDecoders'

describe('Task 7 Firebase boundary decoders', () => {
  it('decodes explicit manager capability and rejects a non-boolean value', () => {
    expect(decodeMember('maya-p', { displayName: 'Maya P.', initials: 'MP', canManage: true }, true)).toMatchObject({ canManage: true })
    expect(decodeMember('jordan-k', { displayName: 'Jordan K.', initials: 'JK', avatarUrl: null }, false)).toEqual({
      id: 'jordan-k', displayName: 'Jordan K.', initials: 'JK', isCurrentUser: false,
    })
    expect(decodeMember('maya-p', { displayName: 'Maya P.', initials: 'MP', avatarUrl: 'https://example.com/maya.png' }, true).avatarUrl).toBe('https://example.com/maya.png')
    expect(() => decodeMember('alex-r', { displayName: 'Alex R.', initials: 'AR', avatarUrl: 42 }, false)).toThrow('avatarUrl')
    expect(() => decodeMember('alex-r', { displayName: 'Alex R.', initials: 'AR', canManage: 'yes' }, false)).toThrow('canManage')
  })

  it('decodes only the canonical deleted member identity', () => {
    const deleted = {
      status: 'removed', role: 'member', canManage: false, displayName: 'Deleted user', initials: 'DU', avatarUrl: null, accountStatus: 'deleted',
    }
    expect(decodeMember('former-member', deleted, false)).toMatchObject({ id: 'former-member', accountStatus: 'deleted', displayName: 'Deleted user' })
    expect(() => decodeMember('former-member', { ...deleted, displayName: 'Forged name' }, false)).toThrow('canonical')
    expect(() => decodeMember('former-member', { ...deleted, canManage: true }, false)).toThrow('canonical')
  })

  it('decodes expense actor snapshots and rejects malformed actor identity', () => {
    const raw = rawExpense()
    expect(decodeExpense('lake-house-weekend', 'groceries', raw)).toMatchObject({
      createdBy: { id: 'maya-p', displayName: 'Maya P.' },
      updatedBy: { id: 'maya-p', displayName: 'Maya P.' },
    })
    expect(() => decodeExpense('lake-house-weekend', 'groceries', { ...raw, createdBy: { id: '', displayName: 'Maya P.' } })).toThrow('createdBy.id')
  })

  it('strictly decodes immutable revision snapshots and rejects mismatched revision identity', () => {
    const raw = {
      groupId: 'lake-house-weekend', expenseId: 'groceries', revision: 2, operationId: 'edit-groceries', action: 'updated',
      actor: { id: 'maya-p', displayName: 'Maya P.' }, createdAt: '2026-08-31T12:00:00.000Z',
      expense: { ...rawExpense(), revision: 2, updatedAt: '2026-08-31T12:00:00.000Z' },
    }
    expect(decodeExpenseRevision('lake-house-weekend', 'groceries', 'revision-groceries-2', raw)).toMatchObject({ revision: 2, action: 'updated' })
    expect(() => decodeExpenseRevision('lake-house-weekend', 'groceries', 'revision-groceries-2', { ...raw, revision: 3 })).toThrow('snapshot revision')
    expect(() => decodeExpenseRevision('lake-house-weekend', 'groceries', 'revision-groceries-2', { ...raw, createdAt: 'August 31' })).toThrow('ISO timestamp')
    expect(() => decodeExpenseRevision('lake-house-weekend', 'groceries', 'revision-groceries-2', { ...raw, action: 'created' })).toThrow('created revision')
    expect(() => decodeExpenseRevision('lake-house-weekend', 'groceries', 'revision-groceries-2', {
      ...raw, actor: { id: 'alex-r', displayName: 'Alex R.' }, expense: { ...raw.expense, updatedBy: { id: 'maya-p', displayName: 'Maya P.' } },
    })).toThrow('actor')
  })

  it('attributes a recurring occurrence creation revision to its materializer while retaining the series creator as author', () => {
    const creator = { id: 'series-creator', displayName: 'Series Creator' }
    const materializer = { id: 'series-manager', displayName: 'Series Manager' }
    const expense = {
      ...rawExpense(), recurringTemplateId: 'monthly-rent', recurrence: { frequency: 'monthly', anchor: { month: 8, day: 30 }, timeZone: 'UTC' },
      createdBy: creator, updatedBy: materializer,
    }
    const revision = {
      groupId: 'lake-house-weekend', expenseId: 'rent-occurrence', revision: 1, operationId: 'materialize-rent', action: 'created',
      actor: materializer, createdAt: expense.createdAt, expense,
    }

    expect(decodeExpenseRevision('lake-house-weekend', 'rent-occurrence', 'creation-token', revision)).toMatchObject({
      action: 'created', actor: materializer, expense: { createdBy: creator, updatedBy: materializer },
    })
    expect(() => decodeExpenseRevision('lake-house-weekend', 'rent-occurrence', 'creation-token', { ...revision, actor: creator })).toThrow('actor')
    expect(() => decodeExpenseRevision('lake-house-weekend', 'ordinary-expense', 'creation-token', {
      ...revision, expenseId: 'ordinary-expense', expense: { ...expense, recurringTemplateId: undefined }, actor: materializer,
    })).toThrow('actor')
  })

  it('strictly decodes structured comments and activity without renderer HTML or URLs', () => {
    expect(decodeComment('lake-house-weekend', 'groceries', 'comment-1', {
      expenseId: 'groceries', operationId: 'comment-op', author: { id: 'maya-p', displayName: 'Maya P.' }, body: 'Hello',
      attachmentRefs: [], createdAt: '2026-08-31T12:00:00.000Z',
    })).toMatchObject({ commentId: 'comment-1', groupId: 'lake-house-weekend', operationId: 'comment-op' })
    expect(() => decodeComment('lake-house-weekend', 'groceries', 'comment-1', {
      expenseId: 'groceries', operationId: 'comment-op', author: { id: 'maya-p', displayName: 'Maya P.' }, body: 'Hello',
      attachmentRefs: [], createdAt: 'yesterday',
    })).toThrow('ISO timestamp')

    const event = decodeActivity('lake-house-weekend', 'activity-1', {
      operationId: 'comment-op', kind: 'comment.added', subject: { kind: 'comment', id: 'comment-1', label: 'Hello' },
      actor: { id: 'maya-p', displayName: 'Maya P.' }, expenseId: 'groceries', commentId: 'comment-1',
      createdAt: '2026-08-31T12:00:00.000Z',
    })
    expect(event).toMatchObject({ kind: 'comment.added', commentId: 'comment-1' })
    expect(event).not.toHaveProperty('summary')
    expect(event).not.toHaveProperty('url')
    expect(() => decodeActivity('lake-house-weekend', 'activity-1', {
      operationId: 'comment-op', kind: 'comment.added', subject: { kind: 'comment', id: 'comment-1' },
      actor: { id: 'maya-p', displayName: 'Maya P.' }, createdAt: 'not-a-timestamp',
    })).toThrow('ISO timestamp')
    expect(() => decodeActivity('../cross-scope', 'activity-1', {
      operationId: 'comment-op', kind: 'comment.added', subject: { kind: 'comment', id: 'comment-1' },
      actor: { id: 'maya-p', displayName: 'Maya P.' }, expenseId: 'groceries', commentId: 'comment-1', createdAt: '2026-08-31T12:00:00.000Z',
    })).toThrow('groupId')
    expect(() => decodeActivity('lake-house-weekend', 'activity-1', {
      operationId: 'comment-op', kind: 'comment.added', subject: { kind: 'expense', id: 'groceries' },
      actor: { id: 'maya-p', displayName: 'Maya P.' }, expenseId: 'groceries', commentId: 'comment-1', createdAt: '2026-08-31T12:00:00.000Z',
    })).toThrow('comment subject')
    expect(() => decodeActivity('lake-house-weekend', 'activity-1', {
      operationId: 'expense-op', kind: 'expense.updated', subject: { kind: 'expense', id: 'different-expense' },
      actor: { id: 'maya-p', displayName: 'Maya P.' }, expenseId: 'groceries', revision: 2, createdAt: '2026-08-31T12:00:00.000Z',
    })).toThrow('subject ID')
  })

  it('binds notifications to the repository principal and strictly decodes read timestamps', () => {
    const raw = {
      principalId: 'maya-p', groupId: 'lake-house-weekend', activityId: 'activity-1', kind: 'expense.updated',
      subject: { kind: 'expense', id: 'groceries', label: 'Groceries' }, actor: { id: 'alex-r', displayName: 'Alex R.' },
      createdAt: '2026-08-31T12:00:00.000Z', readAt: '2026-08-31T12:01:00.000Z',
    }
    expect(decodeNotification('maya-p', 'notification-1', raw)).toMatchObject({ notificationId: 'notification-1', readAt: raw.readAt })
    expect(decodeNotification('maya-p', 'notification-unread', { ...raw, readAt: null })).not.toHaveProperty('readAt')
    expect(() => decodeNotification('maya-p', 'notification-omitted', { ...raw, readAt: undefined })).toThrow('readAt')
    expect(() => decodeNotification('jordan-k', 'notification-1', raw)).toThrow('principalId')
    expect(() => decodeNotification('maya-p', 'notification-1', { ...raw, readAt: 'now' })).toThrow('ISO timestamp')
  })
})

function rawExpense() {
  return {
    description: 'Groceries', date: '2026-08-30', category: 'Food',
    createdAt: '2026-08-30T10:00:00.000Z', updatedAt: '2026-08-30T10:00:00.000Z', revision: 1,
    createdBy: { id: 'maya-p', displayName: 'Maya P.' }, updatedBy: { id: 'maya-p', displayName: 'Maya P.' },
    total: { currency: 'USD', minorAmount: 1000 },
    payments: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 1000 } }],
    allocations: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 1000 } }],
    splitMethod: { type: 'equal', participantIds: ['maya-p'] }, attachmentRefs: [],
  }
}
