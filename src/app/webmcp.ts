/// <reference types="webmcp-types" />
import type { Router } from 'vue-router'
import type { AppDataSession } from '../data/session'
import type { Debt, Money } from '../domain/model'
import { assertCurrencyCode, type CurrencyCode } from '../domain/money'
import { searchExpenses } from '../domain/search'

const MAX_TEXT_LENGTH = 200
const MAX_TOOL_RESULTS = 25

interface ToolInput {
  readonly [key: string]: unknown
}

interface WebMcpOptions {
  readonly router: Router
  readonly session: AppDataSession
}

const listGroupsSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const

const groupBalancesSchema = {
  type: 'object',
  properties: {
    groupId: { type: 'string', description: 'The group ID returned by list_groups.' },
    plan: { type: 'string', enum: ['pairwise', 'simplified'], description: 'Which debt plan to return.' },
  },
  required: ['groupId'],
  additionalProperties: false,
} as const

const searchExpensesSchema = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Text in an expense description or note.' },
    groupId: { type: 'string', description: 'Limit the search to one group.' },
    dateFrom: { type: 'string', description: 'Inclusive date in YYYY-MM-DD format.' },
    dateTo: { type: 'string', description: 'Inclusive date in YYYY-MM-DD format.' },
    currency: { type: 'string', description: 'Exact ISO 4217 currency code for amount filters.' },
    minMinor: { type: 'integer', description: 'Minimum amount in minor currency units.' },
    maxMinor: { type: 'integer', description: 'Maximum amount in minor currency units.' },
    limit: { type: 'integer', description: 'Maximum number of matching expenses, up to 25.' },
  },
  additionalProperties: false,
} as const

const expenseDetailsSchema = {
  type: 'object',
  properties: {
    groupId: { type: 'string', description: 'The group ID returned by list_groups.' },
    expenseId: { type: 'string', description: 'The expense ID returned by search_expenses.' },
  },
  required: ['groupId', 'expenseId'],
  additionalProperties: false,
} as const

const openExpenseFormSchema = {
  type: 'object',
  properties: {
    groupId: { type: 'string', description: 'The group ID where the new expense should be entered.' },
  },
  required: ['groupId'],
  additionalProperties: false,
} as const

function asInput(value: unknown): ToolInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Tool input must be an object')
  return value as ToolInput
}

function requiredText(input: ToolInput, key: string): string {
  const value = input[key]
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_TEXT_LENGTH) {
    throw new Error(`${key} must be a non-empty string of at most ${MAX_TEXT_LENGTH} characters`)
  }
  return value.trim()
}

function optionalText(input: ToolInput, key: string): string | undefined {
  if (input[key] === undefined) return undefined
  return requiredText(input, key)
}

