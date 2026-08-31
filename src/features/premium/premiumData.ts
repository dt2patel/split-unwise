import { getAppSession } from '../../data'
import { isStrictId } from '../../data/identifiers'
import type { ActivityItem, AppRepository, ExpenseComment, ExpenseRevision, ExpenseRow, Group, Member, RecurringExpense, SettlementRecord } from '../../data/repositories'
import { buildReport, selectReportInput, type ReportCoverage, type ReportModel } from '../../domain/reports'
import { searchExpenses, type ExpenseSearchFilters, type ExpenseSearchResult } from '../../domain/search'
import type { GroupSettings } from '../../domain/groupSettings'

export interface GroupPremiumSnapshot {
  readonly group: Group
  readonly currentUser: Member
  readonly members: readonly Member[]
  readonly expenses: readonly ExpenseRow[]
  readonly settlements: readonly SettlementRecord[]
  readonly settings: GroupSettings
  readonly report: ReportModel
}

export interface PremiumExportSnapshot {
  readonly groups: readonly Group[]
  readonly membersByGroup: ReadonlyMap<string, readonly Member[]>
  readonly expenses: readonly ExpenseRow[]
  readonly settlements: readonly SettlementRecord[]
  readonly activity: readonly ActivityItem[]
  readonly comments: readonly ExpenseComment[]
  readonly revisions: readonly ExpenseRevision[]
  readonly recurring: readonly RecurringExpense[]
  readonly settings: readonly GroupSettings[]
  readonly coverage: ReportCoverage
}

export async function loadGroupPremiumSnapshot(groupId: string): Promise<GroupPremiumSnapshot> {
  if (!isStrictId(groupId)) throw new Error('Open this feature from a valid group link.')
  const session = getAppSession()
  await session.ready
  const [group, currentUser, members, expenses, settlements, settings] = await Promise.all([
    session.repository.groups.getById(groupId), session.repository.app.getCurrentUser(), session.repository.groups.listMembers(groupId),
    session.repository.expenses.listForGroup(groupId), session.repository.settlements.listForGroup(groupId), session.repository.groups.getSettings(groupId),
  ])
  if (!group || group.id !== groupId) throw new Error('This group is not available.')
  if (!members.some(({ id }) => id === currentUser.id)) throw new Error('You are not an active member of this group.')
  const coverage = coverageFor(session.repository.mode, 1, expenses.length)
  return { group, currentUser, members, expenses, settlements, settings, report: buildReport(selectReportInput({ currentUserId: currentUser.id, members, expenses, settlements, coverage })) }
}

export async function runPremiumSearch(filters: ExpenseSearchFilters, groupId?: string): Promise<ExpenseSearchResult> {
  const source = await loadSearchSource(groupId)
  return searchExpenses({ groups: source.groups, membersByGroup: source.membersByGroup, expenses: source.expenses, filters, coverageStatus: source.coverage.status, coverageReason: source.coverage.reason })
}

export async function loadPremiumExportSnapshot(groupId?: string): Promise<PremiumExportSnapshot> {
  const session = getAppSession()
  await session.ready
  const currentUser = await session.repository.app.getCurrentUser()
  const groups = groupId ? [await requireGroup(groupId, session.repository)] : [...await session.repository.groups.list()].slice(0, 100)
  const loaded = await Promise.all(groups.map(async (group) => {
    const members = await session.repository.groups.listMembers(group.id)
    if (!members.some(({ id }) => id === currentUser.id)) throw new Error('You are not an active member of this group.')
    const [expenses, settlements, activity, recurring, settings] = await Promise.all([
      session.repository.expenses.listForGroup(group.id), session.repository.settlements.listForGroup(group.id),
      session.repository.activity.listForGroup(group.id), session.repository.groups.listRecurring(group.id), session.repository.groups.getSettings(group.id),
    ])
    const expenseIds = [...new Set([...expenses.map(({ id }) => id), ...activity.flatMap(({ expenseId }) => expenseId ? [expenseId] : [])])].sort(compare)
    const histories = await Promise.all(expenseIds.map(async (expenseId) => {
      const [comments, revisions] = await Promise.all([
        session.repository.comments.listForExpense(group.id, expenseId), session.repository.expenses.listRevisions(group.id, expenseId),
      ])
      return { comments, revisions }
    }))
    return { group, members, expenses, settlements, activity, recurring, settings, comments: histories.flatMap(({ comments }) => comments), revisions: histories.flatMap(({ revisions }) => revisions) }
  }))
  const expenses = loaded.flatMap((row) => row.expenses).slice(0, 10_000)
  const settlements = loaded.flatMap((row) => row.settlements)
  const coverage = coverageFor(session.repository.mode, groups.length, expenses.length, groups.length >= 100, loaded.reduce((sum, row) => sum + row.expenses.length, 0) >= 10_000)
  return {
    groups,
    membersByGroup: new Map(loaded.map((row) => [row.group.id, row.members])),
    expenses,
    settlements,
    activity: loaded.flatMap((row) => row.activity),
    comments: loaded.flatMap((row) => row.comments),
    revisions: loaded.flatMap((row) => row.revisions),
    recurring: loaded.flatMap((row) => row.recurring),
    settings: loaded.map((row) => row.settings),
    coverage,
  }
}

async function loadSearchSource(groupId?: string): Promise<{ groups: readonly Group[]; membersByGroup: ReadonlyMap<string, readonly Member[]>; expenses: readonly ExpenseRow[]; coverage: ReportCoverage }> {
  const session = getAppSession()
  await session.ready
  const [currentUser, listedGroups] = await Promise.all([
    session.repository.app.getCurrentUser(),
    groupId ? requireGroup(groupId, session.repository) : session.repository.groups.list(),
  ])
  const sourceGroups = Array.isArray(listedGroups) ? listedGroups : [listedGroups]
  const groups = [...sourceGroups].slice(0, 100)
  const loaded = await Promise.all(groups.map(async (group) => {
    const [members, expenses] = await Promise.all([session.repository.groups.listMembers(group.id), session.repository.expenses.listForGroup(group.id)])
    if (!members.some(({ id }) => id === currentUser.id)) throw new Error('You are not an active member of this group.')
    return { group, members, expenses }
  }))
  const allExpenses = loaded.flatMap(({ expenses }) => expenses)
  const expenses = allExpenses.slice(0, 10_000)
  return {
    groups,
    membersByGroup: new Map(loaded.map(({ group, members }) => [group.id, members])),
    expenses,
    coverage: coverageFor(session.repository.mode, groups.length, expenses.length, sourceGroups.length >= 100, allExpenses.length >= 10_000),
  }
}

async function requireGroup(groupId: string, repository: AppRepository): Promise<Group> {
  if (!isStrictId(groupId)) throw new Error('Open this feature from a valid group link.')
  const group = await repository.groups.getById(groupId)
  if (!group || group.id !== groupId) throw new Error('This group is not available.')
  return group
}

function coverageFor(mode: 'demo' | 'firebase', scannedGroups: number, scannedExpenses: number, hitGroupLimit = false, hitExpenseLimit = false): ReportCoverage {
  if (hitGroupLimit) return { status: 'bounded', scannedGroups, scannedExpenses, reason: 'group-limit' }
  if (hitExpenseLimit) return { status: 'bounded', scannedGroups, scannedExpenses, reason: 'expense-limit' }
  return mode === 'demo'
    ? { status: 'complete', scannedGroups, scannedExpenses }
    : { status: 'bounded', scannedGroups, scannedExpenses, reason: 'provider-unavailable' }
}

function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0 }
