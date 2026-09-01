import { beforeEach, describe, expect, it, vi } from 'vitest'

const firebase = vi.hoisted(() => ({
  queries: [] as Array<{ base: { path: string }; constraints: readonly Record<string, unknown>[] }>,
  expenseDocuments: [] as Array<{ id: string; data: () => Record<string, unknown> }>,
  recurringDocuments: [] as Array<{ id: string; data: () => Record<string, unknown> }>,
  revisionDocuments: {} as Record<string, { id: string; data: () => Record<string, unknown> }>,
  settlementDocuments: [] as Array<{ id: string; data: () => Record<string, unknown> }>,
  balanceDocument: undefined as { data: () => Record<string, unknown> } | undefined,
  settingsDocument: undefined as { data: () => Record<string, unknown> } | undefined,
  activityDocuments: [] as Array<{ id: string; data: () => Record<string, unknown> }>,
  groupProjectionDocuments: [] as Array<{ id: string; data: () => Record<string, unknown> }>,
  groupDocuments: {} as Record<string, { id: string; data: () => Record<string, unknown> }>,
  groupActivityDocuments: {} as Record<string, Array<{ id: string; data: () => Record<string, unknown> }>>,
  notificationDocuments: [] as Array<{ id: string; data: () => Record<string, unknown> }>,
  profileDocument: undefined as { data: () => Record<string, unknown> } | undefined,
  memberDocument: undefined as { data: () => Record<string, unknown> } | undefined,
  documentReads: [] as string[],
}))

vi.mock('firebase/app', () => ({
  getApps: () => [{ options: { projectId: 'task-7-test' } }],
  initializeApp: () => ({ options: { projectId: 'task-7-test' } }),
}))

vi.mock('firebase/auth', () => ({
  getAuth: () => ({ authStateReady: async () => undefined, currentUser: { uid: 'maya-p' } }),
}))

