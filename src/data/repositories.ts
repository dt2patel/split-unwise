import type { Allocation, Debt, Expense, Money, ParticipantId, Recurrence, SplitMethod } from '../domain/model'
import type { DefaultSplit, GroupSettings } from '../domain/groupSettings'

/** A persisted command or document synchronization state. */
export type SyncState = 'fresh' | 'stale' | 'pending' | 'failed' | 'conflicted'

export interface Member {
  readonly id: ParticipantId
  readonly displayName: string
  readonly initials: string
  readonly avatarUrl?: string
  readonly isCurrentUser: boolean
  /** Unknown/omitted capability is intentionally treated as false. */
  readonly canManage?: boolean
}

export interface ActorSnapshot {
  readonly id: ParticipantId
  readonly displayName: string
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
  readonly occurrenceEditScope?: 'future' | 'occurrence'
  readonly recurringTemplateId?: string
  readonly deletedAt?: string
  readonly createdBy?: ActorSnapshot
  readonly updatedBy?: ActorSnapshot
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
  readonly occurrenceEditScope?: 'future' | 'occurrence'
}

export interface ExpenseComment {
  readonly commentId: string
  readonly groupId: string
  readonly expenseId: string
  readonly operationId: string
  readonly author: ActorSnapshot
  readonly body: string
  readonly attachmentRefs: readonly string[]
  readonly createdAt: string
  readonly deletedAt?: string
  readonly syncState: SyncState
}

export type ActivityKind =
  | 'comment.added'
  | 'comment.deleted'
  | 'expense.created'
  | 'expense.updated'
  | 'expense.deleted'
  | 'group.event'
  | 'membership.changed'
  | 'settlement.created'
  | 'settlement.voided'

export type ActivityFilter = 'all' | 'comments' | 'expenses' | 'payments'

export interface ActivitySubject {
  readonly kind: 'comment' | 'expense' | 'group' | 'membership' | 'settlement'
  readonly id: string
  readonly label?: string
}

export interface ActivityItem {
  readonly id: string
  readonly groupId: string
  readonly operationId: string
  readonly kind: ActivityKind
  readonly subject: ActivitySubject
  readonly actor: ActorSnapshot
  readonly expenseId?: string
  readonly revision?: number
  readonly commentId?: string
  readonly settlementId?: string
  readonly createdAt: string
  readonly syncState: SyncState
}

export interface ExpenseRevision {
  readonly id: string
  readonly groupId: string
  readonly expenseId: string
  readonly revision: number
  readonly operationId: string
  readonly action: 'created' | 'updated' | 'deleted'
  readonly actor: ActorSnapshot
  readonly createdAt: string
  readonly expense: ExpenseRow
}

export interface TimelineCursor { readonly createdAt: string; readonly id: string }
export interface ActivityQuery { readonly filter: ActivityFilter; readonly limit: number; readonly cursor?: TimelineCursor }
export interface ActivityPage { readonly items: readonly ActivityItem[]; readonly nextCursor?: TimelineCursor }

export interface NotificationItem {
  readonly notificationId: string
  readonly principalId: ParticipantId
  readonly groupId: string
  readonly activityId: string
  readonly kind: ActivityKind
  readonly subject: ActivitySubject
  readonly actor: ActorSnapshot
  readonly createdAt: string
  readonly readAt?: string
  readonly syncState: SyncState
}

export interface NotificationPreferences {
  readonly emailEnabled: boolean
  readonly pushEnabled: boolean
}

export interface NotificationPage { readonly items: readonly NotificationItem[]; readonly nextCursor?: TimelineCursor }

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

export interface GroupBalanceSnapshot {
  readonly groupId: string
  readonly balanceRevision: number
  readonly simplifyDebtsEnabled: boolean
  readonly pairwise: readonly Debt[]
  readonly simplified: readonly Debt[]
}

export type SettlementMethod = 'cash' | 'bank-transfer' | 'payment-app' | 'other'

