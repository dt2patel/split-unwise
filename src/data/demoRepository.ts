import { computeBalancePlans, computeBalances } from '../domain/balances'
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
import { decodeActivity, decodeBalanceSnapshot, decodeSettlement } from './firebaseDecoders'
import { assertReplayIdentity, createOperationIdentity, type OperationIdentity } from './operationIdentity'
import { compareFirestoreStrings, compareTimelineAscending, compareTimelineDescending, isAfterDescendingCursor } from './timeline'
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
  GroupBalanceSnapshot,
  Member,
  NotificationItem,
  NotificationPreferences,
  SettlementRecord,
  SettlementRecordResult,
  SettlementVoidResult,
  TimelineCursor,
} from './repositories'

export interface DemoRepositoryOptions {
  readonly now?: () => string
  readonly currentUserId?: string
  readonly stateStorage?: DemoRepositoryStateStorage
}

export interface DemoRepositoryStateStorage {
  load(scope: string): unknown
  save(scope: string, document: unknown): void | Promise<void>
  quarantine?(scope: string, records: readonly unknown[]): void
}

interface DemoRepositoryStateDocument {
  readonly version: 2
  readonly principalId: string
  readonly currentUser: Member
  readonly notificationPreferences: NotificationPreferences
  readonly nextExpenseNumber: number
  readonly balanceRevision: number
  readonly expenses: readonly ExpenseRow[]
  readonly settlements: readonly SettlementRecord[]
  readonly activity: readonly ActivityItem[]
  readonly comments: readonly ExpenseComment[]
  readonly notifications: readonly NotificationItem[]
  readonly revisions: readonly ExpenseRevision[]
  readonly operationLedger: readonly (readonly [string, { readonly identity: OperationIdentity; readonly result: CommandResult }])[]
}

