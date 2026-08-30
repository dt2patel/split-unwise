import { computeBalances, simplifyDebts } from '../domain/balances'
import {
  LAKE_HOUSE_GROUP_ID,
  lakeHouseActivity,
  lakeHouseComments,
  lakeHouseCurrentUser,
  lakeHouseExpenses,
  lakeHouseGroup,
  lakeHouseMembers,
  lakeHouseRecurring,
} from '../demo/lakeHouse'
import type {
  ActivityItem,
  AppRepository,
  ExpenseComment,
  ExpenseDraft,
  ExpenseRow,
  GroupCharts,
  GroupTotals,
  Member,
} from './repositories'

/** A fresh in-memory repository instance for deterministic demos and tests. */
export function createDemoRepository(): AppRepository {
  const expenses = lakeHouseExpenses.map(cloneExpense)
  const activity = lakeHouseActivity.map((item) => ({ ...item }))
  const comments = lakeHouseComments.map((comment) => ({ ...comment }))
  let nextExpenseNumber = 6

  function groupExpenses(groupId: string): ExpenseRow[] {
    assertLakeHouseGroup(groupId)
    return expenses.filter((expense) => expense.groupId === groupId).sort(byDateThenId)
  }

  return {
    mode: 'demo',
    app: {
      async getCurrentUser(): Promise<Member> { return { ...lakeHouseCurrentUser } },
    },
    groups: {
      async list() { return [{ ...lakeHouseGroup, memberIds: [...lakeHouseGroup.memberIds] }] },
      async getById(groupId) { return groupId === LAKE_HOUSE_GROUP_ID ? { ...lakeHouseGroup, memberIds: [...lakeHouseGroup.memberIds] } : undefined },
      async listMembers(groupId) { assertLakeHouseGroup(groupId); return lakeHouseMembers.map((member) => ({ ...member })) },
      async getBalances(groupId) { return simplifyDebts(computeBalances(groupExpenses(groupId))) },
      async getTotals(groupId): Promise<GroupTotals> {
        const rows = groupExpenses(groupId)
        const currentUserPaid = rows.filter((row) => row.payerId === lakeHouseCurrentUser.id).reduce((total, row) => total + row.total.minorAmount, 0)
        const currentUserShare = rows.reduce((total, row) => total + (row.allocations.find(({ participantId }) => participantId === lakeHouseCurrentUser.id)?.money.minorAmount ?? 0), 0)
        return { currency: 'USD', totalPaid: rows.reduce((total, row) => total + row.total.minorAmount, 0), currentUserPaid, currentUserShare, currentUserNet: currentUserPaid - currentUserShare }
      },
      async getCharts(groupId): Promise<GroupCharts> {
        const rows = groupExpenses(groupId)
        return {
          categorySpending: sumCategorySpending(rows),
          dailySpending: sumDailySpending(rows),
        }
      },
      async listRecurring(groupId) { assertLakeHouseGroup(groupId); return lakeHouseRecurring.map((item) => ({ ...item, total: { ...item.total }, recurrence: { ...item.recurrence, anchor: { ...item.recurrence.anchor } } })) },
    },
    expenses: {
      async listForGroup(groupId) { return groupExpenses(groupId).map(cloneExpense) },
      async add(draft: ExpenseDraft): Promise<ExpenseRow> {
        assertLakeHouseGroup(draft.groupId)
        const expense: ExpenseRow = {
          id: `demo-expense-${String(nextExpenseNumber).padStart(3, '0')}`,
          groupId: draft.groupId,
          description: draft.description,
          date: draft.date,
          total: { ...draft.total },
          payerId: draft.payerId,
          allocations: draft.allocations.map((allocation) => ({ participantId: allocation.participantId, money: { ...allocation.money } })),
          category: draft.category,
          createdAt: `${draft.date}T12:00:00.000Z`,
          syncState: 'fresh',
          ...(draft.recurringTemplateId ? { recurringTemplateId: draft.recurringTemplateId } : {}),
        }
        nextExpenseNumber += 1
        expenses.push(expense)
        activity.push({
          id: `activity-${expense.id}`,
          groupId: expense.groupId,
          expenseId: expense.id,
          actorId: lakeHouseCurrentUser.id,
          type: 'expense-created',
          summary: `${lakeHouseCurrentUser.displayName} added ${expense.description}`,
          createdAt: expense.createdAt,
          syncState: 'fresh',
        })
        return cloneExpense(expense)
      },
      async listComments(groupId, expenseId): Promise<readonly ExpenseComment[]> {
        assertLakeHouseGroup(groupId)
        return comments.filter((comment) => comment.expenseId === expenseId).map((comment) => ({ ...comment }))
      },
    },
    activity: {
      async listForGroup(groupId): Promise<readonly ActivityItem[]> {
        assertLakeHouseGroup(groupId)
        return activity.filter((item) => item.groupId === groupId).sort((left, right) => left.createdAt.localeCompare(right.createdAt)).map((item) => ({ ...item }))
      },
    },
  }
}

function assertLakeHouseGroup(groupId: string): void {
  if (groupId !== LAKE_HOUSE_GROUP_ID) throw new Error(`Unknown demo group: ${groupId}`)
}

function cloneExpense(expense: ExpenseRow): ExpenseRow {
  return { ...expense, total: { ...expense.total }, allocations: expense.allocations.map((allocation) => ({ participantId: allocation.participantId, money: { ...allocation.money } })) }
}

function byDateThenId(left: ExpenseRow, right: ExpenseRow): number {
  return left.date.localeCompare(right.date) || left.id.localeCompare(right.id)
}

function sumCategorySpending(rows: readonly ExpenseRow[]): GroupCharts['categorySpending'] {
  const totals = new Map<string, number>()
  rows.forEach((row) => totals.set(row.category, (totals.get(row.category) ?? 0) + row.total.minorAmount))
  return [...totals]
    .sort(([leftName, leftAmount], [rightName, rightAmount]) => rightAmount - leftAmount || leftName.localeCompare(rightName))
    .map(([category, minorAmount]) => ({ category, minorAmount }))
}

function sumDailySpending(rows: readonly ExpenseRow[]): GroupCharts['dailySpending'] {
  const totals = new Map<string, number>()
  rows.forEach((row) => totals.set(row.date, (totals.get(row.date) ?? 0) + row.total.minorAmount))
  return [...totals].sort(([left], [right]) => left.localeCompare(right)).map(([date, minorAmount]) => ({ date, minorAmount }))
}