export interface SettlementBasis {
  readonly kind: 'pairwise' | 'simplified'
  readonly senderId: ParticipantId
  readonly recipientId: ParticipantId
  readonly currency: Money['currency']
  readonly debtMinor: number
}

export interface SettlementVoid {
  readonly operationId: string
  readonly reason: string
  readonly actor: ActorSnapshot
  readonly createdAt: string
  readonly revision: number
}

export interface SettlementRecord {
  readonly settlementId: string
  readonly groupId: string
  readonly operationId: string
  readonly senderId: ParticipantId
  readonly recipientId: ParticipantId
  readonly money: Money
  readonly basis: SettlementBasis
  readonly method: SettlementMethod
  readonly occurredOn: string
  readonly note?: string
  readonly createdBy: ActorSnapshot
  readonly createdAt: string
  readonly revision: number
  readonly syncState: SyncState
  readonly void?: SettlementVoid
}

/** Every mutable operation owns a stable, caller-created client operation ID. */
export interface OperationRequest { readonly operationId: string }

export interface ExpenseAddCommand extends ExpenseDraft, OperationRequest { readonly kind: 'expense.add' }
export interface ExpenseEditCommand extends OperationRequest { readonly kind: 'expense.edit'; readonly groupId: string; readonly expenseId: string; readonly expectedRevision: number; readonly draft: ExpenseDraft }
export interface ExpenseDeleteCommand extends OperationRequest { readonly kind: 'expense.delete'; readonly groupId: string; readonly expenseId: string; readonly expectedRevision: number }
export interface CommentAddCommand extends OperationRequest { readonly kind: 'comment.add'; readonly groupId: string; readonly expenseId: string; readonly body: string; readonly attachmentRefs: readonly string[] }
export interface CommentDeleteCommand extends OperationRequest { readonly kind: 'comment.delete'; readonly groupId: string; readonly expenseId: string; readonly commentId: string }
export interface NotificationReadCommand extends OperationRequest { readonly kind: 'notification.read'; readonly notificationId: string }
export interface NotificationReadAllCommand extends OperationRequest { readonly kind: 'notification.read-all'; readonly cutoff: TimelineCursor }
export interface NotificationPreferencesCommand extends OperationRequest { readonly kind: 'notification.preferences'; readonly preferences: NotificationPreferences }

/** Only a confirmed manual settlement can be recorded from this client boundary. */
export interface SettlementRecordCommand extends OperationRequest {
  readonly kind: 'settlement.record'
  readonly groupId: string
  readonly expectedBalanceRevision: number
  readonly basis: SettlementBasis
  readonly money: Money
  readonly method: SettlementMethod
  readonly occurredOn: string
  readonly note?: string
  readonly outsidePaymentConfirmed: boolean
}

export interface SettlementVoidCommand extends OperationRequest {
  readonly kind: 'settlement.void'
  readonly groupId: string
  readonly settlementId: string
  readonly expectedRevision: number
  readonly expectedBalanceRevision: number
  readonly reason: string
}

export interface GroupDefaultSplitCommand extends OperationRequest {
  readonly kind: 'group.default-split'
  readonly groupId: string
  readonly expectedRevision: number
  /** `null` is an explicit versioned clear. */
  readonly defaultSplit: DefaultSplit | null
}
export interface GroupSimplifyDebtsCommand extends OperationRequest {
  readonly kind: 'group.simplify-debts'
  readonly groupId: string
  readonly expectedRevision: number
  readonly simplifyDebtsEnabled: boolean
}
export interface ProfileUpdateCommand extends OperationRequest { readonly kind: 'profile.update'; readonly displayName: string; readonly initials?: string }

export type CommandEnvelope = CommentAddCommand | CommentDeleteCommand | ExpenseAddCommand | ExpenseDeleteCommand | ExpenseEditCommand | GroupDefaultSplitCommand | GroupSimplifyDebtsCommand | NotificationPreferencesCommand | NotificationReadAllCommand | NotificationReadCommand | ProfileUpdateCommand | SettlementRecordCommand | SettlementVoidCommand
export type CommandKind = CommandEnvelope['kind']

