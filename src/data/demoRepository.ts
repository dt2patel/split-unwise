import { computeBalances, simplifyDebts } from '../domain/balances'
import { computeAllocations } from '../domain/splits'
import { CommandConflictError } from './commandQueue'
import {
  LAKE_HOUSE_GROUP_ID,
  lakeHouseActivity,
  lakeHouseComments,
  lakeHouseCurrentUser,
  lakeHouseExpenses,
  lakeHouseGroup,
  lakeHouseMembers,
  lakeHouseNotifications,
  lakeHouseRecurring,
} from '../demo/lakeHouse'
import { buildCurrencyTotals, buildGroupCharts } from './aggregates'
import { assertReplayIdentity, createOperationIdentity, type OperationIdentity } from './operationIdentity'
import type {
  ActivityFilter,
  ActivityItem,
  ActorSnapshot,
  AppRepository,
  CommandEnvelope,
  CommandResult,
  ExpenseAddResult,
  ExpenseComment,
  ExpenseDeleteResult,
  ExpenseDraft,
  ExpenseEditResult,
  ExpenseRevision,
  ExpenseRow,
  Member,
  NotificationItem,
  NotificationPreferences,
  TimelineCursor,
} from './repositories'

export interface DemoRepositoryOptions {
  readonly now?: () => string
  readonly currentUserId?: string
}

