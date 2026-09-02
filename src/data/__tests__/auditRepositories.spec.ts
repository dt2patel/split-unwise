import { describe, expect, it } from 'vitest'
import { CommandConflictError } from '../commandQueue'
import { createDemoRepository, type DemoRepositoryStateStorage } from '../demoRepository'

describe('Task 7 immutable audit repository', () => {
  it('materializes authoritative demo mutations for a completely new repository instance', async () => {
    let saved: unknown
    const storage: DemoRepositoryStateStorage = {
      load: () => saved === undefined ? undefined : structuredClone(saved),
      save: (_scope, document) => { saved = structuredClone(document) },
    }
    const first = createDemoRepository({ stateStorage: storage, now: () => '2026-08-31T19:00:00.000Z' })
    const added = await first.expenses.add({ kind: 'expense.add', operationId: 'reload-add', ...expenseDraft('Reload firewood') })
    if (added.status !== 'saved') throw new Error('Expected demo save')
    const comment = await first.comments.add({
      kind: 'comment.add', operationId: 'reload-comment-add', groupId: added.expense.groupId,
      expenseId: added.expense.id, body: 'Survives repository replacement', attachmentRefs: [],
    })
    if (comment.status !== 'saved') throw new Error('Expected comment save')

    const second = createDemoRepository({ stateStorage: storage, now: () => '2026-08-31T19:05:00.000Z' })
    await expect(second.expenses.getById(added.expense.groupId, added.expense.id)).resolves.toMatchObject({ description: 'Reload firewood', revision: 1 })
    await expect(second.comments.listForExpense(added.expense.groupId, added.expense.id)).resolves.toContainEqual(expect.objectContaining({ commentId: comment.comment.commentId }))
    await expect(second.expenses.edit({
      kind: 'expense.edit', operationId: 'reload-edit', groupId: added.expense.groupId, expenseId: added.expense.id,
      expectedRevision: 1, draft: expenseDraft('Reload firewood edited'),
    })).resolves.toMatchObject({ status: 'saved', expense: { revision: 2 } })
    await expect(second.comments.delete({
      kind: 'comment.delete', operationId: 'reload-comment-delete', groupId: added.expense.groupId,
      expenseId: added.expense.id, commentId: comment.comment.commentId,
    })).resolves.toMatchObject({ status: 'saved', comment: { deletedAt: '2026-08-31T19:05:00.000Z' } })

    const third = createDemoRepository({ stateStorage: storage, now: () => '2026-08-31T19:10:00.000Z' })
    await expect(third.expenses.delete({
      kind: 'expense.delete', operationId: 'reload-delete', groupId: added.expense.groupId,
      expenseId: added.expense.id, expectedRevision: 2,
    })).resolves.toMatchObject({ status: 'saved', tombstone: { revision: 3 } })
    await expect(third.comments.listForExpense(added.expense.groupId, added.expense.id)).resolves.toContainEqual(expect.objectContaining({
      commentId: comment.comment.commentId, deletedAt: '2026-08-31T19:05:00.000Z',
    }))
    await expect(third.expenses.listRevisions(added.expense.groupId, added.expense.id)).resolves.toHaveLength(3)
    await expect(third.activity.listForGroup(added.expense.groupId)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ operationId: 'reload-add' }),
      expect.objectContaining({ operationId: 'reload-edit' }),
      expect.objectContaining({ operationId: 'reload-delete' }),
      expect.objectContaining({ operationId: 'reload-comment-add' }),
      expect.objectContaining({ operationId: 'reload-comment-delete' }),
    ]))
  })

  it('commits one immutable revision and structured activity item for each expense create, edit, and delete', async () => {
    const timestamps = [
      '2026-08-31T14:00:00.000Z',
      '2026-08-31T14:01:00.000Z',
      '2026-08-31T14:02:00.000Z',
    ]
    const repository = createDemoRepository({ now: () => timestamps.shift() ?? '2026-08-31T15:00:00.000Z' })

    const created = await repository.expenses.add({
      kind: 'expense.add', operationId: 'audit-add', ...expenseDraft('Audit firewood'),
    })
    if (created.status !== 'saved') throw new Error('Expected demo save')
    const edited = await repository.expenses.edit({
      kind: 'expense.edit', operationId: 'audit-edit', groupId: created.expense.groupId,
      expenseId: created.expense.id, expectedRevision: 1, draft: expenseDraft('Audit firewood and ice'),
    })
    if (edited.status !== 'saved') throw new Error('Expected demo edit')
    const deleted = await repository.expenses.delete({
      kind: 'expense.delete', operationId: 'audit-delete', groupId: created.expense.groupId,
      expenseId: created.expense.id, expectedRevision: 2,
    })
    if (deleted.status !== 'saved') throw new Error('Expected demo delete')

    const revisions = await repository.expenses.listRevisions(created.expense.groupId, created.expense.id)
    expect(revisions.map(({ revision, action, operationId, createdAt }) => ({ revision, action, operationId, createdAt }))).toEqual([
      { revision: 1, action: 'created', operationId: 'audit-add', createdAt: '2026-08-31T14:00:00.000Z' },
      { revision: 2, action: 'updated', operationId: 'audit-edit', createdAt: '2026-08-31T14:01:00.000Z' },
      { revision: 3, action: 'deleted', operationId: 'audit-delete', createdAt: '2026-08-31T14:02:00.000Z' },
    ])
    expect(revisions[0].expense.description).toBe('Audit firewood')
    expect(revisions[1].expense.description).toBe('Audit firewood and ice')
    expect(revisions[2].expense.deletedAt).toBe('2026-08-31T14:02:00.000Z')

    const events = (await repository.activity.listForGroup(created.expense.groupId))
      .filter((item) => item.expenseId === created.expense.id)
    expect(events.map(({ kind, operationId, revision, createdAt }) => ({ kind, operationId, revision, createdAt }))).toEqual([
      { kind: 'expense.created', operationId: 'audit-add', revision: 1, createdAt: '2026-08-31T14:00:00.000Z' },
      { kind: 'expense.updated', operationId: 'audit-edit', revision: 2, createdAt: '2026-08-31T14:01:00.000Z' },
      { kind: 'expense.deleted', operationId: 'audit-delete', revision: 3, createdAt: '2026-08-31T14:02:00.000Z' },
    ])
    expect(new Set(events.map(({ id }) => id)).size).toBe(3)
  })

  it('has zero audit, comment, notification, or revision side effects when an expense edit conflicts', async () => {
    const repository = createDemoRepository()
    const before = await repository.expenses.getById('lake-house-weekend', 'groceries')
    if (!before) throw new Error('Missing fixture expense')
    const revisionsBefore = await repository.expenses.listRevisions(before.groupId, before.id)
    const activityBefore = await repository.activity.listForGroup(before.groupId)
    const commentsBefore = await repository.comments.listForExpense(before.groupId, before.id)
    const notificationsBefore = await repository.notifications.list({ limit: 100 })

    await expect(repository.expenses.edit({
      kind: 'expense.edit', operationId: 'conflicted-no-audit', groupId: before.groupId,
      expenseId: before.id, expectedRevision: 0, draft: expenseDraft('Stale groceries'),
    })).rejects.toBeInstanceOf(CommandConflictError)

    await expect(repository.expenses.listRevisions(before.groupId, before.id)).resolves.toEqual(revisionsBefore)
    await expect(repository.activity.listForGroup(before.groupId)).resolves.toEqual(activityBefore)
    await expect(repository.comments.listForExpense(before.groupId, before.id)).resolves.toEqual(commentsBefore)
    await expect(repository.notifications.list({ limit: 100 })).resolves.toEqual(notificationsBefore)
  })

  it('captures historical actor names at commit time and does not rewrite older audit entries', async () => {
    const repository = createDemoRepository({ now: () => '2026-08-31T15:00:00.000Z' })
    await repository.app.updateProfile({ kind: 'profile.update', operationId: 'rename-before-edit', displayName: 'Maya Rivera' })
    const expense = await repository.expenses.getById('lake-house-weekend', 'groceries')
    if (!expense) throw new Error('Missing fixture expense')

    await repository.expenses.edit({
      kind: 'expense.edit', operationId: 'actor-snapshot-edit', groupId: expense.groupId,
      expenseId: expense.id, expectedRevision: expense.revision, draft: expenseDraft('Snapshot groceries'),
    })
    await repository.app.updateProfile({ kind: 'profile.update', operationId: 'rename-after-edit', displayName: 'Maya Chen' })

    const revisions = await repository.expenses.listRevisions(expense.groupId, expense.id)
    expect(revisions.map(({ actor }) => actor.displayName)).toEqual(['Maya P.', 'Maya Rivera'])
    const event = (await repository.activity.listForGroup(expense.groupId)).find(({ operationId }) => operationId === 'actor-snapshot-edit')
    expect(event?.actor).toEqual({ id: 'maya-p', displayName: 'Maya Rivera' })
  })

  it('lets any active group member edit or delete while preserving the acting member in the audit trail', async () => {
    const memberRepository = createDemoRepository({ currentUserId: 'jordan-k' })
    const owned = await memberRepository.expenses.getById('lake-house-weekend', 'kayak-rental')
    const other = await memberRepository.expenses.getById('lake-house-weekend', 'groceries')
    if (!owned || !other) throw new Error('Missing fixture expense')

    await expect(memberRepository.expenses.edit({
      kind: 'expense.edit', operationId: 'author-edit', groupId: owned.groupId, expenseId: owned.id,
      expectedRevision: owned.revision, draft: {
        groupId: owned.groupId, description: 'Jordan kayak', date: owned.date, total: owned.total,
        payments: owned.payments, allocations: owned.allocations, category: owned.category,
        splitMethod: owned.splitMethod, attachmentRefs: owned.attachmentRefs,
      },
    })).resolves.toMatchObject({ status: 'saved', expense: { revision: 2 } })
    await expect(memberRepository.expenses.delete({
      kind: 'expense.delete', operationId: 'collaborative-delete', groupId: other.groupId,
      expenseId: other.id, expectedRevision: other.revision,
    })).resolves.toMatchObject({ status: 'saved', tombstone: { revision: 2 } })
    await expect(memberRepository.expenses.getById(other.groupId, other.id)).resolves.toMatchObject({
      revision: 2, createdBy: { id: 'maya-p' }, updatedBy: { id: 'jordan-k' }, deletedAt: expect.any(String),
    })
    await expect(memberRepository.expenses.listRevisions(other.groupId, other.id)).resolves.toEqual([
      expect.objectContaining({ revision: 1, actor: { id: 'maya-p', displayName: 'Maya P.' } }),
      expect.objectContaining({ revision: 2, action: 'deleted', actor: { id: 'jordan-k', displayName: 'Jordan K.' } }),
    ])

    const managerRepository = createDemoRepository()
    await expect(managerRepository.expenses.delete({
      kind: 'expense.delete', operationId: 'manager-delete', groupId: 'lake-house-weekend',
      expenseId: 'dinner', expectedRevision: 1,
    })).resolves.toMatchObject({ status: 'saved' })
  })
})

