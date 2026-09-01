import { describe, expect, it } from 'vitest'
import type { AppPrincipal } from '../../../data/principal'
import type { ImportedTransactionProposal } from '../../../domain/transactionImport'
import { consumeTransactionImportDraft, storeTransactionImportDraft } from '../transactionImportDrafts'

const principal: AppPrincipal = { mode: 'firebase', projectId: 'split-unwise-aditya', uid: 'owner-user' }
const otherPrincipal: AppPrincipal = { ...principal, uid: 'other-user' }
const proposal: ImportedTransactionProposal = {
  fingerprint: `transaction-v1:${'a'.repeat(64)}`,
  date: '2026-08-30', description: 'Dinner', money: { currency: 'USD', minorAmount: 4250 }, sourceRow: 2,
}

describe('one-time transaction import drafts', () => {
  it('uses an opaque account-scoped ID and consumes a valid draft exactly once', () => {
    const storage = new MemoryStorage()
    const draftId = storeTransactionImportDraft(principal, proposal, {
      storage, id: () => '123e4567-e89b-42d3-a456-426614174000', now: () => 1_000,
    })

    expect(draftId).toBe('123e4567-e89b-42d3-a456-426614174000')
    expect(draftId).not.toMatch(/Dinner|4250|USD/)
    expect(consumeTransactionImportDraft(otherPrincipal, draftId, { storage, now: () => 2_000 })).toBeUndefined()
    expect(consumeTransactionImportDraft(principal, draftId, { storage, now: () => 2_000 })).toEqual(proposal)
    expect(consumeTransactionImportDraft(principal, draftId, { storage, now: () => 2_000 })).toBeUndefined()
  })

  it('removes expired or tampered data without returning financial fields', () => {
    const storage = new MemoryStorage()
    const draftId = storeTransactionImportDraft(principal, proposal, {
      storage, id: () => '123e4567-e89b-42d3-a456-426614174001', now: () => 1_000, ttlMs: 500,
    })
    expect(consumeTransactionImportDraft(principal, draftId, { storage, now: () => 1_501 })).toBeUndefined()

    const tamperedId = storeTransactionImportDraft(principal, proposal, {
      storage, id: () => '123e4567-e89b-42d3-a456-426614174002', now: () => 2_000,
    })
    storage.setItem(storage.key(0)!, '{"schemaVersion":1,"proposal":{"money":{"minorAmount":-1}}}')
    expect(consumeTransactionImportDraft(principal, tamperedId, { storage, now: () => 2_100 })).toBeUndefined()
  })
})

class MemoryStorage implements Storage {
  readonly rows = new Map<string, string>()
  get length(): number { return this.rows.size }
  clear(): void { this.rows.clear() }
  getItem(key: string): string | null { return this.rows.get(key) ?? null }
  key(index: number): string | null { return [...this.rows.keys()][index] ?? null }
  removeItem(key: string): void { this.rows.delete(key) }
  setItem(key: string, value: string): void { this.rows.set(key, value) }
}