/** A fresh deterministic in-memory repository; its operation ledger prevents duplicate same-ID effects. */
export function createDemoRepository(options: DemoRepositoryOptions = {}): AppRepository {
  const expenses = lakeHouseExpenses.map(cloneExpense)
  const activity = lakeHouseActivity.map(clone)
  const comments = lakeHouseComments.map(clone)
  const notifications = lakeHouseNotifications.map(clone)
  const revisions = initialRevisions(expenses, activity)
  const operationLedger = new Map<string, { readonly identity: OperationIdentity; readonly result: CommandResult }>()
  const selectedUser = lakeHouseMembers.find(({ id }) => id === (options.currentUserId ?? lakeHouseCurrentUser.id))
  if (!selectedUser) throw new Error(`Unknown demo user: ${options.currentUserId}`)
  let currentUser = { ...selectedUser, isCurrentUser: true }
  let notificationPreferences: NotificationPreferences = { emailEnabled: true, pushEnabled: true }
  let nextExpenseNumber = 6
  const now = options.now ?? (() => '2026-08-30T12:00:00.000Z')

  const groupExpenses = (groupId: string): ExpenseRow[] => {
    assertLakeHouseGroup(groupId)
    return expenses.filter((expense) => expense.groupId === groupId && expense.deletedAt === undefined).sort(byDateThenId)
  }

  const execute = async (command: CommandEnvelope): Promise<CommandResult> => {
    const identity = await createOperationIdentity(currentUser.id, command)
    const existing = operationLedger.get(command.operationId)
    if (existing) {
      await assertReplayIdentity(existing.identity, identity)
      return clone(existing.result)
    }
    const result = executeNew(command)
    operationLedger.set(command.operationId, { identity, result })
    return clone(result)
  }

  const executeNew = (command: CommandEnvelope): CommandResult => {
    switch (command.kind) {
      case 'expense.add': {
        assertLakeHouseGroup(command.groupId)
        assertActiveMembership()
        const allocations = validateDraft(command)
        const createdAt = checkedNow(now)
        const actor = actorSnapshot(currentUser)
        const expense: ExpenseRow = {
          id: `demo-expense-${String(nextExpenseNumber).padStart(3, '0')}`,
          groupId: command.groupId,
          description: command.description,
          date: command.date,
          total: { ...command.total },
          payments: command.payments.map(cloneAllocation),
          allocations: allocations.map(cloneAllocation),
          category: command.category,
          createdAt,
          updatedAt: createdAt,
          revision: 1,
          syncState: 'fresh',
          splitMethod: clone(command.splitMethod),
          attachmentRefs: [...command.attachmentRefs],
          createdBy: actor,
          updatedBy: actor,
          ...(command.notes ? { notes: command.notes } : {}),
          ...(command.recurrence ? { recurrence: clone(command.recurrence) } : {}),
          ...(command.occurrenceEditScope ? { occurrenceEditScope: command.occurrenceEditScope } : {}),
        }
        const event = expenseActivity(command.operationId, expense, 'expense.created', actor, createdAt)
        const revision = expenseRevision(command.operationId, expense, 'created', actor, createdAt)
        nextExpenseNumber += 1
        expenses.push(expense)
        activity.push(event)
        revisions.push(revision)
        return { kind: 'expense.add', operationId: command.operationId, status: 'saved', expense: cloneExpense(expense) }
      }
      case 'expense.edit': {
        const previous = editableExpense(command.groupId, command.expenseId)
        assertExpenseMutationPermission(previous)
        if (command.expectedRevision !== previous.revision) throw new CommandConflictError('The expense changed remotely.', { local: clone(command.draft), remote: cloneExpense(previous) })
        const allocations = validateDraft(command.draft)
        const updatedAt = checkedNow(now)
        const actor = actorSnapshot(currentUser)
        const { notes: _notes, recurrence: _recurrence, occurrenceEditScope: _scope, updatedBy: _updatedBy, ...retained } = previous
        const updated: ExpenseRow = {
          ...retained,
          ...command.draft,
          id: previous.id,
          groupId: previous.groupId,
          createdAt: previous.createdAt,
          createdBy: previous.createdBy,
          updatedBy: actor,
          updatedAt,
          revision: previous.revision + 1,
          syncState: 'fresh',
          total: { ...command.draft.total },
          payments: command.draft.payments.map(cloneAllocation),
          allocations: allocations.map(cloneAllocation),
          splitMethod: clone(command.draft.splitMethod),
          attachmentRefs: [...command.draft.attachmentRefs],
        }
        const event = expenseActivity(command.operationId, updated, 'expense.updated', actor, updatedAt)
        const revision = expenseRevision(command.operationId, updated, 'updated', actor, updatedAt)
        expenses[expenses.indexOf(previous)] = updated
        activity.push(event)
        revisions.push(revision)
        return { kind: command.kind, operationId: command.operationId, status: 'saved', expense: cloneExpense(updated) }
      }
      case 'expense.delete': {
        const previous = findExpense(command.groupId, command.expenseId)
        if (previous.deletedAt) throw new Error(`Demo expense is already deleted: ${command.expenseId}`)
        assertExpenseMutationPermission(previous)
        if (command.expectedRevision !== previous.revision) throw new CommandConflictError('The expense changed remotely.', { local: clone(command), remote: cloneExpense(previous) })
        const deletedAt = checkedNow(now)
        const actor = actorSnapshot(currentUser)
        const retained: ExpenseRow = { ...previous, revision: previous.revision + 1, updatedAt: deletedAt, updatedBy: actor, deletedAt }
        const event = expenseActivity(command.operationId, retained, 'expense.deleted', actor, deletedAt)
        const revision = expenseRevision(command.operationId, retained, 'deleted', actor, deletedAt)
        expenses[expenses.indexOf(previous)] = retained
        activity.push(event)
        revisions.push(revision)
        return { kind: command.kind, operationId: command.operationId, status: 'saved', tombstone: { id: retained.id, groupId: retained.groupId, revision: retained.revision, deletedAt } }
      }
      case 'comment.add': {
        assertLakeHouseGroup(command.groupId)
        assertActiveMembership()
        const target = findExpense(command.groupId, command.expenseId)
        if (target.deletedAt) throw new Error('Cannot comment on a deleted expense')
        const body = command.body.trim()
        if (!body) throw new Error('Comment body is required')
        validateAttachmentRefs(command.attachmentRefs)
        const createdAt = checkedNow(now)
        const actor = actorSnapshot(currentUser)
        const comment: ExpenseComment = {
          commentId: `comment-${command.operationId}`,
          groupId: command.groupId,
          expenseId: command.expenseId,
          operationId: command.operationId,
          author: actor,
          body,
          attachmentRefs: [...command.attachmentRefs],
          createdAt,
          syncState: 'fresh',
        }
        const event = commentActivity(command.operationId, comment, 'comment.added', actor, createdAt)
        comments.push(comment)
        activity.push(event)
        return { kind: command.kind, operationId: command.operationId, status: 'saved', comment: clone(comment), activity: clone(event) }
      }
      case 'comment.delete': {
        assertLakeHouseGroup(command.groupId)
        assertActiveMembership()
        const target = comments.find((comment) => comment.commentId === command.commentId && comment.groupId === command.groupId && comment.expenseId === command.expenseId)
        if (!target) throw new Error('Comment is not available')
        if (target.deletedAt) throw new Error('Comment is already deleted')
        if (target.author.id !== currentUser.id) throw new Error('Only the comment author may delete it')
        const deletedAt = checkedNow(now)
        const actor = actorSnapshot(currentUser)
        const deleted: ExpenseComment = { ...target, deletedAt }
        const event = commentActivity(command.operationId, deleted, 'comment.deleted', actor, deletedAt)
        comments[comments.indexOf(target)] = deleted
        activity.push(event)
        return { kind: command.kind, operationId: command.operationId, status: 'saved', comment: clone(deleted), activity: clone(event) }
      }
      case 'notification.read': {
        const target = notifications.find(({ notificationId, principalId }) => notificationId === command.notificationId && principalId === currentUser.id)
        if (!target) throw new Error('Notification is not available')
        if (target.readAt) return { kind: command.kind, operationId: command.operationId, status: 'saved', notification: clone(target) }
        const read: NotificationItem = { ...target, readAt: checkedNow(now) }
        notifications[notifications.indexOf(target)] = read
        return { kind: command.kind, operationId: command.operationId, status: 'saved', notification: clone(read) }
      }
      case 'notification.read-all': {
        assertCursor(command.cutoff)
        const readAt = checkedNow(now)
        const readNotificationIds: string[] = []
        notifications.forEach((notification, index) => {
          if (notification.principalId !== currentUser.id || notification.readAt || compareTimeline(notification, command.cutoff) > 0) return
          notifications[index] = { ...notification, readAt }
          readNotificationIds.push(notification.notificationId)
        })
        return { kind: command.kind, operationId: command.operationId, status: 'saved', cutoff: clone(command.cutoff), readNotificationIds: readNotificationIds.sort() }
      }
      case 'notification.preferences': {
        if (typeof command.preferences.emailEnabled !== 'boolean' || typeof command.preferences.pushEnabled !== 'boolean') throw new Error('Notification preferences are invalid')
        notificationPreferences = { ...command.preferences }
        return { kind: command.kind, operationId: command.operationId, status: 'saved', preferences: { ...notificationPreferences } }
      }
      case 'settlement.record': {
        assertLakeHouseGroup(command.groupId)
        if (command.confirmation.kind !== 'manual') throw new Error('Only confirmed manual settlements can be recorded')
        return saved(command, `settlement-${command.operationId}`)
      }
      case 'group.default-split':
        assertLakeHouseGroup(command.groupId)
        return saved(command, command.groupId)
      case 'profile.update':
        currentUser = { ...currentUser, displayName: command.displayName, initials: command.initials ?? initials(command.displayName) }
        return saved(command, currentUser.id)
    }
  }

  function assertActiveMembership(): void {
    const member = lakeHouseMembers.find(({ id }) => id === currentUser.id)
    if (!member) throw new Error('You are not an active group member')
  }

  function assertExpenseMutationPermission(expense: ExpenseRow): void {
    assertActiveMembership()
    const member = lakeHouseMembers.find(({ id }) => id === currentUser.id)
    const authorId = expense.createdBy?.id
    if (authorId !== currentUser.id && member?.canManage !== true) throw new Error('You are not allowed to change this expense')
  }

  function findExpense(groupId: string, expenseId: string): ExpenseRow {
    assertLakeHouseGroup(groupId)
    const expense = expenses.find((item) => item.id === expenseId && item.groupId === groupId)
    if (!expense) throw new Error(`Unknown demo expense: ${expenseId}`)
    return expense
  }

  function editableExpense(groupId: string, expenseId: string): ExpenseRow {
    const expense = findExpense(groupId, expenseId)
    if (expense.deletedAt) throw new Error(`Cannot edit deleted demo expense: ${expenseId}`)
    return expense
  }

  return {
    mode: 'demo',
    projectId: 'split-unwise-demo',
    app: { async getCurrentUser(): Promise<Member> { return { ...currentUser } }, updateProfile: execute },
    groups: {
      async list() { return [{ ...lakeHouseGroup, memberIds: [...lakeHouseGroup.memberIds] }] },
      async getById(groupId) { return groupId === LAKE_HOUSE_GROUP_ID ? { ...lakeHouseGroup, memberIds: [...lakeHouseGroup.memberIds] } : undefined },
      async listMembers(groupId) {
        assertLakeHouseGroup(groupId)
        return lakeHouseMembers.map((member) => ({ ...member, isCurrentUser: member.id === currentUser.id, ...(member.id === currentUser.id ? { displayName: currentUser.displayName, initials: currentUser.initials } : {}) }))
      },
      async getBalances(groupId) { return simplifyDebts(computeBalances(groupExpenses(groupId))) },
      async getTotals(groupId) { return buildCurrencyTotals(groupExpenses(groupId), currentUser.id) },
      async getCharts(groupId) { return buildGroupCharts(groupExpenses(groupId)) },
      async listRecurring(groupId) { assertLakeHouseGroup(groupId); return lakeHouseRecurring.map(clone) },
      setDefaultSplit: execute,
    },
    expenses: {
      async listForGroup(groupId) { return groupExpenses(groupId).map(cloneExpense) },
      async getById(groupId, expenseId) {
        assertLakeHouseGroup(groupId)
        const expense = expenses.find((item) => item.groupId === groupId && item.id === expenseId)
        return expense ? cloneExpense(expense) : undefined
      },
      async add(command): Promise<ExpenseAddResult> { const result = await execute(command); if (result.kind !== 'expense.add') throw new Error('Unexpected expense result'); return result },
      async edit(command): Promise<ExpenseEditResult> { const result = await execute(command); if (result.kind !== 'expense.edit') throw new Error('Unexpected expense edit result'); return result },
      async delete(command): Promise<ExpenseDeleteResult> { const result = await execute(command); if (result.kind !== 'expense.delete') throw new Error('Unexpected expense delete result'); return result },
      async listRevisions(groupId, expenseId) {
        assertLakeHouseGroup(groupId)
        return revisions.filter((revision) => revision.groupId === groupId && revision.expenseId === expenseId).sort(oldestRevisionFirst).map(clone)
      },
    },
    comments: {
      async listForExpense(groupId, expenseId) {
        findExpense(groupId, expenseId)
        return comments.filter((comment) => comment.groupId === groupId && comment.expenseId === expenseId).sort(oldestCommentFirst).map(clone)
      },
      async add(command) { const result = await execute(command); if (result.kind !== 'comment.add') throw new Error('Unexpected comment result'); return result },
      async delete(command) { const result = await execute(command); if (result.kind !== 'comment.delete') throw new Error('Unexpected comment delete result'); return result },
    },
    settlements: { record: execute },
    activity: {
      async listForGroup(groupId) { assertLakeHouseGroup(groupId); return activity.filter((item) => item.groupId === groupId).sort(oldestActivityFirst).map(clone) },
      async listForAccount(query) { return page(activity.filter((item) => activityMatches(item, query.filter)), query.limit, query.cursor) },
    },
    notifications: {
      async list(query) { return page(notifications.filter(({ principalId }) => principalId === currentUser.id), query.limit, query.cursor) },
      async unreadCount() { return notifications.filter(({ principalId, readAt }) => principalId === currentUser.id && readAt === undefined).length },
      async markRead(command) { const result = await execute(command); if (result.kind !== 'notification.read') throw new Error('Unexpected notification result'); return result },
      async markAllRead(command) { const result = await execute(command); if (result.kind !== 'notification.read-all') throw new Error('Unexpected notification result'); return result },
      async getPreferences() { return { ...notificationPreferences } },
      async updatePreferences(command) { const result = await execute(command); if (result.kind !== 'notification.preferences') throw new Error('Unexpected notification preferences result'); return result },
    },
    commands: { execute },
  }
}

