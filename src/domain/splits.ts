import type { Allocation, Money, ParticipantId, SplitMethod } from './model'
import { assertCurrencyCode } from './money'

export function computeAllocations(total: Money, method: SplitMethod): readonly Allocation[] {
  assertMoney(total)
  if (total.minorAmount < 0) throw new Error('Expense total cannot be negative')

  switch (method.type) {
    case 'equal':
      return allocateRatios(total, method.participantIds, method.participantIds.map(() => 1))
    case 'exact':
      return computeExactAllocations(total, method.allocations)
    case 'percentage': {
      assertParticipantIds(method.participantIds)
      const ratios = method.participantIds.map((participantId) => method.percentages[participantId] ?? 0)
      const normalized = normalizeRatios(ratios)
      if (normalized.total !== 100n * normalized.scale) {
        throw new Error('Percentages must total 100')
      }
      return allocateNormalizedRatios(total, method.participantIds, normalized)
    }
    case 'shares':
      return allocateRatios(total, method.participantIds, method.participantIds.map((participantId) => method.shares[participantId] ?? 0))
    case 'adjustment': {
      const adjustments = method.participantIds.map((participantId) => method.adjustments[participantId] ?? 0)
      adjustments.forEach(assertMinorAmount)
      const adjustmentTotal = adjustments.reduce(checkedAdd, 0)
      if (adjustmentTotal > total.minorAmount) throw new Error('Adjustments exceed the expense total')
      const shared = allocateRatios(
        { currency: total.currency, minorAmount: total.minorAmount - adjustmentTotal },
        method.participantIds,
        method.participantIds.map(() => 1),
      )
      return shared.map((allocation, index) => ({
        participantId: allocation.participantId,
        money: { currency: total.currency, minorAmount: checkedAdd(allocation.money.minorAmount, adjustments[index]) },
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
  const allocationTotal = allocations.reduce((sum, allocation) => checkedAdd(sum, allocation.money.minorAmount), 0)
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
    itemTotal = checkedAdd(itemTotal, item.money.minorAmount)
    for (const allocation of itemAllocations) {
      totals.set(allocation.participantId, checkedAdd(totals.get(allocation.participantId) ?? 0, allocation.money.minorAmount))
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
  return allocateNormalizedRatios(total, participantIds, normalizeRatios(ratios))
}

function allocateNormalizedRatios(
  total: Money,
  participantIds: readonly ParticipantId[],
  normalized: NormalizedRatios,
): readonly Allocation[] {
  const totalMinorAmount = BigInt(total.minorAmount)
  const minorAmounts = normalized.weights.map((weight) => (totalMinorAmount * weight) / normalized.total)
  let remainder = totalMinorAmount - minorAmounts.reduce((sum, minorAmount) => sum + minorAmount, 0n)
  for (let index = 0; remainder > 0n; index = (index + 1) % minorAmounts.length) {
    minorAmounts[index] += 1n
    remainder -= 1n
  }

  const allocatedTotal = minorAmounts.reduce((sum, minorAmount) => sum + minorAmount, 0n)
  if (allocatedTotal !== totalMinorAmount) throw new Error('Split allocations must equal the expense total')

  return participantIds.map((participantId, index) => ({
    participantId,
    money: { currency: total.currency, minorAmount: toSafeNumber(minorAmounts[index]) },
  }))
}

interface NormalizedRatios {
  readonly weights: readonly bigint[]
  readonly total: bigint
  readonly scale: bigint
}

function normalizeRatios(ratios: readonly number[]): NormalizedRatios {
  if (ratios.length === 0) throw new Error('A split requires at least one participant')
  const decimals = ratios.map(parseDecimalRatio)
  const decimalPlaces = Math.max(...decimals.map(({ decimalPlaces: places }) => places))
  const scale = 10n ** BigInt(decimalPlaces)
  const weights = decimals.map(({ coefficient, decimalPlaces: places }) => coefficient * (10n ** BigInt(decimalPlaces - places)))
  const total = weights.reduce((sum, weight) => sum + weight, 0n)
  if (total <= 0n) throw new Error('Split ratios must have a positive total')
  return { weights, total, scale }
}

function parseDecimalRatio(ratio: number): { readonly coefficient: bigint; readonly decimalPlaces: number } {
  if (!Number.isFinite(ratio) || ratio < 0) throw new Error('Ratios must be non-negative finite numbers')
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(ratio))
  if (!match) throw new Error('Ratio must be a decimal number')

  const [, wholePart, fractionPart = '', exponentPart] = match
  const exponent = exponentPart === undefined ? 0 : Number(exponentPart)
  const shift = fractionPart.length - exponent
  const coefficient = BigInt(`${wholePart}${fractionPart}`)
  return shift <= 0
    ? { coefficient: coefficient * (10n ** BigInt(-shift)), decimalPlaces: 0 }
    : { coefficient, decimalPlaces: shift }
}

function assertParticipantIds(participantIds: readonly ParticipantId[]): void {
  if (participantIds.length === 0) throw new Error('A split requires at least one participant')
  if (new Set(participantIds).size !== participantIds.length) throw new Error('A split cannot repeat a participant')
}

function assertMoney(money: Money): void {
  assertCurrencyCode(money.currency)
  assertMinorAmount(money.minorAmount)
}

function assertMinorAmount(minorAmount: number): void {
  if (!Number.isSafeInteger(minorAmount) || minorAmount < 0) {
    throw new Error('Money amounts must be non-negative safe integers')
  }
}

function checkedAdd(left: number, right: number): number {
  const sum = left + right
  if (!Number.isSafeInteger(sum)) throw new Error('Money addition exceeds safe integer range')
  return sum
}

function toSafeNumber(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Allocation exceeds safe integer range')
  return Number(value)
}