vi.mock('firebase/firestore', () => {
  const collection = (_db: unknown, ...parts: string[]) => ({ path: parts.join('/') })
  const doc = (_db: unknown, ...parts: string[]) => ({ path: parts.join('/'), id: parts.at(-1) })
  const orderBy = (field: string, direction = 'asc') => ({ type: 'orderBy', field, direction })
  const where = (field: string, operator: string, value: unknown) => ({ type: 'where', field, operator, value })
  const limit = (value: number) => ({ type: 'limit', value })
  const startAfter = (...values: unknown[]) => ({ type: 'startAfter', values })
  const query = (base: { path: string }, ...constraints: readonly Record<string, unknown>[]) => ({ base, constraints })
  const dataFor = (path: string) => path === 'users/maya-p/groups' ? firebase.groupProjectionDocuments
    : path.endsWith('/expenses') ? firebase.expenseDocuments
    : path.endsWith('/recurringTemplates') ? firebase.recurringDocuments
    : path.endsWith('/settlements') ? firebase.settlementDocuments
    : path === 'users/maya-p/activity' ? firebase.activityDocuments
      : path.endsWith('/activity') ? firebase.groupActivityDocuments[path] ?? []
      : path.endsWith('/notifications') ? firebase.notificationDocuments : []
  const getDocs = async (reference: { path?: string; base?: { path: string }; constraints?: readonly Record<string, unknown>[] }) => {
    const base = reference.base ?? { path: reference.path ?? '' }
    const constraints = reference.constraints ?? []
    firebase.queries.push({ base, constraints })
    let docs = [...dataFor(base.path)]
    const unread = constraints.find((candidate) => candidate.type === 'where' && candidate.field === 'readAt')
    if (unread) docs = docs.filter((document) => document.data().readAt === null)
    const filter = constraints.find((candidate) => candidate.type === 'where' && candidate.field === 'kind')
    if (filter && Array.isArray(filter.value)) docs = docs.filter((document) => (filter.value as unknown[]).includes(document.data().kind))
    docs.sort((left, right) => String(right.data().createdAt ?? '').localeCompare(String(left.data().createdAt ?? '')) || (right.id < left.id ? -1 : right.id > left.id ? 1 : 0))
    const cursor = constraints.find((candidate) => candidate.type === 'startAfter')
    if (cursor && Array.isArray(cursor.values)) {
      const [createdAt, id] = cursor.values
      docs = docs.filter((document) => String(document.data().createdAt) < String(createdAt)
        || (document.data().createdAt === createdAt && document.id < String(id)))
    }
    const cap = constraints.find((candidate) => candidate.type === 'limit')?.value
    if ((base.path.endsWith('/activity') || base.path.endsWith('/notifications')) && !unread && typeof cap !== 'number') {
      throw new Error('timeline query fetched without a server limit')
    }
    if (typeof cap === 'number') docs = docs.slice(0, cap)
    return { docs, size: docs.length }
  }
  const snapshotFor = (reference: { path: string; id: string }) => {
    const found = reference.path === 'users/maya-p' ? firebase.profileDocument
      : reference.path.startsWith('groups/') && reference.path.split('/').length === 2 ? firebase.groupDocuments[reference.path]
      : reference.path === 'groups/lake-house-weekend/members/maya-p' ? firebase.memberDocument
      : reference.path.endsWith('/balance/current') ? firebase.balanceDocument
      : reference.path.endsWith('/settings/defaults') ? firebase.settingsDocument
      : reference.path.includes('/recurringTemplates/') ? firebase.recurringDocuments.find(({ id }) => id === reference.id)
      : reference.path.includes('/revisions/') ? firebase.revisionDocuments[reference.path]
      : reference.path.includes('/expenses/') ? firebase.expenseDocuments.find(({ id }) => id === reference.id)
      : reference.path.includes('/settlements/') ? firebase.settlementDocuments.find(({ id }) => id === reference.id)
      : reference.path.includes('/activity/') ? (firebase.groupActivityDocuments[reference.path.split('/').slice(0, 3).join('/')] ?? []).find(({ id }) => id === reference.id)
        : undefined
    return { id: reference.id, exists: () => found !== undefined, data: () => found?.data() }
  }
  const getDoc = async (reference: { path: string; id: string }) => {
    firebase.documentReads.push(reference.path)
    return snapshotFor(reference)
  }
  const setDocument = (reference: { path: string; id: string }, value: Record<string, unknown>) => {
    const saved = documentValue(reference.id, value)
    if (reference.path.includes('/revisions/')) {
      firebase.revisionDocuments[reference.path] = saved
    } else if (reference.path.includes('/recurringTemplates/')) {
      upsert(firebase.recurringDocuments, saved)
    } else if (reference.path.includes('/expenses/')) {
      upsert(firebase.expenseDocuments, saved)
    } else if (reference.path.includes('/activity/')) {
      const collectionPath = reference.path.split('/').slice(0, 3).join('/')
      const documents = firebase.groupActivityDocuments[collectionPath] ??= []
      upsert(documents, saved)
    }
  }
  const runTransaction = async (_db: unknown, callback: (transaction: {
    get(reference: { path: string; id: string }): Promise<ReturnType<typeof snapshotFor>>
    set(reference: { path: string; id: string }, value: Record<string, unknown>): void
  }) => Promise<unknown>) => callback({
    get: async (reference) => snapshotFor(reference),
    set: setDocument,
  })
  return {
    collection, doc, documentId: () => '__name__', getDoc, getDocs, getFirestore: () => ({}), limit, orderBy, query, runTransaction,
    serverTimestamp: () => '2026-09-01T12:00:00.000Z', startAfter, where,
  }

  function documentValue(id: string, value: Record<string, unknown>) {
    return { id, data: () => structuredClone(value) }
  }
  function upsert(documents: Array<{ id: string; data: () => Record<string, unknown> }>, saved: { id: string; data: () => Record<string, unknown> }) {
    const index = documents.findIndex(({ id }) => id === saved.id)
    if (index === -1) documents.push(saved)
    else documents[index] = saved
  }
})

import { createFirebaseRepository } from '../firebaseRepository'
import { OperationReplayConflictError } from '../operationIdentity'