/** A fresh deterministic in-memory repository; its operation ledger prevents duplicate same-ID effects. */
export function createDemoRepository(options: DemoRepositoryOptions = {}): AppRepository {
  const selectedUser = lakeHouseMembers.find(({ id }) => id === (options.currentUserId ?? lakeHouseCurrentUser.id))
  if (!selectedUser) throw new Error(`Unknown demo user: ${options.currentUserId}`)
  const stateScope = `split-unwise-demo:v2:${selectedUser.id}`
  const storedState = options.stateStorage?.load(stateScope)
  let restored: DemoRepositoryStateDocument | undefined
  try {
    restored = decodeDemoState(storedState, selectedUser.id)
  } catch {
    if (storedState !== undefined && storedState !== null) options.stateStorage?.quarantine?.(stateScope, [storedState])
  }
  const expenses = (restored?.expenses ?? lakeHouseExpenses).map(cloneExpense)
  const settlements = (restored?.settlements ?? []).map(clone)
  const activity = (restored?.activity ?? lakeHouseActivity).map(clone)
  const comments = (restored?.comments ?? lakeHouseComments).map(clone)
  const notifications = (restored?.notifications ?? lakeHouseNotifications).map(clone)
  const revisions = (restored?.revisions ?? initialRevisions(expenses, activity)).map(clone)
  const operationLedger = new Map<string, { readonly identity: OperationIdentity; readonly result: CommandResult }>((restored?.operationLedger ?? []).map(([id, value]) => [id, clone(value)]))
  let currentUser = restored?.currentUser ? clone(restored.currentUser) : { ...selectedUser, isCurrentUser: true }
  let notificationPreferences: NotificationPreferences = restored?.notificationPreferences ? { ...restored.notificationPreferences } : { emailEnabled: true, pushEnabled: true }
  let nextExpenseNumber = restored?.nextExpenseNumber ?? 6
  let balanceRevision = restored?.balanceRevision ?? lakeHouseExpenses.length
  let executionTail: Promise<void> = Promise.resolve()
  const now = options.now ?? (() => '2026-08-30T12:00:00.000Z')

  const groupExpenses = (groupId: string): ExpenseRow[] => {
    assertLakeHouseGroup(groupId)
    return expenses.filter((expense) => expense.groupId === groupId && expense.deletedAt === undefined).sort(byDateThenId)
  }

  const groupBalanceSnapshot = (groupId: string): GroupBalanceSnapshot => {
    const plans = computeBalancePlans(
      groupExpenses(groupId),
      settlements
        .filter((settlement) => settlement.groupId === groupId)
        .map((settlement) => ({
          id: settlement.settlementId,
          senderId: settlement.senderId,
          recipientId: settlement.recipientId,
          money: { ...settlement.money },
          ...(settlement.void ? { voided: true } : {}),
        })),
    )
    return {
      groupId,
      balanceRevision,
      simplifyDebtsEnabled: true,
      pairwise: plans.pairwise.map(clone),
      simplified: plans.simplified.map(clone),
    }
  }

  const execute = (command: CommandEnvelope): Promise<CommandResult> => {
    const result = executionTail.then(() => executeSerialized(command))
    executionTail = result.then(() => undefined, () => undefined)
    return result
  }

  const executeSerialized = async (command: CommandEnvelope): Promise<CommandResult> => {
    const identity = await createOperationIdentity(currentUser.id, command)
    const existing = operationLedger.get(command.operationId)
    if (existing) {
      await assertReplayIdentity(existing.identity, identity)
      return clone(existing.result)
    }
    const before = captureState()
    try {
      const result = executeNew(command)
      operationLedger.set(command.operationId, { identity, result })
      await options.stateStorage?.save(stateScope, captureState())
      return clone(result)
    } catch (error: unknown) {
      restoreState(before)
      throw error
    }
  }

  const captureState = (): DemoRepositoryStateDocument => ({
    version: 2,
    principalId: currentUser.id,
    currentUser: clone(currentUser),
    notificationPreferences: { ...notificationPreferences },
    nextExpenseNumber,
    balanceRevision,
    expenses: expenses.map(cloneExpense),
    settlements: settlements.map(clone),
    activity: activity.map(clone),
    comments: comments.map(clone),
    notifications: notifications.map(clone),
    revisions: revisions.map(clone),
    operationLedger: [...operationLedger.entries()].map(([id, value]) => [id, clone(value)] as const),
  })

  const restoreState = (state: DemoRepositoryStateDocument): void => {
    currentUser = clone(state.currentUser)
    notificationPreferences = { ...state.notificationPreferences }
    nextExpenseNumber = state.nextExpenseNumber
    balanceRevision = state.balanceRevision
    expenses.splice(0, expenses.length, ...state.expenses.map(cloneExpense))
    settlements.splice(0, settlements.length, ...state.settlements.map(clone))
    activity.splice(0, activity.length, ...state.activity.map(clone))
    comments.splice(0, comments.length, ...state.comments.map(clone))
    notifications.splice(0, notifications.length, ...state.notifications.map(clone))
    revisions.splice(0, revisions.length, ...state.revisions.map(clone))
    operationLedger.clear()
    state.operationLedger.forEach(([id, value]) => operationLedger.set(id, clone(value)))
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
        balanceRevision += 1
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
        balanceRevision += 1
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
        balanceRevision += 1
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
        assertActiveMembership()
        if (!command.outsidePaymentConfirmed) throw new Error('Confirm that the outside payment already occurred')
        const method = settlementMethod(command.method)
        const occurredOn = checkedIsoDate(command.occurredOn, 'Occurrence date')
        const note = command.note === undefined ? undefined : normalizedPlainText(command.note, 'Settlement note', false)
        const snapshot = groupBalanceSnapshot(command.groupId)
        assertSettlementBasis(command.expectedBalanceRevision, command.basis, command.money, snapshot)
        if (currentUser.id !== command.basis.senderId && currentUser.id !== command.basis.recipientId) {
          throw new Error('The current user must be the settlement sender or recipient')
        }
        const memberIds = new Set(lakeHouseMembers.map(({ id }) => id))
        if (!memberIds.has(command.basis.senderId) || !memberIds.has(command.basis.recipientId)) throw new Error('Settlement participants must be active group members')
        if (!Number.isSafeInteger(command.money.minorAmount) || command.money.minorAmount <= 0) throw new Error('Settlement amount must be a positive minor-unit integer')
        if (command.money.minorAmount > command.basis.debtMinor) throw new Error('Settlement amount cannot exceed the selected debt')
        assertBalanceRevisionCanAdvance(balanceRevision)
        const createdAt = checkedNow(now)
        const actor = actorSnapshot(currentUser)
        const settlement: SettlementRecord = {
          settlementId: `settlement-${command.operationId}`,
          groupId: command.groupId,
          operationId: command.operationId,
          senderId: command.basis.senderId,
          recipientId: command.basis.recipientId,
          money: { ...command.money },
          basis: clone(command.basis),
          method,
          occurredOn,
          ...(note ? { note } : {}),
          createdBy: actor,
          createdAt,
          revision: 1,
          syncState: 'fresh',
        }
        const event = settlementActivity(command.operationId, settlement, 'settlement.created', actor, createdAt)
        settlements.push(settlement)
        activity.push(event)
        balanceRevision += 1
        return {
          kind: command.kind,
          operationId: command.operationId,
          status: 'saved',
          settlement: clone(settlement),
          balanceSnapshot: groupBalanceSnapshot(command.groupId),
          activity: clone(event),
        }
      }
      case 'settlement.void': {
        assertLakeHouseGroup(command.groupId)
        assertActiveMembership()
        const previous = settlements.find((settlement) => settlement.groupId === command.groupId && settlement.settlementId === command.settlementId)
        if (!previous) throw new Error('Settlement is not available')
        if (previous.void) throw new Error('Settlement is already voided')
        const snapshot = groupBalanceSnapshot(command.groupId)
        if (command.expectedRevision !== previous.revision || command.expectedBalanceRevision !== snapshot.balanceRevision) {
          throw new CommandConflictError('The settlement or balance changed remotely.', { remote: clone(previous), balanceSnapshot: snapshot })
        }
        const member = lakeHouseMembers.find(({ id }) => id === currentUser.id)
        if (previous.createdBy.id !== currentUser.id && member?.canManage !== true) throw new Error('Only the settlement creator or an active group manager may void it')
        const reason = normalizedPlainText(command.reason, 'Void reason', true)
        assertBalanceRevisionCanAdvance(balanceRevision)
        const createdAt = checkedNow(now)
        const actor = actorSnapshot(currentUser)
        const updated: SettlementRecord = {
          ...previous,
          revision: previous.revision + 1,
          void: { operationId: command.operationId, reason, actor, createdAt, revision: previous.revision + 1 },
        }
        const event = settlementActivity(command.operationId, updated, 'settlement.voided', actor, createdAt)
        settlements[settlements.indexOf(previous)] = updated
        activity.push(event)
        balanceRevision += 1
        return {
          kind: command.kind,
          operationId: command.operationId,
          status: 'saved',
          settlement: clone(updated),
          balanceSnapshot: groupBalanceSnapshot(command.groupId),
          activity: clone(event),
        }
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
      async getBalanceSnapshot(groupId) { return clone(groupBalanceSnapshot(groupId)) },
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
    settlements: {
      async listForGroup(groupId) {
        assertLakeHouseGroup(groupId)
        return settlements.filter((settlement) => settlement.groupId === groupId).sort(oldestSettlementFirst).map(clone)
      },
      async getById(groupId, settlementId) {
        assertLakeHouseGroup(groupId)
        const settlement = settlements.find((item) => item.groupId === groupId && item.settlementId === settlementId)
        return settlement ? clone(settlement) : undefined
      },
      async record(command): Promise<SettlementRecordResult> {
        const result = await execute(command)
        if (result.kind !== 'settlement.record') throw new Error('Unexpected settlement result')
        return result
      },
      async void(command): Promise<SettlementVoidResult> {
        const result = await execute(command)
        if (result.kind !== 'settlement.void') throw new Error('Unexpected settlement void result')
        return result
      },
    },
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

function saved(command: Extract<CommandEnvelope, { kind: 'group.default-split' | 'profile.update' }>, resourceId: string): CommandResult {
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

function settlementActivity(operationId: string, settlement: SettlementRecord, kind: 'settlement.created' | 'settlement.voided', actor: ActorSnapshot, createdAt: string): ActivityItem {
  return {
    id: `activity-${operationId}`,
    groupId: settlement.groupId,
    operationId,
    kind,
    subject: { kind: 'settlement', id: settlement.settlementId, label: 'Payment' },
    actor: clone(actor),
    settlementId: settlement.settlementId,
    createdAt,
    syncState: 'fresh',
  }
}

function activityMatches(item: ActivityItem, filter: ActivityFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'expenses') return item.kind.startsWith('expense.')
  if (filter === 'comments') return item.kind.startsWith('comment.')
  return item.kind.startsWith('settlement.')
}

function page<T extends { readonly createdAt: string; readonly id?: string; readonly notificationId?: string }>(values: readonly T[], limit: number, cursor?: TimelineCursor): { items: readonly T[]; nextCursor?: TimelineCursor } {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Timeline limit must be between 1 and 100')
  if (cursor) assertCursor(cursor)
  const sorted = [...values].sort(newestTimelineFirst)
  const after = cursor ? sorted.filter((item) => isAfterDescendingCursor({ createdAt: item.createdAt, id: timelineId(item) }, cursor)) : sorted
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
  return compareTimelineAscending({ createdAt: left.createdAt, id: timelineId(left) }, right)
}

function newestTimelineFirst(left: { readonly createdAt: string; readonly id?: string; readonly notificationId?: string }, right: { readonly createdAt: string; readonly id?: string; readonly notificationId?: string }): number {
  return compareTimelineDescending({ createdAt: left.createdAt, id: timelineId(left) }, { createdAt: right.createdAt, id: timelineId(right) })
}

function assertCursor(cursor: TimelineCursor): void {
  checkedIsoTimestamp(cursor.createdAt, 'Timeline cursor timestamp')
  if (!cursor.id.trim()) throw new Error('Timeline cursor ID is required')
}

function checkedNow(now: () => string): string { return checkedIsoTimestamp(now(), 'Commit timestamp') }
function checkedIsoDate(value: string, label: string): string {
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) throw new Error(`${label} must be a valid ISO date`)
  return value
}
function checkedIsoTimestamp(value: string, label: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) throw new Error(`${label} must be a strict ISO timestamp`)
  return value
}
function settlementMethod(value: SettlementRecord['method']): SettlementRecord['method'] {
  if (value !== 'cash' && value !== 'bank-transfer' && value !== 'payment-app' && value !== 'other') throw new Error('Settlement method is invalid')
  return value
}
function normalizedPlainText(value: string, label: string, required: boolean): string {
  const normalized = value.normalize('NFC').replace(/\r\n?/g, '\n').trim()
  if (required && !normalized) throw new Error(`${label} is required`)
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(normalized)) throw new Error(`${label} must be plain text`)
  if ([...normalized].length > 500) throw new Error(`${label} must be at most 500 Unicode code points`)
  return normalized
}
function assertBalanceRevisionCanAdvance(value: number): void {
  if (!Number.isSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER) throw new Error('Balance revision cannot advance beyond a safe integer')
}
function assertSettlementBasis(
  expectedBalanceRevision: number,
  basis: SettlementRecord['basis'],
  money: SettlementRecord['money'],
  snapshot: GroupBalanceSnapshot,
): void {
  if (!Number.isSafeInteger(expectedBalanceRevision) || expectedBalanceRevision !== snapshot.balanceRevision) {
    throw new CommandConflictError('The group balance changed remotely.', { balanceSnapshot: clone(snapshot) })
  }
  const plan = basis.kind === 'pairwise' ? snapshot.pairwise : basis.kind === 'simplified' ? snapshot.simplified : undefined
  const exact = plan?.find((debt) => debt.fromParticipantId === basis.senderId
    && debt.toParticipantId === basis.recipientId
    && debt.money.currency === basis.currency)
  if (!exact || !Number.isSafeInteger(basis.debtMinor) || basis.debtMinor <= 0 || exact.money.minorAmount !== basis.debtMinor || money.currency !== basis.currency) {
    throw new CommandConflictError('The selected balance changed remotely.', { balanceSnapshot: clone(snapshot) })
  }
}
function actorSnapshot(member: Member): ActorSnapshot { return { id: member.id, displayName: member.displayName } }
function validateAttachmentRefs(references: readonly string[]): void { if (references.some((reference) => !reference.trim())) throw new Error('Attachment references must be durable non-empty strings') }
function assertLakeHouseGroup(groupId: string): void { if (groupId !== LAKE_HOUSE_GROUP_ID) throw new Error(`Unknown demo group: ${groupId}`) }
function cloneAllocation(allocation: ExpenseRow['allocations'][number]): ExpenseRow['allocations'][number] { return { participantId: allocation.participantId, money: { ...allocation.money } } }
function cloneExpense(expense: ExpenseRow): ExpenseRow { return clone(expense) }
function byDateThenId(left: ExpenseRow, right: ExpenseRow): number { return compareFirestoreStrings(left.date, right.date) || compareFirestoreStrings(left.id, right.id) }
function oldestActivityFirst(left: ActivityItem, right: ActivityItem): number { return compareTimelineAscending(left, right) }
function oldestCommentFirst(left: ExpenseComment, right: ExpenseComment): number { return compareTimelineAscending({ createdAt: left.createdAt, id: left.commentId }, { createdAt: right.createdAt, id: right.commentId }) }
function oldestRevisionFirst(left: ExpenseRevision, right: ExpenseRevision): number { return left.revision - right.revision || compareFirestoreStrings(left.id, right.id) }
function oldestSettlementFirst(left: SettlementRecord, right: SettlementRecord): number { return compareFirestoreStrings(left.occurredOn, right.occurredOn) || compareFirestoreStrings(left.settlementId, right.settlementId) }
function initials(displayName: string): string { return displayName.split(/\s+/).filter(Boolean).map((part) => part[0]).join('').slice(0, 2).toUpperCase() }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }

function decodeDemoState(value: unknown, principalId: string): DemoRepositoryStateDocument | undefined {
  if (value === undefined || value === null) return undefined
  if (!isRecord(value) || value.version !== 2 || value.principalId !== principalId || !isRecord(value.currentUser) || value.currentUser.id !== principalId
    || !isRecord(value.notificationPreferences) || typeof value.notificationPreferences.emailEnabled !== 'boolean' || typeof value.notificationPreferences.pushEnabled !== 'boolean'
    || !Number.isSafeInteger(value.nextExpenseNumber) || (value.nextExpenseNumber as number) < 1
    || !Number.isSafeInteger(value.balanceRevision) || (value.balanceRevision as number) < 0
    || !Array.isArray(value.expenses) || !Array.isArray(value.settlements) || !Array.isArray(value.activity) || !Array.isArray(value.comments) || !Array.isArray(value.notifications)
    || !Array.isArray(value.revisions) || !Array.isArray(value.operationLedger)) {
    throw new Error('Persisted demo repository state is invalid')
  }
  const settlements = value.settlements.map(decodeDemoSettlement)
  const activities = value.activity.map(decodeDemoActivity)
  assertSettlementActivityLinks(settlements, activities)
  value.operationLedger.forEach((entry) => assertDemoOperationLedgerEntry(entry, principalId, value.balanceRevision as number, settlements, activities))
  return clone(value) as unknown as DemoRepositoryStateDocument
}

