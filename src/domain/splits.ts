import type { Allocation, Money, ParticipantId, SplitMethod } from './model'

export function computeAllocations(total: Money, method: SplitMethod): readonly Allocation[] {
  assertMoney(total)
  if (total.minorAmount < 0) throw new Error('Expense total cannot be negative')

  switch (method.type) {
    case 'equal':
      return allocateRatios(total, method.participantIds, method.participantIds.map(() => 1))
    case 'exact':
      return computeExactAllocations(total, method.allocations)
    case 'percentage': {
      const ratios = method.participantIds.map((participantId) => method.percentages[participantId] ?? 0)
      const percentageTotal = ratios.reduce((sum, percentage) => sum + percentage, 0)
      if (Math.abs(percentageTotal - 100) > Number.EPSILON * 100) {
        throw new Error('Percentages must total 100')
      }
      return allocateRatios(total, method.participantIds, ratios)
    }
    case 'shares':
      return allocateRatios(total, method.participantIds, method.participantIds.map((participantId) => method.shares[participantId] ?? 0))
    case 'adjustment': {
      const adjustments = method.participantIds.map((participantId) => method.adjustments[participantId] ?? 0)
      adjustments.forEach(assertMinorAmount)
      const adjustmentTotal = adjustments.reduce((sum, adjustment) => sum + adjustment, 0)
      if (adjustmentTotal > total.minorAmount) throw new Error('Adjustments exceed the expense total')
      const shared = allocateRatios(
        { currency: total.currency, minorAmount: total.minorAmount - adjustmentTotal },
        method.participantIds,
        method.participantIds.map(() => 1),
      )
      return shared.map((allocation, index) => ({
        participantId: allocation.participantId,
        money: { currency: total.currency, minorAmount: allocation.money.minorAmount + adjustments[index] },
      }))
    }
    case 'itemized':
      return computeItemizedAllocations(total, method.items)
  }
}

function computeExactAllocations(total: Money, allocations: readonly Allocation[]): readonly Allocation[] {
  if (allocations.length === 0) throw new Error('An exact split requires allocations')
  const participantIds = allocations.map(({ participantId }) => participantId)
  assertParticipantIds(participantIds)
  allocations.forEach(({ money }) => {
    assertMoney(money)
    if (money.currency !== total.currency) throw new Error('Allocation currency must match the expense total')
    if (money.minorAmount < 0) throw new Error('Allocation cannot be negative')
  })
  const allocationTotal = allocations.reduce((sum, allocation) => sum + allocation.money.minorAmount, 0)
  if (allocationTotal !== total.minorAmount) throw new Error('Exact allocations must equal the expense total')
  return allocations.map(({ participantId, money }) => ({
    participantId,
    money: { currency: money.currency, minorAmount: money.minorAmount },
  }))
}

function computeItemizedAllocations(
  total: Money,
  items: readonly { readonly money: Money; readonly participantIds: readonly ParticipantId[] }[],
): readonly Allocation[] {
  if (items.length === 0) throw new Error('An itemized split requires receipt items')
  const totals = new Map<ParticipantId, number>()
  let itemTotal = 0

  for (const item of items) {
    assertMoney(item.money)
    if (item.money.currency !== total.currency) throw new Error('Item currency must match the expense total')
    if (item.money.minorAmount < 0) throw new Error('Item amount cannot be negative')
    const itemAllocations = allocateRatios(item.money, item.participantIds, item.participantIds.map(() => 1))
    itemTotal += item.money.minorAmount
    for (const allocation of itemAllocations) {
      totals.set(allocation.participantId, (totals.get(allocation.participantId) ?? 0) + allocation.money.minorAmount)
    }
  }

  if (itemTotal !== total.minorAmount) throw new Error('Receipt items must equal the expense total')
  return [...totals].map(([participantId, minorAmount]) => ({
    participantId,
    money: { currency: total.currency, minorAmount },
  }))
}

function allocateRatios(total: Money, participantIds: readonly ParticipantId[], ratios: readonly number[]): readonly Allocation[] {
  assertParticipantIds(participantIds)
  if (participantIds.length !== ratios.length) throw new Error('Every participant needs a ratio')
  if (ratios.some((ratio) => !Number.isFinite(ratio) || ratio < 0)) throw new Error('Ratios must be non-negative finite numbers')

  const ratioTotal = ratios.reduce((sum, ratio) => sum + ratio, 0)
  if (ratioTotal <= 0) throw new Error('Split ratios must have a positive total')

  const minorAmounts = ratios.map((ratio) => Math.floor((total.minorAmount * ratio) / ratioTotal))
  let remainder = total.minorAmount - minorAmounts.reduce((sum, minorAmount) => sum + minorAmount, 0)
  for (let index = 0; remainder > 0; index = (index + 1) % minorAmounts.length) {
    minorAmounts[index] += 1
    remainder -= 1
  }

  return participantIds.map((participantId, index) => ({
    participantId,
    money: { currency: total.currency, minorAmount: minorAmounts[index] },
  }))
}

function assertParticipantIds(participantIds: readonly ParticipantId[]): void {
  if (participantIds.length === 0) throw new Error('A split requires at least one participant')
  if (new Set(participantIds).size !== participantIds.length) throw new Error('A split cannot repeat a participant')
}

function assertMoney(money: Money): void {
  if (money.currency.length !== 3) throw new Error('Currency must be an ISO 4217 code')
  assertMinorAmount(money.minorAmount)
}

function assertMinorAmount(minorAmount: number): void {
  if (!Number.isSafeInteger(minorAmount) || minorAmount < 0) {
    throw new Error('Money amounts must be non-negative safe integers')
  }
}