describe('Task 7 comments repository', () => {
  it('adds a trimmed operation-bound comment and exactly one activity event', async () => {
    const repository = createDemoRepository({ now: () => '2026-08-31T16:00:00.000Z' })

    const result = await repository.comments.add({
      kind: 'comment.add', operationId: 'comment-add-audit', groupId: 'lake-house-weekend',
      expenseId: 'groceries', body: '  Remember the cooler.  ', attachmentRefs: ['local-receipt:comment-photo'],
    })

    expect(result).toMatchObject({
      status: 'saved',
      comment: {
        operationId: 'comment-add-audit', groupId: 'lake-house-weekend', expenseId: 'groceries',
        author: { id: 'maya-p', displayName: 'Maya P.' }, body: 'Remember the cooler.',
        attachmentRefs: ['local-receipt:comment-photo'], createdAt: '2026-08-31T16:00:00.000Z', syncState: 'fresh',
      },
      activity: { kind: 'comment.added', operationId: 'comment-add-audit', commentId: expect.any(String) },
    })
    const comments = await repository.comments.listForExpense('lake-house-weekend', 'groceries')
    expect(comments.filter(({ operationId }) => operationId === 'comment-add-audit')).toHaveLength(1)
    const events = await repository.activity.listForGroup('lake-house-weekend')
    expect(events.filter(({ operationId }) => operationId === 'comment-add-audit')).toHaveLength(1)
  })

  it.each([
    ['blank body', { groupId: 'lake-house-weekend', expenseId: 'groceries', body: '   ' }],
    ['unknown expense', { groupId: 'lake-house-weekend', expenseId: 'missing', body: 'Hello' }],
    ['cross-group context', { groupId: 'another-group', expenseId: 'groceries', body: 'Hello' }],
  ])('rejects %s with zero comment and activity side effects', async (_label, input) => {
    const repository = createDemoRepository()
    const commentsBefore = await repository.comments.listForExpense('lake-house-weekend', 'groceries')
    const activityBefore = await repository.activity.listForGroup('lake-house-weekend')

    await expect(repository.comments.add({
      kind: 'comment.add', operationId: `invalid-${_label.replaceAll(' ', '-')}`,
      ...input, attachmentRefs: [],
    })).rejects.toThrow()

    await expect(repository.comments.listForExpense('lake-house-weekend', 'groceries')).resolves.toEqual(commentsBefore)
    await expect(repository.activity.listForGroup('lake-house-weekend')).resolves.toEqual(activityBefore)
  })

  it('lets only the comment author tombstone a user comment and rejects repeat deletion', async () => {
    const repository = createDemoRepository({ now: () => '2026-08-31T17:00:00.000Z' })
    const added = await repository.comments.add({
      kind: 'comment.add', operationId: 'comment-own-add', groupId: 'lake-house-weekend',
      expenseId: 'groceries', body: 'My note', attachmentRefs: [],
    })
    if (added.status !== 'saved') throw new Error('Expected comment save')

    const removed = await repository.comments.delete({
      kind: 'comment.delete', operationId: 'comment-own-delete', groupId: 'lake-house-weekend',
      expenseId: 'groceries', commentId: added.comment.commentId,
    })
    expect(removed).toMatchObject({
      status: 'saved', comment: { commentId: added.comment.commentId, deletedAt: '2026-08-31T17:00:00.000Z' },
      activity: { kind: 'comment.deleted', operationId: 'comment-own-delete' },
    })
    await expect(repository.comments.delete({
      kind: 'comment.delete', operationId: 'comment-repeat-delete', groupId: 'lake-house-weekend',
      expenseId: 'groceries', commentId: added.comment.commentId,
    })).rejects.toThrow('already deleted')
    await expect(repository.comments.delete({
      kind: 'comment.delete', operationId: 'comment-other-delete', groupId: 'lake-house-weekend',
      expenseId: 'cabin-deposit', commentId: 'comment-cabin-1',
    })).rejects.toThrow('author')
  })

  it('rejects comments on a tombstoned expense while retaining prior comments', async () => {
    const repository = createDemoRepository()
    const before = await repository.comments.listForExpense('lake-house-weekend', 'cabin-deposit')
    await repository.expenses.delete({
      kind: 'expense.delete', operationId: 'delete-comment-target', groupId: 'lake-house-weekend',
      expenseId: 'cabin-deposit', expectedRevision: 1,
    })

    await expect(repository.comments.add({
      kind: 'comment.add', operationId: 'comment-on-tombstone', groupId: 'lake-house-weekend',
      expenseId: 'cabin-deposit', body: 'Too late', attachmentRefs: [],
    })).rejects.toThrow('deleted')
    await expect(repository.comments.listForExpense('lake-house-weekend', 'cabin-deposit')).resolves.toEqual(before)
  })
})

