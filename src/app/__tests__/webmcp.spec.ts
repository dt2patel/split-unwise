import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Router } from 'vue-router'
import type { AppDataSession } from '../../data/session'
import type { ActivityItem, AppRepository, ExpenseRow, Group, Member } from '../../data/repositories'
import type { WebMCP } from 'webmcp-types'
import { installWebMcp } from '../webmcp'

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

  it('registers read-only tools only when the browser provides modelContext', async () => {
    const { registered, registrationOptions } = provideModelContext()
    const router = { push: vi.fn(async () => undefined) } as unknown as Router
    const dispose = await installWebMcp({ router, session: fakeSession().session })

    expect(registered.map(({ name }) => name)).toEqual([
      'whoami', 'list_groups', 'list_group_members', 'get_group_balances', 'get_friend_balances',
      'search_expenses', 'get_expense_details', 'list_recent_activity', 'open_expense_form',
    ])
    expect(registered.filter(({ annotations }) => annotations?.readOnlyHint).map(({ name }) => name)).toHaveLength(8)
    // Every result carrying names or text written by other members is marked untrusted.
    expect(registered.filter(({ annotations }) => annotations?.untrustedContentHint).map(({ name }) => name)).toEqual([
      'list_groups', 'list_group_members', 'get_group_balances', 'get_friend_balances', 'search_expenses', 'get_expense_details', 'list_recent_activity',
    ])

    const open = tool(registered, 'open_expense_form')
    await open.execute({ groupId: group.id }, { signal: new AbortController().signal })
    expect(router.push).toHaveBeenCalledWith({ name: 'groups-expense-create', query: { groupId: group.id } })

    dispose()
    expect(registrationOptions.every(({ signal }) => signal?.aborted)).toBe(true)
  })

  it('returns amounts as minor units, a decimal and a display string', async () => {
    const { registered } = provideModelContext()
    await installWebMcp({ router: {} as Router, session: fakeSession().session })

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
    await installWebMcp({ router: {} as Router, session: fakeSession().session })

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
    await installWebMcp({ router: {} as Router, session })

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
    await installWebMcp({ router: {} as Router, session }, () => now)

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
    const dispose = await installWebMcp({ router: {} as Router, session: fakeSession().session })
    expect(registerTool).not.toHaveBeenCalled()
    expect(dispose()).toBeUndefined()
  })

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
    const session = { ready: Promise.resolve(), repository: repository as unknown as AppRepository } as AppDataSession
    return { session, repository }
  }
})
