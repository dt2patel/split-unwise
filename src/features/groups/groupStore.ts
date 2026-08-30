import { computed, onScopeDispose, ref } from 'vue'
import { defineStore } from 'pinia'
import { getAppSession } from '../../data'
import { buildCurrencyTotals } from '../../data/aggregates'
import type { CommandHandle, CommandOperation } from '../../data/commandQueue'
import type { ActivityItem, ExpenseRow, Group, Member } from '../../data'
import type { Money } from '../../domain/model'

export interface UserExpensePosition {
  readonly money: Money
  readonly direction: 'owed' | 'owing' | 'settled'
  readonly label: 'you lent' | 'you borrowed' | 'settled'
}

export interface JournalExpenseRow extends ExpenseRow { readonly clientOperationId?: string }

export const useGroupStore = defineStore('groups', () => {
  const { repository, queue } = getAppSession()
  const groups = ref<readonly Group[]>([])
  const currentUser = ref<Member>()
  const activeGroup = ref<Group>()
  const members = ref<readonly Member[]>([])
  const expenses = ref<readonly ExpenseRow[]>([])
  const activity = ref<readonly ActivityItem[]>([])
  const currentUserNets = ref<readonly Money[]>([])
  const isLoading = ref(false)
  const error = ref<string>()
  const queueRevision = ref(0)
  let latestGroupRequest = 0
  const unsubscribe = queue.subscribe(() => { queueRevision.value += 1 })
  onScopeDispose(unsubscribe)

  const memberNames = computed(() => new Map(members.value.map((member) => [member.id, member.displayName])))
  const journalExpenses = computed<readonly JournalExpenseRow[]>(() => {
    queueRevision.value
    return projectJournal(expenses.value, queue.snapshot(), activeGroup.value?.id).sort(newestFirst)
  })
  const recentActivity = computed(() => [...activity.value].sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)))
  async function loadOverview(): Promise<void> {
    isLoading.value = true
    error.value = undefined
    try {
      const [loadedGroups, user] = await Promise.all([repository.groups.list(), repository.app.getCurrentUser()])
      groups.value = loadedGroups
      currentUser.value = user
    } catch (reason) {
      error.value = messageFor(reason)
    } finally {
      isLoading.value = false
    }
  }

  async function loadGroup(groupId: string): Promise<void> {
    const request = ++latestGroupRequest
    isLoading.value = true
    error.value = undefined
    clearActiveGroup()
    try {
      const [group, user, loadedMembers, loadedExpenses, loadedActivity] = await Promise.all([
        repository.groups.getById(groupId),
        repository.app.getCurrentUser(),
        repository.groups.listMembers(groupId),
        repository.expenses.listForGroup(groupId),
        repository.activity.listForGroup(groupId),
      ])
      if (request !== latestGroupRequest) return
      if (!group) throw new Error('This group is not available.')
      if (group.id !== groupId) throw new Error('The loaded group did not match the requested group.')
      const loadedNets = netsByCurrency(loadedExpenses, user.id, group.currency)
      activeGroup.value = group
      currentUser.value = user
      members.value = loadedMembers
      expenses.value = loadedExpenses
      activity.value = loadedActivity
      currentUserNets.value = loadedNets
    } catch (reason) {
      if (request !== latestGroupRequest) return
      clearActiveGroup()
      error.value = messageFor(reason)
    } finally {
      if (request === latestGroupRequest) isLoading.value = false
    }
  }

  function positionFor(expense: ExpenseRow): UserExpensePosition {
    const minorAmount = currentUser.value ? signedPosition(expense, currentUser.value.id) : 0
    if (minorAmount > 0) return { money: { currency: expense.total.currency, minorAmount }, direction: 'owed', label: 'you lent' }
    if (minorAmount < 0) return { money: { currency: expense.total.currency, minorAmount: Math.abs(minorAmount) }, direction: 'owing', label: 'you borrowed' }
    return { money: { currency: expense.total.currency, minorAmount: 0 }, direction: 'settled', label: 'settled' }
  }

  function payerName(expense: ExpenseRow): string {
    const names = expense.payments.map(({ participantId }) => memberNames.value.get(participantId) ?? 'Unknown member')
    if (names.length === 1) return names[0]
    if (names.length === 2) return `${names[0]} and ${names[1]}`
    return `${names[0]} + ${names.length - 1} others`
  }

  function retryOperation(operationId: string): CommandHandle { return queue.retry(operationId) }
  function discardFailedOperation(operationId: string): boolean { const removed = queue.discard(operationId); queueRevision.value += 1; return removed }

  return {
    groups,
    currentUser,
    activeGroup,
    members,
    journalExpenses,
    recentActivity,
    currentUserNets,
    isLoading,
    error,
    loadOverview,
    loadGroup,
    positionFor,
    payerName,
    retryOperation,
    discardFailedOperation,
  }

  function clearActiveGroup(): void {
    activeGroup.value = undefined
    members.value = []
    expenses.value = []
    activity.value = []
    currentUserNets.value = []
  }
})

