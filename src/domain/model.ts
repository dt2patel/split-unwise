/** ISO 4217 currency values are stored as integer minor units. */
export interface Money {
  readonly currency: string
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
  readonly payerId: ParticipantId
  readonly allocations: readonly Allocation[]
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

export type Recurrence =
  | { readonly frequency: 'weekly' }
  | { readonly frequency: 'fortnightly' }
  | { readonly frequency: 'monthly' }
  | { readonly frequency: 'yearly' }
