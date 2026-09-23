import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { clearAgentDrafts, offerAgentDraft, type AgentExpenseDraft } from '../../../app/agentDrafts'
import { createMemoryCommandStorage } from '../../../data/commandQueue'
import { createDemoRepository } from '../../../data/demoRepository'
import { appPrincipalKey } from '../../../data/principal'
import { createAppSession, setAppSessionForTesting, type AppDataSession } from '../../../data/session'
import { useExpenseStore } from '../expenseStore'

const dinner: AgentExpenseDraft = {
  kind: 'expense', groupId: 'lake-house-weekend', description: 'Dinner at Nopa', amountText: '84.50', currency: 'USD',
  category: 'Food', paidBy: 'alex-r', participantIds: ['maya-p', 'alex-r'],
}

let session: AppDataSession

beforeEach(() => {
  setActivePinia(createPinia())
  session = createAppSession({ repository: createDemoRepository(), commandStorage: createMemoryCommandStorage() })
  setAppSessionForTesting(session)
})

afterEach(() => clearAgentDrafts())

describe('expense editor with an agent draft', () => {
  it('prefills an unsaved draft for the user to save, then tells the agent the saved expense ID', async () => {
    const offer = offerAgentDraft(appPrincipalKey(await session.principal), dinner)
    const store = useExpenseStore()

    await store.initialize({ origin: 'groups', groupId: 'lake-house-weekend', agentDraftId: offer.id, today: '2026-08-31' })

    expect(store.editor).toMatchObject({
      description: 'Dinner at Nopa', amountText: '84.50', currency: 'USD', category: 'Food', date: '2026-08-31',
      participants: ['maya-p', 'alex-r'], payments: [{ participantId: 'alex-r', amountText: '' }], split: { type: 'equal' },
    })
    expect(store.notice).toContain('An AI agent filled this in')
    expect(store.isDirty).toBe(true)
    expect(session.queue.snapshot()).toEqual([])

    expect(await store.submit('agent-dinner')).toBe(true)
    // The editor closes as soon as Save is accepted; the agent still hears the server's answer.
    store.leaveEditor()
    const saved = await session.queue.submit(session.queue.get('agent-dinner')!.envelope).result()
    expect(await offer.outcome).toEqual({ status: 'saved', id: 'expense' in saved ? saved.expense.id : undefined })
  })

  it('tells the agent nothing was saved when the user leaves or the editor opens something else', async () => {
    const owner = appPrincipalKey(await session.principal)
    const store = useExpenseStore()

    const left = offerAgentDraft(owner, dinner)
    await store.initialize({ origin: 'groups', groupId: 'lake-house-weekend', agentDraftId: left.id, today: '2026-08-31' })
    store.leaveEditor()
    await expect(left.outcome).resolves.toEqual({ status: 'cancelled', reason: 'left' })

    const replacedByNavigation = offerAgentDraft(owner, dinner)
    await store.initialize({ origin: 'groups', groupId: 'lake-house-weekend', agentDraftId: replacedByNavigation.id, today: '2026-08-31' })
    await store.initialize({ origin: 'groups', groupId: 'lake-house-weekend', today: '2026-08-31' })
    await expect(replacedByNavigation.outcome).resolves.toEqual({ status: 'cancelled', reason: 'left' })
    expect(store.editor.description).toBe('')
    expect(store.notice).toBe('')
  })

  it('ignores a draft offered to another account or for another group', async () => {
    const store = useExpenseStore()
    const otherAccount = offerAgentDraft('someone-else', dinner)
    await store.initialize({ origin: 'groups', groupId: 'lake-house-weekend', agentDraftId: otherAccount.id, today: '2026-08-31' })
    expect(store.editor.description).toBe('')

    const otherGroup = offerAgentDraft(appPrincipalKey(await session.principal), { ...dinner, groupId: 'elsewhere' })
    await store.initialize({ origin: 'groups', groupId: 'lake-house-weekend', agentDraftId: otherGroup.id, today: '2026-08-31' })
    expect(store.editor.description).toBe('')
    expect(store.isDirty).toBe(false)
  })
})
