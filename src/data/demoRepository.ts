import { computeBalances, simplifyDebts } from '../domain/balances'
import { LAKE_HOUSE_GROUP_ID, lakeHouseActivity, lakeHouseComments, lakeHouseCurrentUser, lakeHouseExpenses, lakeHouseGroup, lakeHouseMembers, lakeHouseRecurring } from '../demo/lakeHouse'
import type { ActivityItem, AppRepository, CommandEnvelope, CommandResult, CurrencyTotals, ExpenseAddCommand, ExpenseAddResult, ExpenseComment, ExpenseRow, GroupCharts, Member } from './repositories'

/** A fresh deterministic in-memory repository; its operation ledger prevents duplicate same-ID effects. */
export function createDemoRepository(): AppRepository {
  const expenses = lakeHouseExpenses.map(cloneExpense)
  const activity = lakeHouseActivity.map((item) => ({ ...item }))
  const comments = lakeHouseComments.map((comment) => ({ ...comment }))
  const operationLedger = new Map<string, CommandResult>()
  let currentUser = { ...lakeHouseCurrentUser }
  let nextExpenseNumber = 6

  const groupExpenses = (groupId: string): ExpenseRow[] => { assertLakeHouseGroup(groupId); return expenses.filter((expense) => expense.groupId === groupId).sort(byDateThenId) }
  const execute = async (command: CommandEnvelope): Promise<CommandResult> => {
    const existing = operationLedger.get(command.operationId)
    if (existing) {
      if (existing.kind !== command.kind) throw new Error(`Operation ID ${command.operationId} already belongs to ${existing.kind}`)
      return clone(existing)
    }
    const result = executeNew(command)
    operationLedger.set(command.operationId, result)
    return clone(result)
  }

  const executeNew = (command: CommandEnvelope): CommandResult => {
    switch (command.kind) {
      case 'expense.add': {
        assertLakeHouseGroup(command.groupId)
        const expense: ExpenseRow = {
          id: `demo-expense-${String(nextExpenseNumber).padStart(3, '0')}`, groupId: command.groupId, description: command.description, date: command.date,
          total: { ...command.total }, payerId: command.payerId, allocations: command.allocations.map(cloneAllocation), category: command.category,
          createdAt: `${command.date}T12:00:00.000Z`, syncState: 'fresh', ...(command.recurringTemplateId ? { recurringTemplateId: command.recurringTemplateId } : {}),
        }
        nextExpenseNumber += 1
        expenses.push(expense)
        activity.push(activityFor(command.operationId, expense, 'expense-created', `${currentUser.displayName} added ${expense.description}`))
        return { kind: 'expense.add', operationId: command.operationId, status: 'saved', expense: cloneExpense(expense) }
      }
      case 'expense.edit': {
        assertLakeHouseGroup(command.groupId)
        const index = expenses.findIndex((expense) => expense.id === command.expenseId && expense.groupId === command.groupId)
        if (index < 0) throw new Error(`Unknown demo expense: ${command.expenseId}`)
        const previous = expenses[index]
        const updated: ExpenseRow = { ...previous, ...command.draft, id: previous.id, groupId: previous.groupId, createdAt: previous.createdAt, syncState: 'fresh', total: { ...command.draft.total }, allocations: command.draft.allocations.map(cloneAllocation) }
        expenses[index] = updated
        activity.push(activityFor(command.operationId, updated, 'expense-updated', `${currentUser.displayName} updated ${updated.description}`))
        return saved(command, updated.id)
      }
      case 'expense.delete': {
        assertLakeHouseGroup(command.groupId)
        const index = expenses.findIndex((expense) => expense.id === command.expenseId && expense.groupId === command.groupId)
        if (index < 0) throw new Error(`Unknown demo expense: ${command.expenseId}`)
        expenses.splice(index, 1)
        return saved(command, command.expenseId)
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
      async getTotals(groupId): Promise<readonly CurrencyTotals[]> { return totalsFor(groupExpenses(groupId), currentUser.id) },
      async getCharts(groupId): Promise<GroupCharts> { return chartsFor(groupExpenses(groupId)) },
      async listRecurring(groupId) { assertLakeHouseGroup(groupId); return lakeHouseRecurring.map((item) => ({ ...item, total: { ...item.total }, recurrence: { ...item.recurrence, anchor: { ...item.recurrence.anchor } } })) },
      setDefaultSplit: execute,
    },
    expenses: {
      async listForGroup(groupId) { return groupExpenses(groupId).map(cloneExpense) },
      async add(command): Promise<ExpenseAddResult> { const result = await execute(command); if (result.kind !== 'expense.add') throw new Error('Unexpected expense result'); return result },
      edit: execute,
      delete: execute,
      async listComments(groupId, expenseId) { assertLakeHouseGroup(groupId); return comments.filter((comment) => comment.expenseId === expenseId).map((comment) => ({ ...comment })) },
    },
    comments: { add: execute },
    settlements: { record: execute },
    activity: { async listForGroup(groupId): Promise<readonly ActivityItem[]> { assertLakeHouseGroup(groupId); return activity.filter((item) => item.groupId === groupId).sort((left, right) => left.createdAt.localeCompare(right.createdAt)).map((item) => ({ ...item })) } },
    commands: { execute },
  }
}

function totalsFor(rows: readonly ExpenseRow[], currentUserId: string): readonly CurrencyTotals[] {
  return [...new Set(rows.map((row) => row.total.currency))].sort().map((currency) => {
    const matching = rows.filter((row) => row.total.currency === currency)
    const currentUserPaid = matching.filter((row) => row.payerId === currentUserId).reduce((total, row) => total + row.total.minorAmount, 0)
    const currentUserShare = matching.reduce((total, row) => total + (row.allocations.find(({ participantId }) => participantId === currentUserId)?.money.minorAmount ?? 0), 0)
    return { currency, totalPaid: matching.reduce((total, row) => total + row.total.minorAmount, 0), currentUserPaid, currentUserShare, currentUserNet: currentUserPaid - currentUserShare }
  })
}
function chartsFor(rows: readonly ExpenseRow[]): GroupCharts {
  return {
    categorySpending: sumRows(rows, (row) => row.category, true).map(([currency, category, minorAmount]) => ({ currency, category, minorAmount })),
    dailySpending: sumRows(rows, (row) => row.date, false).map(([currency, date, minorAmount]) => ({ currency, date, minorAmount })),
  }
}
function sumRows(rows: readonly ExpenseRow[], key: (row: ExpenseRow) => string, sortByAmount: boolean): readonly (readonly [ExpenseRow['total']['currency'], string, number])[] {
  const totals = new Map<string, number>()
  rows.forEach((row) => { const id = `${row.total.currency}\u0000${key(row)}`; totals.set(id, (totals.get(id) ?? 0) + row.total.minorAmount) })
  return [...totals].map(([id, amount]) => { const [currency, name] = id.split('\u0000'); return [currency as ExpenseRow['total']['currency'], name, amount] as const })
    .sort(([leftCurrency, leftName, leftAmount], [rightCurrency, rightName, rightAmount]) => leftCurrency.localeCompare(rightCurrency) || (sortByAmount ? rightAmount - leftAmount : 0) || leftName.localeCompare(rightName))
}
function saved(command: Exclude<CommandEnvelope, ExpenseAddCommand>, resourceId: string): CommandResult {
  switch (command.kind) {
    case 'comment.add': return { kind: command.kind, operationId: command.operationId, status: 'saved', resourceId }
    case 'expense.delete': return { kind: command.kind, operationId: command.operationId, status: 'saved', resourceId }
    case 'expense.edit': return { kind: command.kind, operationId: command.operationId, status: 'saved', resourceId }
    case 'group.default-split': return { kind: command.kind, operationId: command.operationId, status: 'saved', resourceId }
    case 'profile.update': return { kind: command.kind, operationId: command.operationId, status: 'saved', resourceId }
    case 'settlement.record': return { kind: command.kind, operationId: command.operationId, status: 'saved', resourceId }
  }
}
function activityFor(operationId: string, expense: ExpenseRow, type: 'expense-created' | 'expense-updated', summary: string): ActivityItem { return { id: `activity-${operationId}`, groupId: expense.groupId, expenseId: expense.id, actorId: 'maya-p', type, summary, createdAt: expense.createdAt, syncState: 'fresh' } }
function assertLakeHouseGroup(groupId: string): void { if (groupId !== LAKE_HOUSE_GROUP_ID) throw new Error(`Unknown demo group: ${groupId}`) }
function cloneAllocation(allocation: ExpenseRow['allocations'][number]): ExpenseRow['allocations'][number] { return { participantId: allocation.participantId, money: { ...allocation.money } } }
function cloneExpense(expense: ExpenseRow): ExpenseRow { return { ...expense, total: { ...expense.total }, allocations: expense.allocations.map(cloneAllocation) } }
function byDateThenId(left: ExpenseRow, right: ExpenseRow): number { return left.date.localeCompare(right.date) || left.id.localeCompare(right.id) }
function initials(displayName: string): string { return displayName.split(/\s+/).filter(Boolean).map((part) => part[0]).join('').slice(0, 2).toUpperCase() }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
