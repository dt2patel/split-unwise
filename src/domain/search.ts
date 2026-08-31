import type { ExpenseRow, Group, Member } from '../data/repositories'
import { assertCurrencyCode, type CurrencyCode } from './money'
import type { ReportCoverage } from './reports'

export interface ExpenseSearchFilters {
  readonly query?: string
  readonly groupIds?: readonly string[]
  readonly participantIds?: readonly string[]
  readonly categories?: readonly string[]
  readonly dateFrom?: string
  readonly dateTo?: string
  readonly minMinor?: number
  readonly maxMinor?: number
  readonly currency?: CurrencyCode
}

export interface ExpenseSearchInput {
  readonly groups: readonly Group[]
  readonly membersByGroup?: ReadonlyMap<string, readonly Member[]>
  readonly expenses: readonly ExpenseRow[]
  readonly filters: ExpenseSearchFilters
  readonly coverageStatus: ReportCoverage['status']
  readonly coverageReason?: ReportCoverage['reason']
}

export interface ExpenseSearchResult {
  readonly items: readonly { readonly group: Group; readonly expense: ExpenseRow }[]
  readonly facets: {
    readonly groups: readonly Group[]
    readonly participants: readonly { readonly id: string; readonly displayName: string }[]
    readonly categories: readonly string[]
    readonly currencies: readonly CurrencyCode[]
  }
  readonly coverage: ReportCoverage
  readonly cursor?: { readonly date: string; readonly id: string }
}

const GROUP_LIMIT = 100
const EXPENSE_LIMIT = 10_000

export function searchExpenses(input: ExpenseSearchInput): ExpenseSearchResult {
  const filters = validateFilters(input.filters)
  const groups = input.groups.slice(0, GROUP_LIMIT)
  const groupById = new Map(groups.map((group) => [group.id, group]))
  const expenses = input.expenses.filter(({ groupId }) => groupById.has(groupId)).slice(0, EXPENSE_LIMIT)
  const currentExpenses = expenses.filter((expense) => expense.syncState === 'fresh' && expense.deletedAt === undefined)
  const tokens = normalizedTokens(filters.query)
  const selectedGroups = new Set(filters.groupIds ?? [])
  const selectedParticipants = new Set(filters.participantIds ?? [])
  const selectedCategories = new Set(filters.categories ?? [])

  const items = currentExpenses.filter((expense) => {
    if (selectedGroups.size && !selectedGroups.has(expense.groupId)) return false
    if (selectedCategories.size && !selectedCategories.has(expense.category)) return false
    if (selectedParticipants.size) {
      const participants = new Set([...expense.payments, ...expense.allocations].map(({ participantId }) => participantId))
      if (![...selectedParticipants].some((participantId) => participants.has(participantId))) return false
    }
    if (filters.dateFrom && expense.date < filters.dateFrom) return false
    if (filters.dateTo && expense.date > filters.dateTo) return false
    if (filters.currency && expense.total.currency !== filters.currency) return false
    if (filters.minMinor !== undefined && expense.total.minorAmount < filters.minMinor) return false
    if (filters.maxMinor !== undefined && expense.total.minorAmount > filters.maxMinor) return false
    const haystack = normalizeSearchText(`${expense.description}\n${expense.notes ?? ''}`)
    return tokens.every((token) => haystack.includes(token))
  }).map((expense) => ({ group: groupById.get(expense.groupId)!, expense }))
    .sort((left, right) => compare(right.expense.date, left.expense.date) || compare(left.expense.id, right.expense.id))

  const boundary = input.groups.length >= GROUP_LIMIT
    ? { status: 'bounded' as const, reason: 'group-limit' as const }
    : input.expenses.length >= EXPENSE_LIMIT
      ? { status: 'bounded' as const, reason: 'expense-limit' as const }
      : input.coverageStatus === 'bounded'
        ? { status: 'bounded' as const, reason: input.coverageReason ?? 'provider-unavailable' as const }
        : { status: 'complete' as const }
  const last = items.at(-1)?.expense
  const participantIds = new Set(currentExpenses.flatMap((expense) => [...expense.payments, ...expense.allocations].map(({ participantId }) => participantId)))
  const participantById = new Map<string, string>()
  for (const group of groups) for (const member of input.membersByGroup?.get(group.id) ?? []) if (participantIds.has(member.id) && !participantById.has(member.id)) participantById.set(member.id, member.displayName)
  for (const id of participantIds) if (!participantById.has(id)) participantById.set(id, id)
  return {
    items,
    facets: {
      groups: [...groups].sort((left, right) => compare(left.name, right.name) || compare(left.id, right.id)),
      participants: [...participantById].map(([id, displayName]) => ({ id, displayName })).sort((left, right) => compare(left.displayName, right.displayName) || compare(left.id, right.id)),
      categories: [...new Set(currentExpenses.map(({ category }) => category))].sort(compare),
      currencies: [...new Set(currentExpenses.map(({ total }) => total.currency))].sort(compare),
    },
    coverage: { ...boundary, scannedGroups: groups.length, scannedExpenses: expenses.length },
    ...(last ? { cursor: { date: last.date, id: last.id } } : {}),
  }
}

export function normalizeSearchText(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}+/gu, '').toLocaleLowerCase().replace(/\s+/g, ' ').trim()
}

function validateFilters(filters: ExpenseSearchFilters): ExpenseSearchFilters {
  if (filters.dateFrom && !isIsoDate(filters.dateFrom) || filters.dateTo && !isIsoDate(filters.dateTo)) throw new Error('Search date filters must use YYYY-MM-DD')
  if (filters.dateFrom && filters.dateTo && filters.dateFrom > filters.dateTo) throw new Error('Search date range is invalid')
  for (const amount of [filters.minMinor, filters.maxMinor]) {
    if (amount !== undefined && (!Number.isSafeInteger(amount) || amount < 0)) throw new Error('Search amount filters must be non-negative minor-unit integers')
  }
  if (filters.minMinor !== undefined && filters.maxMinor !== undefined && filters.minMinor > filters.maxMinor) throw new Error('Search amount range is invalid')
  if ((filters.minMinor !== undefined || filters.maxMinor !== undefined) && !filters.currency) throw new Error('Search amount filters require an exact currency')
  if (filters.currency) assertCurrencyCode(filters.currency)
  return filters
}

function normalizedTokens(value: string | undefined): readonly string[] { return normalizeSearchText(value ?? '').split(' ').filter(Boolean) }
function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
}
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
