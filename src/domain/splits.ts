import { computeLedgerAllocations } from '@split-unwise/shared'
import type { Allocation, Money, SplitMethod } from './model'

export function computeAllocations(total: Money, method: SplitMethod): readonly Allocation[] {
  return computeLedgerAllocations(total, method)
}
