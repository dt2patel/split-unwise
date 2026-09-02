import { computed, onScopeDispose, ref } from 'vue'
import { defineStore } from 'pinia'
import { getAppSession } from '../../data'
import { buildCurrencyTotals } from '../../data/aggregates'
import type { CommandFailure, CommandHandle, CommandOperation } from '../../data/commandQueue'
import type { ActivityItem, ExpenseAddCommand, ExpenseDeleteCommand, ExpenseEditCommand, ExpenseRow, Group, Member } from '../../data'
import type { Money } from '../../domain/model'
import { projectActivityTimeline } from '../activity/activityStore'
import { compareFirestoreStrings } from '../../data/timeline'
import { AggregateOverflowError } from '../../data/aggregates'
import { ApplicationError, displayMessageFor, type DisplayMessage } from '../../app/displayMessages'

export interface UserExpensePosition {
  readonly money: Money
  readonly direction: 'owed' | 'owing' | 'settled'
  readonly label: 'you lent' | 'you borrowed' | 'settled'
}

export interface JournalExpenseRow extends ExpenseRow {
  readonly clientOperationId?: string
  readonly retryable?: boolean
  readonly conflictRemote?: ExpenseRow
  readonly conflictIntent?: 'delete' | 'edit'
}

export type GroupStoreError = DisplayMessage