const configuration = {
  apiKey: 'test', authDomain: 'task-7-test.invalid', projectId: 'task-7-test', storageBucket: 'task-7-test.invalid', messagingSenderId: '1', appId: 'test-app',
}

describe('Task 7 Firebase repository query boundaries', () => {
  beforeEach(() => {
    firebase.queries.length = 0
    firebase.expenseDocuments = [document('live-expense', expenseData()), document('deleted-expense', { ...expenseData(), deletedAt: '2026-08-31T12:00:00.000Z' })]
    firebase.recurringDocuments = []
    firebase.revisionDocuments = {}
    firebase.settlementDocuments = [document('settlement-a', settlementData())]
    firebase.balanceDocument = document('current', balanceData())
    firebase.settingsDocument = document('defaults', { schemaVersion: 1, groupId: 'lake-house-weekend', revision: 3 })
    firebase.activityDocuments = [
      document('activity_a', activityData('expense.updated', '2026-08-31T12:00:00.000Z', 'expense-a')),
      document('activity.Z', activityData('expense.created', '2026-08-31T12:00:00.000Z', 'expense-z')),
      document('activity-B', activityData('settlement.created', '2026-08-30T12:00:00.000Z', undefined, undefined, 'settlement-a')),
    ]
    firebase.groupProjectionDocuments = [
      document('lake-house-weekend', { groupId: 'lake-house-weekend', status: 'active' }),
      document('road-trip', { groupId: 'road-trip', status: 'active', contextLabel: 'Jordan Lee' }),
    ]
    firebase.groupDocuments = {
      'groups/lake-house-weekend': document('lake-house-weekend', groupData('lake-house-weekend', 'Lake House Weekend')),
      'groups/road-trip': document('road-trip', { ...groupData('road-trip', 'Friendship storage name'), kind: 'friendship', memberIds: ['maya-p', 'jordan-p'] }),
    }
    firebase.groupActivityDocuments = {
      'groups/lake-house-weekend/activity': [
        document('activity_a', activityData('expense.updated', '2026-08-31T12:00:00.000Z', 'expense-a')),
        document('activity-B', activityData('settlement.created', '2026-08-30T12:00:00.000Z', undefined, undefined, 'settlement-a')),
      ],
      'groups/road-trip/activity': [
        document('activity.Z', { ...activityData('expense.created', '2026-08-31T12:00:00.000Z', 'expense-z'), groupId: 'road-trip' }),
      ],
    }
    firebase.notificationDocuments = [
      document('notification_a', notificationData(null, '2026-08-31T12:00:00.000Z')),
      document('notification.Z', notificationData('2026-08-31T13:00:00.000Z', '2026-08-31T12:00:00.000Z')),
      document('notification-B', notificationData(null, '2026-08-30T12:00:00.000Z')),
    ]
    firebase.profileDocument = document('maya-p', { displayName: 'Maya P.', initials: 'MP' })
    firebase.memberDocument = document('maya-p', { status: 'active', displayName: 'Maya P.', canManage: true })
    firebase.documentReads.length = 0
  })

  it('rejects an explicit Firebase app from a different client context before binding the repository', async () => {
    const app = {
      name: 'proof-other-project', automaticDataCollectionEnabled: false,
      options: { ...configuration, projectId: 'other-project' },
    }
    const repository = createFirebaseRepository(configuration, 'maya-p', undefined, app)

    await expect(repository.app.getCurrentUser()).rejects.toThrow('projectId')
  })

  it('memoizes the authenticated profile across feature reads', async () => {
    const repository = createFirebaseRepository(configuration)

    const [first, second] = await Promise.all([repository.app.getCurrentUser(), repository.app.getCurrentUser()])
    await expect(repository.app.getCurrentUser()).resolves.toEqual(first)

    expect(second).toEqual(first)
    expect(firebase.documentReads.filter((path) => path === 'users/maya-p')).toHaveLength(1)
  })

  it('reuses group documents loaded for the overview when a group is opened', async () => {
    const repository = createFirebaseRepository(configuration)

    await expect(repository.groups.list()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'road-trip', kind: 'friendship', name: 'Jordan Lee' }),
    ]))
    const readsAfterOverview = firebase.documentReads.filter((path) => path === 'groups/lake-house-weekend').length
    await expect(repository.groups.getById('lake-house-weekend')).resolves.toMatchObject({ id: 'lake-house-weekend' })

    expect(firebase.documentReads.filter((path) => path === 'groups/lake-house-weekend')).toHaveLength(readsAfterOverview)
  })

  it('excludes expense tombstones from live journals and aggregates while retaining direct audit lookup', async () => {
    const repository = createFirebaseRepository(configuration)

    await expect(repository.expenses.listForGroup('lake-house-weekend')).resolves.toHaveLength(1)
    await expect(repository.groups.getTotals('lake-house-weekend')).resolves.toHaveLength(1)
    await expect(repository.expenses.getById('lake-house-weekend', 'deleted-expense')).resolves.toMatchObject({ deletedAt: '2026-08-31T12:00:00.000Z' })
  })

  it('uses an audited current expense projection without fetching its revision document', async () => {
    firebase.expenseDocuments = [document('edited-expense', {
      ...expenseData(),
      headRevision: 2,
      headDeleted: false,
      lastResourceToken: 'd'.repeat(48),
      current: { ...expenseData(), description: 'Updated groceries', revision: 2 },
    })]
    const repository = createFirebaseRepository(configuration)

    await expect(repository.expenses.listForGroup('lake-house-weekend')).resolves.toEqual([
      expect.objectContaining({ id: 'edited-expense', description: 'Updated groceries', revision: 2 }),
    ])

    expect(firebase.documentReads.filter((path) => path.includes('/revisions/'))).toHaveLength(0)
  })

  it('synthesizes recurring occurrence creation history with the immutable materializer actor', async () => {
    const occurrenceId = 'occ_monthly-rent_2026-09-30'
    const creator = { id: 'series-creator', displayName: 'Series Creator' }
    const materializer = { id: 'series-manager', displayName: 'Series Manager' }
    firebase.expenseDocuments = [document(occurrenceId, {
      ...expenseData(), operationId: 'materialize-rent', resourceToken: 'c'.repeat(48), recurringTemplateId: 'monthly-rent',
      recurrence: { frequency: 'monthly', anchor: { month: 8, day: 30 }, timeZone: 'UTC' }, createdBy: creator, updatedBy: materializer,
    })]
    const repository = createFirebaseRepository(configuration)

    await expect(repository.expenses.listRevisions('lake-house-weekend', occurrenceId)).resolves.toMatchObject([{
      action: 'created', operationId: 'materialize-rent', actor: materializer,
      expense: { createdBy: creator, updatedBy: materializer },
    }])
  })

  it('uses server filters, stable document ordering, limit-plus-one, and cursor continuation for activity', async () => {
    const repository = createFirebaseRepository(configuration, undefined, 'us-central1')
    const first = await repository.activity.listForAccount({ filter: 'expenses', limit: 1 })
    expect(first.items.map(({ id }) => id)).toEqual(['activity_a'])
    const query = firebase.queries.at(-1)?.constraints ?? []
    expect(query).toEqual(expect.arrayContaining([
      { type: 'where', field: 'kind', operator: 'in', value: ['expense.created', 'expense.updated', 'expense.deleted'] },
      { type: 'orderBy', field: 'createdAt', direction: 'desc' },
      { type: 'orderBy', field: '__name__', direction: 'desc' },
      { type: 'limit', value: 2 },
    ]))
    if (!first.nextCursor) throw new Error('Expected activity continuation')
    await repository.activity.listForAccount({ filter: 'expenses', limit: 1, cursor: first.nextCursor })
    expect(firebase.queries.at(-1)?.constraints).toContainEqual({
      type: 'startAfter', values: [first.nextCursor.createdAt, first.nextCursor.id],
    })
  })

  it('fans account activity out across active Spark groups with stable filtering and pagination', async () => {
    const repository = createFirebaseRepository(configuration)
    const first = await repository.activity.listForAccount({ filter: 'expenses', limit: 1 })
    expect(first.items.map(({ id, groupId }) => `${groupId}:${id}`)).toEqual(['lake-house-weekend:activity_a'])
    expect(first.nextCursor).toEqual({ createdAt: '2026-08-31T12:00:00.000Z', id: 'activity_a' })
    expect(firebase.queries).toContainEqual({ base: { path: 'users/maya-p/groups' }, constraints: [{ type: 'limit', value: 100 }] })
    expect(firebase.queries).toEqual(expect.arrayContaining([
      expect.objectContaining({ base: { path: 'groups/lake-house-weekend/activity' } }),
      expect.objectContaining({ base: { path: 'groups/road-trip/activity' } }),
    ]))
    if (!first.nextCursor) throw new Error('Expected Spark activity continuation')
    const second = await repository.activity.listForAccount({ filter: 'expenses', limit: 1, cursor: first.nextCursor })
    expect(second.items.map(({ id, groupId }) => `${groupId}:${id}`)).toEqual(['road-trip:activity.Z'])
  })

  it('uses server ordering, limit-plus-one, and cursor continuation for notifications', async () => {
    const repository = createFirebaseRepository(configuration, undefined, 'us-central1')
    const first = await repository.notifications.list({ limit: 1 })
    expect(first.items).toHaveLength(1)
    expect(firebase.queries.at(-1)?.constraints).toEqual(expect.arrayContaining([
      { type: 'orderBy', field: 'createdAt', direction: 'desc' },
      { type: 'orderBy', field: '__name__', direction: 'desc' },
      { type: 'limit', value: 2 },
    ]))
    if (!first.nextCursor) throw new Error('Expected notification continuation')
    await repository.notifications.list({ limit: 1, cursor: first.nextCursor })
    expect(firebase.queries.at(-1)?.constraints).toContainEqual({
      type: 'startAfter', values: [first.nextCursor.createdAt, first.nextCursor.id],
    })
  })

  it('uses explicit null for unread documents so listing and authoritative count agree', async () => {
    const repository = createFirebaseRepository(configuration, undefined, 'us-central1')
    const listed = await repository.notifications.list({ limit: 10 })
    expect(listed.items.filter(({ readAt }) => readAt === undefined)).toHaveLength(2)
    await expect(repository.notifications.unreadCount()).resolves.toBe(2)
  })

  it('reads the server-maintained balance snapshot and immutable settlements without client recomputation', async () => {
    const repository = createFirebaseRepository(configuration, undefined, 'us-central1')

    await expect(repository.groups.getBalanceSnapshot('lake-house-weekend')).resolves.toEqual(balanceData())
    await expect(repository.settlements.listForGroup('lake-house-weekend')).resolves.toEqual([
      expect.objectContaining({ settlementId: 'settlement-a', operationId: 'record-a', revision: 1 }),
    ])
    await expect(repository.settlements.getById('lake-house-weekend', 'settlement-a')).resolves.toMatchObject({
      settlementId: 'settlement-a', groupId: 'lake-house-weekend', basis: { kind: 'simplified' },
    })
    expect(firebase.queries).toContainEqual({
      base: { path: 'groups/lake-house-weekend/settlements' },
      constraints: [
        { type: 'orderBy', field: 'occurredOn', direction: 'asc' },
        { type: 'orderBy', field: '__name__', direction: 'asc' },
        { type: 'limit', value: 100 },
      ],
    })
  })

  it('defaults legacy group settings to simplified debts and strictly decodes an explicit toggle', async () => {
    const repository = createFirebaseRepository(configuration)

    await expect(repository.groups.getSettings('lake-house-weekend')).resolves.toEqual({
      schemaVersion: 1, groupId: 'lake-house-weekend', revision: 3, simplifyDebtsEnabled: true,
    })
    firebase.settingsDocument = document('defaults', {
      schemaVersion: 1, groupId: 'lake-house-weekend', revision: 4, simplifyDebtsEnabled: false,
      defaultSplit: { type: 'equal', participantIds: ['maya-p'] },
    })
    await expect(repository.groups.getSettings('lake-house-weekend')).resolves.toMatchObject({
      revision: 4, simplifyDebtsEnabled: false, defaultSplit: { type: 'equal', participantIds: ['maya-p'] },
    })
    firebase.settingsDocument = document('defaults', { schemaVersion: 1, groupId: 'lake-house-weekend', revision: 5, simplifyDebtsEnabled: 'false' })
    await expect(repository.groups.getSettings('lake-house-weekend')).rejects.toThrow('invalid')
  })

  it('semantically replays a materialized occurrence after its editable date changes', async () => {
    const templateId = 'recurring-rent'
    firebase.expenseDocuments = []
    firebase.recurringDocuments = [document(templateId, recurringData({ id: templateId }))]
    firebase.groupActivityDocuments['groups/lake-house-weekend/activity'] = []
    const repository = createFirebaseRepository(configuration)
    const materialize = {
      kind: 'recurrence.materialize' as const, operationId: 'materialize-rent-september', groupId: 'lake-house-weekend',
      templateId, occurrenceDate: '2026-09-30',
    }

    const first = await repository.commands.execute(materialize)
    if (first.kind !== 'recurrence.materialize' || first.status !== 'saved') throw new Error('Expected materialized occurrence')
    await repository.expenses.edit({
      kind: 'expense.edit', operationId: 'edit-rent-occurrence-date', groupId: 'lake-house-weekend', expenseId: first.occurrence.id, expectedRevision: 1,
      draft: {
        groupId: 'lake-house-weekend', description: 'Rent moved one day', date: '2026-10-02', total: { currency: 'USD', minorAmount: 1000 },
        payments: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 1000 } }],
        allocations: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 1000 } }], category: 'Housing',
        splitMethod: { type: 'equal', participantIds: ['maya-p'] }, attachmentRefs: [], occurrenceEditScope: 'occurrence',
      },
    })

    await expect(repository.commands.execute(materialize)).resolves.toMatchObject({
      status: 'saved', template: { nextDate: '2026-10-30', revision: 2 },
      occurrence: { id: `occ_${templateId}_2026-09-30`, date: '2026-10-02', revision: 2 },
    })
    expect(firebase.expenseDocuments.filter(({ id }) => id === `occ_${templateId}_2026-09-30`)).toHaveLength(1)
    expect(firebase.groupActivityDocuments['groups/lake-house-weekend/activity']?.filter(({ data }) => {
      const value = data()
      return value.kind === 'expense.created' && value.expenseId === `occ_${templateId}_2026-09-30`
    })).toHaveLength(1)

    firebase.groupActivityDocuments['groups/lake-house-weekend/activity'] = []
    await expect(repository.commands.execute(materialize)).rejects.toBeInstanceOf(OperationReplayConflictError)
    await expect(repository.groups.getTotals('lake-house-weekend')).resolves.toEqual([
      { currency: 'USD', totalPaid: 1000, currentUserPaid: 1000, currentUserShare: 1000, currentUserNet: 0 },
    ])
  })

  it('loads recurring templates once while materializing globally earliest due occurrences', async () => {
    firebase.expenseDocuments = []
    firebase.recurringDocuments = [
      document('recurring-later', recurringData({ id: 'recurring-later', anchorDate: '2026-09-01', nextDate: '2026-10-01', anchor: { month: 9, day: 1 } })),
      document('recurring-earlier', recurringData({ id: 'recurring-earlier', anchorDate: '2026-08-15', nextDate: '2026-09-15', anchor: { month: 8, day: 15 } })),
    ]
    firebase.groupActivityDocuments['groups/lake-house-weekend/activity'] = []
    const repository = createFirebaseRepository(configuration)

    await expect(repository.groups.materializeDue('lake-house-weekend', '2026-10-01', 2)).resolves.toEqual({
      occurrences: [
        expect.objectContaining({ id: 'occ_recurring-earlier_2026-09-15' }),
        expect.objectContaining({ id: 'occ_recurring-later_2026-10-01' }),
      ],
      moreRemain: false,
    })
    expect(firebase.queries.filter(({ base }) => base.path === 'groups/lake-house-weekend/recurringTemplates')).toHaveLength(1)
  })

  it('skips due templates an ordinary member did not create', async () => {
    firebase.memberDocument = document('maya-p', { status: 'active', displayName: 'Maya P.', canManage: false })
    firebase.expenseDocuments = []
    firebase.recurringDocuments = [
      document('recurring-other', recurringData({ id: 'recurring-other', createdBy: { id: 'other', displayName: 'Other Creator' } })),
      document('recurring-own', recurringData({ id: 'recurring-own' })),
    ]
    firebase.groupActivityDocuments['groups/lake-house-weekend/activity'] = []
    const repository = createFirebaseRepository(configuration)

    await expect(repository.groups.materializeDue('lake-house-weekend', '2026-09-30', 24)).resolves.toEqual({
      occurrences: [expect.objectContaining({ id: 'occ_recurring-own_2026-09-30', createdBy: { id: 'maya-p', displayName: 'Maya P.' } })],
      moreRemain: false,
    })
    expect(firebase.expenseDocuments.some(({ id }) => id === 'occ_recurring-other_2026-09-30')).toBe(false)
  })

  it('rejects an unauthorized semantic replay after another principal materialized the occurrence', async () => {
    firebase.memberDocument = document('maya-p', { status: 'active', displayName: 'Maya P.', canManage: false })
    const templateId = 'recurring-other'
    const occurrenceId = `occ_${templateId}_2026-09-30`
    firebase.recurringDocuments = [document(templateId, recurringData({
      id: templateId,
      nextDate: '2026-10-30',
      createdBy: { id: 'other', displayName: 'Other Creator' },
      revision: 2,
      lastOccurrenceId: occurrenceId,
      lastOccurrenceDate: '2026-09-30',
    }))]
    firebase.expenseDocuments = [document(occurrenceId, {
      ...expenseData(), id: occurrenceId, groupId: 'lake-house-weekend', date: '2026-09-30',
      recurringTemplateId: templateId, recurrence: { frequency: 'monthly', anchor: { month: 8, day: 30 }, timeZone: 'UTC' },
      operationId: 'materialize-other', requestFingerprint: 'a'.repeat(64), resourceToken: 'b'.repeat(48),
      lastOperationId: 'materialize-other', lastRequestFingerprint: 'a'.repeat(64), lastResourceToken: 'b'.repeat(48),
      createdBy: { id: 'other', displayName: 'Other Creator' }, updatedBy: { id: 'manager', displayName: 'Series Manager' },
    })]
    firebase.groupActivityDocuments['groups/lake-house-weekend/activity'] = [document(`activity-${'b'.repeat(48)}`, {
      groupId: 'lake-house-weekend', operationId: 'materialize-other', kind: 'expense.created',
      subject: { kind: 'expense', id: occurrenceId, label: 'Groceries' }, actor: { id: 'manager', displayName: 'Series Manager' },
      expenseId: occurrenceId, resourceToken: 'b'.repeat(48), revision: 1, createdAt: '2026-08-30T10:00:00.000Z',
    })]
    const repository = createFirebaseRepository(configuration)

    await expect(repository.commands.execute({
      kind: 'recurrence.materialize', operationId: 'unauthorized-replay', groupId: 'lake-house-weekend', templateId, occurrenceDate: '2026-09-30',
    })).rejects.toThrow(/series creator|manager/i)
  })
})

