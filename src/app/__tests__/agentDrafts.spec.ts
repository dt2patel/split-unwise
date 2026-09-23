import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  abandonAgentDraft, claimAgentDraft, clearAgentDrafts, isAgentDraftId, offerAgentDraft,
  reportAgentDraftLeft, reportAgentDraftQueued, reportAgentDraftSaved, type AgentExpenseDraft,
} from '../agentDrafts'

const draft: AgentExpenseDraft = { kind: 'expense', groupId: 'lake-house', description: 'Dinner', amountText: '84.50', currency: 'USD' }

afterEach(() => {
  clearAgentDrafts()
  vi.useRealTimers()
})

describe('agent drafts', () => {
  it('hands a draft to the editor once, only for the account and kind it was offered for', () => {
    const offer = offerAgentDraft('maya', draft)
    expect(isAgentDraftId(offer.id)).toBe(true)
    expect(claimAgentDraft('sam', offer.id, 'expense')).toBeUndefined()
    expect(claimAgentDraft('maya', offer.id, 'settlement')).toBeUndefined()
    expect(claimAgentDraft('maya', offer.id, 'expense')).toEqual(draft)
    expect(claimAgentDraft('maya', offer.id, 'expense')).toBeUndefined()
  })

  it('reports a confirmed save with the new ID', async () => {
    const offer = offerAgentDraft('maya', draft)
    claimAgentDraft('maya', offer.id, 'expense')
    reportAgentDraftQueued(offer.id, 'op-1')
    reportAgentDraftSaved(offer.id, 'expense-9')
    await expect(offer.outcome).resolves.toEqual({ status: 'saved', id: 'expense-9' })
  })

  it('reports queued when the server has not confirmed a save within a few seconds', async () => {
    vi.useFakeTimers()
    const offer = offerAgentDraft('maya', draft)
    claimAgentDraft('maya', offer.id, 'expense')
    reportAgentDraftQueued(offer.id, 'op-1')
    await vi.advanceTimersByTimeAsync(8_000)
    await expect(offer.outcome).resolves.toEqual({ status: 'queued', operationId: 'op-1' })
  })

  it('reports cancelled when the user leaves without saving, and queued when they saved first', async () => {
    const left = offerAgentDraft('maya', draft)
    claimAgentDraft('maya', left.id, 'expense')
    reportAgentDraftLeft(left.id)
    await expect(left.outcome).resolves.toEqual({ status: 'cancelled', reason: 'left' })

    const saved = offerAgentDraft('maya', draft)
    claimAgentDraft('maya', saved.id, 'expense')
    reportAgentDraftQueued(saved.id, 'op-2')
    reportAgentDraftLeft(saved.id)
    await expect(saved.outcome).resolves.toEqual({ status: 'queued', operationId: 'op-2' })
  })

  it('replaces an older draft, lapses when the editor never opens, and ends every wait on sign-out', async () => {
    vi.useFakeTimers()
    const first = offerAgentDraft('maya', draft)
    const second = offerAgentDraft('maya', draft)
    await expect(first.outcome).resolves.toEqual({ status: 'cancelled', reason: 'replaced' })
    expect(claimAgentDraft('maya', first.id, 'expense')).toBeUndefined()

    await vi.advanceTimersByTimeAsync(2 * 60 * 1000)
    await expect(second.outcome).resolves.toEqual({ status: 'cancelled', reason: 'expired' })

    const third = offerAgentDraft('maya', draft)
    clearAgentDrafts()
    await expect(third.outcome).resolves.toEqual({ status: 'cancelled', reason: 'signed-out' })
  })

  it('ignores reports for a draft the editor never claimed or the agent abandoned', async () => {
    const offer = offerAgentDraft('maya', draft)
    reportAgentDraftSaved(offer.id, 'expense-9')
    reportAgentDraftLeft(offer.id)
    abandonAgentDraft(offer.id)
    await expect(offer.outcome).resolves.toEqual({ status: 'cancelled', reason: 'aborted' })
    reportAgentDraftSaved(offer.id, 'expense-9')
  })
})
