import { assertCurrencyCode, type CurrencyCode } from './money.js'

export interface LedgerMoney { readonly currency: CurrencyCode; readonly minorAmount: number }
export interface LedgerAllocation { readonly participantId: string; readonly money: LedgerMoney }
export interface LedgerExpense { readonly id: string; readonly total: LedgerMoney; readonly payments: readonly LedgerAllocation[]; readonly allocations: readonly LedgerAllocation[] }
export interface LedgerSettlement { readonly id: string; readonly senderId: string; readonly recipientId: string; readonly money: LedgerMoney; readonly voided?: boolean }
export interface LedgerDebt { readonly fromParticipantId: string; readonly toParticipantId: string; readonly money: LedgerMoney }
export interface SignedLedgerBalance extends LedgerDebt {}
export interface LedgerBalancePlans { readonly pairwise: readonly LedgerDebt[]; readonly simplified: readonly LedgerDebt[] }

export function validateLedgerExpense(expense: LedgerExpense): void {
  assertCurrencyCode(expense.total.currency)
  if (!Number.isSafeInteger(expense.total.minorAmount) || expense.total.minorAmount <= 0) throw new Error('Expense total must be a positive safe integer')
  validateEntries(expense.payments, expense.total, 'Payment')
  validateEntries(expense.allocations, expense.total, 'Allocation')
  if (expense.payments.length === 0) throw new Error('Expense requires at least one payer')
  if (new Set(expense.payments.map(({ participantId }) => participantId)).size !== expense.payments.length) throw new Error('Expense cannot repeat a payer')
  if (new Set(expense.allocations.map(({ participantId }) => participantId)).size !== expense.allocations.length) throw new Error('Expense cannot repeat a participant')
  if (sum(expense.payments) !== BigInt(expense.total.minorAmount)) throw new Error('Expense payments must equal its total')
  if (sum(expense.allocations) !== BigInt(expense.total.minorAmount)) throw new Error('Expense allocations must equal its total')
}

export function computeLedgerBalancePlans(expenses: readonly LedgerExpense[], settlements: readonly LedgerSettlement[] = []): LedgerBalancePlans {
  const synthetic = settlements.filter(({ voided }) => !voided).map((settlement): LedgerExpense => {
    if (!Number.isSafeInteger(settlement.money.minorAmount) || settlement.money.minorAmount <= 0) throw new Error('Settlement amount must be a positive safe integer')
    if (!settlement.senderId || !settlement.recipientId || settlement.senderId === settlement.recipientId) throw new Error('Settlement participants must be distinct')
    return { id: `settlement:${settlement.id}`, total: settlement.money, payments: [{ participantId: settlement.senderId, money: settlement.money }], allocations: [{ participantId: settlement.recipientId, money: settlement.money }] }
  })
  const signed = computeSignedBalances([...expenses, ...synthetic])
  return {
    pairwise: signed.map((balance) => balance.money.minorAmount > 0 ? balance : { fromParticipantId: balance.toParticipantId, toParticipantId: balance.fromParticipantId, money: { ...balance.money, minorAmount: -balance.money.minorAmount } }),
    simplified: simplifyLedgerDebts(signed),
  }
}

export function computeSignedBalances(expenses: readonly LedgerExpense[]): readonly SignedLedgerBalance[] {
  const balances = new Map<string, { fromParticipantId: string; toParticipantId: string; currency: CurrencyCode; minorAmount: bigint }>()
  for (const expense of expenses) {
    validateLedgerExpense(expense)
    const nets = new Map<string, bigint>()
    for (const item of expense.payments) nets.set(item.participantId, (nets.get(item.participantId) ?? 0n) + BigInt(item.money.minorAmount))
    for (const item of expense.allocations) nets.set(item.participantId, (nets.get(item.participantId) ?? 0n) - BigInt(item.money.minorAmount))
    const debtors = [...nets].filter(([, amount]) => amount < 0n).map(([participantId, amount]) => ({ participantId, remaining: -amount })).sort(byParticipant)
    const creditors = [...nets].filter(([, amount]) => amount > 0n).map(([participantId, amount]) => ({ participantId, remaining: amount })).sort(byParticipant)
    let debtor = 0; let creditor = 0
    while (debtor < debtors.length && creditor < creditors.length) {
      const amount = debtors[debtor].remaining < creditors[creditor].remaining ? debtors[debtor].remaining : creditors[creditor].remaining
      const [fromParticipantId, toParticipantId] = ordered(debtors[debtor].participantId, creditors[creditor].participantId)
      const direction = fromParticipantId === debtors[debtor].participantId ? 1n : -1n
      const key = `${expense.total.currency}\0${fromParticipantId}\0${toParticipantId}`
      const previous = balances.get(key)
      balances.set(key, { fromParticipantId, toParticipantId, currency: expense.total.currency, minorAmount: (previous?.minorAmount ?? 0n) + direction * amount })
      debtors[debtor].remaining -= amount; creditors[creditor].remaining -= amount
      if (debtors[debtor].remaining === 0n) debtor += 1
      if (creditors[creditor].remaining === 0n) creditor += 1
    }
  }
  return [...balances.values()].filter(({ minorAmount }) => minorAmount !== 0n).map(({ fromParticipantId, toParticipantId, currency, minorAmount }) => ({ fromParticipantId, toParticipantId, money: { currency, minorAmount: safeNumber(minorAmount) } })).sort(compareDebt)
}