function document(id: string, value: Record<string, unknown>) { return { id, data: () => structuredClone(value) } }

function expenseData() {
  return {
    description: 'Groceries', date: '2026-08-30', category: 'Food', createdAt: '2026-08-30T10:00:00.000Z', updatedAt: '2026-08-30T10:00:00.000Z', revision: 1,
    createdBy: { id: 'maya-p', displayName: 'Maya P.' }, updatedBy: { id: 'maya-p', displayName: 'Maya P.' },
    total: { currency: 'USD', minorAmount: 1000 }, payments: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 1000 } }],
    allocations: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 1000 } }], splitMethod: { type: 'equal', participantIds: ['maya-p'] }, attachmentRefs: [],
  }
}

function groupData(id: string, name: string) {
  return { id, name, currency: 'USD', memberIds: ['maya-p'], createdByUid: 'maya-p' }
}

function activityData(kind: string, createdAt: string, expenseId?: string, commentId?: string, settlementId?: string) {
  const subjectKind = kind.startsWith('expense.') ? 'expense' : kind.startsWith('comment.') ? 'comment' : 'settlement'
  const subjectId = expenseId && subjectKind === 'expense' ? expenseId : commentId ?? settlementId ?? 'subject-a'
  return {
    groupId: 'lake-house-weekend', operationId: `operation-${subjectId}`, kind, subject: { kind: subjectKind, id: subjectId },
    actor: { id: 'maya-p', displayName: 'Maya P.' }, createdAt,
    ...(expenseId ? { expenseId } : {}), ...(commentId ? { commentId } : {}), ...(settlementId ? { settlementId } : {}),
    ...(kind.startsWith('expense.') ? { revision: kind === 'expense.created' ? 1 : 2 } : {}),
  }
}

