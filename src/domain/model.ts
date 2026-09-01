import type { CurrencyCode } from './money'

/** ISO 4217 currency values are stored as integer minor units. */
export interface Money {
  readonly currency: CurrencyCode
  readonly minorAmount: number
}

export type ParticipantId = string

export interface Allocation {
  readonly participantId: ParticipantId
  readonly money: Money
}

export interface Expense {
  readonly id: string
  readonly description: string
  readonly date: string
  readonly total: Money
  readonly payments: readonly Allocation[]
  readonly allocations: readonly Allocation[]
  /** A refund received by the payers and owed back to the allocated participants. */
  readonly reimbursement?: true
}

export interface ExactSplit {
  readonly type: 'exact'
  readonly allocations: readonly Allocation[]
}

export interface EqualSplit {
  readonly type: 'equal'
  readonly participantIds: readonly ParticipantId[]
}

export interface PercentageSplit {
  readonly type: 'percentage'
  readonly participantIds: readonly ParticipantId[]
  readonly percentages: Readonly<Record<ParticipantId, number>>
}

export interface SharesSplit {
  readonly type: 'shares'
  readonly participantIds: readonly ParticipantId[]
  readonly shares: Readonly<Record<ParticipantId, number>>
}

/** Fixed minor-unit adjustments are applied before the residual is shared equally. */
export interface AdjustmentSplit {
  readonly type: 'adjustment'
  readonly participantIds: readonly ParticipantId[]
  readonly adjustments: Readonly<Record<ParticipantId, number>>
}

export interface ItemizedSplitItem {
  readonly description: string
  readonly money: Money
  readonly participantIds: readonly ParticipantId[]
}

export interface ItemizedSplit {
  readonly type: 'itemized'
  readonly items: readonly ItemizedSplitItem[]
}

export type SplitMethod =
  | AdjustmentSplit
  | EqualSplit
  | ExactSplit
  | ItemizedSplit
  | PercentageSplit
  | SharesSplit

export interface PairwiseBalance {
  /** Lexicographically first participant in a canonical pair. */
  readonly fromParticipantId: ParticipantId
  /** Lexicographically second participant in a canonical pair. */
  readonly toParticipantId: ParticipantId
  /** Positive means `fromParticipantId` owes `toParticipantId`; negative reverses it. */
  readonly money: Money
}

export interface Debt {
  readonly fromParticipantId: ParticipantId
  readonly toParticipantId: ParticipantId
  /** Simplified debts are always strictly positive. */
  readonly money: Money
}

/** A saved outside payment applied to the ledger. Voided transfers remain audit data but do not affect balances. */
export interface SettlementTransfer {
  readonly id: string
  readonly senderId: ParticipantId
  readonly recipientId: ParticipantId
  readonly money: Money
  readonly voided?: boolean
}

export interface BalancePlans {
  readonly pairwise: readonly Debt[]
  readonly simplified: readonly Debt[]
}

/** Original calendar position retained by a recurring template across clamped occurrences. */
export interface RecurrenceAnchor {
  readonly month: number
  readonly day: number
}

export type Recurrence =
  | { readonly frequency: 'weekly'; readonly anchor: RecurrenceAnchor; readonly timeZone: string }
  | { readonly frequency: 'fortnightly'; readonly anchor: RecurrenceAnchor; readonly timeZone: string }
  | { readonly frequency: 'monthly'; readonly anchor: RecurrenceAnchor; readonly timeZone: string }
  | { readonly frequency: 'yearly'; readonly anchor: RecurrenceAnchor; readonly timeZone: string }