export interface SavedExpenseAddResult { readonly kind: 'expense.add'; readonly operationId: string; readonly status: 'saved'; readonly expense: ExpenseRow }
export interface SavedExpenseEditResult { readonly kind: 'expense.edit'; readonly operationId: string; readonly status: 'saved'; readonly expense: ExpenseRow }
export interface ExpenseTombstone { readonly id: string; readonly groupId: string; readonly revision: number; readonly deletedAt: string }
export interface SavedExpenseDeleteResult { readonly kind: 'expense.delete'; readonly operationId: string; readonly status: 'saved'; readonly tombstone: ExpenseTombstone }
export interface SavedCommentAddResult { readonly kind: 'comment.add'; readonly operationId: string; readonly status: 'saved'; readonly comment: ExpenseComment; readonly activity: ActivityItem }
export interface SavedCommentDeleteResult { readonly kind: 'comment.delete'; readonly operationId: string; readonly status: 'saved'; readonly comment: ExpenseComment; readonly activity: ActivityItem }
export interface SavedNotificationReadResult { readonly kind: 'notification.read'; readonly operationId: string; readonly status: 'saved'; readonly notification: NotificationItem }
export interface SavedNotificationReadAllResult { readonly kind: 'notification.read-all'; readonly operationId: string; readonly status: 'saved'; readonly cutoff: TimelineCursor; readonly readNotificationIds: readonly string[] }
export interface SavedNotificationPreferencesResult { readonly kind: 'notification.preferences'; readonly operationId: string; readonly status: 'saved'; readonly preferences: NotificationPreferences }
export interface SavedSettlementRecordResult { readonly kind: 'settlement.record'; readonly operationId: string; readonly status: 'saved'; readonly settlement: SettlementRecord; readonly balanceSnapshot: GroupBalanceSnapshot; readonly activity: ActivityItem }
export interface SavedSettlementVoidResult { readonly kind: 'settlement.void'; readonly operationId: string; readonly status: 'saved'; readonly settlement: SettlementRecord; readonly balanceSnapshot: GroupBalanceSnapshot; readonly activity: ActivityItem }
export interface SavedCommandResult<K extends Exclude<CommandKind, 'expense.add' | 'expense.delete' | 'expense.edit'>> { readonly kind: K; readonly operationId: string; readonly status: 'saved'; readonly resourceId: string }
export interface NotSupportedCommandResult<K extends CommandKind = CommandKind> { readonly kind: K; readonly operationId: string; readonly status: 'not-supported'; readonly reason: string }

export type ExpenseAddResult = SavedExpenseAddResult | NotSupportedCommandResult<'expense.add'>
export type ExpenseEditResult = SavedExpenseEditResult | NotSupportedCommandResult<'expense.edit'>
export type ExpenseDeleteResult = SavedExpenseDeleteResult | NotSupportedCommandResult<'expense.delete'>
export type CommentAddResult = SavedCommentAddResult | NotSupportedCommandResult<'comment.add'>
export type CommentDeleteResult = SavedCommentDeleteResult | NotSupportedCommandResult<'comment.delete'>
export type NotificationReadResult = SavedNotificationReadResult | NotSupportedCommandResult<'notification.read'>
export type NotificationReadAllResult = SavedNotificationReadAllResult | NotSupportedCommandResult<'notification.read-all'>
export type NotificationPreferencesResult = SavedNotificationPreferencesResult | NotSupportedCommandResult<'notification.preferences'>
export type SettlementRecordResult = SavedSettlementRecordResult | NotSupportedCommandResult<'settlement.record'>
export type SettlementVoidResult = SavedSettlementVoidResult | NotSupportedCommandResult<'settlement.void'>
export type CommandResult = ExpenseAddResult | ExpenseDeleteResult | ExpenseEditResult | CommentAddResult | CommentDeleteResult | NotificationReadResult | NotificationReadAllResult | NotificationPreferencesResult | SettlementRecordResult | SettlementVoidResult | SavedCommandResult<'group.default-split'> | SavedCommandResult<'group.simplify-debts'> | SavedCommandResult<'profile.update'> | NotSupportedCommandResult<'group.default-split' | 'group.simplify-debts' | 'profile.update'>

