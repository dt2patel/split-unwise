import type { Debt, Expense, Money, ParticipantId, Recurrence } from '../domain/model'
import { createDemoRepository } from './demoRepository'
import { readFirebaseConfiguration, type PublicEnvironment } from './firebase'
import { createFirebaseRepository } from './firebaseRepository'

export type SyncState = 'fresh' | 'stale' | 'pending' | 'failed' | 'conflicted'

export interface Member {
  readonly id: ParticipantId
  readonly displayName: string
  readonly initials: string
  readonly avatarUrl?: string
  readonly isCurrentUser: boolean
}

export interface Group {
  readonly id: string
  readonly name: string
  readonly currency: Money['currency']
  readonly coverImageUrl?: string
  readonly memberIds: readonly ParticipantId[]
  readonly syncState: SyncState
}

export interface ExpenseRow extends Expense {
  readonly groupId: string
  readonly category: string
  readonly createdAt: string
  readonly syncState: SyncState
  readonly recurringTemplateId?: string
}

export interface ExpenseDraft {
  readonly groupId: string
  readonly description: string
  readonly date: string
  readonly total: Money
  readonly payerId: ParticipantId
  readonly allocations: Expense['allocations']
  readonly category: string
  readonly recurringTemplateId?: string
}

export interface ExpenseComment {
  readonly id: string
  readonly expenseId: string
  readonly authorId: ParticipantId
  readonly body: string
  readonly createdAt: string
  readonly syncState: SyncState
}

export interface ActivityItem {
  readonly id: string
  readonly groupId: string
  readonly expenseId?: string
  readonly actorId: ParticipantId
  readonly type: 'comment-added' | 'expense-created' | 'expense-updated'
  readonly createdAt: string
  readonly summary: string
  readonly syncState: SyncState
}

export interface GroupTotals {
  readonly currency: Money['currency']
  readonly totalPaid: number
  readonly currentUserPaid: number
  readonly currentUserShare: number
  readonly currentUserNet: number
}

export interface GroupCharts {
  readonly categorySpending: readonly { readonly category: string; readonly minorAmount: number }[]
  readonly dailySpending: readonly { readonly date: string; readonly minorAmount: number }[]
}

export interface RecurringExpense {
  readonly id: string
  readonly groupId: string
  readonly description: string
  readonly total: Money
  readonly payerId: ParticipantId
  readonly recurrence: Recurrence
  readonly nextDate: string
  readonly syncState: SyncState
}

export interface AppRepository {
  readonly mode: 'demo' | 'firebase'
  readonly app: {
    getCurrentUser(): Promise<Member>
  }
  readonly groups: GroupRepository
  readonly expenses: ExpenseRepository
  readonly activity: ActivityRepository
}

export interface GroupRepository {
  list(): Promise<readonly Group[]>
  getById(groupId: string): Promise<Group | undefined>
  listMembers(groupId: string): Promise<readonly Member[]>
  getBalances(groupId: string): Promise<readonly Debt[]>
  getTotals(groupId: string): Promise<GroupTotals>
  getCharts(groupId: string): Promise<GroupCharts>
  listRecurring(groupId: string): Promise<readonly RecurringExpense[]>
}

export interface ExpenseRepository {
  listForGroup(groupId: string): Promise<readonly ExpenseRow[]>
  add(draft: ExpenseDraft): Promise<ExpenseRow>
  listComments(groupId: string, expenseId: string): Promise<readonly ExpenseComment[]>
}

export interface ActivityRepository {
  listForGroup(groupId: string): Promise<readonly ActivityItem[]>
}

/** Selects Firebase only when every required public Firebase setting is configured. */
export function createRepository(environment?: PublicEnvironment): AppRepository {
  const configuration = readFirebaseConfiguration(environment)
  return configuration ? createFirebaseRepository(configuration) : createDemoRepository()
}