function decodeDemoSettlement(value: unknown): SettlementRecord {
  if (!isRecord(value) || typeof value.groupId !== 'string' || typeof value.settlementId !== 'string' || value.syncState !== 'fresh') throw new Error('Persisted demo settlement is invalid')
  const settlement = decodeSettlement(value.groupId, value.settlementId, value)
  if (!isDemoOperationId(settlement.operationId) || (settlement.createdBy.id !== settlement.senderId && settlement.createdBy.id !== settlement.recipientId)) {
    throw new Error('Persisted demo settlement identity is invalid')
  }
  if (settlement.void && (!isDemoOperationId(settlement.void.operationId) || !lakeHouseMembers.some(({ id }) => id === settlement.void?.actor.id))) {
    throw new Error('Persisted demo settlement void is invalid')
  }
  return settlement
}

function decodeDemoActivity(value: unknown): ActivityItem {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.groupId !== 'string' || value.syncState !== 'fresh' || !isDemoOperationId(value.operationId)) {
    throw new Error('Persisted demo activity is invalid')
  }
  const item = decodeActivity(value.groupId, value.id, value)
  if (!lakeHouseMembers.some(({ id }) => id === item.actor.id)) throw new Error('Persisted demo activity actor is invalid')
  return item
}

function assertSettlementActivityLinks(settlements: readonly SettlementRecord[], activities: readonly ActivityItem[]): void {
  for (const settlement of settlements) {
    const created = activities.find((item) => item.operationId === settlement.operationId && item.kind === 'settlement.created')
    if (!created || created.groupId !== settlement.groupId || created.settlementId !== settlement.settlementId
      || !sameActor(created.actor, settlement.createdBy) || created.createdAt !== settlement.createdAt) {
      throw new Error('Persisted demo settlement creation activity is invalid')
    }
    if (!settlement.void) continue
    const voided = activities.find((item) => item.operationId === settlement.void?.operationId && item.kind === 'settlement.voided')
    if (!voided || voided.groupId !== settlement.groupId || voided.settlementId !== settlement.settlementId
      || !sameActor(voided.actor, settlement.void.actor) || voided.createdAt !== settlement.void.createdAt) {
      throw new Error('Persisted demo settlement void activity is invalid')
    }
  }
}

