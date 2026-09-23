/// <reference types="webmcp-types" />
import type { Router } from 'vue-router'
import { formatMoney } from '../components/MoneyAmount.vue'
import type { ActivityFilter, ActivityItem, ExpenseRow, Group, GroupBalanceSnapshot, Member } from '../data/repositories'
import type { AppDataSession } from '../data/session'
import { projectAccountBalances, type AccountBalanceContext } from '../domain/accountBalances'
import type { Debt, Money } from '../domain/model'
import { assertCurrencyCode, fromMinorUnits, type CurrencyCode } from '../domain/money'
import { searchExpenses } from '../domain/search'

const MAX_TEXT_LENGTH = 200
const MAX_TOOL_RESULTS = 25
const MAX_GROUPS = 100
/** One agent task often reads the same data several times; reuse an answer briefly instead of re-reading every document. */
const READ_REUSE_MS = 30_000
const ACTIVITY_FILTERS: readonly ActivityFilter[] = ['all', 'comments', 'expenses', 'payments']
const AMOUNT_NOTE = 'Amounts include minorAmount (integer minor units such as cents), amount (a decimal string) and formatted (for display).'

interface ToolInput {
  readonly [key: string]: unknown
}

interface WebMcpOptions {
  readonly router: Router
  readonly session: AppDataSession
}

const noInputSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const

const groupSchema = {
  type: 'object',
  properties: {
    groupId: { type: 'string', description: 'The group ID returned by list_groups.' },
  },
  required: ['groupId'],
  additionalProperties: false,
} as const

const groupBalancesSchema = {
  type: 'object',
  properties: {
    groupId: { type: 'string', description: 'The group ID returned by list_groups.' },
    plan: { type: 'string', enum: ['pairwise', 'simplified'], description: 'Which debt plan to return. Defaults to the plan the group uses.' },
  },
  required: ['groupId'],
  additionalProperties: false,
} as const

const friendBalancesSchema = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Only return friends whose name contains this text (case-insensitive).' },
  },
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

const recentActivitySchema = {
  type: 'object',
  properties: {
    filter: { type: 'string', enum: ACTIVITY_FILTERS, description: 'Which kind of activity to return. Defaults to all.' },
    limit: { type: 'integer', description: 'Maximum number of items, newest first, up to 25.' },
  },
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

function optionalActivityFilter(input: ToolInput): ActivityFilter {
  const value = optionalText(input, 'filter')
  if (value === undefined) return 'all'
  const filter = ACTIVITY_FILTERS.find((candidate) => candidate === value)
  if (!filter) throw new Error(`filter must be one of ${ACTIVITY_FILTERS.join(', ')}`)
  return filter
}

function json(value: unknown): string {
  return JSON.stringify(value)
}

/** Minor units alone are easy for a model to misread (8400 is $84.00), so every amount also carries a decimal and a display string. */
function money(value: Money): { readonly currency: CurrencyCode; readonly minorAmount: number; readonly amount: string; readonly formatted: string } {
  return { currency: value.currency, minorAmount: value.minorAmount, amount: fromMinorUnits(value.minorAmount, value.currency), formatted: formatMoney(value, 'en-US') }
}

type MoneyOutput = ReturnType<typeof money>

/** A signed position from the signed-in user's side: positive means the other person owes them. */
function position(currency: CurrencyCode, signedMinor: number): { readonly direction: 'owes_you' | 'you_owe' | 'settled'; readonly money: MoneyOutput } {
  return {
    direction: signedMinor > 0 ? 'owes_you' : signedMinor < 0 ? 'you_owe' : 'settled',
    money: money({ currency, minorAmount: Math.abs(signedMinor) }),
  }
}

function person(id: string, names: ReadonlyMap<string, string>): { readonly id: string; readonly name: string } {
  return { id, name: names.get(id) ?? id }
}

function debt(value: Debt, names: ReadonlyMap<string, string>): unknown {
  const from = person(value.fromParticipantId, names)
  const to = person(value.toParticipantId, names)
  return { from, to, money: money(value.money), summary: `${from.name} owes ${to.name} ${formatMoney(value.money, 'en-US')}` }
}

function memberNames(members: readonly Member[]): ReadonlyMap<string, string> {
  return new Map(members.map((member) => [member.id, member.displayName]))
}

function cancellable<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  return work.then((value) => {
    if (signal.aborted) throw new DOMException('Tool execution cancelled', 'AbortError')
    return value
  })
}

