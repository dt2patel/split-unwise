import { computeBalancePlans, computeBalances } from '../domain/balances'
import { computeAllocations } from '../domain/splits'
import { applyGroupCurrencyConversion, updateGroupSettings, type GroupSettings } from '../domain/groupSettings'
import { applyCurrencyConversionToExpense, applyCurrencyConversionToSettlement, assertGroupCurrencyConversion } from '../domain/currencyConversion'
import { nextOccurrence, recurringOccurrenceId } from '../domain/recurrence'
import { assessGroupMemberRemoval } from '../domain/groupMembership'
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
import { decodeActivity, decodeBalanceSnapshot, decodeRecurringExpense, decodeSettlement } from './firebaseDecoders'
import { assertReplayIdentity, createOperationIdentity, type OperationIdentity } from './operationIdentity'
import { compareFirestoreStrings, compareTimelineAscending, compareTimelineDescending, isAfterDescendingCursor } from './timeline'
import { buildSparkMaterializationOperationId } from './firebaseSparkMutations'
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
  RecurringExpense,
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
  readonly recurring?: readonly RecurringExpense[]
  readonly operationLedger: readonly (readonly [string, { readonly identity: OperationIdentity; readonly result: CommandResult }])[]
  readonly groupSettings?: GroupSettings
  readonly removedMemberIds?: readonly string[]
  readonly groupDeletion?: { readonly deletedAt: string; readonly deletedBy: ActorSnapshot }
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
  const recurring = (restored?.recurring ?? lakeHouseRecurring).map(clone)
  const operationLedger = new Map<string, { readonly identity: OperationIdentity; readonly result: CommandResult }>((restored?.operationLedger ?? []).map(([id, value]) => [id, clone(value)]))
  let currentUser = restored?.currentUser ? clone(restored.currentUser) : { ...selectedUser, isCurrentUser: true }
  let notificationPreferences: NotificationPreferences = restored?.notificationPreferences ? { ...restored.notificationPreferences } : { emailEnabled: true, pushEnabled: true }
  let nextExpenseNumber = restored?.nextExpenseNumber ?? 6
  let balanceRevision = restored?.balanceRevision ?? lakeHouseExpenses.length
  let groupSettings: GroupSettings = restored?.groupSettings ? clone(restored.groupSettings) : { schemaVersion: 1, groupId: LAKE_HOUSE_GROUP_ID, revision: 1 }
  const removedMemberIds = new Set(restored?.removedMemberIds ?? [])
  let groupDeletion = restored?.groupDeletion ? clone(restored.groupDeletion) : undefined
  let executionTail: Promise<void> = Promise.resolve()
  let defaultCommitTime = Math.max(
    Date.parse('2026-08-30T12:00:00.000Z') - 1,
    ...activity.map((item) => Date.parse(item.createdAt)),
    ...(groupDeletion ? [Date.parse(groupDeletion.deletedAt)] : []),
  )
  const now = options.now ?? (() => new Date(++defaultCommitTime).toISOString())

  const groupExpenses = (groupId: string): ExpenseRow[] => {
    assertLakeHouseGroup(groupId)
    return expenses
      .filter((expense) => expense.groupId === groupId && expense.deletedAt === undefined)
      .map((expense) => groupSettings.currencyConversion ? applyCurrencyConversionToExpense(expense, groupSettings.currencyConversion) : expense)
      .sort(byDateThenId)
  }

  const projectedSettlement = (settlement: SettlementRecord): SettlementRecord => groupSettings.currencyConversion
    ? applyCurrencyConversionToSettlement(settlement, groupSettings.currencyConversion)
    : settlement

  const groupBalanceSnapshot = (groupId: string): GroupBalanceSnapshot => {
    const plans = computeBalancePlans(
      groupExpenses(groupId),
      settlements
        .filter((settlement) => settlement.groupId === groupId)
        .map(projectedSettlement)
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
      simplifyDebtsEnabled: groupSettings.simplifyDebtsEnabled !== false,
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
      const result = executeNew(command, identity)
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
    recurring: recurring.map(clone),
    operationLedger: [...operationLedger.entries()].map(([id, value]) => [id, clone(value)] as const),
    groupSettings: clone(groupSettings),
    removedMemberIds: [...removedMemberIds].sort(),
    ...(groupDeletion ? { groupDeletion: clone(groupDeletion) } : {}),
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
    recurring.splice(0, recurring.length, ...(state.recurring ?? lakeHouseRecurring).map(clone))
    operationLedger.clear()
    state.operationLedger.forEach(([id, value]) => operationLedger.set(id, clone(value)))
    groupSettings = state.groupSettings ? clone(state.groupSettings) : { schemaVersion: 1, groupId: LAKE_HOUSE_GROUP_ID, revision: 1 }
    removedMemberIds.clear()
    state.removedMemberIds?.forEach((id) => removedMemberIds.add(id))
    groupDeletion = state.groupDeletion ? clone(state.groupDeletion) : undefined
  }

  const executeNew = (command: CommandEnvelope, identity: OperationIdentity): CommandResult => {
    switch (command.kind) {
      case 'expense.add': {
        assertLakeHouseGroup(command.groupId)
        assertActiveMembership()
        const allocations = validateDraft(command, activeMembers())
        const createdAt = checkedNow(now)
        const actor = actorSnapshot(currentUser)
        const expenseId = `demo-expense-${String(nextExpenseNumber).padStart(3, '0')}`
        const templateId = command.recurrence ? `recurring-${identity.resourceId.slice('operation-'.length)}` : undefined
        if (command.occurrenceEditScope) throw new Error('Occurrence scope requires an existing recurring expense')
        if (command.recurrence) assertRecurrenceAnchor(command.date, command.recurrence)
        const expense: ExpenseRow = {
          id: expenseId,
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
          ...(command.reimbursement ? { reimbursement: true as const } : {}),
          attachmentRefs: [...command.attachmentRefs],
          createdBy: actor,
          updatedBy: actor,
          ...(command.notes ? { notes: command.notes } : {}),
          ...(command.recurrence ? { recurrence: clone(command.recurrence) } : {}),
          ...(templateId ? { recurringTemplateId: templateId } : {}),
        }
        const event = expenseActivity(command.operationId, expense, 'expense.created', actor, createdAt)
        const revision = expenseRevision(command.operationId, expense, 'created', actor, createdAt)
        nextExpenseNumber += 1
        expenses.push(expense)
        activity.push(event)
        revisions.push(revision)
        if (command.recurrence && templateId) recurring.push({
          id: templateId, groupId: command.groupId, status: 'active', description: expense.description,
          total: { ...expense.total }, payments: expense.payments.map(cloneAllocation), allocations: expense.allocations.map(cloneAllocation),
          category: expense.category, splitMethod: clone(command.splitMethod), recurrence: clone(command.recurrence),
          ...(expense.reimbursement ? { reimbursement: true as const } : {}),
          anchorDate: command.date, nextDate: nextOccurrence(command.date, command.recurrence), revision: 1,
          createdBy: actor, syncState: 'fresh',
        })
        balanceRevision += 1
        return { kind: 'expense.add', operationId: command.operationId, status: 'saved', expense: cloneExpense(expense) }
      }
      case 'expense.edit': {
        if (command.draft.groupId !== command.groupId) throw new Error('Moving expenses between contexts requires the Firebase shared ledger.')
        const previous = editableExpense(command.groupId, command.expenseId)
        assertExpenseMutationPermission(previous)
        if (command.expectedRevision !== previous.revision) throw new CommandConflictError('The expense changed remotely.', { local: clone(command.draft), remote: cloneExpense(previous) })
        const allocations = validateDraft(command.draft, activeMembers())
        const template = previous.recurringTemplateId ? recurring.find(({ id }) => id === previous.recurringTemplateId) : undefined
        if (previous.recurringTemplateId && !template) throw new Error('Linked recurring template is unavailable')
        if (previous.recurringTemplateId && !command.draft.occurrenceEditScope) throw new Error('Choose whether to edit this occurrence or future expenses')
        if (!previous.recurringTemplateId && (command.draft.recurrence || command.draft.occurrenceEditScope)) throw new Error('Recurrence requires a linked recurring expense')
        if (command.draft.occurrenceEditScope === 'future') {
          if (!template || template.status !== 'active') throw new Error('Recurring template is not active')
          if (!command.draft.recurrence) throw new Error('A future-series edit requires recurrence settings')
          assertLatestFutureEdit(previous, template, expenses)
          assertRecurrenceAnchor(command.draft.date, command.draft.recurrence)
        }
        const updatedAt = checkedNow(now)
        const actor = actorSnapshot(currentUser)
        const { notes: _notes, recurrence: _recurrence, occurrenceEditScope: _scope, reimbursement: _reimbursement, updatedBy: _updatedBy, ...retained } = previous
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
        if (template && command.draft.occurrenceEditScope === 'future' && command.draft.recurrence) {
          const { reimbursement: _templateReimbursement, ...retainedTemplate } = template
          recurring[recurring.indexOf(template)] = {
            ...retainedTemplate, description: updated.description, total: { ...updated.total }, payments: updated.payments.map(cloneAllocation),
            allocations: updated.allocations.map(cloneAllocation), category: updated.category, splitMethod: clone(command.draft.splitMethod),
            recurrence: clone(command.draft.recurrence), anchorDate: command.draft.date,
            nextDate: nextOccurrence(command.draft.date, command.draft.recurrence), revision: template.revision + 1,
            ...(updated.reimbursement ? { reimbursement: true as const } : {}),
          }
        }
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
        const memberIds = new Set(activeMembers().map(({ id }) => id))
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
        const member = activeMembers().find(({ id }) => id === currentUser.id)
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
      case 'group.default-split': {
        assertLakeHouseGroup(command.groupId)
        if (command.expectedRevision !== groupSettings.revision) throw new CommandConflictError('Group settings changed remotely.', { remote: clone(groupSettings) })
        groupSettings = updateGroupSettings(groupSettings, { expectedRevision: command.expectedRevision, defaultSplit: command.defaultSplit }, activeMembers(), currentUser.id)
        const createdAt = checkedNow(now)
        activity.push({
          id: `activity-${command.operationId}`, groupId: command.groupId, operationId: command.operationId, kind: 'group.event',
          subject: { kind: 'group', id: command.groupId, label: command.defaultSplit ? 'Default split updated' : 'Default split cleared' },
          actor: actorSnapshot(currentUser), createdAt, syncState: 'fresh',
        })
        return saved(command, command.groupId)
      }
      case 'group.currency-conversion': {
        assertLakeHouseGroup(command.groupId)
        assertActiveMembership()
        if (command.expectedRevision !== groupSettings.revision) throw new CommandConflictError('Group settings changed remotely.', { remote: clone(groupSettings) })
        assertBalanceRevisionCanAdvance(balanceRevision)
        const convertedAt = checkedNow(now)
        groupSettings = applyGroupCurrencyConversion(groupSettings, command.expectedRevision, {
          schemaVersion: 1,
          operationId: command.operationId,
          targetCurrency: command.targetCurrency,
          convertedAt,
          rates: command.rates.map((rate) => ({ ...rate })),
        }, activeMembers(), currentUser.id)
        activity.push({
          id: `activity-${command.operationId}`, groupId: command.groupId, operationId: command.operationId, kind: 'group.event',
          subject: { kind: 'group', id: command.groupId, label: `Currencies converted to ${command.targetCurrency}` },
          actor: actorSnapshot(currentUser), createdAt: convertedAt, syncState: 'fresh',
        })
        balanceRevision += 1
        return saved(command, command.groupId)
      }
      case 'group.simplify-debts': {
        assertLakeHouseGroup(command.groupId)
        assertActiveMembership()
        if (command.expectedRevision !== groupSettings.revision) throw new CommandConflictError('Group settings changed remotely.', { remote: clone(groupSettings) })
        assertBalanceRevisionCanAdvance(balanceRevision)
        groupSettings = updateGroupSettings(groupSettings, { expectedRevision: command.expectedRevision, simplifyDebtsEnabled: command.simplifyDebtsEnabled }, activeMembers(), currentUser.id)
        const createdAt = checkedNow(now)
        activity.push({
          id: `activity-${command.operationId}`, groupId: command.groupId, operationId: command.operationId, kind: 'group.event',
          subject: { kind: 'group', id: command.groupId, label: `Simplify debts ${command.simplifyDebtsEnabled ? 'enabled' : 'disabled'}` },
          actor: actorSnapshot(currentUser), createdAt, syncState: 'fresh',
        })
        balanceRevision += 1
        return saved(command, command.groupId)
      }
      case 'group.member-remove': {
        assertLakeHouseGroup(command.groupId)
        const actor = currentMembership()
        const target = activeMembers().find(({ id }) => id === command.targetMemberId)
        if (!target) throw new Error('This person is not an active group member.')
        const snapshot = groupBalanceSnapshot(command.groupId)
        const assessment = assessGroupMemberRemoval({
          actor,
          target,
          activeExpenseCount: groupExpenses(command.groupId).filter((expense) => expense.payments.some(({ participantId }) => participantId === target.id) || expense.allocations.some(({ participantId }) => participantId === target.id)).length,
          activeRecurringCount: recurring.filter((template) => template.status === 'active' && (template.payments.some(({ participantId }) => participantId === target.id) || template.allocations.some(({ participantId }) => participantId === target.id))).length,
          activeSettlementCount: settlements.filter((settlement) => !settlement.void && (settlement.senderId === target.id || settlement.recipientId === target.id)).length,
          balanceCount: snapshot.pairwise.filter((debt) => debt.fromParticipantId === target.id || debt.toParticipantId === target.id).length,
        })
        if (!assessment.canRemove) throw new Error(assessment.reason)
        removedMemberIds.add(target.id)
        if (groupSettings.defaultSplit?.participantIds.includes(target.id)) {
          groupSettings = updateGroupSettings(groupSettings, { expectedRevision: groupSettings.revision, defaultSplit: null }, activeMembers(), currentUser.id)
        }
        const createdAt = checkedNow(now)
        activity.push({
          id: `activity-${command.operationId}`, groupId: command.groupId, operationId: command.operationId, kind: 'membership.changed',
          subject: { kind: 'membership', id: target.id, label: `${target.displayName} removed` }, actor: actorSnapshot(currentUser), createdAt, syncState: 'fresh',
        })
        return saved(command, target.id)
      }
      case 'group.delete': {
        assertLakeHouseGroup(command.groupId)
        const member = currentMembership()
        if (member.canManage !== true) throw new Error('Only an active group manager can delete this group.')
        if (groupDeletion) throw new Error('This group is already deleted.')
        const deletedAt = checkedNow(now)
        const deletedBy = actorSnapshot(currentUser)
        groupDeletion = { deletedAt, deletedBy }
        activity.push({
          id: `activity-${command.operationId}`, groupId: command.groupId, operationId: command.operationId, kind: 'group.deleted',
          subject: { kind: 'group', id: command.groupId, label: lakeHouseGroup.name }, actor: deletedBy, createdAt: deletedAt, syncState: 'fresh',
        })
        return saved(command, command.groupId)
      }
      case 'group.restore': {
        assertLakeHouseGroup(command.groupId)
        const member = currentMembership()
        if (member.canManage !== true) throw new Error('Only an active group manager can restore this group.')
        if (!groupDeletion) throw new Error('This group is not deleted.')
        const restoredAt = checkedNow(now)
        const actor = actorSnapshot(currentUser)
        groupDeletion = undefined
        activity.push({
          id: `activity-${command.operationId}`, groupId: command.groupId, operationId: command.operationId, kind: 'group.restored',
          subject: { kind: 'group', id: command.groupId, label: lakeHouseGroup.name }, actor, createdAt: restoredAt, syncState: 'fresh',
        })
        return saved(command, command.groupId)
      }
      case 'profile.update':
        currentUser = { ...currentUser, displayName: command.displayName, initials: command.initials ?? initials(command.displayName) }
        return saved(command, currentUser.id)
      case 'recurrence.materialize': {
        assertLakeHouseGroup(command.groupId)
        assertActiveMembership()
        const template = recurring.find((item) => item.id === command.templateId && item.groupId === command.groupId)
        if (!template) throw new Error('Recurring template was not found')
        const occurrenceId = recurringOccurrenceId(command.templateId, command.occurrenceDate)
        const existing = expenses.find((item) => item.id === occurrenceId && item.groupId === command.groupId)
        if (existing) {
          if (existing.id !== occurrenceId || existing.groupId !== command.groupId || existing.recurringTemplateId !== template.id
            || template.nextDate <= command.occurrenceDate) throw new Error('Recurring occurrence identity conflicts with an existing expense')
          return { kind: command.kind, operationId: command.operationId, status: 'saved', template: clone(template), occurrence: cloneExpense(existing) }
        }
        if (template.status !== 'active') throw new Error('Recurring template is not active')
        if (template.nextDate !== command.occurrenceDate) throw new CommandConflictError('Recurring template changed remotely.', { remote: clone(template) })
        const createdAt = checkedNow(now)
        const actor = actorSnapshot(currentUser)
        const seriesCreator = { ...template.createdBy }
        const occurrence: ExpenseRow = {
          id: occurrenceId, groupId: command.groupId, description: template.description, date: command.occurrenceDate,
          total: { ...template.total }, payments: template.payments.map(cloneAllocation), allocations: template.allocations.map(cloneAllocation),
          category: template.category, splitMethod: clone(template.splitMethod), attachmentRefs: [], recurrence: clone(template.recurrence),
          ...(template.reimbursement ? { reimbursement: true as const } : {}),
          recurringTemplateId: template.id, createdAt, updatedAt: createdAt, createdBy: seriesCreator, updatedBy: actor,
          revision: 1, syncState: 'fresh',
        }
        const advanced: RecurringExpense = {
          ...template, nextDate: nextOccurrence(command.occurrenceDate, template.recurrence), revision: template.revision + 1,
          lastOccurrenceId: occurrenceId, lastOccurrenceDate: command.occurrenceDate,
        }
        expenses.push(occurrence)
        recurring[recurring.indexOf(template)] = advanced
        activity.push(expenseActivity(command.operationId, occurrence, 'expense.created', actor, createdAt))
        revisions.push(expenseRevision(command.operationId, occurrence, 'created', actor, createdAt))
        balanceRevision += 1
        return { kind: command.kind, operationId: command.operationId, status: 'saved', template: clone(advanced), occurrence: cloneExpense(occurrence) }
      }
      case 'recurrence.cancel': {
        assertLakeHouseGroup(command.groupId)
        assertActiveMembership()
        const template = recurring.find((item) => item.id === command.templateId && item.groupId === command.groupId)
        if (!template) throw new Error('Recurring template was not found')
        if (template.status !== 'active') throw new Error('Recurring template is already cancelled')
        if (template.revision !== command.expectedRevision) throw new CommandConflictError('Recurring template changed remotely.', { remote: clone(template) })
        const cancelled: RecurringExpense = { ...template, status: 'cancelled', revision: template.revision + 1 }
        recurring[recurring.indexOf(template)] = cancelled
        return { kind: command.kind, operationId: command.operationId, status: 'saved', template: clone(cancelled) }
      }
    }
  }

  function assertActiveMembership(): void {
    if (groupDeletion) throw new Error('This group is deleted. Restore it from Activity to make changes.')
    currentMembership()
  }

  function currentMembership(): Member {
    const member = activeMembers().find(({ id }) => id === currentUser.id)
    if (!member) throw new Error('You are not an active group member')
    return member
  }

  function activeMembers(): Member[] {
    return lakeHouseMembers.filter(({ id }) => !removedMemberIds.has(id))
  }

  function assertExpenseMutationPermission(expense: ExpenseRow): void {
    assertActiveMembership()
    if (!activeMembers().some(({ id }) => id === currentUser.id)) throw new Error('You are not allowed to change this expense')
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
      async list() { return groupDeletion ? [] : [{ ...lakeHouseGroup, memberIds: activeMembers().map(({ id }) => id) }] },
      async getById(groupId) { return groupId === LAKE_HOUSE_GROUP_ID && !groupDeletion ? { ...lakeHouseGroup, memberIds: activeMembers().map(({ id }) => id) } : undefined },
      async listMembers(groupId) {
        assertLakeHouseGroup(groupId)
        return activeMembers().map((member) => ({ ...member, isCurrentUser: member.id === currentUser.id, ...(member.id === currentUser.id ? { displayName: currentUser.displayName, initials: currentUser.initials } : {}) }))
      },
      async getBalanceSnapshot(groupId) { return clone(groupBalanceSnapshot(groupId)) },
      async getSettings(groupId) { assertLakeHouseGroup(groupId); return clone(groupSettings) },
      async getTotals(groupId) { return buildCurrencyTotals(groupExpenses(groupId), currentUser.id) },
      async getCharts(groupId) { return buildGroupCharts(groupExpenses(groupId)) },
      async listRecurring(groupId) { assertLakeHouseGroup(groupId); return recurring.map(clone) },
      async materializeDue(groupId, throughDate, maxOccurrences = 24) {
        assertLakeHouseGroup(groupId)
        checkedIsoDate(throughDate, 'Through date')
        assertMaterializationLimit(maxOccurrences)
        const templates = recurring.filter((item) => item.groupId === groupId).map(clone)
        const occurrences: ExpenseRow[] = []
        while (occurrences.length < maxOccurrences) {
          const template = templates.filter((item) => item.status === 'active' && item.nextDate <= throughDate)
            .sort((left, right) => left.nextDate.localeCompare(right.nextDate) || left.id.localeCompare(right.id))[0]
          if (!template) break
          const command = {
            kind: 'recurrence.materialize' as const, operationId: await buildSparkMaterializationOperationId(groupId, template.id, template.nextDate),
            groupId, templateId: template.id, occurrenceDate: template.nextDate,
          }
          const result = await execute(command)
          if (result.kind !== 'recurrence.materialize' || result.status !== 'saved') throw new Error('Recurring occurrence could not be materialized')
          occurrences.push(cloneExpense(result.occurrence))
          templates[templates.indexOf(template)] = clone(result.template)
        }
        const moreRemain = templates.some((item) => item.status === 'active' && item.nextDate <= throughDate)
        return { occurrences, moreRemain }
      },
      setDefaultSplit: execute,
      convertCurrencies: execute,
      removeMember: execute,
      setSimplifyDebts: execute,
    },
    expenses: {
      async listForGroup(groupId) { return groupExpenses(groupId).map(cloneExpense) },
      async getById(groupId, expenseId) {
        assertLakeHouseGroup(groupId)
        const expense = expenses.find((item) => item.groupId === groupId && item.id === expenseId)
        return expense ? cloneExpense(groupSettings.currencyConversion ? applyCurrencyConversionToExpense(expense, groupSettings.currencyConversion) : expense) : undefined
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
        return settlements.filter((settlement) => settlement.groupId === groupId).map(projectedSettlement).sort(oldestSettlementFirst).map(clone)
      },
      async getById(groupId, settlementId) {
        assertLakeHouseGroup(groupId)
        const settlement = settlements.find((item) => item.groupId === groupId && item.settlementId === settlementId)
        return settlement ? clone(projectedSettlement(settlement)) : undefined
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

function saved(command: Extract<CommandEnvelope, { kind: 'group.currency-conversion' | 'group.default-split' | 'group.delete' | 'group.member-remove' | 'group.restore' | 'group.simplify-debts' | 'profile.update' }>, resourceId: string): CommandResult {
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
function assertRecurrenceAnchor(date: string, recurrence: RecurringExpense['recurrence']): void {
  checkedIsoDate(date, 'Recurring expense date')
  const anchor = `${String(recurrence.anchor.month).padStart(2, '0')}-${String(recurrence.anchor.day).padStart(2, '0')}`
  if (date.slice(5) !== anchor) throw new Error('Recurring expense date must match its recurrence anchor')
  nextOccurrence(date, recurrence)
}
function assertLatestFutureEdit(expense: ExpenseRow, template: RecurringExpense, allExpenses: readonly ExpenseRow[]): void {
  const expectedId = template.lastOccurrenceId ?? expensesSourceId(template, allExpenses)
  if (expense.id !== expectedId) throw new CommandConflictError('Only the latest recurring occurrence can update future expenses.', { remote: clone(template) })
}
function expensesSourceId(template: RecurringExpense, allExpenses: readonly ExpenseRow[]): string {
  if (template.lastOccurrenceId) return template.lastOccurrenceId
  const seeded = allExpenses.find((expense) => expense.groupId === template.groupId && expense.recurringTemplateId === template.id)
  if (seeded) return seeded.id
  throw new Error('Recurring source expense is unavailable')
}
function assertMaterializationLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 24) throw new Error('Recurring catch-up limit must be between 1 and 24')
}
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
    || !Array.isArray(value.revisions) || !Array.isArray(value.operationLedger)
    || (value.recurring !== undefined && !Array.isArray(value.recurring))
    || (value.groupSettings !== undefined && !isDemoGroupSettings(value.groupSettings))
    || (value.removedMemberIds !== undefined && (!Array.isArray(value.removedMemberIds) || value.removedMemberIds.some((id) => typeof id !== 'string' || id === lakeHouseCurrentUser.id || !lakeHouseMembers.some((member) => member.id === id)) || new Set(value.removedMemberIds).size !== value.removedMemberIds.length))
    || (value.groupDeletion !== undefined && (!isRecord(value.groupDeletion) || !isStrictIsoTimestamp(value.groupDeletion.deletedAt) || !isDemoActor(value.groupDeletion.deletedBy)))) {
    throw new Error('Persisted demo repository state is invalid')
  }
  const settlements = value.settlements.map(decodeDemoSettlement)
  const activities = value.activity.map(decodeDemoActivity)
  if (Array.isArray(value.recurring)) value.recurring.forEach((template) => {
    if (!isRecord(template) || typeof template.id !== 'string' || typeof template.groupId !== 'string') throw new Error('Persisted demo recurring template is invalid')
    decodeRecurringExpense(template.groupId, template.id, template)
  })
  assertSettlementActivityLinks(settlements, activities)
  value.operationLedger.forEach((entry) => assertDemoOperationLedgerEntry(entry, principalId, value.balanceRevision as number, settlements, activities))
  assertSettlementOperationProofs(settlements, value.operationLedger, principalId)
  return clone(value) as unknown as DemoRepositoryStateDocument
}

function isDemoGroupSettings(value: unknown): value is GroupSettings {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.groupId !== LAKE_HOUSE_GROUP_ID || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1) return false
  if (Object.keys(value).some((key) => !['schemaVersion', 'groupId', 'revision', 'defaultSplit', 'simplifyDebtsEnabled', 'currencyConversion'].includes(key))) return false
  if (value.simplifyDebtsEnabled !== undefined && typeof value.simplifyDebtsEnabled !== 'boolean') return false
  try {
    if (value.currencyConversion !== undefined) assertGroupCurrencyConversion(value.currencyConversion as never)
    if (value.defaultSplit !== undefined) updateGroupSettings({ schemaVersion: 1, groupId: LAKE_HOUSE_GROUP_ID, revision: 1 }, { expectedRevision: 1, defaultSplit: value.defaultSplit as never }, lakeHouseMembers, lakeHouseCurrentUser.id)
    return true
  } catch { return false }
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
  } else if (!resultSettlement.void || resultSettlement.void.operationId !== operationId || resultActivity.kind !== 'settlement.voided'
    || !sameSettlementAudit(resultSettlement, current)) {
    throw new Error('Persisted demo settlement void result is invalid')
  }
}