function assertDemoOperationLedgerEntry(
  entry: unknown,
  principalId: string,
  currentBalanceRevision: number,
  settlements: readonly SettlementRecord[],
  activities: readonly ActivityItem[],
): void {
  if (!Array.isArray(entry) || entry.length !== 2 || !isDemoOperationId(entry[0]) || !isRecord(entry[1]) || !isRecord(entry[1].identity) || !isRecord(entry[1].result)) {
    throw new Error('Persisted demo operation ledger entry is invalid')
  }
  const [operationId, stored] = entry as [string, { identity: Record<string, unknown>; result: Record<string, unknown> }]
  const identity = stored.identity
  const result = stored.result
  if (identity.userId !== principalId || identity.operationId !== operationId || !isCommandKind(identity.kind)
    || (identity.groupId !== null && typeof identity.groupId !== 'string') || typeof identity.requestFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(identity.requestFingerprint)
    || typeof identity.resourceId !== 'string' || !/^operation-[a-f0-9]{48}$/.test(identity.resourceId)
    || result.kind !== identity.kind || result.operationId !== operationId || result.status !== 'saved') {
    throw new Error('Persisted demo operation identity or result is invalid')
  }
  if (identity.kind !== 'settlement.record' && identity.kind !== 'settlement.void') return
  if (identity.groupId !== LAKE_HOUSE_GROUP_ID || !isRecord(result.settlement) || !isRecord(result.balanceSnapshot) || !isRecord(result.activity)) {
    throw new Error('Persisted demo settlement result is invalid')
  }
  const resultSettlement = decodeDemoSettlement(result.settlement)
  const resultSnapshot = decodeBalanceSnapshot(identity.groupId, result.balanceSnapshot)
  const resultActivity = decodeDemoActivity(result.activity)
  const current = settlements.find(({ settlementId }) => settlementId === resultSettlement.settlementId)
  const currentActivity = activities.find(({ operationId: id }) => id === operationId)
  if (!current || !currentActivity || resultSnapshot.balanceRevision > currentBalanceRevision
    || !sameImmutableSettlement(resultSettlement, current) || !sameActivity(resultActivity, currentActivity)) {
    throw new Error('Persisted demo settlement result does not match restored state')
  }
  if (identity.kind === 'settlement.record') {
    if (resultSettlement.operationId !== operationId || resultSettlement.revision !== 1 || resultSettlement.void !== undefined || resultActivity.kind !== 'settlement.created') {
      throw new Error('Persisted demo settlement record result is invalid')
    }
  } else if (!resultSettlement.void || resultSettlement.void.operationId !== operationId || resultActivity.kind !== 'settlement.voided') {
    throw new Error('Persisted demo settlement void result is invalid')
  }
}