interface Reader {
  currentUser(): Promise<Member>
  groups(): Promise<readonly Group[]>
  group(groupId: string): Promise<Group | undefined>
  members(groupId: string): Promise<readonly Member[]>
  balances(groupId: string): Promise<GroupBalanceSnapshot>
  expenses(groupId: string): Promise<readonly ExpenseRow[]>
  /** Drops reused answers, e.g. after this tab saved a change. */
  forget(): void
}

function createReader(session: AppDataSession, now: () => number): Reader {
  const recent = new Map<string, { readonly until: number; readonly value: Promise<unknown> }>()
  function reuse<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = recent.get(key)
    if (hit && hit.until > now()) return hit.value as Promise<T>
    const value = session.ready.then(load)
    recent.set(key, { until: now() + READ_REUSE_MS, value })
    // A failed read is never reused.
    value.catch(() => { if (recent.get(key)?.value === value) recent.delete(key) })
    return value
  }
  const { app, groups, expenses } = session.repository
  return {
    currentUser: () => reuse('user', () => app.getCurrentUser()),
    groups: () => reuse('groups', () => groups.list()),
    group: (groupId) => reuse(`group:${groupId}`, () => groups.getById(groupId)),
    members: (groupId) => reuse(`members:${groupId}`, () => groups.listMembers(groupId)),
    balances: (groupId) => reuse(`balances:${groupId}`, () => groups.getBalanceSnapshot(groupId)),
    expenses: (groupId) => reuse(`expenses:${groupId}`, () => expenses.listForGroup(groupId)),
    forget: () => recent.clear(),
  }
}

async function whoami(read: Reader): Promise<string> {
  const user = await read.currentUser()
  return json({ user: { id: user.id, name: user.displayName } })
}

async function listGroups(read: Reader): Promise<string> {
  const groups = await read.groups()
  return json({
    groups: groups.slice(0, MAX_GROUPS).map((group) => ({
      id: group.id,
      name: group.name,
      kind: group.kind,
      currency: group.currency,
      memberCount: group.memberIds.length,
    })),
  })
}

async function listGroupMembers(read: Reader, inputValue: unknown): Promise<string> {
  const groupId = requiredText(asInput(inputValue), 'groupId')
  const [group, members] = await Promise.all([read.group(groupId), read.members(groupId)])
  if (!group) throw new Error('Group was not found or is not accessible')
  return json({
    group: { id: group.id, name: group.name, currency: group.currency },
    members: members.map((member) => ({
      id: member.id,
      name: member.displayName,
      isYou: member.isCurrentUser,
      ...(member.role ? { role: member.role } : {}),
      ...(member.accountStatus === 'deleted' ? { status: 'deleted-account' } : {}),
    })),
  })
}

async function getGroupBalances(read: Reader, inputValue: unknown): Promise<string> {
  const input = asInput(inputValue)
  const groupId = requiredText(input, 'groupId')
  const planValue = optionalText(input, 'plan')
  if (planValue !== undefined && planValue !== 'pairwise' && planValue !== 'simplified') throw new Error('plan must be pairwise or simplified')
  const [group, members, snapshot] = await Promise.all([read.group(groupId), read.members(groupId), read.balances(groupId)])
  if (!group) throw new Error('Group was not found or is not accessible')
  const names = memberNames(members)
  const plan = planValue ?? (snapshot.simplifyDebtsEnabled ? 'simplified' : 'pairwise')
  return json({
    group: { id: group.id, name: group.name, currency: group.currency },
    balanceRevision: snapshot.balanceRevision,
    plan,
    debts: snapshot[plan].map((item) => debt(item, names)),
  })
}