export const useGroupStore = defineStore('groups', () => {
  const session = getAppSession()
  const { repository, queue } = session
  const groups = ref<readonly Group[]>([])
  const currentUser = ref<Member>()
  const activeGroup = ref<Group>()
  const members = ref<readonly Member[]>([])
  const expenses = ref<readonly ExpenseRow[]>([])
  const activity = ref<readonly ActivityItem[]>([])
  const isLoading = ref(false)
  const isActivityLoading = ref(false)
  const error = ref<GroupStoreError>()
  const queueRevision = ref(0)
  const acknowledgedOperationIds = new Set<string>()
  const tombstoneWatermarks = new Map<string, Map<string, number>>()
  let latestGroupRequest = 0
  let latestActivityRequest = 0
  let loadedActivityGroupId: string | undefined
  let activeActivityRequest: { readonly groupId: string; readonly promise: Promise<void> } | undefined
  const unsubscribe = queue.subscribe((operation) => {
    rememberTombstone(operation, tombstoneWatermarks)
    queueRevision.value += 1
  })
  onScopeDispose(unsubscribe)

  const memberNames = computed(() => new Map(members.value.map((member) => [member.id, member.displayName])))
  const journalExpenses = computed<readonly JournalExpenseRow[]>(() => {
    queueRevision.value
    return projectJournal(expenses.value, queue.snapshot(), activeGroup.value?.id, acknowledgedOperationIds, tombstoneWatermarks).sort(newestFirst)
  })
  const currentUserNets = computed<readonly Money[]>(() => {
    if (!activeGroup.value || !currentUser.value) return []
    // A conflict is visibly local-first, but only its remote record is confirmed enough to post.
    const reconciledRows = journalExpenses.value.map((row) => row.conflictRemote ?? row)
    return netsByCurrency(reconciledRows, currentUser.value.id, activeGroup.value.currency)
  })
  const recentActivity = computed(() => {
    queueRevision.value
    return projectActivityTimeline(activity.value, queue.snapshot(), currentUser.value, activeGroup.value?.id)
  })

  async function loadOverview(): Promise<void> {
    isLoading.value = true
    error.value = undefined
    try {
      await (session as typeof session & { readonly ready?: Promise<void> }).ready
      const [loadedGroups, user] = await Promise.all([repository.groups.list(), repository.app.getCurrentUser()])
      groups.value = loadedGroups
      currentUser.value = user
    } catch (reason) {
      error.value = messageFor(reason)
    } finally {
      isLoading.value = false
    }
  }

  async function loadGroupList(): Promise<void> {
    try {
      await (session as typeof session & { readonly ready?: Promise<void> }).ready
      groups.value = await repository.groups.list()
    } catch (reason) {
      if (!activeGroup.value) error.value = messageFor(reason)
    }
  }

  async function loadGroup(groupId: string): Promise<void> {
    const request = ++latestGroupRequest
    isLoading.value = true
    error.value = undefined
    if (activeGroup.value?.id !== groupId) clearActiveGroup()
    try {
      await (session as typeof session & { readonly ready?: Promise<void> }).ready
      if (request !== latestGroupRequest) return
      const groupRequest = repository.groups.getById(groupId)
      const journalRequest = Promise.all([
        repository.app.getCurrentUser(),
        repository.groups.listMembers(groupId),
        repository.expenses.listForGroup(groupId),
      ])
      void journalRequest.catch(() => undefined)
      const group = await groupRequest
      if (request !== latestGroupRequest) return
      if (!group) throw new ApplicationError('groups.error.unavailable')
      if (group.id !== groupId) throw new ApplicationError('groups.error.unavailable')
      activeGroup.value = group
      const [user, loadedMembers, loadedExpenses] = await journalRequest
      if (request !== latestGroupRequest) return
      // Preserve deterministic load errors for malformed/overflowing repository data.
      netsByCurrency(loadedExpenses, user.id, group.currency)
      currentUser.value = user
      members.value = loadedMembers
      const counterpart = group.kind === 'friendship' ? loadedMembers.find((member) => member.id !== user.id) : undefined
      if (counterpart) activeGroup.value = { ...group, name: counterpart.displayName }
      expenses.value = loadedExpenses
      for (const operation of queue.snapshot()) rememberTombstone(operation, tombstoneWatermarks)
      await acknowledgeConfirmedOperations(groupId, loadedExpenses)
    } catch (reason) {
      if (request !== latestGroupRequest) return
      clearActiveGroup()
      error.value = messageFor(reason)
    } finally {
      if (request === latestGroupRequest) isLoading.value = false
    }
  }

  function loadActivity(groupId: string, force = false): Promise<void> {
    if (!force && loadedActivityGroupId === groupId) return Promise.resolve()
    if (!force && activeActivityRequest?.groupId === groupId) return activeActivityRequest.promise
    const request = ++latestActivityRequest
    isActivityLoading.value = true
    let pending!: Promise<void>
    pending = (async () => {
      try {
        await (session as typeof session & { readonly ready?: Promise<void> }).ready
        const loaded = await repository.activity.listForGroup(groupId)
        if (request !== latestActivityRequest || activeGroup.value?.id !== groupId) return
        activity.value = loaded
        loadedActivityGroupId = groupId
      } catch (reason) {
        if (request === latestActivityRequest && activeGroup.value?.id === groupId) error.value = messageFor(reason)
      } finally {
        if (request === latestActivityRequest) isActivityLoading.value = false
        if (activeActivityRequest?.promise === pending) activeActivityRequest = undefined
      }
    })()
    activeActivityRequest = { groupId, promise: pending }
    return pending
  }

  function positionFor(expense: ExpenseRow): UserExpensePosition {
    const posted = (expense as JournalExpenseRow).conflictRemote ?? expense
    const minorAmount = currentUser.value ? signedPosition(posted, currentUser.value.id) : 0
    if (minorAmount > 0) return { money: { currency: posted.total.currency, minorAmount }, direction: 'owed', label: 'you lent' }
    if (minorAmount < 0) return { money: { currency: posted.total.currency, minorAmount: Math.abs(minorAmount) }, direction: 'owing', label: 'you borrowed' }
    return { money: { currency: posted.total.currency, minorAmount: 0 }, direction: 'settled', label: 'settled' }
  }

  function payerName(expense: ExpenseRow): string {
    const names = expense.payments.map(({ participantId }) => memberNames.value.get(participantId) ?? 'Unknown member')
    if (names.length === 1) return names[0]
    if (names.length === 2) return `${names[0]} and ${names[1]}`
    return `${names[0]} + ${names.length - 1} others`
  }

  function retryOperation(operationId: string): CommandHandle { return queue.retry(operationId) }
  async function discardFailedOperation(operationId: string): Promise<boolean> {
    const operation = queue.get(operationId)
    if (!operation || operation.status !== 'failed') return false
    try {
      const removed = await queue.discard(operationId)
      if (removed) queueRevision.value += 1
      return removed
    } catch (reason) {
      error.value = messageFor(reason)
      return false
    }
  }

  async function reloadRemoteConflict(operationId: string): Promise<boolean> {
    const operation = queue.get(operationId)
    if (!operation || operation.status !== 'conflicted') return false
    const target = conflictTarget(operation)
    if (!target || target.groupId !== activeGroup.value?.id) return false
    const remote = await latestRemote(operation)
    const current = queue.get(operationId)
    if (!current || current.status !== 'conflicted') return false
    if (remote && remote.groupId !== target.groupId) return false
    if (!(await acknowledge(operationId))) return false
    if (remote) replaceExpense(remote)
    else expenses.value = expenses.value.filter(({ id }) => id !== target.expenseId)
    return true
  }

  async function retainAndSaveLocal(operationId: string): Promise<CommandHandle | undefined> {
    const operation = queue.get(operationId)
    if (!operation || operation.status !== 'conflicted' || operation.envelope.kind !== 'expense.edit') return undefined
    const remote = await latestRemote(operation)
    const current = queue.get(operationId)
    if (!current || current.status !== 'conflicted' || current.envelope.kind !== 'expense.edit') return undefined
    if (!remote || remote.deletedAt || remote.groupId !== operation.envelope.groupId || remote.id !== operation.envelope.expenseId) return undefined
    if (!(await acknowledge(operationId))) return undefined
    replaceExpense(remote)
    const retained: ExpenseEditCommand = {
      ...operation.envelope,
      operationId: retainedIntentId(operationId, remote.revision),
      expectedRevision: remote.revision,
    }
    return queue.submit(retained)
  }

  async function deleteAgainstRemoteRevision(operationId: string): Promise<CommandHandle | undefined> {
    const operation = queue.get(operationId)
    if (!operation || operation.status !== 'conflicted' || operation.envelope.kind !== 'expense.delete') return undefined
    const remote = await latestRemote(operation)
    const current = queue.get(operationId)
    if (!current || current.status !== 'conflicted' || current.envelope.kind !== 'expense.delete') return undefined
    if (!remote || remote.groupId !== operation.envelope.groupId || remote.id !== operation.envelope.expenseId) return undefined
    if (remote.deletedAt) {
      if (!(await acknowledge(operationId))) return undefined
      replaceExpense(remote)
      return undefined
    }
    if (!(await acknowledge(operationId))) return undefined
    replaceExpense(remote)
    const retained: ExpenseDeleteCommand = {
      ...operation.envelope,
      operationId: deleteIntentId(operationId, remote.revision),
      expectedRevision: remote.revision,
    }
    return queue.submit(retained)
  }

  return {
    groups,
    currentUser,
    activeGroup,
    members,
    journalExpenses,
    recentActivity,
    currentUserNets,
    isLoading,
    isActivityLoading,
    error,
    loadOverview,
    loadGroupList,
    loadGroup,
    loadActivity,
    positionFor,
    payerName,
    retryOperation,
    discardFailedOperation,
    reloadRemoteConflict,
    retainAndSaveLocal,
    deleteAgainstRemoteRevision,
  }

  async function latestRemote(operation: Extract<CommandOperation, { readonly status: 'conflicted' }>): Promise<ExpenseRow | undefined> {
    const payload = conflictRemote(operation.conflict)
    const target = conflictTarget(operation)
    if (!target) return payload
    const repositoryRemote = await repository.expenses.getById(target.groupId, target.expenseId)
    if (!repositoryRemote) return undefined
    return highestExpense(repositoryRemote, payload)
  }

  function replaceExpense(remote: ExpenseRow): void {
    if (remote.deletedAt) rememberTombstoneRevision(remote.groupId, remote.id, remote.revision, tombstoneWatermarks)
    const withoutRemote = expenses.value.filter(({ id }) => id !== remote.id)
    expenses.value = remote.deletedAt ? withoutRemote : [...withoutRemote, cloneExpense(remote)]
  }

  async function acknowledge(operationId: string): Promise<boolean> {
    try {
      const removed = await queue.acknowledge(operationId)
      if (!removed) return false
      acknowledgedOperationIds.add(operationId)
      queueRevision.value += 1
      return true
    } catch (reason) {
      error.value = messageFor(reason)
      return false
    }
  }

  async function acknowledgeConfirmedOperations(groupId: string, loadedExpenses: readonly ExpenseRow[]): Promise<void> {
    const byId = new Map(loadedExpenses.map((expense) => [expense.id, expense]))
    for (const operation of queue.snapshot()) {
      if (operation.status !== 'fresh' && operation.status !== 'stale') continue
      const envelope = operation.envelope
      if (!isExpenseOperationRelevant(envelope, groupId)) continue
      if (operation.result.status !== 'saved') continue
      if (envelope.kind === 'expense.edit' && isExpenseMove(envelope)) {
        if (!('expense' in operation.result)) continue
        const saved = operation.result.expense
        let sourceExpense = envelope.groupId === groupId ? byId.get(envelope.expenseId) : undefined
        let targetExpense = saved.groupId === groupId ? byId.get(saved.id) : undefined
        if (!isConfirmedMoveSource(sourceExpense, envelope)) {
          try {
            sourceExpense = await repository.expenses.getById(envelope.groupId, envelope.expenseId)
          } catch {
            continue
          }
        }
        if (!isConfirmedMoveTarget(targetExpense, saved)) {
          try {
            targetExpense = await repository.expenses.getById(saved.groupId, saved.id)
          } catch {
            continue
          }
        }
        if (!isConfirmedMoveSource(sourceExpense, envelope) || !isConfirmedMoveTarget(targetExpense, saved)) continue
        rememberTombstoneRevision(envelope.groupId, envelope.expenseId, sourceExpense.revision, tombstoneWatermarks)
        await acknowledge(envelope.operationId)
        continue
      }
      if ('expense' in operation.result) {
        const saved = operation.result.expense
        if (isRevisionRetired(groupId, saved.id, saved.revision, tombstoneWatermarks)) {
          await acknowledge(operation.envelope.operationId)
          continue
        }
        const repositoryExpense = byId.get(saved.id)
        if (!repositoryExpense || repositoryExpense.revision < saved.revision) continue
      } else if ('tombstone' in operation.result) {
        const tombstone = operation.result.tombstone
        let repositoryExpense = byId.get(tombstone.id)
        if (!isConfirmedTombstone(repositoryExpense, tombstone)) {
          try {
            repositoryExpense = await repository.expenses.getById(groupId, tombstone.id)
          } catch {
            continue
          }
        }
        if (!isConfirmedTombstone(repositoryExpense, tombstone)) continue
        rememberTombstoneRevision(groupId, tombstone.id, repositoryExpense.revision, tombstoneWatermarks)
      } else {
        continue
      }
      await acknowledge(operation.envelope.operationId)
    }
  }

  function clearActiveGroup(): void {
    activeGroup.value = undefined
    members.value = []
    expenses.value = []
    activity.value = []
    loadedActivityGroupId = undefined
    latestActivityRequest += 1
    isActivityLoading.value = false
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
  const ordinaryPosition = paid - BigInt(share)
  const position = expense.reimbursement ? -ordinaryPosition : ordinaryPosition
  const maximum = BigInt(Number.MAX_SAFE_INTEGER)
  if (position < -maximum || position > maximum) throw new Error('Money addition exceeds safe integer range')
  return Number(position)
}

function newestFirst(left: ExpenseRow, right: ExpenseRow): number {
  return compareFirestoreStrings(right.date, left.date) || compareFirestoreStrings(right.createdAt, left.createdAt) || compareFirestoreStrings(right.id, left.id)
}

interface ConfirmedExpenseVersion {
  readonly revision: number
  readonly deleted: boolean
  readonly row?: ExpenseRow
  readonly sourcePriority: number
  readonly tieBreaker: string
}

function projectJournal(
  base: readonly ExpenseRow[],
  operations: readonly CommandOperation[],
  groupId: string | undefined,
  acknowledgedOperationIds: ReadonlySet<string>,
  tombstoneWatermarks: ReadonlyMap<string, ReadonlyMap<string, number>>,
): JournalExpenseRow[] {
  const confirmed = new Map<string, ConfirmedExpenseVersion>()
  for (const expense of base) {
    considerConfirmed(confirmed, expense.id, {
      revision: expense.revision,
      deleted: Boolean(expense.deletedAt),
      ...(expense.deletedAt ? {} : { row: expense }),
      sourcePriority: 2,
      tieBreaker: expense.updatedAt,
    })
  }
  if (!groupId) return [...confirmed.values()].flatMap((candidate) => candidate.row ? [cloneExpense(candidate.row)] : [])
  for (const [expenseId, revision] of tombstoneWatermarks.get(groupId) ?? []) {
    considerConfirmed(confirmed, expenseId, {
      revision,
      deleted: true,
      sourcePriority: 4,
      tieBreaker: `watermark:${revision}`,
    })
  }

  for (const operation of operations) {
    if (acknowledgedOperationIds.has(operation.envelope.operationId)) continue
    const envelope = operation.envelope
    if (!isExpenseOperationRelevant(envelope, groupId)) continue
    if (operation.status !== 'fresh' && operation.status !== 'stale') continue
    if (operation.result.status !== 'saved') continue
    if (envelope.kind === 'expense.edit' && isExpenseMove(envelope)) {
      if (groupId === envelope.groupId) {
        considerConfirmed(confirmed, envelope.expenseId, {
          revision: envelope.expectedRevision + 1,
          deleted: true,
          sourcePriority: 3,
          tieBreaker: envelope.operationId,
        })
      } else if ('expense' in operation.result) {
        const saved = operation.result.expense
        considerConfirmed(confirmed, saved.id, {
          revision: saved.revision,
          deleted: Boolean(saved.deletedAt),
          ...(saved.deletedAt ? {} : { row: saved }),
          sourcePriority: 1,
          tieBreaker: envelope.operationId,
        })
      }
      continue
    }
    if ('expense' in operation.result) {
      const saved = operation.result.expense
      considerConfirmed(confirmed, saved.id, {
        revision: saved.revision,
        deleted: Boolean(saved.deletedAt),
        ...(saved.deletedAt ? {} : { row: saved }),
        sourcePriority: 1,
        tieBreaker: operation.envelope.operationId,
      })
    } else if ('tombstone' in operation.result) {
      const tombstone = operation.result.tombstone
      considerConfirmed(confirmed, tombstone.id, {
        revision: tombstone.revision,
        deleted: true,
        sourcePriority: 3,
        tieBreaker: operation.envelope.operationId,
      })
    }
  }

  const projected = new Map<string, JournalExpenseRow>()
  for (const [id, candidate] of confirmed) if (!candidate.deleted && candidate.row) projected.set(id, cloneExpense(candidate.row))

  for (const operation of operations) {
    if (acknowledgedOperationIds.has(operation.envelope.operationId)) continue
    const envelope = operation.envelope
    if (!isExpenseOperationRelevant(envelope, groupId)) continue
    if (operation.status === 'fresh' || operation.status === 'stale') continue

    if (envelope.kind === 'expense.delete') {
      if (operation.status === 'pending') {
        projected.delete(envelope.expenseId)
        continue
      }
      const remote = operation.status === 'conflicted' ? highestExpense(projected.get(envelope.expenseId), conflictRemote(operation.conflict)) : undefined
      const existing = projected.get(envelope.expenseId) ?? remote
      if (!existing) continue
      projected.set(envelope.expenseId, {
        ...existing,
        syncState: operation.status,
        clientOperationId: envelope.operationId,
        retryable: operation.status === 'failed' && isRetryable(operation.error),
        ...(remote ? { conflictRemote: remote } : {}),
        ...(operation.status === 'conflicted' ? { conflictIntent: 'delete' as const } : {}),
      })
      continue
    }

    if (envelope.kind === 'expense.edit' && isExpenseMove(envelope)) {
      if (groupId === envelope.groupId) {
        if (operation.status === 'pending') {
          projected.delete(envelope.expenseId)
          continue
        }
        const existing = projected.get(envelope.expenseId)
        const remote = operation.status === 'conflicted' ? highestExpense(existing, conflictRemote(operation.conflict)) : undefined
        const source = existing ?? remote
        if (!source) continue
        projected.set(envelope.expenseId, {
          ...source,
          syncState: operation.status,
          clientOperationId: envelope.operationId,
          retryable: operation.status === 'failed' && isRetryable(operation.error),
          ...(remote ? { conflictRemote: remote } : {}),
          ...(operation.status === 'conflicted' ? { conflictIntent: 'edit' as const } : {}),
        })
        continue
      }
      if (operation.status !== 'pending') continue
    }

    const draft = envelope.kind === 'expense.edit' ? envelope.draft : envelope
    const existing = envelope.kind === 'expense.edit' && !isExpenseMove(envelope) ? projected.get(envelope.expenseId) : undefined
    const remotePayload = operation.status === 'conflicted' ? conflictRemote(operation.conflict) : undefined
    const remote = operation.status === 'conflicted' ? highestExpense(existing, remotePayload) : undefined
    const row: JournalExpenseRow = {
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
      ...(draft.reimbursement ? { reimbursement: true } : {}),
      ...(draft.recurrence ? { recurrence: JSON.parse(JSON.stringify(draft.recurrence)) } : {}),
      ...(draft.occurrenceEditScope ? { occurrenceEditScope: draft.occurrenceEditScope } : {}),
      ...(existing?.recurringTemplateId ? { recurringTemplateId: existing.recurringTemplateId } : {}),
      clientOperationId: envelope.operationId,
      retryable: operation.status === 'failed' && isRetryable(operation.error),
      ...(remote ? { conflictRemote: remote } : {}),
      ...(operation.status === 'conflicted' && envelope.kind === 'expense.edit' ? { conflictIntent: 'edit' as const } : {}),
    }
    projected.set(row.id, row)
  }
  return [...projected.values()]
}

function considerConfirmed(versions: Map<string, ConfirmedExpenseVersion>, expenseId: string, candidate: ConfirmedExpenseVersion): void {
  const current = versions.get(expenseId)
  if (!current || compareConfirmed(candidate, current) > 0) versions.set(expenseId, candidate)
}

function compareConfirmed(left: ConfirmedExpenseVersion, right: ConfirmedExpenseVersion): number {
  if (left.revision !== right.revision) return left.revision - right.revision
  if (left.deleted !== right.deleted) return left.deleted ? 1 : -1
  if (left.sourcePriority !== right.sourcePriority) return left.sourcePriority - right.sourcePriority
  return compareFirestoreStrings(left.tieBreaker, right.tieBreaker)
}

function isRetryable(error: CommandFailure): boolean {
  const explicit = (error as CommandFailure & { readonly retryable?: unknown }).retryable
  if (typeof explicit === 'boolean') return explicit
  return error.code === 'network'
}

function conflictRemote(conflict: unknown): ExpenseRow | undefined {
  if (!conflict || typeof conflict !== 'object' || !('remote' in conflict)) return undefined
  const remote = (conflict as { readonly remote?: unknown }).remote
  if (!remote || typeof remote !== 'object') return undefined
  const record = remote as Partial<ExpenseRow>
  if (typeof record.id !== 'string' || typeof record.groupId !== 'string' || !Number.isSafeInteger(record.revision)) return undefined
  return cloneExpense(record as ExpenseRow)
}

function conflictTarget(operation: CommandOperation): { readonly groupId: string; readonly expenseId: string } | undefined {
  const envelope = operation.envelope
  if (envelope.kind !== 'expense.edit' && envelope.kind !== 'expense.delete') return undefined
  return { groupId: envelope.groupId, expenseId: envelope.expenseId }
}

function highestExpense(first: ExpenseRow | undefined, second: ExpenseRow | undefined): ExpenseRow | undefined {
  if (!first) return second ? cloneExpense(second) : undefined
  if (!second) return cloneExpense(first)
  if (first.revision !== second.revision) return cloneExpense(first.revision > second.revision ? first : second)
  if (Boolean(first.deletedAt) !== Boolean(second.deletedAt)) return cloneExpense(first.deletedAt ? first : second)
  return cloneExpense(first.updatedAt >= second.updatedAt ? first : second)
}

function rememberTombstone(
  operation: CommandOperation,
  watermarks: Map<string, Map<string, number>>,
): void {
  if (operation.status !== 'fresh' && operation.status !== 'stale') return
  if (operation.result.status !== 'saved') return
  if (operation.envelope.kind === 'expense.edit' && isExpenseMove(operation.envelope) && 'expense' in operation.result) {
    rememberTombstoneRevision(operation.envelope.groupId, operation.envelope.expenseId, operation.envelope.expectedRevision + 1, watermarks)
    return
  }
  if (!('tombstone' in operation.result)) return
  const tombstone = operation.result.tombstone
  rememberTombstoneRevision(tombstone.groupId, tombstone.id, tombstone.revision, watermarks)
}

function isExpenseMove(envelope: ExpenseEditCommand): boolean {
  return envelope.draft.groupId !== envelope.groupId
}

function isExpenseOperationRelevant(
  envelope: CommandOperation['envelope'],
  groupId: string,
): envelope is ExpenseAddCommand | ExpenseEditCommand | ExpenseDeleteCommand {
  if (envelope.kind !== 'expense.add' && envelope.kind !== 'expense.edit' && envelope.kind !== 'expense.delete') return false
  return envelope.groupId === groupId || (envelope.kind === 'expense.edit' && isExpenseMove(envelope) && envelope.draft.groupId === groupId)
}

function isConfirmedMoveSource(expense: ExpenseRow | undefined, command: ExpenseEditCommand): expense is ExpenseRow {
  return expense?.id === command.expenseId
    && expense.groupId === command.groupId
    && expense.deletedAt !== undefined
    && expense.revision >= command.expectedRevision + 1
}

function isConfirmedMoveTarget(expense: ExpenseRow | undefined, saved: ExpenseRow): expense is ExpenseRow {
  return expense?.id === saved.id
    && expense.groupId === saved.groupId
    && expense.deletedAt === undefined
    && expense.revision >= saved.revision
}

function rememberTombstoneRevision(
  groupId: string,
  expenseId: string,
  revision: number,
  watermarks: Map<string, Map<string, number>>,
): void {
  const groupWatermarks = watermarks.get(groupId) ?? new Map<string, number>()
  const current = groupWatermarks.get(expenseId) ?? -1
  if (revision > current) groupWatermarks.set(expenseId, revision)
  watermarks.set(groupId, groupWatermarks)
}

function isRevisionRetired(
  groupId: string,
  expenseId: string,
  revision: number,
  watermarks: ReadonlyMap<string, ReadonlyMap<string, number>>,
): boolean {
  const tombstoneRevision = watermarks.get(groupId)?.get(expenseId)
  return tombstoneRevision !== undefined && tombstoneRevision >= revision
}

function isConfirmedTombstone(
  expense: ExpenseRow | undefined,
  tombstone: { readonly id: string; readonly groupId: string; readonly revision: number },
): expense is ExpenseRow {
  return expense?.id === tombstone.id
    && expense.groupId === tombstone.groupId
    && expense.deletedAt !== undefined
    && expense.revision >= tombstone.revision
}

function retainedIntentId(operationId: string, remoteRevision: number): string {
  const suffix = `.retain-local.r${remoteRevision}`
  return `${operationId.slice(0, 128 - suffix.length)}${suffix}`
}

function deleteIntentId(operationId: string, remoteRevision: number): string {
  const suffix = `.delete-remote.r${remoteRevision}`
  return `${operationId.slice(0, 128 - suffix.length)}${suffix}`
}

function cloneExpense(expense: ExpenseRow): ExpenseRow { return JSON.parse(JSON.stringify(expense)) as ExpenseRow }

function messageFor(reason: unknown): GroupStoreError {
  if (reason instanceof AggregateOverflowError) return { kind: 'application', key: 'groups.error.moneyOverflow' }
  return displayMessageFor(reason, 'groups.error.load')
}