function saved(command: Extract<CommandEnvelope, { kind: 'group.default-split' | 'profile.update' | 'settlement.record' }>, resourceId: string): CommandResult {
  return { kind: command.kind, operationId: command.operationId, status: 'saved', resourceId } as CommandResult
}

function initialRevisions(expenses: readonly ExpenseRow[], activity: readonly ActivityItem[]): ExpenseRevision[] {
  return expenses.map((expense) => {
    const event = activity.find((item) => item.kind === 'expense.created' && item.expenseId === expense.id)
    const actor = expense.createdBy ?? event?.actor
    if (!actor || !event) throw new Error(`Demo expense ${expense.id} is missing its immutable creation audit`)
    return expenseRevision(event.operationId, expense, 'created', actor, expense.createdAt)
  })
}

function expenseRevision(operationId: string, expense: ExpenseRow, action: ExpenseRevision['action'], actor: ActorSnapshot, createdAt: string): ExpenseRevision {
  return { id: `revision-${expense.id}-${expense.revision}`, groupId: expense.groupId, expenseId: expense.id, revision: expense.revision, operationId, action, actor: clone(actor), createdAt, expense: cloneExpense(expense) }
}

function expenseActivity(operationId: string, expense: ExpenseRow, kind: Extract<ActivityItem['kind'], `expense.${string}`>, actor: ActorSnapshot, createdAt: string): ActivityItem {
  return { id: `activity-${operationId}`, groupId: expense.groupId, operationId, kind, subject: { kind: 'expense', id: expense.id, label: expense.description }, actor: clone(actor), expenseId: expense.id, revision: expense.revision, createdAt, syncState: 'fresh' }
}