describe('Task 7 account activity and notifications', () => {
  it('returns stable newest-first account activity with cursor paging and non-mutating filters', async () => {
    const repository = createDemoRepository()
    const first = await repository.activity.listForAccount({ filter: 'all', limit: 3 })
    expect(first.items.map(({ id }) => id)).toEqual(['activity-groceries', 'activity-kayak', 'activity-cabin-comment'])
    expect(first.nextCursor).toEqual({ createdAt: '2026-08-28T15:04:00.000Z', id: 'activity-cabin-comment' })

    const second = await repository.activity.listForAccount({ filter: 'all', limit: 3, cursor: first.nextCursor })
    expect(second.items.map(({ id }) => id)).toEqual(['activity-cabin', 'activity-dinner', 'activity-gas'])
    const comments = await repository.activity.listForAccount({ filter: 'comments', limit: 20 })
    expect(comments.items.map(({ kind }) => kind)).toEqual(['comment.added'])
    const allAgain = await repository.activity.listForAccount({ filter: 'all', limit: 20 })
    expect(allAgain.items).toHaveLength(6)
  })

  it('keeps notification read state principal-owned and distinct from activity history', async () => {
    const repository = createDemoRepository({ now: () => '2026-08-31T18:00:00.000Z' })
    const activityBefore = await repository.activity.listForAccount({ filter: 'all', limit: 100 })
    const initial = await repository.notifications.list({ limit: 100 })
    expect(initial.items.every(({ principalId }) => principalId === 'maya-p')).toBe(true)
    expect(await repository.notifications.unreadCount()).toBe(3)

    const one = initial.items[0]
    await repository.notifications.markRead({
      kind: 'notification.read', operationId: 'read-one', notificationId: one.notificationId,
    })
    expect(await repository.notifications.unreadCount()).toBe(2)
    const reread = await repository.notifications.markRead({
      kind: 'notification.read', operationId: 'read-one-again', notificationId: one.notificationId,
    })
    expect(reread).toMatchObject({ status: 'saved', notification: { notificationId: one.notificationId } })
    expect(await repository.notifications.unreadCount()).toBe(2)
    await expect(repository.activity.listForAccount({ filter: 'all', limit: 100 })).resolves.toEqual(activityBefore)
  })

  it('marks notifications through an inclusive deterministic timestamp-and-id cutoff', async () => {
    const repository = createDemoRepository({ now: () => '2026-08-31T18:00:00.000Z' })

    await repository.notifications.markAllRead({
      kind: 'notification.read-all', operationId: 'read-through-b',
      cutoff: { createdAt: '2026-08-30T11:00:00.000Z', id: 'notification-b' },
    })

    const notifications = await repository.notifications.list({ limit: 100 })
    const byId = new Map(notifications.items.map((item) => [item.notificationId, item]))
    expect(byId.get('notification-a')?.readAt).toBe('2026-08-31T18:00:00.000Z')
    expect(byId.get('notification-b')?.readAt).toBe('2026-08-31T18:00:00.000Z')
    expect(byId.get('notification-c')?.readAt).toBeUndefined()
  })

  it('persists notification preferences without deleting activity or existing notifications', async () => {
    const repository = createDemoRepository()
    const activityBefore = await repository.activity.listForAccount({ filter: 'all', limit: 100 })
    const notificationsBefore = await repository.notifications.list({ limit: 100 })

    await expect(repository.notifications.updatePreferences({
      kind: 'notification.preferences', operationId: 'prefs-off',
      preferences: { emailEnabled: false, pushEnabled: false },
    })).resolves.toMatchObject({ status: 'saved', preferences: { emailEnabled: false, pushEnabled: false } })

    await expect(repository.notifications.getPreferences()).resolves.toEqual({ emailEnabled: false, pushEnabled: false })
    await expect(repository.activity.listForAccount({ filter: 'all', limit: 100 })).resolves.toEqual(activityBefore)
    await expect(repository.notifications.list({ limit: 100 })).resolves.toEqual(notificationsBefore)
  })
})

function expenseDraft(description: string) {
  const participantIds = ['maya-p', 'jordan-k', 'alex-r', 'taylor-s'] as const
  return {
    groupId: 'lake-house-weekend', description, date: '2026-08-31', total: { currency: 'USD' as const, minorAmount: 2400 },
    payments: [{ participantId: 'maya-p', money: { currency: 'USD' as const, minorAmount: 2400 } }],
    allocations: participantIds.map((participantId) => ({ participantId, money: { currency: 'USD' as const, minorAmount: 600 } })),
    category: 'Supplies', splitMethod: { type: 'equal' as const, participantIds }, attachmentRefs: [],
  }
}