function notificationData(readAt: string | null, createdAt: string) {
  return {
    principalId: 'maya-p', groupId: 'lake-house-weekend', activityId: 'activity-a', kind: 'expense.updated',
    subject: { kind: 'expense', id: 'expense-a' }, actor: { id: 'maya-p', displayName: 'Maya P.' }, createdAt, readAt,
  }
}

function balanceData() {
  return {
    groupId: 'lake-house-weekend', balanceRevision: 9, simplifyDebtsEnabled: true,
    pairwise: [{ fromParticipantId: 'taylor-s', toParticipantId: 'maya-p', money: { currency: 'USD', minorAmount: 3825 } }],
    simplified: [{ fromParticipantId: 'taylor-s', toParticipantId: 'maya-p', money: { currency: 'USD', minorAmount: 3625 } }],
  }
}

function settlementData() {
  return {
    groupId: 'lake-house-weekend', operationId: 'record-a', senderId: 'taylor-s', recipientId: 'maya-p',
    money: { currency: 'USD', minorAmount: 500 }, basis: { kind: 'simplified', senderId: 'taylor-s', recipientId: 'maya-p', currency: 'USD', debtMinor: 3625 },
    method: 'cash', occurredOn: '2026-08-31', note: 'Paid', createdBy: { id: 'maya-p', displayName: 'Maya P.' },
    createdAt: '2026-08-31T20:00:00.000Z', revision: 1,
  }
}