function netsByCurrency(rows: readonly ExpenseRow[], currentUserId: string, groupCurrency: Money['currency']): readonly Money[] {
  const nets = buildCurrencyTotals(rows, currentUserId).map(({ currency, currentUserNet }) => ({ currency, minorAmount: currentUserNet }))
  if (nets.length === 0) return [{ currency: groupCurrency, minorAmount: 0 }]
  return nets.sort((left, right) => {
    if (left.currency === groupCurrency && right.currency !== groupCurrency) return -1
    if (right.currency === groupCurrency && left.currency !== groupCurrency) return 1
    return left.currency.localeCompare(right.currency)
  })
}

function signedPosition(expense: ExpenseRow, participantId: string): number {
  const share = expense.allocations.find((allocation) => allocation.participantId === participantId)?.money.minorAmount ?? 0
  const paid = expense.payments.filter((payment) => payment.participantId === participantId).reduce((sum, payment) => sum + BigInt(payment.money.minorAmount), 0n)
  const position = paid - BigInt(share)
  const maximum = BigInt(Number.MAX_SAFE_INTEGER)
  if (position < -maximum || position > maximum) throw new Error('Money addition exceeds safe integer range')
  return Number(position)
}

function newestFirst(left: ExpenseRow, right: ExpenseRow): number {
  return right.date.localeCompare(left.date) || right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
}

function projectJournal(base: readonly ExpenseRow[], operations: readonly CommandOperation[], groupId: string | undefined): JournalExpenseRow[] {
  const projected = new Map(base.map((expense) => [expense.id, expense as JournalExpenseRow]))
  if (!groupId) return [...projected.values()]
  for (const operation of operations) {
    const envelope = operation.envelope
    if ((envelope.kind !== 'expense.add' && envelope.kind !== 'expense.edit') || envelope.groupId !== groupId) continue
    if ((operation.status === 'fresh' || operation.status === 'stale') && operation.result.status === 'saved' && 'expense' in operation.result) {
      projected.set(operation.result.expense.id, { ...operation.result.expense, clientOperationId: envelope.operationId })
      if (envelope.kind === 'expense.add') projected.delete(`pending:${envelope.operationId}`)
      continue
    }
    if (operation.status === 'pending' || operation.status === 'failed' || operation.status === 'conflicted') {
      const draft = envelope.kind === 'expense.edit' ? envelope.draft : envelope
      const existing = envelope.kind === 'expense.edit' ? projected.get(envelope.expenseId) : undefined
      const row: JournalExpenseRow = {
        ...(existing ?? {}),
        id: existing?.id ?? `pending:${envelope.operationId}`,
        groupId,
        description: draft.description,
        date: draft.date,
        total: { ...draft.total },
        payments: draft.payments.map((payment) => ({ participantId: payment.participantId, money: { ...payment.money } })),
        allocations: draft.allocations.map((allocation) => ({ participantId: allocation.participantId, money: { ...allocation.money } })),
        category: draft.category,
        createdAt: existing?.createdAt ?? `${draft.date}T23:59:59.999Z`,
        updatedAt: `${draft.date}T23:59:59.999Z`,
        revision: existing?.revision ?? 0,
        syncState: operation.status,
        splitMethod: JSON.parse(JSON.stringify(draft.splitMethod)),
        attachmentRefs: [...draft.attachmentRefs],
        ...(draft.notes ? { notes: draft.notes } : {}),
        ...(draft.recurrence ? { recurrence: JSON.parse(JSON.stringify(draft.recurrence)) } : {}),
        ...(draft.occurrenceEditScope ? { occurrenceEditScope: draft.occurrenceEditScope } : {}),
        clientOperationId: envelope.operationId,
      }
      projected.set(row.id, row)
    }
  }
  return [...projected.values()]
}

function messageFor(reason: unknown): string {
  if (!(reason instanceof Error)) return 'The group could not be loaded.'
  if (reason.message === 'Aggregate exceeds safe integer range') return 'Money addition exceeds safe integer range.'
  return reason.message
}
