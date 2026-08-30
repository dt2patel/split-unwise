import type { Debt, Expense, PairwiseBalance, ParticipantId } from './model'

/**
 * Returns one canonical signed balance per unordered participant pair and currency.
 * A positive minor amount means `fromParticipantId` owes `toParticipantId`.
 */
export function computeBalances(expenses: readonly Expense[]): readonly PairwiseBalance[] {
  const balances = new Map<string, PairwiseBalance>()

  for (const expense of expenses) {
    validateExpense(expense)
    for (const allocation of expense.allocations) {
      if (allocation.participantId === expense.payerId || allocation.money.minorAmount === 0) continue
      const [fromParticipantId, toParticipantId] = orderedPair(allocation.participantId, expense.payerId)
      const direction = fromParticipantId === allocation.participantId ? 1 : -1
      const key = `${expense.total.currency}\u0000${fromParticipantId}\u0000${toParticipantId}`
      const existing = balances.get(key)
      const minorAmount = (existing?.money.minorAmount ?? 0) + direction * allocation.money.minorAmount
      balances.set(key, {
        fromParticipantId,
        toParticipantId,
        money: { currency: expense.total.currency, minorAmount },
      })
    }
  }

  return [...balances.values()]
    .filter((balance) => balance.money.minorAmount !== 0)
    .sort(compareBalance)
}

/** Creates a deterministic, positive-only repayment plan that preserves every net position by currency. */
export function simplifyDebts(balances: readonly PairwiseBalance[]): readonly Debt[] {
  const netByCurrency = new Map<string, Map<ParticipantId, number>>()

  for (const balance of balances) {
    if (!Number.isSafeInteger(balance.money.minorAmount)) throw new Error('Balance must be a safe integer')
    const net = netByCurrency.get(balance.money.currency) ?? new Map<ParticipantId, number>()
    net.set(balance.fromParticipantId, (net.get(balance.fromParticipantId) ?? 0) - balance.money.minorAmount)
    net.set(balance.toParticipantId, (net.get(balance.toParticipantId) ?? 0) + balance.money.minorAmount)
    netByCurrency.set(balance.money.currency, net)
  }

  const debts: Debt[] = []
  for (const [currency, net] of [...netByCurrency].sort(([left], [right]) => compareStrings(left, right))) {
    const debtors = [...net]
      .filter(([, minorAmount]) => minorAmount < 0)
      .map(([participantId, minorAmount]) => ({ participantId, remaining: -minorAmount }))
      .sort((left, right) => compareStrings(left.participantId, right.participantId))
    const creditors = [...net]
      .filter(([, minorAmount]) => minorAmount > 0)
      .map(([participantId, minorAmount]) => ({ participantId, remaining: minorAmount }))
      .sort((left, right) => compareStrings(left.participantId, right.participantId))

    let debtorIndex = 0
    let creditorIndex = 0
    while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
      const debtor = debtors[debtorIndex]
      const creditor = creditors[creditorIndex]
      const minorAmount = Math.min(debtor.remaining, creditor.remaining)
      debts.push({
        fromParticipantId: debtor.participantId,
        toParticipantId: creditor.participantId,
        money: { currency, minorAmount },
      })
      debtor.remaining -= minorAmount
      creditor.remaining -= minorAmount
      if (debtor.remaining === 0) debtorIndex += 1
      if (creditor.remaining === 0) creditorIndex += 1
    }
  }

  return debts
}

function validateExpense(expense: Expense): void {
  if (expense.total.minorAmount < 0 || !Number.isSafeInteger(expense.total.minorAmount)) {
    throw new Error('Expense total must be a non-negative safe integer')
  }
  let allocationTotal = 0
  for (const allocation of expense.allocations) {
    if (allocation.money.currency !== expense.total.currency) throw new Error('Allocation currency must match expense currency')
    if (allocation.money.minorAmount < 0 || !Number.isSafeInteger(allocation.money.minorAmount)) {
      throw new Error('Allocation must be a non-negative safe integer')
    }
    allocationTotal += allocation.money.minorAmount
  }
  if (allocationTotal !== expense.total.minorAmount) throw new Error('Expense allocations must equal its total')
}

function orderedPair(left: ParticipantId, right: ParticipantId): readonly [ParticipantId, ParticipantId] {
  return compareStrings(left, right) <= 0 ? [left, right] : [right, left]
}

function compareBalance(left: PairwiseBalance, right: PairwiseBalance): number {
  return compareStrings(left.money.currency, right.money.currency)
    || compareStrings(left.fromParticipantId, right.fromParticipantId)
    || compareStrings(left.toParticipantId, right.toParticipantId)
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
