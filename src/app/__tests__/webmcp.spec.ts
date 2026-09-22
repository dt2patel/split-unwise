import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Router } from 'vue-router'
import type { AppDataSession } from '../../data/session'
import type { AppRepository, ExpenseRow, Group, Member } from '../../data/repositories'
import type { WebMCP } from 'webmcp-types'
import { installWebMcp } from '../webmcp'

describe('WebMCP integration', () => {
  const group: Group = { id: 'lake-house', kind: 'group', name: 'Lake House', currency: 'USD', memberIds: ['maya', 'alex'], syncState: 'fresh' }
  const members: Member[] = [
    { id: 'maya', displayName: 'Maya', initials: 'M', isCurrentUser: true },
    { id: 'alex', displayName: 'Alex', initials: 'A', isCurrentUser: false },
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

  beforeEach(() => {
    Object.defineProperty(document, 'modelContext', { configurable: true, value: undefined })
  })

  it('registers read-only tools only when the browser provides modelContext', async () => {
    const registered: WebMCP.ModelContextTool[] = []
    const registrationOptions: WebMCP.ModelContextRegisterToolOptions[] = []
    const modelContext = {
      registerTool: vi.fn(async (tool: WebMCP.ModelContextTool, options?: WebMCP.ModelContextRegisterToolOptions) => {
        registered.push(tool)
        if (options) registrationOptions.push(options)
      }),
    } as unknown as WebMCP.ModelContext
    Object.defineProperty(document, 'modelContext', { configurable: true, value: modelContext })

    const router = { push: vi.fn(async () => undefined) } as unknown as Router
    const session = fakeSession()
    const dispose = await installWebMcp({ router, session })

    expect(registered.map(({ name }) => name)).toEqual([
      'list_groups', 'get_group_balances', 'search_expenses', 'get_expense_details', 'open_expense_form',
    ])
    expect(registered.filter(({ annotations }) => annotations?.readOnlyHint)).toHaveLength(4)
    expect(registered.find(({ name }) => name === 'search_expenses')?.annotations?.untrustedContentHint).toBe(true)

    const search = registered.find(({ name }) => name === 'search_expenses')!
    const output = JSON.parse(String(await search.execute({ query: 'dinner' }, { signal: new AbortController().signal })))
    expect(output.expenses).toEqual([expect.objectContaining({ id: 'dinner', total: { currency: 'USD', minorAmount: 2400 } })])

    const open = registered.find(({ name }) => name === 'open_expense_form')!
    await open.execute({ groupId: group.id }, { signal: new AbortController().signal })
    expect(router.push).toHaveBeenCalledWith({ name: 'groups-expense-create', query: { groupId: group.id } })

    dispose()
    expect(registrationOptions.every(({ signal }) => signal?.aborted)).toBe(true)
  })

  it('does not fail or register tools in browsers without WebMCP', async () => {
    const registerTool = vi.fn()
    const dispose = await installWebMcp({ router: {} as Router, session: fakeSession() })
    expect(registerTool).not.toHaveBeenCalled()
    expect(dispose()).toBeUndefined()
  })

  function fakeSession(): AppDataSession {
    const repository = {
      groups: {
        list: async () => [group],
        getById: async (groupId: string) => groupId === group.id ? group : undefined,
        listMembers: async () => members,
        getBalanceSnapshot: async () => ({ groupId: group.id, balanceRevision: 3, simplifyDebtsEnabled: true, pairwise: [], simplified: [{ fromParticipantId: 'alex', toParticipantId: 'maya', money: { currency: 'USD', minorAmount: 1200 } }] }),
      },
      expenses: {
        listForGroup: async () => [expense],
        getById: async (_groupId: string, expenseId: string) => expenseId === expense.id ? expense : undefined,
      },
    } as unknown as AppRepository
    return { ready: Promise.resolve(), repository } as AppDataSession
  }
})