function optionalDate(input: ToolInput, key: string): string | undefined {
  const value = optionalText(input, key)
  if (value === undefined) return undefined
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${key} must use YYYY-MM-DD`)
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) throw new Error(`${key} must be a valid date`)
  return value
}

function optionalMinorAmount(input: ToolInput, key: string): number | undefined {
  if (input[key] === undefined) return undefined
  const value = input[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`${key} must be a non-negative minor-unit integer`)
  return value
}

function optionalCurrency(input: ToolInput): CurrencyCode | undefined {
  const value = optionalText(input, 'currency')
  if (value === undefined) return undefined
  assertCurrencyCode(value)
  return value
}

function optionalLimit(input: ToolInput): number {
  if (input.limit === undefined) return MAX_TOOL_RESULTS
  const value = input.limit
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_TOOL_RESULTS) {
    throw new Error(`limit must be an integer from 1 to ${MAX_TOOL_RESULTS}`)
  }
  return value
}

function json(value: unknown): string {
  return JSON.stringify(value)
}

function money(value: Money): { readonly currency: CurrencyCode; readonly minorAmount: number } {
  return { currency: value.currency, minorAmount: value.minorAmount }
}

function debt(value: Debt, names: ReadonlyMap<string, string>): unknown {
  return {
    from: { id: value.fromParticipantId, name: names.get(value.fromParticipantId) ?? value.fromParticipantId },
    to: { id: value.toParticipantId, name: names.get(value.toParticipantId) ?? value.toParticipantId },
    money: money(value.money),
  }
}

async function listGroups(session: AppDataSession): Promise<string> {
  await session.ready
  const groups = await session.repository.groups.list()
  return json({
    groups: groups.slice(0, 100).map((group) => ({
      id: group.id,
      name: group.name,
      kind: group.kind,
      currency: group.currency,
      memberCount: group.memberIds.length,
    })),
  })
}

async function getGroupBalances(session: AppDataSession, inputValue: unknown): Promise<string> {
  const input = asInput(inputValue)
  const groupId = requiredText(input, 'groupId')
  const planValue = optionalText(input, 'plan')
  if (planValue !== undefined && planValue !== 'pairwise' && planValue !== 'simplified') throw new Error('plan must be pairwise or simplified')
  await session.ready
  const [group, members, snapshot] = await Promise.all([
    session.repository.groups.getById(groupId),
    session.repository.groups.listMembers(groupId),
    session.repository.groups.getBalanceSnapshot(groupId),
  ])
  if (!group) throw new Error('Group was not found or is not accessible')
  const names = new Map(members.map((member) => [member.id, member.displayName]))
  const plan = planValue ?? (snapshot.simplifyDebtsEnabled ? 'simplified' : 'pairwise')
  return json({
    group: { id: group.id, name: group.name, currency: group.currency },
    balanceRevision: snapshot.balanceRevision,
    plan,
    debts: snapshot[plan].map((item) => debt(item, names)),
  })
}

async function searchAuthorizedExpenses(session: AppDataSession, inputValue: unknown): Promise<string> {
  const input = asInput(inputValue)
  const query = optionalText(input, 'query')
  const groupId = optionalText(input, 'groupId')
  const dateFrom = optionalDate(input, 'dateFrom')
  const dateTo = optionalDate(input, 'dateTo')
  const currency = optionalCurrency(input)
  const minMinor = optionalMinorAmount(input, 'minMinor')
  const maxMinor = optionalMinorAmount(input, 'maxMinor')
  const limit = optionalLimit(input)
  await session.ready
  const allGroups = await session.repository.groups.list()
  const groups = groupId ? allGroups.filter((group) => group.id === groupId) : allGroups
  if (groupId && groups.length === 0) throw new Error('Group was not found or is not accessible')
  const [expensePages, memberPages] = await Promise.all([
    Promise.all(groups.map((group) => session.repository.expenses.listForGroup(group.id))),
    Promise.all(groups.map((group) => session.repository.groups.listMembers(group.id))),
  ])
  const membersByGroup = new Map(groups.map((group, index) => [group.id, memberPages[index]]))
  const result = searchExpenses({
    groups,
    membersByGroup,
    expenses: expensePages.flat(),
    filters: { query, ...(groupId ? { groupIds: [groupId] } : {}), dateFrom, dateTo, currency, minMinor, maxMinor },
    coverageStatus: 'complete',
  })
  return json({
    coverage: result.coverage,
    expenses: result.items.slice(0, limit).map(({ group, expense }) => ({
      id: expense.id,
      groupId: group.id,
      groupName: group.name,
      description: expense.description,
      date: expense.date,
      total: money(expense.total),
      category: expense.category,
    })),
  })
}

async function getExpenseDetails(session: AppDataSession, inputValue: unknown): Promise<string> {
  const input = asInput(inputValue)
  const groupId = requiredText(input, 'groupId')
  const expenseId = requiredText(input, 'expenseId')
  await session.ready
  const [group, members, expense] = await Promise.all([
    session.repository.groups.getById(groupId),
    session.repository.groups.listMembers(groupId),
    session.repository.expenses.getById(groupId, expenseId),
  ])
  if (!group || !expense) throw new Error('Expense was not found or is not accessible')
  const names = new Map(members.map((member) => [member.id, member.displayName]))
  const allocation = (item: { readonly participantId: string; readonly money: Money }) => ({
    participant: { id: item.participantId, name: names.get(item.participantId) ?? item.participantId },
    money: money(item.money),
  })
  return json({
    group: { id: group.id, name: group.name, currency: group.currency },
    expense: {
      id: expense.id,
      description: expense.description,
      date: expense.date,
      total: money(expense.total),
      category: expense.category,
      splitMethod: expense.splitMethod,
      reimbursement: expense.reimbursement === true,
      payments: expense.payments.map(allocation),
      allocations: expense.allocations.map(allocation),
      ...(expense.notes ? { notes: expense.notes } : {}),
      revision: expense.revision,
      syncState: expense.syncState,
    },
  })
}

async function openExpenseForm(session: AppDataSession, router: Router, inputValue: unknown): Promise<string> {
  const input = asInput(inputValue)
  const groupId = requiredText(input, 'groupId')
  await session.ready
  const group = await session.repository.groups.getById(groupId)
  if (!group) throw new Error('Group was not found or is not accessible')
  await router.push({ name: 'groups-expense-create', query: { groupId } })
  return json({ opened: true, group: { id: group.id, name: group.name } })
}

export async function installWebMcp({ router, session }: WebMcpOptions): Promise<() => void> {
  const modelContext = document.modelContext
  if (!modelContext) return () => undefined
  const controller = new AbortController()
  const tools: WebMCP.ModelContextTool[] = [
    {
      name: 'list_groups',
      title: 'List groups',
      description: 'List the signed-in user’s authorized Split Unwise groups and their currencies.',
      inputSchema: listGroupsSchema,
      annotations: { readOnlyHint: true },
      execute: () => listGroups(session),
    },
    {
      name: 'get_group_balances',
      title: 'Get group balances',
      description: 'Read who owes whom in an authorized Split Unwise group, with a stable balance revision.',
      inputSchema: groupBalancesSchema,
      annotations: { readOnlyHint: true },
      execute: (_input, { signal }) => getGroupBalances(session, _input).then((value) => { if (signal.aborted) throw new DOMException('Tool execution cancelled', 'AbortError'); return value }),
    },
    {
      name: 'search_expenses',
      title: 'Search expenses',
      description: 'Search confirmed, non-deleted expenses across the signed-in user’s authorized groups.',
      inputSchema: searchExpensesSchema,
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: (_input, { signal }) => searchAuthorizedExpenses(session, _input).then((value) => { if (signal.aborted) throw new DOMException('Tool execution cancelled', 'AbortError'); return value }),
    },
    {
      name: 'get_expense_details',
      title: 'Get expense details',
      description: 'Read the participants, split, amount, and audit state for one authorized expense.',
      inputSchema: expenseDetailsSchema,
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: (_input, { signal }) => getExpenseDetails(session, _input).then((value) => { if (signal.aborted) throw new DOMException('Tool execution cancelled', 'AbortError'); return value }),
    },
    {
      name: 'open_expense_form',
      title: 'Open expense form',
      description: 'Open the visible Split Unwise expense form for an authorized group without saving anything.',
      inputSchema: openExpenseFormSchema,
      execute: (_input, { signal }) => openExpenseForm(session, router, _input).then((value) => { if (signal.aborted) throw new DOMException('Tool execution cancelled', 'AbortError'); return value }),
    },
  ]
  try {
    for (const tool of tools) await modelContext.registerTool(tool, { signal: controller.signal })
  } catch (error) {
    controller.abort()
    console.warn('WebMCP tools could not be registered', error)
    return () => undefined
  }
  return () => controller.abort()
}
