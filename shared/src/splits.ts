import { assertCurrencyCode } from './money.js'
import type { LedgerAllocation, LedgerMoney } from './ledger.js'

export type LedgerSplitMethod =
  | { readonly type: 'equal'; readonly participantIds: readonly string[] }
  | { readonly type: 'exact'; readonly allocations: readonly LedgerAllocation[] }
  | { readonly type: 'percentage'; readonly participantIds: readonly string[]; readonly percentages: Readonly<Record<string, number>> }
  | { readonly type: 'shares'; readonly participantIds: readonly string[]; readonly shares: Readonly<Record<string, number>> }
  | { readonly type: 'adjustment'; readonly participantIds: readonly string[]; readonly adjustments: Readonly<Record<string, number>> }
  | { readonly type: 'itemized'; readonly items: readonly { readonly description: string; readonly money: LedgerMoney; readonly participantIds: readonly string[] }[] }

export function computeLedgerAllocations(total: LedgerMoney, method: LedgerSplitMethod): readonly LedgerAllocation[] {
  assertMoney(total)
  switch (method.type) {
    case 'equal': return allocateRatios(total, method.participantIds, method.participantIds.map(() => 1))
    case 'exact': return exact(total, method.allocations)
    case 'percentage': {
      assertKeys(method.participantIds, method.percentages, 'Percentage')
      const normalized = normalize(method.participantIds.map((participant) => method.percentages[participant]))
      if (normalized.total !== 100n * normalized.scale) throw new Error('Percentages must total 100')
      return allocateNormalized(total, method.participantIds, normalized)
    }
    case 'shares': assertKeys(method.participantIds, method.shares, 'Share'); return allocateRatios(total, method.participantIds, method.participantIds.map((participant) => method.shares[participant]))
    case 'adjustment': {
      assertKeys(method.participantIds, method.adjustments, 'Adjustment')
      const adjustments = method.participantIds.map((participant) => method.adjustments[participant])
      adjustments.forEach(assertMinor)
      const sum = adjustments.reduce(checkedAdd, 0)
      if (sum > total.minorAmount) throw new Error('Adjustments exceed the expense total')
      return allocateRatios({ ...total, minorAmount: total.minorAmount - sum }, method.participantIds, method.participantIds.map(() => 1)).map((entry, index) => ({ participantId: entry.participantId, money: { ...total, minorAmount: checkedAdd(entry.money.minorAmount, adjustments[index]) } }))
    }
    case 'itemized': {
      if (method.items.length === 0) throw new Error('An itemized split requires receipt items')
      const totals = new Map<string, number>(); let sum = 0
      for (const item of method.items) {
        assertMoney(item.money)
        if (item.money.currency !== total.currency) throw new Error('Item currency must match the expense total')
        sum = checkedAdd(sum, item.money.minorAmount)
        for (const entry of allocateRatios(item.money, item.participantIds, item.participantIds.map(() => 1))) totals.set(entry.participantId, checkedAdd(totals.get(entry.participantId) ?? 0, entry.money.minorAmount))
      }
      if (sum !== total.minorAmount) throw new Error('Receipt items must equal the expense total')
      return [...totals].map(([participantId, minorAmount]) => ({ participantId, money: { currency: total.currency, minorAmount } }))
    }
  }
}

export function assertSplitMatchesAllocations(total: LedgerMoney, method: LedgerSplitMethod, allocations: readonly LedgerAllocation[]): void {
  const normalizeEntries = (values: readonly LedgerAllocation[]) => [...values].sort((a, b) => a.participantId.localeCompare(b.participantId)).map((entry) => `${entry.participantId}\0${entry.money.currency}\0${entry.money.minorAmount}`)
  const expected = normalizeEntries(computeLedgerAllocations(total, method)); const actual = normalizeEntries(allocations)
  if (expected.length !== actual.length || expected.some((value, index) => value !== actual[index])) throw new Error('Allocations do not match the selected split method')
}

function exact(total: LedgerMoney, allocations: readonly LedgerAllocation[]): readonly LedgerAllocation[] {
  assertParticipants(allocations.map(({ participantId }) => participantId))
  allocations.forEach((entry) => { assertMoney(entry.money); if (entry.money.currency !== total.currency) throw new Error('Allocation currency must match the expense total') })
  if (allocations.reduce((sum, entry) => checkedAdd(sum, entry.money.minorAmount), 0) !== total.minorAmount) throw new Error('Exact allocations must equal the expense total')
  return allocations.map((entry) => ({ participantId: entry.participantId, money: { ...entry.money } }))
}
function allocateRatios(total: LedgerMoney, participants: readonly string[], ratios: readonly number[]): readonly LedgerAllocation[] { assertParticipants(participants); if (participants.length !== ratios.length) throw new Error('Every participant needs a ratio'); return allocateNormalized(total, participants, normalize(ratios)) }
function allocateNormalized(total: LedgerMoney, participants: readonly string[], ratios: Normalized): readonly LedgerAllocation[] {
  const minor = BigInt(total.minorAmount); const amounts = ratios.weights.map((weight) => minor * weight / ratios.total); let remainder = minor - amounts.reduce((sum, value) => sum + value, 0n)
  for (let index = 0; remainder > 0n; index = (index + 1) % amounts.length) { amounts[index] += 1n; remainder -= 1n }
  return participants.map((participantId, index) => ({ participantId, money: { currency: total.currency, minorAmount: safe(amounts[index]) } }))
}
interface Normalized { readonly weights: readonly bigint[]; readonly total: bigint; readonly scale: bigint }
function normalize(ratios: readonly number[]): Normalized { if (!ratios.length) throw new Error('A split requires at least one participant'); const decimals = ratios.map(decimal); const places = Math.max(...decimals.map((item) => item.places)); const scale = 10n ** BigInt(places); const weights = decimals.map((item) => item.coefficient * 10n ** BigInt(places - item.places)); const total = weights.reduce((sum, value) => sum + value, 0n); if (total <= 0n) throw new Error('Split ratios must have a positive total'); return { weights, total, scale } }
function decimal(value: number): { coefficient: bigint; places: number } { if (!Number.isFinite(value) || value < 0) throw new Error('Ratios must be non-negative finite numbers'); const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(value)); if (!match) throw new Error('Ratio must be a decimal number'); const fraction = match[2] ?? ''; const exponent = match[3] ? Number(match[3]) : 0; const shift = fraction.length - exponent; const coefficient = BigInt(`${match[1]}${fraction}`); return shift <= 0 ? { coefficient: coefficient * 10n ** BigInt(-shift), places: 0 } : { coefficient, places: shift } }
function assertParticipants(values: readonly string[]): void { if (!values.length) throw new Error('A split requires at least one participant'); if (new Set(values).size !== values.length) throw new Error('A split cannot repeat a participant') }
function assertKeys(participants: readonly string[], values: Readonly<Record<string, number>>, label: string): void { assertParticipants(participants); const selected = [...participants].sort(); const keyed = Object.keys(values).sort(); if (selected.length !== keyed.length || selected.some((value, index) => value !== keyed[index])) throw new Error(`${label} keys must exactly match selected participants`) }
function assertMoney(money: LedgerMoney): void { assertCurrencyCode(money.currency); assertMinor(money.minorAmount) }
function assertMinor(value: number): void { if (!Number.isSafeInteger(value) || value < 0) throw new Error('Money amounts must be non-negative safe integers') }
function checkedAdd(left: number, right: number): number { const value = left + right; if (!Number.isSafeInteger(value)) throw new Error('Money addition exceeds safe integer range'); return value }
function safe(value: bigint): number { if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Allocation exceeds safe integer range'); return Number(value) }