function commentActivity(operationId: string, comment: ExpenseComment, kind: 'comment.added' | 'comment.deleted', actor: ActorSnapshot, createdAt: string): ActivityItem {
  return { id: `activity-${operationId}`, groupId: comment.groupId, operationId, kind, subject: { kind: 'comment', id: comment.commentId, label: comment.body }, actor: clone(actor), expenseId: comment.expenseId, commentId: comment.commentId, createdAt, syncState: 'fresh' }
}

function activityMatches(item: ActivityItem, filter: ActivityFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'expenses') return item.kind.startsWith('expense.')
  if (filter === 'comments') return item.kind.startsWith('comment.')
  return item.kind.startsWith('settlement.')
}

function page<T extends { readonly createdAt: string }>(values: readonly T[], limit: number, cursor?: TimelineCursor): { items: readonly T[]; nextCursor?: TimelineCursor } {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Timeline limit must be between 1 and 100')
  if (cursor) assertCursor(cursor)
  const sorted = [...values].sort(newestTimelineFirst)
  const after = cursor ? sorted.filter((item) => compareTimeline(item, cursor) < 0) : sorted
  const items = after.slice(0, limit).map(clone)
  if (items.length < limit || after.length <= limit) return { items }
  const last = items.at(-1) as T & { readonly id?: string; readonly notificationId?: string }
  return { items, nextCursor: { createdAt: last.createdAt, id: timelineId(last) } }
}