export function simplifyLedgerDebts(balances: readonly SignedLedgerBalance[]): readonly LedgerDebt[] {
  const ledgers = new Map<CurrencyCode, Map<string, bigint>>()
  for (const balance of balances) {
    assertCurrencyCode(balance.money.currency)
    if (!Number.isSafeInteger(balance.money.minorAmount)) throw new Error('Balance must be a safe integer')
    const ledger = ledgers.get(balance.money.currency) ?? new Map<string, bigint>()
    const amount = BigInt(balance.money.minorAmount)
    ledger.set(balance.fromParticipantId, (ledger.get(balance.fromParticipantId) ?? 0n) - amount)
    ledger.set(balance.toParticipantId, (ledger.get(balance.toParticipantId) ?? 0n) + amount)
    ledgers.set(balance.money.currency, ledger)
  }
  const debts: LedgerDebt[] = []
  for (const [currency, ledger] of [...ledgers].sort(([a], [b]) => a.localeCompare(b))) {
    for (const amount of ledger.values()) safeNumber(amount)
    const debtors = [...ledger].filter(([, amount]) => amount < 0n).map(([participantId, amount]) => ({ participantId, remaining: -amount })).sort(byParticipant)
    const creditors = [...ledger].filter(([, amount]) => amount > 0n).map(([participantId, amount]) => ({ participantId, remaining: amount })).sort(byParticipant)
    let debtor = 0; let creditor = 0
    while (debtor < debtors.length && creditor < creditors.length) {
      const amount = debtors[debtor].remaining < creditors[creditor].remaining ? debtors[debtor].remaining : creditors[creditor].remaining
      debts.push({ fromParticipantId: debtors[debtor].participantId, toParticipantId: creditors[creditor].participantId, money: { currency, minorAmount: safePositive(amount) } })
      debtors[debtor].remaining -= amount; creditors[creditor].remaining -= amount
      if (debtors[debtor].remaining === 0n) debtor += 1
      if (creditors[creditor].remaining === 0n) creditor += 1
    }
  }
  return debts
}

function validateEntries(entries: readonly LedgerAllocation[], total: LedgerMoney, label: string): void {
  for (const item of entries) {
    if (!item.participantId.trim()) throw new Error(`${label} participant is required`)
    if (item.money.currency !== total.currency) throw new Error(`${label} currency must match expense currency`)
    if (!Number.isSafeInteger(item.money.minorAmount) || item.money.minorAmount < 0) throw new Error(`${label} must be a non-negative safe integer`)
  }
}
function sum(entries: readonly LedgerAllocation[]): bigint { return entries.reduce((value, item) => value + BigInt(item.money.minorAmount), 0n) }
function byParticipant(left: { participantId: string }, right: { participantId: string }): number { return left.participantId.localeCompare(right.participantId) }
function ordered(left: string, right: string): readonly [string, string] { return left <= right ? [left, right] : [right, left] }
function compareDebt(left: SignedLedgerBalance, right: SignedLedgerBalance): number { return left.money.currency.localeCompare(right.money.currency) || left.fromParticipantId.localeCompare(right.fromParticipantId) || left.toParticipantId.localeCompare(right.toParticipantId) }
function safeNumber(value: bigint): number { const max = BigInt(Number.MAX_SAFE_INTEGER); if (value < -max || value > max) throw new Error('Money addition exceeds safe integer range'); return Number(value) }
function safePositive(value: bigint): number { if (value <= 0n) throw new Error('Debt must be positive'); return safeNumber(value) }
