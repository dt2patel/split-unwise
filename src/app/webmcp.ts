/// <reference types="webmcp-types" />
import type { Router } from 'vue-router'
import { formatMoney } from '../components/MoneyAmount.vue'
import { appPrincipalKey } from '../data/principal'
import type { ActivityFilter, ActivityItem, ExpenseRow, Group, GroupBalanceSnapshot, Member, SettlementMethod } from '../data/repositories'
import type { AppDataSession } from '../data/session'
import { projectAccountBalances, type AccountBalanceContext } from '../domain/accountBalances'
import type { Debt, Money } from '../domain/model'
import { assertCurrencyCode, currencyExponent, fromMinorUnits, toMinorUnits, type CurrencyCode } from '../domain/money'
import { searchExpenses } from '../domain/search'
import { EXPENSE_CATEGORIES } from '../features/expenses/categories'
import { abandonAgentDraft, clearAgentDrafts, offerAgentDraft, type AgentDraft, type AgentDraftOutcome } from './agentDrafts'

const MAX_TEXT_LENGTH = 200
const MAX_TOOL_RESULTS = 25
const MAX_GROUPS = 100
/** One agent task often reads the same data several times; reuse an answer briefly instead of re-reading every document. */
const READ_REUSE_MS = 30_000
const ACTIVITY_FILTERS: readonly ActivityFilter[] = ['all', 'comments', 'expenses', 'payments']
const AMOUNT_NOTE = 'Amounts include minorAmount (integer minor units such as cents), amount (a decimal string) and formatted (for display).'
const MAX_NOTES_LENGTH = 1000
const MAX_PARTICIPANTS = 100
const SETTLEMENT_METHODS: readonly SettlementMethod[] = ['cash', 'bank-transfer', 'payment-app', 'other']
const REVIEW_NOTE = 'Nothing is saved until the user checks the prefilled form in this tab and taps the button themselves. The call waits for their decision: saved (with the new ID), queued (saved on this device, syncing when back online), or cancelled (nothing was saved).'

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

const addExpenseSchema = {
  type: 'object',
  properties: {
    groupId: { type: 'string', description: 'The group ID returned by list_groups.' },
    description: { type: 'string', description: 'What the expense was for, e.g. "Dinner at Nopa".' },
    amount: { type: 'string', description: 'The total as a decimal string in the expense currency, e.g. "84.50".' },
    currency: { type: 'string', description: 'ISO 4217 currency code. Defaults to the group currency.' },
    date: { type: 'string', description: 'The date in YYYY-MM-DD format. Defaults to today.' },
    category: { type: 'string', enum: EXPENSE_CATEGORIES, description: 'The expense category.' },
    notes: { type: 'string', description: 'Optional notes.' },
    paidBy: { type: 'string', description: 'Participant ID of who paid the whole amount (from list_group_members). Defaults to the signed-in user.' },
    participantIds: { type: 'array', items: { type: 'string' }, description: 'Participant IDs to split the amount equally between. Defaults to the group’s usual split.' },
  },
  required: ['groupId'],
  additionalProperties: false,
} as const

