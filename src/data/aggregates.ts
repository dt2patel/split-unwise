import type { CurrencyTotals, ExpenseRow, GroupCharts } from './repositories'

export function buildCurrencyTotals(rows: readonly ExpenseRow[], currentUserId: string): readonly CurrencyTotals[] {
  const amounts = new Map<string, { totalPaid: bigint; currentUserPaid: bigint; currentUserShare: bigint }>()
  for (const row of rows) {
    const direction = row.reimbursement ? -1 : 1
    const current = amounts.get(row.total.currency) ?? { totalPaid: 0n, currentUserPaid: 0n, currentUserShare: 0n }
    current.totalPaid = checkedAdd(current.totalPaid, direction * row.total.minorAmount)
    for (const payment of row.payments) {
      if (payment.participantId === currentUserId) current.currentUserPaid = checkedAdd(current.currentUserPaid, direction * payment.money.minorAmount)
    }
    const allocation = row.allocations.find(({ participantId }) => participantId === currentUserId)
    if (allocation) current.currentUserShare = checkedAdd(current.currentUserShare, direction * allocation.money.minorAmount)
    amounts.set(row.total.currency, current)
  }
  return [...amounts].sort(([left], [right]) => left.localeCompare(right)).map(([currency, amount]) => ({
    currency: currency as ExpenseRow['total']['currency'], totalPaid: toSafe(amount.totalPaid), currentUserPaid: toSafe(amount.currentUserPaid), currentUserShare: toSafe(amount.currentUserShare), currentUserNet: toSafe(amount.currentUserPaid - amount.currentUserShare),
  }))
}

export function buildGroupCharts(rows: readonly ExpenseRow[]): GroupCharts {
  const categories = sum(rows, (row) => row.category, true)
  const daily = sum(rows, (row) => row.date, false)
  return {
    categorySpending: categories.map(([currency, category, amount]) => ({ currency, category, minorAmount: toSafe(amount) })),
    dailySpending: daily.map(([currency, date, amount]) => ({ currency, date, minorAmount: toSafe(amount) })),
  }
}

function sum(rows: readonly ExpenseRow[], key: (row: ExpenseRow) => string, sortByAmount: boolean): readonly (readonly [ExpenseRow['total']['currency'], string, bigint])[] {
  const amounts = new Map<string, bigint>()
  for (const row of rows) {
    const id = `${row.total.currency}\u0000${key(row)}`
    amounts.set(id, checkedAdd(amounts.get(id) ?? 0n, (row.reimbursement ? -1 : 1) * row.total.minorAmount))
  }
  return [...amounts].map(([id, amount]) => { const [currency, name] = id.split('\u0000'); return [currency as ExpenseRow['total']['currency'], name, amount] as const })
    .sort(([leftCurrency, leftName, leftAmount], [rightCurrency, rightName, rightAmount]) => leftCurrency.localeCompare(rightCurrency) || (sortByAmount && rightAmount > leftAmount ? 1 : sortByAmount && rightAmount < leftAmount ? -1 : leftName.localeCompare(rightName)))
}

function checkedAdd(total: bigint, next: number): bigint {
  if (!Number.isSafeInteger(next)) throw new Error('Aggregate input must be a safe integer')
  const result = total + BigInt(next)
  const maximum = BigInt(Number.MAX_SAFE_INTEGER)
  if (result < -maximum || result > maximum) throw new Error('Aggregate exceeds safe integer range')
  return result
}
function toSafe(value: bigint): number {
  const maximum = BigInt(Number.MAX_SAFE_INTEGER)
  if (value < -maximum || value > maximum) throw new Error('Aggregate exceeds safe integer range')
  return Number(value)
}
