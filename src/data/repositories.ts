import type { Allocation, Debt, Expense, Money, ParticipantId, Recurrence, SplitMethod } from '../domain/model'

/** A persisted command or document synchronization state. */
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
  readonly updatedAt: string
  readonly revision: number
  readonly syncState: SyncState
  readonly splitMethod: SplitMethod
  readonly notes?: string
  readonly attachmentRefs: readonly string[]
  readonly recurrence?: Recurrence
  readonly occurrenceEditScope?: 'future' | 'single'
  readonly recurringTemplateId?: string
  readonly deletedAt?: string
}

export interface ExpenseDraft {
  readonly groupId: string
  readonly description: string
  readonly date: string
  readonly total: Money
  readonly payments: readonly Allocation[]
  readonly allocations: Expense['allocations']
  readonly category: string
  readonly splitMethod: SplitMethod
  readonly notes?: string
  readonly attachmentRefs: readonly string[]
  readonly recurrence?: Recurrence
  readonly occurrenceEditScope?: 'future' | 'single'
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

export interface CurrencyTotals {
  readonly currency: Money['currency']
  readonly totalPaid: number
  readonly currentUserPaid: number
  readonly currentUserShare: number
  readonly currentUserNet: number
}

export interface GroupCharts {
  readonly categorySpending: readonly { readonly currency: Money['currency']; readonly category: string; readonly minorAmount: number }[]
  readonly dailySpending: readonly { readonly currency: Money['currency']; readonly date: string; readonly minorAmount: number }[]
}

export interface RecurringExpense {
  readonly id: string
  readonly groupId: string
  readonly description: string
  readonly total: Money
  readonly payments: readonly Allocation[]
  readonly recurrence: Recurrence
  readonly nextDate: string
  readonly syncState: SyncState
}

/** Every mutable operation owns a stable, caller-created client operation ID. */
export interface OperationRequest { readonly operationId: string }

export interface ExpenseAddCommand extends ExpenseDraft, OperationRequest { readonly kind: 'expense.add' }
export interface ExpenseEditCommand extends OperationRequest { readonly kind: 'expense.edit'; readonly groupId: string; readonly expenseId: string; readonly expectedRevision: number; readonly draft: ExpenseDraft }
export interface ExpenseDeleteCommand extends OperationRequest { readonly kind: 'expense.delete'; readonly groupId: string; readonly expenseId: string }
export interface CommentAddCommand extends OperationRequest { readonly kind: 'comment.add'; readonly groupId: string; readonly expenseId: string; readonly body: string }

/** Only a confirmed manual settlement can be recorded from this client boundary. */
export interface SettlementRecordCommand extends OperationRequest {
  readonly kind: 'settlement.record'
  readonly groupId: string
  readonly fromParticipantId: ParticipantId
  readonly toParticipantId: ParticipantId
  readonly money: Money
  readonly confirmation: { readonly kind: 'manual'; readonly confirmedAt: string }
}

export interface GroupDefaultSplitCommand extends OperationRequest { readonly kind: 'group.default-split'; readonly groupId: string; readonly defaultSplit: SplitMethod }
export interface ProfileUpdateCommand extends OperationRequest { readonly kind: 'profile.update'; readonly displayName: string; readonly initials?: string }

export type CommandEnvelope = CommentAddCommand | ExpenseAddCommand | ExpenseDeleteCommand | ExpenseEditCommand | GroupDefaultSplitCommand | ProfileUpdateCommand | SettlementRecordCommand
export type CommandKind = CommandEnvelope['kind']

export interface SavedExpenseAddResult { readonly kind: 'expense.add'; readonly operationId: string; readonly status: 'saved'; readonly expense: ExpenseRow }
export interface SavedExpenseEditResult { readonly kind: 'expense.edit'; readonly operationId: string; readonly status: 'saved'; readonly expense: ExpenseRow }
export interface ExpenseTombstone { readonly id: string; readonly groupId: string; readonly revision: number; readonly deletedAt: string }
export interface SavedExpenseDeleteResult { readonly kind: 'expense.delete'; readonly operationId: string; readonly status: 'saved'; readonly tombstone: ExpenseTombstone }
export interface SavedCommandResult<K extends Exclude<CommandKind, 'expense.add' | 'expense.delete' | 'expense.edit'>> { readonly kind: K; readonly operationId: string; readonly status: 'saved'; readonly resourceId: string }
export interface NotSupportedCommandResult<K extends CommandKind = CommandKind> { readonly kind: K; readonly operationId: string; readonly status: 'not-supported'; readonly reason: string }

export type ExpenseAddResult = SavedExpenseAddResult | NotSupportedCommandResult<'expense.add'>
export type ExpenseEditResult = SavedExpenseEditResult | NotSupportedCommandResult<'expense.edit'>
export type ExpenseDeleteResult = SavedExpenseDeleteResult | NotSupportedCommandResult<'expense.delete'>
export type CommandResult = ExpenseAddResult | ExpenseDeleteResult | ExpenseEditResult | SavedCommandResult<'comment.add'> | SavedCommandResult<'group.default-split'> | SavedCommandResult<'profile.update'> | SavedCommandResult<'settlement.record'> | NotSupportedCommandResult<Exclude<CommandKind, 'expense.add' | 'expense.delete' | 'expense.edit'>>

export interface AppRepository {
  readonly mode: 'demo' | 'firebase'
  readonly app: AppProfileRepository
  readonly groups: GroupRepository
  readonly expenses: ExpenseRepository
  readonly comments: CommentRepository
  readonly settlements: SettlementRepository
  readonly activity: ActivityRepository
  readonly commands: CommandRepository
}

export interface AppProfileRepository { getCurrentUser(): Promise<Member>; updateProfile(command: ProfileUpdateCommand): Promise<CommandResult> }
export interface GroupRepository {
  list(): Promise<readonly Group[]>
  getById(groupId: string): Promise<Group | undefined>
  listMembers(groupId: string): Promise<readonly Member[]>
  getBalances(groupId: string): Promise<readonly Debt[]>
  getTotals(groupId: string): Promise<readonly CurrencyTotals[]>
  getCharts(groupId: string): Promise<GroupCharts>
  listRecurring(groupId: string): Promise<readonly RecurringExpense[]>
  setDefaultSplit(command: GroupDefaultSplitCommand): Promise<CommandResult>
}
export interface ExpenseRepository {
  listForGroup(groupId: string): Promise<readonly ExpenseRow[]>
  getById(groupId: string, expenseId: string): Promise<ExpenseRow | undefined>
  add(command: ExpenseAddCommand): Promise<ExpenseAddResult>
  edit(command: ExpenseEditCommand): Promise<ExpenseEditResult>
  delete(command: ExpenseDeleteCommand): Promise<ExpenseDeleteResult>
  listComments(groupId: string, expenseId: string): Promise<readonly ExpenseComment[]>
}
export interface CommentRepository { add(command: CommentAddCommand): Promise<CommandResult> }
export interface SettlementRepository { record(command: SettlementRecordCommand): Promise<CommandResult> }
/** Durable command boundary for offline feature stores. */
export interface CommandRepository { execute(command: CommandEnvelope): Promise<CommandResult> }
export interface ActivityRepository { listForGroup(groupId: string): Promise<readonly ActivityItem[]> }
