import type { BalancePlans, Debt, Expense, PairwiseBalance, ParticipantId, SettlementTransfer } from './model'
import { assertCurrencyCode } from './money'

/**
 * Returns one canonical signed balance per unordered participant pair and currency.
 * A positive minor amount means `fromParticipantId` owes `toParticipantId`.
 */
export function computeBalances(expenses: readonly Expense[]): readonly PairwiseBalance[] {
  const balances = new Map<string, { readonly fromParticipantId: ParticipantId; readonly toParticipantId: ParticipantId; readonly currency: string; readonly minorAmount: bigint }>()

  for (const expense of expenses) {
    validateExpense(expense)
    const nets = expenseNets(expense)
    const debtors = [...nets]
      .filter(([, net]) => net < 0n)
      .map(([participantId, net]) => ({ participantId, remaining: -net }))
      .sort((left, right) => compareStrings(left.participantId, right.participantId))
    const creditors = [...nets]
      .filter(([, net]) => net > 0n)
      .map(([participantId, net]) => ({ participantId, remaining: net }))
      .sort((left, right) => compareStrings(left.participantId, right.participantId))
    let debtorIndex = 0
    let creditorIndex = 0
    while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
      const debtor = debtors[debtorIndex]
      const creditor = creditors[creditorIndex]
      const obligation = debtor.remaining < creditor.remaining ? debtor.remaining : creditor.remaining
      const [fromParticipantId, toParticipantId] = orderedPair(debtor.participantId, creditor.participantId)
      const direction = fromParticipantId === debtor.participantId ? 1n : -1n
      const key = `${expense.total.currency}\u0000${fromParticipantId}\u0000${toParticipantId}`
      const existing = balances.get(key)
      const minorAmount = (existing?.minorAmount ?? 0n) + direction * obligation
      balances.set(key, {
        fromParticipantId,
        toParticipantId,
        currency: expense.total.currency,
        minorAmount,
      })
      debtor.remaining -= obligation
      creditor.remaining -= obligation
      if (debtor.remaining === 0n) debtorIndex += 1
      if (creditor.remaining === 0n) creditorIndex += 1
    }
  }

  return [...balances.values()]
    .filter((balance) => balance.minorAmount !== 0n)
    .map(({ fromParticipantId, toParticipantId, currency, minorAmount }) => ({
      fromParticipantId,
      toParticipantId,
      money: { currency: assertCurrency(currency), minorAmount: toSafeSignedNumber(minorAmount) },
    }))
    .sort(compareBalance)
}

/** Creates a deterministic, positive-only repayment plan that preserves every net position by currency. */
export function simplifyDebts(balances: readonly PairwiseBalance[]): readonly Debt[] {
  const netByCurrency = new Map<string, Map<ParticipantId, bigint>>()

  for (const balance of balances) {
    assertCurrencyCode(balance.money.currency)
    if (!Number.isSafeInteger(balance.money.minorAmount)) throw new Error('Balance must be a safe integer')
    const net = netByCurrency.get(balance.money.currency) ?? new Map<ParticipantId, bigint>()
    const minorAmount = BigInt(balance.money.minorAmount)
    net.set(balance.fromParticipantId, (net.get(balance.fromParticipantId) ?? 0n) - minorAmount)
    net.set(balance.toParticipantId, (net.get(balance.toParticipantId) ?? 0n) + minorAmount)
    netByCurrency.set(balance.money.currency, net)
  }

  const debts: Debt[] = []
  for (const [currency, net] of [...netByCurrency].sort(([left], [right]) => compareStrings(left, right))) {
    for (const minorAmount of net.values()) toSafeSignedNumber(minorAmount)
    const debtors = [...net]
      .filter(([, minorAmount]) => minorAmount < 0n)
      .map(([participantId, minorAmount]) => ({ participantId, remaining: -minorAmount }))
      .sort((left, right) => compareStrings(left.participantId, right.participantId))
    const creditors = [...net]
      .filter(([, minorAmount]) => minorAmount > 0n)
      .map(([participantId, minorAmount]) => ({ participantId, remaining: minorAmount }))
      .sort((left, right) => compareStrings(left.participantId, right.participantId))

    let debtorIndex = 0
    let creditorIndex = 0
    while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
      const debtor = debtors[debtorIndex]
      const creditor = creditors[creditorIndex]
      const minorAmount = debtor.remaining < creditor.remaining ? debtor.remaining : creditor.remaining
      debts.push({
        fromParticipantId: debtor.participantId,
        toParticipantId: creditor.participantId,
        money: { currency: assertCurrency(currency), minorAmount: toSafePositiveNumber(minorAmount) },
      })
      debtor.remaining -= minorAmount
      creditor.remaining -= minorAmount
      if (debtor.remaining === 0n) debtorIndex += 1
      if (creditor.remaining === 0n) creditorIndex += 1
    }
  }

  return debts
}