export interface AppRepository {
  readonly mode: 'demo' | 'firebase'
  /** Stable backing-data project. Together with mode and UID, this owns local state. */
  readonly projectId: string
  readonly app: AppProfileRepository
  readonly groups: GroupRepository
  readonly expenses: ExpenseRepository
  readonly comments: CommentRepository
  readonly settlements: SettlementRepository
  readonly activity: ActivityRepository
  readonly notifications: NotificationRepository
  readonly commands: CommandRepository
}

export interface AppProfileRepository { getCurrentUser(): Promise<Member>; updateProfile(command: ProfileUpdateCommand): Promise<CommandResult> }
export interface GroupRepository {
  list(): Promise<readonly Group[]>
  getById(groupId: string): Promise<Group | undefined>
  listMembers(groupId: string): Promise<readonly Member[]>
  getBalanceSnapshot(groupId: string): Promise<GroupBalanceSnapshot>
  getSettings(groupId: string): Promise<GroupSettings>
  getTotals(groupId: string): Promise<readonly CurrencyTotals[]>
  getCharts(groupId: string): Promise<GroupCharts>
  listRecurring(groupId: string): Promise<readonly RecurringExpense[]>
  setDefaultSplit(command: GroupDefaultSplitCommand): Promise<CommandResult>
  setSimplifyDebts(command: GroupSimplifyDebtsCommand): Promise<CommandResult>
}
export interface ExpenseRepository {
  listForGroup(groupId: string): Promise<readonly ExpenseRow[]>
  getById(groupId: string, expenseId: string): Promise<ExpenseRow | undefined>
  add(command: ExpenseAddCommand): Promise<ExpenseAddResult>
  edit(command: ExpenseEditCommand): Promise<ExpenseEditResult>
  delete(command: ExpenseDeleteCommand): Promise<ExpenseDeleteResult>
  listRevisions(groupId: string, expenseId: string): Promise<readonly ExpenseRevision[]>
}
export interface CommentRepository {
  listForExpense(groupId: string, expenseId: string): Promise<readonly ExpenseComment[]>
  add(command: CommentAddCommand): Promise<CommentAddResult>
  delete(command: CommentDeleteCommand): Promise<CommentDeleteResult>
}
export interface SettlementRepository {
  listForGroup(groupId: string): Promise<readonly SettlementRecord[]>
  getById(groupId: string, settlementId: string): Promise<SettlementRecord | undefined>
  record(command: SettlementRecordCommand): Promise<SettlementRecordResult>
  void(command: SettlementVoidCommand): Promise<SettlementVoidResult>
}
/** Durable command boundary for offline feature stores. */
export interface CommandRepository { execute(command: CommandEnvelope): Promise<CommandResult> }
export interface ActivityRepository {
  listForGroup(groupId: string): Promise<readonly ActivityItem[]>
  listForAccount(query: ActivityQuery): Promise<ActivityPage>
}
export interface NotificationRepository {
  list(query: { readonly limit: number; readonly cursor?: TimelineCursor }): Promise<NotificationPage>
  unreadCount(): Promise<number>
  markRead(command: NotificationReadCommand): Promise<NotificationReadResult>
  markAllRead(command: NotificationReadAllCommand): Promise<NotificationReadAllResult>
  getPreferences(): Promise<NotificationPreferences>
  updatePreferences(command: NotificationPreferencesCommand): Promise<NotificationPreferencesResult>
}