async function getFriendBalances(read: Reader, inputValue: unknown): Promise<string> {
  const nameFilter = optionalText(asInput(inputValue), 'name')?.toLocaleLowerCase()
  const [user, groups] = await Promise.all([read.currentUser(), read.groups()])
  const loaded = await Promise.allSettled(groups.slice(0, MAX_GROUPS).map(async (group): Promise<AccountBalanceContext> => {
    const [members, snapshot] = await Promise.all([read.members(group.id), read.balances(group.id)])
    return { group, members, snapshot }
  }))
  const contexts = loaded.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])
  const unavailable = groups.filter((_group, index) => loaded[index]?.status === 'rejected')
  const projection = projectAccountBalances(user.id, contexts)
  const friends = projection.friends
    .filter((friend) => !nameFilter || friend.displayName.toLocaleLowerCase().includes(nameFilter))
    .slice(0, 50)
  return json({
    totals: projection.currencies.map((currency) => ({
      currency: currency.currency,
      owedToYou: money({ currency: currency.currency, minorAmount: currency.owedToUserMinor }),
      youOwe: money({ currency: currency.currency, minorAmount: currency.userOwesMinor }),
      net: position(currency.currency, currency.netMinor),
    })),
    friends: friends.map((friend) => ({
      ...(friend.pending ? { pendingInvite: true } : { id: friend.id }),
      name: friend.displayName,
      balances: friend.positions.filter(({ minorAmount }) => minorAmount !== 0).map(({ currency, minorAmount }) => position(currency, minorAmount)),
      byGroup: friend.breakdowns
        .filter(({ minorAmount }) => minorAmount !== 0)
        .map((breakdown) => ({ groupId: breakdown.contextId, groupName: breakdown.contextName, ...position(breakdown.currency, breakdown.minorAmount) })),
    })),
    ...(unavailable.length ? { unavailableGroups: unavailable.map((group) => ({ id: group.id, name: group.name })) } : {}),
  })
}