/**
 * Applies saved, non-void settlement payments as inverse ledger obligations.
 * The raw pairwise plan intentionally retains cycles created by a simplified-plan
 * payment; only the separately derived simplified plan nets those positions.
 */
export function computeBalancePlans(
  expenses: readonly Expense[],
  settlements: readonly SettlementTransfer[] = [],
): BalancePlans {
  const paymentExpenses: Expense[] = settlements
    .filter(({ voided }) => voided !== true)
    .map((settlement) => {
      assertCurrencyCode(settlement.money.currency)
      if (!Number.isSafeInteger(settlement.money.minorAmount) || settlement.money.minorAmount <= 0) {
        throw new Error('Settlement amount must be a positive safe integer')
      }
      if (!settlement.senderId.trim() || !settlement.recipientId.trim() || settlement.senderId === settlement.recipientId) {
        throw new Error('Settlement participants must be distinct')
      }
      return {
        id: `settlement:${settlement.id}`,
        description: 'Settlement payment',
        date: '1970-01-01',
        total: { ...settlement.money },
        payments: [{ participantId: settlement.senderId, money: { ...settlement.money } }],
        allocations: [{ participantId: settlement.recipientId, money: { ...settlement.money } }],
      }
    })
  const signedPairwise = computeBalances([...expenses, ...paymentExpenses])
  return {
    pairwise: signedPairwise.map((balance) => balance.money.minorAmount > 0
      ? {
          fromParticipantId: balance.fromParticipantId,
          toParticipantId: balance.toParticipantId,
          money: { ...balance.money },
        }
      : {
          fromParticipantId: balance.toParticipantId,
          toParticipantId: balance.fromParticipantId,
          money: { ...balance.money, minorAmount: -balance.money.minorAmount },
        }),
    simplified: simplifyDebts(signedPairwise),
  }
}

function validateExpense(expense: Expense): void {
  assertCurrencyCode(expense.total.currency)
  if (expense.total.minorAmount < 0 || !Number.isSafeInteger(expense.total.minorAmount)) {
    throw new Error('Expense total must be a non-negative safe integer')
  }
  validateEntries(expense.payments, expense, 'Payment')
  validateEntries(expense.allocations, expense, 'Allocation')
  if (expense.payments.length === 0) throw new Error('Expense requires at least one payer')
  if (new Set(expense.payments.map(({ participantId }) => participantId)).size !== expense.payments.length) {
    throw new Error('Expense cannot repeat a payer')
  }
  const paymentTotal = expense.payments.reduce((sum, payment) => sum + BigInt(payment.money.minorAmount), 0n)
  if (paymentTotal !== BigInt(expense.total.minorAmount)) throw new Error('Expense payments must equal its total')
  const allocationTotal = expense.allocations.reduce((sum, allocation) => sum + BigInt(allocation.money.minorAmount), 0n)
  if (allocationTotal !== BigInt(expense.total.minorAmount)) throw new Error('Expense allocations must equal its total')
}

function validateEntries(entries: Expense['allocations'], expense: Expense, label: 'Allocation' | 'Payment'): void {
  for (const allocation of entries) {
    if (!allocation.participantId.trim()) throw new Error(`${label} participant is required`)
    assertCurrencyCode(allocation.money.currency)
    if (allocation.money.currency !== expense.total.currency) throw new Error(`${label} currency must match expense currency`)
    if (allocation.money.minorAmount < 0 || !Number.isSafeInteger(allocation.money.minorAmount)) {
      throw new Error(`${label} must be a non-negative safe integer`)
    }
  }
}

function expenseNets(expense: Expense): Map<ParticipantId, bigint> {
  const nets = new Map<ParticipantId, bigint>()
  for (const payment of expense.payments) {
    nets.set(payment.participantId, (nets.get(payment.participantId) ?? 0n) + BigInt(payment.money.minorAmount))
  }
  for (const allocation of expense.allocations) {
    nets.set(allocation.participantId, (nets.get(allocation.participantId) ?? 0n) - BigInt(allocation.money.minorAmount))
  }
  return nets
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

function assertCurrency(currency: string): PairwiseBalance['money']['currency'] {
  assertCurrencyCode(currency)
  return currency
}

function toSafeSignedNumber(value: bigint): number {
  const safeMaximum = BigInt(Number.MAX_SAFE_INTEGER)
  if (value < -safeMaximum || value > safeMaximum) throw new Error('Money addition exceeds safe integer range')
  return Number(value)
}

function toSafePositiveNumber(value: bigint): number {
  if (value <= 0n) throw new Error('Debt must be positive')
  return toSafeSignedNumber(value)
}
