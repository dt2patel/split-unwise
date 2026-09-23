import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Router } from 'vue-router'
import { appPrincipalKey, type AppPrincipal } from '../../data/principal'
import type { AppDataSession } from '../../data/session'
import type { ActivityItem, AppRepository, ExpenseRow, Group, Member } from '../../data/repositories'
import type { WebMCP } from 'webmcp-types'
import { claimAgentDraft, clearAgentDrafts, reportAgentDraftLeft, reportAgentDraftQueued, reportAgentDraftSaved } from '../agentDrafts'
import { installWebMcp } from '../webmcp'

const principal: AppPrincipal = { mode: 'demo', projectId: 'demo-split-unwise', uid: 'maya' }
const owner = appPrincipalKey(principal)

describe('WebMCP integration', () => {
  const group: Group = { id: 'lake-house', kind: 'group', name: 'Lake House', currency: 'USD', memberIds: ['maya', 'alex'], syncState: 'fresh' }
  const members: Member[] = [
    { id: 'maya', displayName: 'Maya', initials: 'M', isCurrentUser: true, role: 'owner' },
    { id: 'alex', displayName: 'Alex', initials: 'A', isCurrentUser: false, role: 'member' },
  ]
  const expense: ExpenseRow = {
    id: 'dinner', groupId: group.id, description: 'Dinner', date: '2026-09-09', total: { currency: 'USD', minorAmount: 2400 },
    payments: [{ participantId: 'maya', money: { currency: 'USD', minorAmount: 2400 } }],
    allocations: [
      { participantId: 'maya', money: { currency: 'USD', minorAmount: 1200 } },
      { participantId: 'alex', money: { currency: 'USD', minorAmount: 1200 } },
    ],
    category: 'Food', splitMethod: { type: 'equal', participantIds: ['maya', 'alex'] }, notes: 'Team dinner', attachmentRefs: [],
    createdAt: '2026-09-09T10:00:00.000Z', updatedAt: '2026-09-09T10:00:00.000Z', revision: 1, syncState: 'fresh',
  }
  const activity: ActivityItem = {
    id: 'activity-1', groupId: group.id, operationId: 'op-1', kind: 'expense.created', subject: { kind: 'expense', id: 'dinner', label: 'Dinner' },
    actor: { id: 'alex', displayName: 'Alex' }, expenseId: 'dinner', createdAt: '2026-09-09T10:00:00.000Z', syncState: 'fresh',
  }

  beforeEach(() => {
    Object.defineProperty(document, 'modelContext', { configurable: true, value: undefined })
  })
  afterEach(() => clearAgentDrafts())

  it('registers read-only tools only when the browser provides modelContext', async () => {
    const { registered, registrationOptions } = provideModelContext()
    const dispose = await installWebMcp({ router: fakeRouter(), session: fakeSession().session })

    expect(registered.map(({ name }) => name)).toEqual([
      'whoami', 'list_groups', 'list_group_members', 'get_group_balances', 'get_friend_balances',
      'search_expenses', 'get_expense_details', 'list_recent_activity', 'add_expense', 'record_settlement',
    ])
    expect(registered.filter(({ annotations }) => annotations?.readOnlyHint).map(({ name }) => name)).toHaveLength(8)
    // Every result carrying names or text written by other members is marked untrusted.
    expect(registered.filter(({ annotations }) => annotations?.untrustedContentHint).map(({ name }) => name)).toEqual([
      'list_groups', 'list_group_members', 'get_group_balances', 'get_friend_balances', 'search_expenses', 'get_expense_details', 'list_recent_activity',
    ])
    expect(tool(registered, 'record_settlement').annotations).toEqual({ consequentialHint: true })

    dispose()
    expect(registrationOptions.every(({ signal }) => signal?.aborted)).toBe(true)
  })

  it('returns amounts as minor units, a decimal and a display string', async () => {
    const { registered } = provideModelContext()
    await installWebMcp({ router: fakeRouter(), session: fakeSession().session })

    const output = await call(registered, 'search_expenses', { query: 'dinner' })
    expect(output.expenses).toEqual([expect.objectContaining({ id: 'dinner', total: { currency: 'USD', minorAmount: 2400, amount: '24.00', formatted: '$24.00' } })])

    const balances = await call(registered, 'get_group_balances', { groupId: group.id })
    expect(balances.debts).toEqual([{
      from: { id: 'alex', name: 'Alex' },
      to: { id: 'maya', name: 'Maya' },
      money: { currency: 'USD', minorAmount: 1200, amount: '12.00', formatted: '$12.00' },
      summary: 'Alex owes Maya $12.00',
    }])
  })

  it('answers who the user is, who is in a group, and what each friend owes across groups', async () => {
    const { registered } = provideModelContext()
    await installWebMcp({ router: fakeRouter(), session: fakeSession().session })

    expect(await call(registered, 'whoami', {})).toEqual({ user: { id: 'maya', name: 'Maya' } })
    expect((await call(registered, 'list_group_members', { groupId: group.id })).members).toEqual([
      { id: 'maya', name: 'Maya', isYou: true, role: 'owner' },
      { id: 'alex', name: 'Alex', isYou: false, role: 'member' },
    ])

    const friends = await call(registered, 'get_friend_balances', {})
    expect(friends.friends).toEqual([{
      id: 'alex',
      name: 'Alex',
      balances: [{ direction: 'owes_you', money: { currency: 'USD', minorAmount: 1200, amount: '12.00', formatted: '$12.00' } }],
      byGroup: [{ groupId: group.id, groupName: 'Lake House', direction: 'owes_you', money: expect.objectContaining({ minorAmount: 1200 }) }],
    }])
    expect(friends.totals).toEqual([expect.objectContaining({ currency: 'USD', net: { direction: 'owes_you', money: expect.objectContaining({ amount: '12.00' }) } })])
    expect((await call(registered, 'get_friend_balances', { name: 'sam' })).friends).toEqual([])
  })

  it('lists recent activity with group and actor names', async () => {
    const { registered } = provideModelContext()
    const { session, repository } = fakeSession()
    await installWebMcp({ router: fakeRouter(), session })

    const output = await call(registered, 'list_recent_activity', { filter: 'expenses', limit: 5 })
    expect(repository.activity.listForAccount).toHaveBeenCalledWith({ filter: 'expenses', limit: 5 })
    expect(output.items).toEqual([{
      id: 'activity-1', kind: 'expense.created', createdAt: '2026-09-09T10:00:00.000Z',
      group: { id: group.id, name: 'Lake House' }, actor: { id: 'alex', name: 'Alex' },
      subject: { kind: 'expense', id: 'dinner', label: 'Dinner' }, expenseId: 'dinner',
    }])
    await expect(tool(registered, 'list_recent_activity').execute({ filter: 'everything' }, { signal: new AbortController().signal })).rejects.toThrow('filter must be one of')
  })

  it('reuses a read for a short time instead of re-reading every document', async () => {
    const { registered } = provideModelContext()
    const { session, repository } = fakeSession()
    let now = 1_000_000
    await installWebMcp({ router: fakeRouter(), session }, () => now)

    await call(registered, 'search_expenses', { query: 'dinner' })
    await call(registered, 'search_expenses', { query: 'lunch' })
    await call(registered, 'list_groups', {})
    expect(repository.groups.list).toHaveBeenCalledTimes(1)
    expect(repository.expenses.listForGroup).toHaveBeenCalledTimes(1)

    now += 31_000
    await call(registered, 'search_expenses', { query: 'dinner' })
    expect(repository.expenses.listForGroup).toHaveBeenCalledTimes(2)

    // A failed read is never reused.
    vi.mocked(repository.groups.list).mockRejectedValueOnce(new Error('offline'))
    now += 31_000
    await expect(call(registered, 'list_groups', {})).rejects.toThrow('offline')
    await expect(call(registered, 'list_groups', {})).resolves.toEqual(expect.objectContaining({ groups: [expect.objectContaining({ id: group.id })] }))
  })

  it('does not fail or register tools in browsers without WebMCP', async () => {
    const registerTool = vi.fn()
    const dispose = await installWebMcp({ router: fakeRouter(), session: fakeSession().session })
    expect(registerTool).not.toHaveBeenCalled()
    expect(dispose()).toBeUndefined()
  })

  describe('add_expense', () => {
    it('opens the prefilled editor and waits for the user to save it', async () => {
      const { registered } = provideModelContext()
      const router = fakeRouter()
      const { session, repository } = fakeSession()
      await installWebMcp({ router, session })

      const pending = call(registered, 'add_expense', { groupId: group.id, description: 'Dinner at Nopa', amount: '84.5', participantIds: ['maya', 'alex'], category: 'Food' })
      const draftId = await openedDraft(router, { name: 'groups-expense-create', query: { groupId: group.id } })
      expect(claimAgentDraft(owner, draftId, 'expense', group.id)).toEqual({
        kind: 'expense', groupId: group.id, description: 'Dinner at Nopa', amountText: '84.50', currency: 'USD',
        date: undefined, category: 'Food', notes: undefined, paidBy: undefined, participantIds: ['maya', 'alex'],
      })
      reportAgentDraftQueued(draftId, 'op-1')
      reportAgentDraftSaved(draftId, 'expense-9')
      await expect(pending).resolves.toEqual({ status: 'saved', expenseId: 'expense-9', message: 'The user reviewed and saved the expense.' })

      // What the user saved shows up in the next read instead of a reused answer.
      const listCalls = repository.groups.list.mock.calls.length
      await call(registered, 'list_groups', {})
      expect(repository.groups.list.mock.calls.length).toBe(listCalls + 1)
    })

    it('tells the agent nothing was saved when the user leaves the form', async () => {
      const { registered } = provideModelContext()
      const router = fakeRouter()
      await installWebMcp({ router, session: fakeSession().session })

      const pending = call(registered, 'add_expense', { groupId: group.id })
      const draftId = await openedDraft(router, { name: 'groups-expense-create' })
      claimAgentDraft(owner, draftId, 'expense', group.id)
      reportAgentDraftLeft(draftId)
      await expect(pending).resolves.toEqual(expect.objectContaining({ status: 'cancelled', reason: 'left' }))
    })

    it('stops waiting when the agent cancels, leaving the form for the user', async () => {
      const { registered } = provideModelContext()
      const router = fakeRouter()
      await installWebMcp({ router, session: fakeSession().session })

      const controller = new AbortController()
      const pending = tool(registered, 'add_expense').execute({ groupId: group.id }, { signal: controller.signal })
      await openedDraft(router, { name: 'groups-expense-create' })
      controller.abort()
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    })

    it('rejects details the editor could not use before opening anything', async () => {
      const { registered } = provideModelContext()
      const router = fakeRouter()
      await installWebMcp({ router, session: fakeSession().session })

      await expect(call(registered, 'add_expense', { groupId: group.id, participantIds: ['maya', 'sam'] })).rejects.toThrow('sam is not an active member of this group. Call list_group_members')
      await expect(call(registered, 'add_expense', { groupId: group.id, paidBy: 'sam' })).rejects.toThrow('paidBy sam is not an active member')
      await expect(call(registered, 'add_expense', { groupId: group.id, amount: '84.505' })).rejects.toThrow('at most 2 decimal places')
      await expect(call(registered, 'add_expense', { groupId: group.id, amount: '0' })).rejects.toThrow('greater than zero')
      await expect(call(registered, 'add_expense', { groupId: group.id, category: 'Rent' })).rejects.toThrow('category must be one of')
      await expect(call(registered, 'add_expense', { groupId: 'elsewhere' })).rejects.toThrow('Group was not found')
      expect(router.push).not.toHaveBeenCalled()
    })
  })

  describe('record_settlement', () => {
    it('opens Settle Up on the open balance with the payment prefilled and waits for Record', async () => {
      const { registered } = provideModelContext()
      const router = fakeRouter()
      await installWebMcp({ router, session: fakeSession().session })

      const pending = call(registered, 'record_settlement', { groupId: group.id, withParticipantId: 'alex', amount: '10', method: 'payment-app' })
      const draftId = await openedDraft(router, {
        name: 'group-settle-up',
        params: { groupId: group.id },
        query: { plan: 'simplified', senderId: 'alex', recipientId: 'maya', currency: 'USD', debtMinor: '1200' },
      })
      expect(claimAgentDraft(owner, draftId, 'settlement', group.id)).toEqual({ kind: 'settlement', groupId: group.id, amountText: '10.00', method: 'payment-app', occurredOn: undefined, note: undefined })
      reportAgentDraftSaved(draftId, 'settlement-3')
      await expect(pending).resolves.toEqual({ status: 'saved', settlementId: 'settlement-3', message: 'The user reviewed and saved the payment.' })
    })

    it('defaults to the whole open balance and refuses amounts or people it cannot settle', async () => {
      const { registered } = provideModelContext()
      const router = fakeRouter()
      await installWebMcp({ router, session: fakeSession().session })

      await expect(call(registered, 'record_settlement', { groupId: group.id, withParticipantId: 'alex', amount: '12.01' })).rejects.toThrow('cannot exceed the open balance of $12.00')
      await expect(call(registered, 'record_settlement', { groupId: group.id, withParticipantId: 'maya' })).rejects.toThrow('someone other than the signed-in user')
      await expect(call(registered, 'record_settlement', { groupId: group.id, withParticipantId: 'sam' })).rejects.toThrow('sam is not an active member')
      await expect(call(registered, 'record_settlement', { groupId: group.id, withParticipantId: 'alex', currency: 'EUR' })).rejects.toThrow('no open EUR balance')
      expect(router.push).not.toHaveBeenCalled()

      const pending = call(registered, 'record_settlement', { groupId: group.id, withParticipantId: 'alex' })
      const draftId = await openedDraft(router, { name: 'group-settle-up' })
      expect(claimAgentDraft(owner, draftId, 'settlement', group.id)).toEqual(expect.objectContaining({ amountText: '12.00' }))
      reportAgentDraftLeft(draftId)
      await expect(pending).resolves.toEqual(expect.objectContaining({ status: 'cancelled', reason: 'left', message: 'The user left the form without saving. No payment was saved.' }))
    })
  })

  it('names the open balances the user does have when a payment pair has none', async () => {
    const { registered } = provideModelContext()
    const { session, repository } = fakeSession()
    repository.groups.listMembers.mockResolvedValue([...members, { id: 'jo', displayName: 'Jo', initials: 'J', isCurrentUser: false, role: 'member' }])
    await installWebMcp({ router: fakeRouter(), session })

    await expect(call(registered, 'record_settlement', { groupId: group.id, withParticipantId: 'jo' }))
      .rejects.toThrow("There is no open balance between you and Jo in this group's simplified plan. Your open balances: Alex (alex) owes you $12.00.")
  })

  function fakeRouter() {
    return { push: vi.fn(async () => undefined) } as unknown as Router & { push: ReturnType<typeof vi.fn> }
  }

  /** Waits for the tool to navigate, checks where it went, and returns the draft ID it put in the URL. */
  async function openedDraft(router: Router & { push: ReturnType<typeof vi.fn> }, expected: Record<string, unknown>): Promise<string> {
    await vi.waitFor(() => expect(router.push).toHaveBeenCalled())
    const location = router.push.mock.calls.at(-1)![0] as { query: Record<string, string> }
    const { query, ...rest } = expected as { query?: Record<string, string> }
    expect(location).toMatchObject({ ...rest, ...(query ? { query } : {}) })
    return location.query.agentDraft
  }

  function provideModelContext() {
    const registered: WebMCP.ModelContextTool[] = []
    const registrationOptions: WebMCP.ModelContextRegisterToolOptions[] = []
    const modelContext = {
      registerTool: vi.fn(async (tool: WebMCP.ModelContextTool, options?: WebMCP.ModelContextRegisterToolOptions) => {
        registered.push(tool)
        if (options) registrationOptions.push(options)
      }),
    } as unknown as WebMCP.ModelContext
    Object.defineProperty(document, 'modelContext', { configurable: true, value: modelContext })
    return { registered, registrationOptions }
  }

  function tool(registered: readonly WebMCP.ModelContextTool[], name: string): WebMCP.ModelContextTool {
    const found = registered.find((candidate) => candidate.name === name)
    if (!found) throw new Error(`${name} was not registered`)
    return found
  }

  async function call(registered: readonly WebMCP.ModelContextTool[], name: string, input: Record<string, unknown>) {
    return JSON.parse(String(await tool(registered, name).execute(input, { signal: new AbortController().signal })))
  }

  function fakeSession() {
    const repository = {
      app: { getCurrentUser: vi.fn(async () => members[0]) },
      groups: {
        list: vi.fn(async () => [group]),
        getById: vi.fn(async (groupId: string) => groupId === group.id ? group : undefined),
        listMembers: vi.fn(async () => members),
        getBalanceSnapshot: vi.fn(async () => ({ groupId: group.id, balanceRevision: 3, simplifyDebtsEnabled: true, pairwise: [], simplified: [{ fromParticipantId: 'alex', toParticipantId: 'maya', money: { currency: 'USD', minorAmount: 1200 } }] })),
      },
      expenses: {
        listForGroup: vi.fn(async () => [expense]),
        getById: vi.fn(async (_groupId: string, expenseId: string) => expenseId === expense.id ? expense : undefined),
      },
      activity: { listForAccount: vi.fn(async () => ({ items: [activity] })) },
    }
    const session = { ready: Promise.resolve(), principal: Promise.resolve(principal), repository: repository as unknown as AppRepository } as AppDataSession
    return { session, repository }
  }
})