function assertSettlementOperationProofs(settlements: readonly SettlementRecord[], entries: readonly unknown[], principalId: string): void {
  const hasProof = (operationId: string, kind: 'settlement.record' | 'settlement.void') => entries.some((entry) => Array.isArray(entry)
    && entry[0] === operationId && isRecord(entry[1]) && isRecord(entry[1].identity) && entry[1].identity.kind === kind)
  for (const settlement of settlements) {
    if ((settlement.createdBy.id === principalId && !hasProof(settlement.operationId, 'settlement.record'))
      || (settlement.void?.actor.id === principalId && !hasProof(settlement.void.operationId, 'settlement.void'))) {
      throw new Error('Persisted demo settlement is missing its operation proof')
    }
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

function sameSettlementAudit(left: SettlementRecord, right: SettlementRecord): boolean {
  if (left.revision !== right.revision || left.syncState !== right.syncState) return false
  if (!left.void || !right.void) return left.void === right.void
  return left.void.operationId === right.void.operationId && left.void.reason === right.void.reason
    && sameActor(left.void.actor, right.void.actor) && left.void.createdAt === right.void.createdAt && left.void.revision === right.void.revision
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
  return typeof value === 'string' && ['comment.add', 'comment.delete', 'expense.add', 'expense.delete', 'expense.edit', 'group.currency-conversion', 'group.default-split', 'group.delete', 'group.member-remove', 'group.restore', 'group.simplify-debts', 'notification.preferences', 'notification.read', 'notification.read-all', 'profile.update', 'recurrence.cancel', 'recurrence.materialize', 'settlement.record', 'settlement.void'].includes(value)
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function isStrictIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parsed = new Date(value)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value
}
function isDemoActor(value: unknown): value is ActorSnapshot {
  return isRecord(value) && typeof value.id === 'string' && value.id.length > 0 && typeof value.displayName === 'string' && value.displayName.trim().length > 0
}

export function createBrowserDemoRepositoryStateStorage(storage: Storage | undefined = browserStorage()): DemoRepositoryStateStorage {
  const key = (scope: string) => `split-unwise:demo-repository:v2:${encodeURIComponent(scope)}`
  const quarantineKey = (scope: string) => `split-unwise:demo-repository:quarantine:v2:${encodeURIComponent(scope)}`
  const quarantine = (scope: string, records: readonly unknown[]): void => {
    if (!storage) return
    const previous = parseDemoQuarantine(storage.getItem(quarantineKey(scope)), scope)
    storage.setItem(quarantineKey(scope), JSON.stringify({ version: 2, scope, records: [...previous, ...records] }))
    storage.removeItem(key(scope))
  }
  return {
    load(scope) {
      if (!storage) return undefined
      const value = storage.getItem(key(scope))
      if (value === null) return undefined
      try { return JSON.parse(value) as unknown } catch {
        quarantine(scope, [{ reason: 'invalid-json', raw: value }])
        return undefined
      }
    },
    save(scope, document) {
      if (!storage) throw new Error('Browser demo repository storage is unavailable')
      storage.setItem(key(scope), JSON.stringify(document))
    },
    quarantine,
  }
}

function parseDemoQuarantine(value: string | null, scope: string): readonly unknown[] {
  if (value === null) return []
  try {
    const parsed = JSON.parse(value) as unknown
    return isRecord(parsed) && parsed.version === 2 && parsed.scope === scope && Array.isArray(parsed.records) ? parsed.records : []
  } catch {
    return []
  }
}

function browserStorage(): Storage | undefined {
  if (typeof window === 'undefined') return undefined
  try { return window.localStorage } catch { return undefined }
}

function validateDraft(draft: ExpenseDraft, members: readonly Member[]): readonly ExpenseRow['allocations'][number][] {
  const active = new Set(members.map(({ id }) => id))
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