function timelineId(value: { readonly id?: string; readonly notificationId?: string }): string {
  const id = value.id ?? value.notificationId
  if (!id) throw new Error('Timeline item ID is required')
  return id
}

function compareTimeline(left: { readonly createdAt: string; readonly id?: string; readonly notificationId?: string }, right: TimelineCursor): number {
  return left.createdAt.localeCompare(right.createdAt) || timelineId(left).localeCompare(right.id)
}

function newestTimelineFirst(left: { readonly createdAt: string; readonly id?: string; readonly notificationId?: string }, right: { readonly createdAt: string; readonly id?: string; readonly notificationId?: string }): number {
  return right.createdAt.localeCompare(left.createdAt) || timelineId(right).localeCompare(timelineId(left))
}

function assertCursor(cursor: TimelineCursor): void {
  checkedIsoTimestamp(cursor.createdAt, 'Timeline cursor timestamp')
  if (!cursor.id.trim()) throw new Error('Timeline cursor ID is required')
}

function checkedNow(now: () => string): string { return checkedIsoTimestamp(now(), 'Commit timestamp') }
function checkedIsoTimestamp(value: string, label: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) throw new Error(`${label} must be a strict ISO timestamp`)
  return value
}
function actorSnapshot(member: Member): ActorSnapshot { return { id: member.id, displayName: member.displayName } }
function validateAttachmentRefs(references: readonly string[]): void { if (references.some((reference) => !reference.trim())) throw new Error('Attachment references must be durable non-empty strings') }
function assertLakeHouseGroup(groupId: string): void { if (groupId !== LAKE_HOUSE_GROUP_ID) throw new Error(`Unknown demo group: ${groupId}`) }
function cloneAllocation(allocation: ExpenseRow['allocations'][number]): ExpenseRow['allocations'][number] { return { participantId: allocation.participantId, money: { ...allocation.money } } }
function cloneExpense(expense: ExpenseRow): ExpenseRow { return clone(expense) }
function byDateThenId(left: ExpenseRow, right: ExpenseRow): number { return left.date.localeCompare(right.date) || left.id.localeCompare(right.id) }
function oldestActivityFirst(left: ActivityItem, right: ActivityItem): number { return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id) }
function oldestCommentFirst(left: ExpenseComment, right: ExpenseComment): number { return left.createdAt.localeCompare(right.createdAt) || left.commentId.localeCompare(right.commentId) }
function oldestRevisionFirst(left: ExpenseRevision, right: ExpenseRevision): number { return left.revision - right.revision || left.id.localeCompare(right.id) }
function initials(displayName: string): string { return displayName.split(/\s+/).filter(Boolean).map((part) => part[0]).join('').slice(0, 2).toUpperCase() }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }

function validateDraft(draft: ExpenseDraft): readonly ExpenseRow['allocations'][number][] {
  const active = new Set(lakeHouseMembers.map(({ id }) => id))
  const assertActive = (participantId: string, label: string) => { if (!active.has(participantId)) throw new Error(`${label} must be an active group member`) }
  assertLakeHouseGroup(draft.groupId)
  const allocations = computeAllocations(draft.total, draft.splitMethod)
  draft.payments.forEach(({ participantId }) => assertActive(participantId, 'Payer'))
  allocations.forEach(({ participantId }) => assertActive(participantId, 'Participant'))
  if (!sameAllocations(allocations, draft.allocations)) throw new Error('Expense allocations do not match split method')
  computeBalances([{ id: 'draft', description: draft.description, date: draft.date, total: draft.total, payments: draft.payments, allocations }])
  return allocations
}

function sameAllocations(left: readonly ExpenseRow['allocations'][number][], right: readonly ExpenseRow['allocations'][number][]): boolean {
  const normalize = (values: readonly ExpenseRow['allocations'][number][]) => [...values]
    .sort((a, b) => a.participantId.localeCompare(b.participantId))
    .map(({ participantId, money }) => `${participantId}\u0000${money.currency}\u0000${money.minorAmount}`)
  const first = normalize(left)
  const second = normalize(right)
  return first.length === second.length && first.every((value, index) => value === second[index])
}