const recordSettlementSchema = {
  type: 'object',
  properties: {
    groupId: { type: 'string', description: 'The group ID returned by list_groups.' },
    withParticipantId: { type: 'string', description: 'Participant ID of the other person (from list_group_members). The payment can go either way; the direction comes from who owes whom.' },
    currency: { type: 'string', description: 'ISO 4217 currency code of the balance to settle. Required only when the two people have balances in more than one currency.' },
    amount: { type: 'string', description: 'The amount paid as a decimal string. Defaults to the whole open balance; it cannot exceed it.' },
    method: { type: 'string', enum: SETTLEMENT_METHODS, description: 'How the money was paid. Defaults to cash.' },
    date: { type: 'string', description: 'The date the payment happened, in YYYY-MM-DD format. Defaults to today.' },
    note: { type: 'string', description: 'Optional note.' },
  },
  required: ['groupId', 'withParticipantId'],
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

function optionalLongText(input: ToolInput, key: string, maxLength: number): string | undefined {
  const value = input[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > maxLength) throw new Error(`${key} must be a string of at most ${maxLength} characters`)
  return value.trim() || undefined
}

function optionalChoice<T extends string>(input: ToolInput, key: string, choices: readonly T[]): T | undefined {
  const value = optionalText(input, key)
  if (value === undefined) return undefined
  const choice = choices.find((candidate) => candidate === value)
  if (!choice) throw new Error(`${key} must be one of ${choices.join(', ')}`)
  return choice
}

function optionalIdList(input: ToolInput, key: string): readonly string[] | undefined {
  const value = input[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PARTICIPANTS || value.some((id) => typeof id !== 'string' || !id.trim() || id.length > MAX_TEXT_LENGTH)) {
    throw new Error(`${key} must be a non-empty list of participant IDs`)
  }
  const ids = value.map((id: string) => id.trim())
  if (new Set(ids).size !== ids.length) throw new Error(`${key} must not repeat a participant`)
  return ids
}

/** A positive amount written with no more decimals than the currency has; nothing is rounded silently. */
function positiveMinorAmount(text: string, currency: CurrencyCode, key: string): number {
  const decimals = currencyExponent(currency)
  const pattern = decimals === 0 ? /^\d+$/ : new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`)
  if (!pattern.test(text)) throw new Error(`${key} must be a decimal amount with at most ${decimals} decimal places, like "${fromMinorUnits(8450 * 10 ** Math.max(0, decimals - 2), currency)}"`)
  const minor = toMinorUnits(text, currency)
  if (minor <= 0) throw new Error(`${key} must be greater than zero`)
  return minor
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

function activeMemberIds(members: readonly Member[]): ReadonlySet<string> {
  return new Set(members.filter((member) => member.accountStatus !== 'deleted').map(({ id }) => id))
}

function requireActiveMember(active: ReadonlySet<string>, id: string, key: string): void {
  if (!active.has(id)) throw new Error(`${key} ${id} is not an active member of this group. Call list_group_members for participant IDs.`)
}

/** Waits for the user's decision, or for the agent to stop waiting (the prefilled form then stays on screen for the user). */
function untilDecided(outcome: Promise<AgentDraftOutcome>, draftId: string, signal: AbortSignal): Promise<AgentDraftOutcome> {
  if (signal.aborted) {
    abandonAgentDraft(draftId)
    return Promise.reject(new DOMException('Tool execution cancelled', 'AbortError'))
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      abandonAgentDraft(draftId)
      reject(new DOMException('Tool execution cancelled', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void outcome.then((value) => {
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    })
  })
}

function describeOutcome(outcome: AgentDraftOutcome, idKey: 'expenseId' | 'settlementId', noun: string): unknown {
  if (outcome.status === 'saved') return { status: 'saved', [idKey]: outcome.id, message: `The user reviewed and saved the ${noun}.` }
  if (outcome.status === 'queued') return { status: 'queued', operationId: outcome.operationId, message: `The user saved the ${noun} on this device; it syncs when the connection is back.` }
  if (outcome.status === 'failed') return { status: 'failed', operationId: outcome.operationId, message: `The user tried to save the ${noun}, but it was rejected. It is kept on this device for the user to retry or discard.` }
  const reasons = {
    left: `The user left the form without saving. No ${noun} was saved.`,
    replaced: `A newer request replaced this one before it was saved. No ${noun} was saved from this request.`,
    expired: `The form was not opened in time. No ${noun} was saved.`,
    aborted: 'Stopped waiting. The prefilled form stays open for the user, who may still save it.',
    'signed-out': `The user signed out. No ${noun} was saved.`,
  } as const
  return { status: 'cancelled', reason: outcome.reason, message: reasons[outcome.reason] }
}

async function openDraft(session: AppDataSession, read: Reader, draft: AgentDraft, navigate: (draftId: string) => Promise<unknown>, signal: AbortSignal): Promise<AgentDraftOutcome> {
  const owner = appPrincipalKey(await session.principal)
  if (signal.aborted) throw new DOMException('Tool execution cancelled', 'AbortError')
  const offer = offerAgentDraft(owner, draft)
  try {
    await navigate(offer.id)
  } catch (error) {
    abandonAgentDraft(offer.id)
    throw error
  }
  const outcome = await untilDecided(offer.outcome, offer.id, signal)
  // Whatever the user saved should show up in the next read.
  read.forget()
  return outcome
}

async function addExpense(session: AppDataSession, read: Reader, router: Router, inputValue: unknown, signal: AbortSignal): Promise<string> {
  const input = asInput(inputValue)
  const groupId = requiredText(input, 'groupId')
  const description = optionalText(input, 'description')
  const requestedCurrency = optionalCurrency(input)
  const amount = optionalText(input, 'amount')
  const date = optionalDate(input, 'date')
  const category = optionalChoice(input, 'category', EXPENSE_CATEGORIES)
  const notes = optionalLongText(input, 'notes', MAX_NOTES_LENGTH)
  const paidBy = optionalText(input, 'paidBy')
  const participantIds = optionalIdList(input, 'participantIds')
  const [group, members, user] = await Promise.all([read.group(groupId), read.members(groupId), read.currentUser()])
  if (!group) throw new Error('Group was not found or is not accessible')
  const active = activeMemberIds(members)
  if (!active.has(user.id)) throw new Error('You are not an active member of this group')
  if (paidBy) requireActiveMember(active, paidBy, 'paidBy')
  for (const id of participantIds ?? []) requireActiveMember(active, id, 'participantIds entry')
  const currency = requestedCurrency ?? group.currency
  const amountText = amount === undefined ? undefined : fromMinorUnits(positiveMinorAmount(amount, currency, 'amount'), currency)
  const outcome = await openDraft(session, read, {
    kind: 'expense', groupId, description, amountText, currency, date, category, notes, paidBy, participantIds,
  }, (draftId) => router.push({ name: 'groups-expense-create', query: { groupId, agentDraft: draftId } }), signal)
  return json(describeOutcome(outcome, 'expenseId', 'expense'))
}

async function recordSettlement(session: AppDataSession, read: Reader, router: Router, inputValue: unknown, signal: AbortSignal): Promise<string> {
  const input = asInput(inputValue)
  const groupId = requiredText(input, 'groupId')
  const otherId = requiredText(input, 'withParticipantId')
  const requestedCurrency = optionalCurrency(input)
  const amount = optionalText(input, 'amount')
  const method = optionalChoice(input, 'method', SETTLEMENT_METHODS)
  const occurredOn = optionalDate(input, 'date')
  const note = optionalLongText(input, 'note', MAX_TEXT_LENGTH)
  const [group, members, snapshot, user] = await Promise.all([read.group(groupId), read.members(groupId), read.balances(groupId), read.currentUser()])
  if (!group) throw new Error('Group was not found or is not accessible')
  const active = activeMemberIds(members)
  if (!active.has(user.id)) throw new Error('You are not an active member of this group')
  if (otherId === user.id) throw new Error('withParticipantId must be someone other than the signed-in user')
  requireActiveMember(active, otherId, 'withParticipantId')
  const plan = snapshot.simplifyDebtsEnabled ? 'simplified' : 'pairwise'
  const between = snapshot[plan].filter((item) => (item.fromParticipantId === user.id && item.toParticipantId === otherId) || (item.fromParticipantId === otherId && item.toParticipantId === user.id))
  const names = memberNames(members)
  if (between.length === 0) throw new Error(`There is no open balance between you and ${names.get(otherId) ?? otherId} in this group.`)
  const matching = requestedCurrency ? between.filter((item) => item.money.currency === requestedCurrency) : between
  if (matching.length === 0) throw new Error(`There is no open ${requestedCurrency} balance between you and ${names.get(otherId) ?? otherId} in this group.`)
  if (matching.length > 1) throw new Error(`You have balances in ${matching.map((item) => item.money.currency).join(' and ')} with ${names.get(otherId) ?? otherId}; pass currency to choose one.`)
  const open = matching[0]
  const minorAmount = amount === undefined ? open.money.minorAmount : positiveMinorAmount(amount, open.money.currency, 'amount')
  if (minorAmount > open.money.minorAmount) throw new Error(`amount cannot exceed the open balance of ${formatMoney(open.money, 'en-US')}`)
  const outcome = await openDraft(session, read, {
    kind: 'settlement', groupId, amountText: fromMinorUnits(minorAmount, open.money.currency), method, occurredOn, note,
  }, (draftId) => router.push({
    name: 'group-settle-up',
    params: { groupId },
    query: { plan, senderId: open.fromParticipantId, recipientId: open.toParticipantId, currency: open.money.currency, debtMinor: String(open.money.minorAmount), agentDraft: draftId },
  }), signal)
  return json(describeOutcome(outcome, 'settlementId', 'payment'))
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
      name: 'add_expense',
      title: 'Add expense',
      description: `Open the Add Expense form in this tab, prefilled with these details, for the user to review. Any detail left out is left for the user to fill in. The amount is split equally between participantIds and paid by paidBy; the user can change anything before saving. ${REVIEW_NOTE}`,
      inputSchema: addExpenseSchema,
      execute: (input, { signal }) => addExpense(session, read, router, input, signal),
    },
    {
      name: 'record_settlement',
      title: 'Record a payment',
      description: `Open Settle Up in this tab, prefilled to record that the signed-in user and one other group member paid each other outside Split Unwise to settle their open balance. It never moves money. The user must confirm the payment already happened and tap Record. ${REVIEW_NOTE}`,
      inputSchema: recordSettlementSchema,
      annotations: { consequentialHint: true },
      execute: (input, { signal }) => recordSettlement(session, read, router, input, signal),
    },
  ]
  try {
    for (const tool of tools) await modelContext.registerTool(tool, { signal: controller.signal })
  } catch (error) {
    controller.abort()
    console.warn('WebMCP tools could not be registered', error)
    return () => undefined
  }
  return () => {
    controller.abort()
    clearAgentDrafts()
  }
}