async function searchAuthorizedExpenses(read: Reader, inputValue: unknown): Promise<string> {
  const input = asInput(inputValue)
  const query = optionalText(input, 'query')
  const groupId = optionalText(input, 'groupId')
  const dateFrom = optionalDate(input, 'dateFrom')
  const dateTo = optionalDate(input, 'dateTo')
  const currency = optionalCurrency(input)
  const minMinor = optionalMinorAmount(input, 'minMinor')
  const maxMinor = optionalMinorAmount(input, 'maxMinor')
  const limit = optionalLimit(input)
  const allGroups = await read.groups()
  const groups = groupId ? allGroups.filter((group) => group.id === groupId) : allGroups
  if (groupId && groups.length === 0) throw new Error('Group was not found or is not accessible')
  const [expensePages, memberPages] = await Promise.all([
    Promise.all(groups.map((group) => read.expenses(group.id))),
    Promise.all(groups.map((group) => read.members(group.id))),
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

async function getExpenseDetails(session: AppDataSession, read: Reader, inputValue: unknown): Promise<string> {
  const input = asInput(inputValue)
  const groupId = requiredText(input, 'groupId')
  const expenseId = requiredText(input, 'expenseId')
  await session.ready
  // The expense itself is always read fresh: it is one document, and its revision is what edits are checked against.
  const [group, members, expense] = await Promise.all([
    read.group(groupId),
    read.members(groupId),
    session.repository.expenses.getById(groupId, expenseId),
  ])
  if (!group || !expense) throw new Error('Expense was not found or is not accessible')
  const names = memberNames(members)
  const allocation = (item: { readonly participantId: string; readonly money: Money }) => ({
    participant: person(item.participantId, names),
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

async function listRecentActivity(session: AppDataSession, read: Reader, inputValue: unknown): Promise<string> {
  const input = asInput(inputValue)
  const filter = optionalActivityFilter(input)
  const limit = optionalLimit(input)
  await session.ready
  const [page, groups] = await Promise.all([session.repository.activity.listForAccount({ filter, limit }), read.groups()])
  const groupNames = new Map(groups.map((group) => [group.id, group.name]))
  return json({
    items: page.items.slice(0, limit).map((item: ActivityItem) => ({
      id: item.id,
      kind: item.kind,
      createdAt: item.createdAt,
      group: { id: item.groupId, name: groupNames.get(item.groupId) ?? item.groupId },
      actor: { id: item.actor.id, name: item.actor.displayName },
      subject: { kind: item.subject.kind, id: item.subject.id, ...(item.subject.label ? { label: item.subject.label } : {}) },
      ...(item.expenseId ? { expenseId: item.expenseId } : {}),
      ...(item.settlementId ? { settlementId: item.settlementId } : {}),
    })),
  })
}

async function openExpenseForm(read: Reader, router: Router, inputValue: unknown): Promise<string> {
  const groupId = requiredText(asInput(inputValue), 'groupId')
  const group = await read.group(groupId)
  if (!group) throw new Error('Group was not found or is not accessible')
  await router.push({ name: 'groups-expense-create', query: { groupId } })
  return json({ opened: true, group: { id: group.id, name: group.name } })
}

export async function installWebMcp({ router, session }: WebMcpOptions, now: () => number = Date.now): Promise<() => void> {
  const modelContext = document.modelContext
  if (!modelContext) return () => undefined
  const controller = new AbortController()
  const read = createReader(session, now)
  // Names, descriptions and notes are written by other group members, so every result that carries them is untrusted content.
  const readOnly = { readOnlyHint: true, untrustedContentHint: true }
  const tools: WebMCP.ModelContextTool[] = [
    {
      name: 'whoami',
      title: 'Who am I',
      description: 'Return the signed-in Split Unwise user. Balances from the other tools are from this user’s point of view.',
      inputSchema: noInputSchema,
      annotations: { readOnlyHint: true },
      execute: (_input, { signal }) => cancellable(signal, whoami(read)),
    },
    {
      name: 'list_groups',
      title: 'List groups',
      description: 'List the signed-in user’s authorized Split Unwise groups (including one-to-one friend ledgers) and their currencies.',
      inputSchema: noInputSchema,
      annotations: readOnly,
      execute: (_input, { signal }) => cancellable(signal, listGroups(read)),
    },
    {
      name: 'list_group_members',
      title: 'List group members',
      description: 'List the members of an authorized group with their participant IDs. Use it to turn a person’s name into the ID other tools need.',
      inputSchema: groupSchema,
      annotations: readOnly,
      execute: (input, { signal }) => cancellable(signal, listGroupMembers(read, input)),
    },
    {
      name: 'get_group_balances',
      title: 'Get group balances',
      description: `Read who owes whom in an authorized Split Unwise group, with a stable balance revision. ${AMOUNT_NOTE}`,
      inputSchema: groupBalancesSchema,
      annotations: readOnly,
      execute: (input, { signal }) => cancellable(signal, getGroupBalances(read, input)),
    },
    {
      name: 'get_friend_balances',
      title: 'Get friend balances',
      description: `Read what each person owes the signed-in user, or is owed, across all of their groups, with a per-group breakdown and per-currency totals. Currencies are never combined. ${AMOUNT_NOTE}`,
      inputSchema: friendBalancesSchema,
      annotations: readOnly,
      execute: (input, { signal }) => cancellable(signal, getFriendBalances(read, input)),
    },
    {
      name: 'search_expenses',
      title: 'Search expenses',
      description: `Search confirmed, non-deleted expenses across the signed-in user’s authorized groups. ${AMOUNT_NOTE}`,
      inputSchema: searchExpensesSchema,
      annotations: readOnly,
      execute: (input, { signal }) => cancellable(signal, searchAuthorizedExpenses(read, input)),
    },
    {
      name: 'get_expense_details',
      title: 'Get expense details',
      description: `Read who paid, how an authorized expense is split, and its audit state. ${AMOUNT_NOTE}`,
      inputSchema: expenseDetailsSchema,
      annotations: readOnly,
      execute: (input, { signal }) => cancellable(signal, getExpenseDetails(session, read, input)),
    },
    {
      name: 'list_recent_activity',
      title: 'List recent activity',
      description: 'List the newest expense, comment, payment and membership changes across the signed-in user’s groups.',
      inputSchema: recentActivitySchema,
      annotations: readOnly,
      execute: (input, { signal }) => cancellable(signal, listRecentActivity(session, read, input)),
    },
    {
      name: 'open_expense_form',
      title: 'Open expense form',
      description: 'Open the visible Split Unwise expense form for an authorized group without saving anything.',
      inputSchema: openExpenseFormSchema,
      execute: (input, { signal }) => cancellable(signal, openExpenseForm(read, router, input)),
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
