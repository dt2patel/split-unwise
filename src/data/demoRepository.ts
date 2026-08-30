import { computeBalances, simplifyDebts } from '../domain/balances'
import { computeAllocations } from '../domain/splits'
import { CommandConflictError } from './commandQueue'
import { LAKE_HOUSE_GROUP_ID, lakeHouseActivity, lakeHouseComments, lakeHouseCurrentUser, lakeHouseExpenses, lakeHouseGroup, lakeHouseMembers, lakeHouseRecurring } from '../demo/lakeHouse'
import { buildCurrencyTotals, buildGroupCharts } from './aggregates'
import { assertReplayIdentity, createOperationIdentity, type OperationIdentity } from './operationIdentity'
import type { ActivityItem, AppRepository, CommandEnvelope, CommandResult, ExpenseAddCommand, ExpenseAddResult, ExpenseComment, ExpenseDeleteCommand, ExpenseDeleteResult, ExpenseDraft, ExpenseEditCommand, ExpenseEditResult, ExpenseRow, Member } from './repositories'

/** A fresh deterministic in-memory repository; its operation ledger prevents duplicate same-ID effects. */
export function createDemoRepository(options: { readonly now?: () => string } = {}): AppRepository {
  const expenses = lakeHouseExpenses.map(cloneExpense)
  const activity = lakeHouseActivity.map((item) => ({ ...item }))
  const comments = lakeHouseComments.map((comment) => ({ ...comment }))
  const operationLedger = new Map<string, { readonly identity: OperationIdentity; readonly result: CommandResult }>()
  let currentUser = { ...lakeHouseCurrentUser }
  let nextExpenseNumber = 6
  const now = options.now ?? (() => '2026-08-30T12:00:00.000Z')

  const groupExpenses = (groupId: string): ExpenseRow[] => { assertLakeHouseGroup(groupId); return expenses.filter((expense) => expense.groupId === groupId && expense.deletedAt === undefined).sort(byDateThenId) }
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
        const allocations = validateDraft(command)
        const createdAt = now()
        const expense: ExpenseRow = {
          id: `demo-expense-${String(nextExpenseNumber).padStart(3, '0')}`, groupId: command.groupId, description: command.description, date: command.date,
          total: { ...command.total }, payments: command.payments.map(cloneAllocation), allocations: allocations.map(cloneAllocation), category: command.category,
          createdAt, updatedAt: createdAt, revision: 1, syncState: 'fresh', splitMethod: clone(command.splitMethod), attachmentRefs: [...command.attachmentRefs],
          ...(command.notes ? { notes: command.notes } : {}), ...(command.recurrence ? { recurrence: clone(command.recurrence) } : {}),
          ...(command.occurrenceEditScope ? { occurrenceEditScope: command.occurrenceEditScope } : {}),
        }
        nextExpenseNumber += 1
        expenses.push(expense)
        activity.push(activityFor(command.operationId, expense, 'expense-created', `${currentUser.displayName} added ${expense.description}`))
        return { kind: 'expense.add', operationId: command.operationId, status: 'saved', expense: cloneExpense(expense) }
      }
      case 'expense.edit': {
        assertLakeHouseGroup(command.groupId)
        const allocations = validateDraft(command.draft)
        const index = expenses.findIndex((expense) => expense.id === command.expenseId && expense.groupId === command.groupId)
        if (index < 0) throw new Error(`Unknown demo expense: ${command.expenseId}`)
        const previous = expenses[index]
        if (command.expectedRevision !== previous.revision) throw new CommandConflictError('The expense changed remotely.', { local: clone(command.draft), remote: cloneExpense(previous) })
        const { notes: _previousNotes, recurrence: _previousRecurrence, occurrenceEditScope: _previousOccurrenceEditScope, ...retained } = previous
        const updated: ExpenseRow = {
          ...retained, ...command.draft, id: previous.id, groupId: previous.groupId, createdAt: previous.createdAt, updatedAt: now(), revision: previous.revision + 1, syncState: 'fresh',
          total: { ...command.draft.total }, payments: command.draft.payments.map(cloneAllocation), allocations: allocations.map(cloneAllocation),
          splitMethod: clone(command.draft.splitMethod), attachmentRefs: [...command.draft.attachmentRefs],
        }
        expenses[index] = updated
        activity.push(activityFor(command.operationId, updated, 'expense-updated', `${currentUser.displayName} updated ${updated.description}`))
        return { kind: command.kind, operationId: command.operationId, status: 'saved', expense: cloneExpense(updated) }
      }
      case 'expense.delete': {
        assertLakeHouseGroup(command.groupId)
        const index = expenses.findIndex((expense) => expense.id === command.expenseId && expense.groupId === command.groupId)
        if (index < 0) throw new Error(`Unknown demo expense: ${command.expenseId}`)
        const previous = expenses[index]
        if (command.expectedRevision !== previous.revision) throw new CommandConflictError('The expense changed remotely.', { local: clone(command), remote: cloneExpense(previous) })
        const deletedAt = now()
        const retained: ExpenseRow = { ...previous, revision: previous.revision + 1, updatedAt: deletedAt, deletedAt }
        expenses[index] = retained
        return { kind: command.kind, operationId: command.operationId, status: 'saved', tombstone: { id: retained.id, groupId: retained.groupId, revision: retained.revision, deletedAt } }
      }
      case 'comment.add': {
        assertLakeHouseGroup(command.groupId)
        const comment: ExpenseComment = { id: `comment-${command.operationId}`, expenseId: command.expenseId, authorId: currentUser.id, body: command.body, createdAt: '2026-08-30T12:00:00.000Z', syncState: 'fresh' }
        comments.push(comment)
        activity.push({ id: `activity-${command.operationId}`, groupId: command.groupId, expenseId: command.expenseId, actorId: currentUser.id, type: 'comment-added', summary: `${currentUser.displayName} commented`, createdAt: comment.createdAt, syncState: 'fresh' })
        return saved(command, comment.id)
      }
      case 'settlement.record': {
        assertLakeHouseGroup(command.groupId)
        if (command.confirmation.kind !== 'manual') throw new Error('Only confirmed manual settlements can be recorded')
        return saved(command, `settlement-${command.operationId}`)
      }
      case 'group.default-split': assertLakeHouseGroup(command.groupId); return saved(command, command.groupId)
      case 'profile.update': {
        currentUser = { ...currentUser, displayName: command.displayName, initials: command.initials ?? initials(command.displayName) }
        return saved(command, currentUser.id)
      }
    }
  }

  return {
    mode: 'demo',
    app: { async getCurrentUser(): Promise<Member> { return { ...currentUser } }, updateProfile: execute },
    groups: {
      async list() { return [{ ...lakeHouseGroup, memberIds: [...lakeHouseGroup.memberIds] }] },
      async getById(groupId) { return groupId === LAKE_HOUSE_GROUP_ID ? { ...lakeHouseGroup, memberIds: [...lakeHouseGroup.memberIds] } : undefined },
      async listMembers(groupId) { assertLakeHouseGroup(groupId); return lakeHouseMembers.map((member) => member.id === currentUser.id ? { ...currentUser } : { ...member }) },
      async getBalances(groupId) { return simplifyDebts(computeBalances(groupExpenses(groupId))) },
      async getTotals(groupId) { return buildCurrencyTotals(groupExpenses(groupId), currentUser.id) },
      async getCharts(groupId) { return buildGroupCharts(groupExpenses(groupId)) },
      async listRecurring(groupId) { assertLakeHouseGroup(groupId); return lakeHouseRecurring.map((item) => ({ ...item, total: { ...item.total }, recurrence: { ...item.recurrence, anchor: { ...item.recurrence.anchor } } })) },
      setDefaultSplit: execute,
    },
    expenses: {
      async listForGroup(groupId) { return groupExpenses(groupId).map(cloneExpense) },
      async getById(groupId, expenseId) { assertLakeHouseGroup(groupId); const expense = expenses.find((item) => item.groupId === groupId && item.id === expenseId); return expense ? cloneExpense(expense) : undefined },
      async add(command): Promise<ExpenseAddResult> { const result = await execute(command); if (result.kind !== 'expense.add') throw new Error('Unexpected expense result'); return result },
      async edit(command): Promise<ExpenseEditResult> { const result = await execute(command); if (result.kind !== 'expense.edit') throw new Error('Unexpected expense edit result'); return result },
      async delete(command): Promise<ExpenseDeleteResult> { const result = await execute(command); if (result.kind !== 'expense.delete') throw new Error('Unexpected expense delete result'); return result },
      async listComments(groupId, expenseId) { assertLakeHouseGroup(groupId); return comments.filter((comment) => comment.expenseId === expenseId).map((comment) => ({ ...comment })) },
    },
    comments: { add: execute },
    settlements: { record: execute },
    activity: { async listForGroup(groupId): Promise<readonly ActivityItem[]> { assertLakeHouseGroup(groupId); return activity.filter((item) => item.groupId === groupId).sort((left, right) => left.createdAt.localeCompare(right.createdAt)).map((item) => ({ ...item })) } },
    commands: { execute },
  }
}