function sameImmutableSettlement(left: SettlementRecord, right: SettlementRecord): boolean {
  return left.settlementId === right.settlementId && left.groupId === right.groupId && left.operationId === right.operationId
    && left.senderId === right.senderId && left.recipientId === right.recipientId && sameMoney(left.money, right.money)
    && left.basis.kind === right.basis.kind && left.basis.senderId === right.basis.senderId && left.basis.recipientId === right.basis.recipientId
    && left.basis.currency === right.basis.currency && left.basis.debtMinor === right.basis.debtMinor
    && left.method === right.method && left.occurredOn === right.occurredOn && left.note === right.note
    && sameActor(left.createdBy, right.createdBy) && left.createdAt === right.createdAt
}

function sameActivity(left: ActivityItem, right: ActivityItem): boolean {
  return left.id === right.id && left.groupId === right.groupId && left.operationId === right.operationId && left.kind === right.kind
    && left.subject.kind === right.subject.kind && left.subject.id === right.subject.id && left.subject.label === right.subject.label
    && sameActor(left.actor, right.actor) && left.settlementId === right.settlementId && left.createdAt === right.createdAt
}

function sameActor(left: ActorSnapshot, right: ActorSnapshot): boolean { return left.id === right.id && left.displayName === right.displayName }
function sameMoney(left: SettlementRecord['money'], right: SettlementRecord['money']): boolean { return left.currency === right.currency && left.minorAmount === right.minorAmount }
function isDemoOperationId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) }
function isCommandKind(value: unknown): value is CommandEnvelope['kind'] {
  return typeof value === 'string' && ['comment.add', 'comment.delete', 'expense.add', 'expense.delete', 'expense.edit', 'group.default-split', 'notification.preferences', 'notification.read', 'notification.read-all', 'profile.update', 'settlement.record', 'settlement.void'].includes(value)
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }

export function createBrowserDemoRepositoryStateStorage(storage: Storage | undefined = browserStorage()): DemoRepositoryStateStorage {
  const key = (scope: string) => `split-unwise:demo-repository:v2:${encodeURIComponent(scope)}`
  return {
    load(scope) {
      if (!storage) return undefined
      const value = storage.getItem(key(scope))
      if (value === null) return undefined
      try { return JSON.parse(value) as unknown } catch { throw new Error('Persisted demo repository state is invalid JSON') }
    },
    save(scope, document) {
      if (!storage) throw new Error('Browser demo repository storage is unavailable')
      storage.setItem(key(scope), JSON.stringify(document))
    },
  }
}

function browserStorage(): Storage | undefined {
  if (typeof window === 'undefined') return undefined
  try { return window.localStorage } catch { return undefined }
}

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
