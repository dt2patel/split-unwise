import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claimAgentDraft, clearAgentDrafts, offerAgentDraft } from '../../../app/agentDrafts'
import { createMemoryCommandStorage } from '../../../data/commandQueue'
import { createDemoRepository } from '../../../data/demoRepository'
import { appPrincipalKey } from '../../../data/principal'
import { createAppSession, setAppSessionForTesting } from '../../../data/session'
import type { SettlementRecordCommand } from '../../../data/repositories'
import { useSettlementStore } from '../settlementStore'

const groupId = 'lake-house-weekend'
const principal = { mode: 'demo' as const, projectId: 'split-unwise-demo', uid: 'maya-p' }
const owner = appPrincipalKey(principal)

beforeEach(() => {
  setActivePinia(createPinia())
  setAppSessionForTesting(createAppSession({ repository: createDemoRepository(), principal, commandStorage: createMemoryCommandStorage() }))
})

afterEach(() => clearAgentDrafts())

describe('recording a payment an agent prefilled', () => {
  it('tells the waiting agent the saved settlement ID once the user records it', async () => {
    const offer = offerAgentDraft(owner, { kind: 'settlement', groupId, amountText: '5.00' })
    expect(claimAgentDraft(owner, offer.id, 'settlement', groupId)).toBeDefined()
    const store = useSettlementStore()
    await store.loadGroup(groupId)
    const revision = store.balanceSnapshot!.balanceRevision

    expect(await store.recordPayment(record('agent-payment', revision), { agentDraftId: offer.id })).toBe(true)
    await expect(offer.outcome).resolves.toEqual({ status: 'saved', id: 'settlement-agent-payment' })
  })

  it('leaves other waits alone when the payment was not prefilled by an agent', async () => {
    const offer = offerAgentDraft(owner, { kind: 'settlement', groupId, amountText: '5.00' })
    claimAgentDraft(owner, offer.id, 'settlement', groupId)
    const store = useSettlementStore()
    await store.loadGroup(groupId)

    expect(await store.recordPayment(record('manual-payment', store.balanceSnapshot!.balanceRevision))).toBe(true)
    clearAgentDrafts()
    await expect(offer.outcome).resolves.toEqual({ status: 'cancelled', reason: 'signed-out' })
  })
})

function record(operationId: string, expectedBalanceRevision: number): SettlementRecordCommand {
  return {
    kind: 'settlement.record', operationId, groupId, expectedBalanceRevision,
    basis: { kind: 'simplified', senderId: 'taylor-s', recipientId: 'maya-p', currency: 'USD', debtMinor: 3625 },
    money: { currency: 'USD', minorAmount: 500 }, method: 'cash', occurredOn: '2026-08-31', outsidePaymentConfirmed: true,
  }
}