function saved(command: Exclude<CommandEnvelope, ExpenseAddCommand | ExpenseDeleteCommand | ExpenseEditCommand>, resourceId: string): CommandResult {
  switch (command.kind) {
    case 'comment.add': return { kind: command.kind, operationId: command.operationId, status: 'saved', resourceId }
    case 'group.default-split': return { kind: command.kind, operationId: command.operationId, status: 'saved', resourceId }
    case 'profile.update': return { kind: command.kind, operationId: command.operationId, status: 'saved', resourceId }
    case 'settlement.record': return { kind: command.kind, operationId: command.operationId, status: 'saved', resourceId }
  }
}
function activityFor(operationId: string, expense: ExpenseRow, type: 'expense-created' | 'expense-updated', summary: string): ActivityItem { return { id: `activity-${operationId}`, groupId: expense.groupId, expenseId: expense.id, actorId: 'maya-p', type, summary, createdAt: expense.createdAt, syncState: 'fresh' } }
function assertLakeHouseGroup(groupId: string): void { if (groupId !== LAKE_HOUSE_GROUP_ID) throw new Error(`Unknown demo group: ${groupId}`) }
function cloneAllocation(allocation: ExpenseRow['allocations'][number]): ExpenseRow['allocations'][number] { return { participantId: allocation.participantId, money: { ...allocation.money } } }
function cloneExpense(expense: ExpenseRow): ExpenseRow { return clone(expense) }
function byDateThenId(left: ExpenseRow, right: ExpenseRow): number { return left.date.localeCompare(right.date) || left.id.localeCompare(right.id) }
function initials(displayName: string): string { return displayName.split(/\s+/).filter(Boolean).map((part) => part[0]).join('').slice(0, 2).toUpperCase() }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }

function validateDraft(draft: ExpenseDraft): readonly ExpenseRow['allocations'][number][] {
  const active = new Set(lakeHouseMembers.map(({ id }) => id))
  const assertActive = (participantId: string, label: string) => { if (!active.has(participantId)) throw new Error(`${label} must be an active group member`) }
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
