import { computeLedgerBalancePlans, computeSignedBalances, simplifyLedgerDebts } from '@split-unwise/shared'
import type { BalancePlans, Expense, PairwiseBalance, SettlementTransfer } from './model'

export function computeBalances(expenses: readonly Expense[]): readonly PairwiseBalance[] {
  return computeSignedBalances(expenses)
}

export function simplifyDebts(balances: readonly PairwiseBalance[]): BalancePlans['simplified'] {
  return simplifyLedgerDebts(balances)
}

export function computeBalancePlans(expenses: readonly Expense[], settlements: readonly SettlementTransfer[] = []): BalancePlans {
  return computeLedgerBalancePlans(expenses, settlements)
}