function recurringData(input: {
  id: string
  anchorDate?: string
  nextDate?: string
  anchor?: { readonly month: number; readonly day: number }
  createdBy?: { readonly id: string; readonly displayName: string }
  revision?: number
  lastOccurrenceId?: string
  lastOccurrenceDate?: string
}) {
  return {
    id: input.id, groupId: 'lake-house-weekend', sourceExpenseId: 'source-rent', status: 'active', description: 'Rent',
    total: { currency: 'USD', minorAmount: 1000 }, payments: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 1000 } }],
    allocations: [{ participantId: 'maya-p', money: { currency: 'USD', minorAmount: 1000 } }], category: 'Housing',
    splitMethod: { type: 'equal', participantIds: ['maya-p'] },
    recurrence: { frequency: 'monthly', anchor: input.anchor ?? { month: 8, day: 30 }, timeZone: 'UTC' },
    anchorDate: input.anchorDate ?? '2026-08-30', nextDate: input.nextDate ?? '2026-09-30', revision: input.revision ?? 1,
    createdBy: input.createdBy ?? { id: 'maya-p', displayName: 'Maya P.' },
    ...(input.lastOccurrenceId ? { lastOccurrenceId: input.lastOccurrenceId } : {}),
    ...(input.lastOccurrenceDate ? { lastOccurrenceDate: input.lastOccurrenceDate } : {}),
  }
}
