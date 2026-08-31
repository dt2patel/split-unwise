import { computed, onScopeDispose, ref } from 'vue'
import { defineStore } from 'pinia'
import { getAppSession } from '../../data'
import type { ActivityFilter, ActivityItem, ActivityKind, ActorSnapshot, Member, TimelineCursor } from '../../data/repositories'
import type { CommandOperation } from '../../data/commandQueue'
import { isStrictId } from '../../data/identifiers'
import { compareTimelineDescending } from '../../data/timeline'

export const useActivityStore = defineStore('activity', () => {
  const session = getAppSession()
  const canonical = ref<readonly ActivityItem[]>([])
  const filter = ref<ActivityFilter>('all')
  const isLoading = ref(false)
  const isFiltering = ref(false)
  const isLoadingMore = ref(false)
  const error = ref('')
  const nextCursor = ref<TimelineCursor>()
  const currentUser = ref<Member>()
  const queueRevision = ref(0)
  let request = 0
  let pageRequest = 0
  const unsubscribe = session.queue.subscribe(() => { queueRevision.value += 1 })
  onScopeDispose(unsubscribe)

  const allItems = computed(() => {
    queueRevision.value
    return projectActivityTimeline(canonical.value, session.queue.snapshot(), currentUser.value)
  })
  const items = computed(() => allItems.value.filter((item) => matchesFilter(item, filter.value)))

  async function load(selectedFilter: ActivityFilter = filter.value): Promise<void> {
    const active = ++request
    ++pageRequest
    nextCursor.value = undefined
    isLoadingMore.value = false
    const blocking = canonical.value.length === 0
    isLoading.value = blocking
    isFiltering.value = !blocking
    error.value = ''
    try {
      await session.ready
      const [page, user] = await Promise.all([
        session.repository.activity.listForAccount({ filter: selectedFilter, limit: 100 }),
        session.repository.app.getCurrentUser(),
      ])
      if (active !== request) return
      canonical.value = page.items
      nextCursor.value = page.nextCursor
      currentUser.value = user
    } catch (reason) {
      if (active === request) error.value = reason instanceof Error ? reason.message : 'Activity could not be loaded.'
    } finally {
      if (active === request) {
        isLoading.value = false
        isFiltering.value = false
      }
    }
  }

  async function loadMore(): Promise<void> {
    const cursor = nextCursor.value
    if (!cursor || isLoading.value || isFiltering.value || isLoadingMore.value) return
    const activeRoot = request
    const activePage = ++pageRequest
    const selectedFilter = filter.value
    isLoadingMore.value = true
    error.value = ''
    try {
      const page = await session.repository.activity.listForAccount({ filter: selectedFilter, limit: 100, cursor })
      if (activeRoot !== request || activePage !== pageRequest || filter.value !== selectedFilter || !sameCursor(nextCursor.value, cursor)) return
      const byId = new Map(canonical.value.map((item) => [item.id, item]))
      page.items.forEach((item) => byId.set(item.id, item))
      canonical.value = [...byId.values()].sort(newestActivityFirst)
      nextCursor.value = page.nextCursor
    } catch (reason) {
      if (activeRoot === request && activePage === pageRequest) error.value = reason instanceof Error ? reason.message : 'More activity could not be loaded.'
    } finally {
      if (activeRoot === request && activePage === pageRequest) isLoadingMore.value = false
    }
  }

  function setFilter(next: ActivityFilter): void {
    if (filter.value === next) return
    filter.value = next
    void load(next)
  }

  return { items, allItems, filter, isLoading, isFiltering, isLoadingMore, error, nextCursor, load, loadMore, setFilter }
})

function sameCursor(left: TimelineCursor | undefined, right: TimelineCursor): boolean {
  return left?.createdAt === right.createdAt && left.id === right.id
}

export function projectActivityTimeline(
  base: readonly ActivityItem[],
  operations: readonly CommandOperation[],
  user: Member | undefined,
  groupId?: string,
): readonly ActivityItem[] {
  const byOperation = new Map<string, ActivityItem>()
  for (const item of base) if (!groupId || item.groupId === groupId) byOperation.set(item.operationId, clone(item))
  for (const projected of projectQueueActivity(operations, base, user)) {
    if (groupId && projected.groupId !== groupId) continue
    if (!byOperation.has(projected.operationId) || projected.syncState !== 'fresh') byOperation.set(projected.operationId, projected)
  }
  return [...byOperation.values()].sort(newestActivityFirst)
}

export function activityDestination(item: ActivityItem, origin: 'account' | 'activity' | 'groups' | 'home'): string | undefined {
  if (!isStrictId(item.groupId) || !['account', 'activity', 'groups', 'home'].includes(origin)) return undefined
  if ((item.kind === 'settlement.created' || item.kind === 'settlement.voided') && item.settlementId && isStrictId(item.settlementId)) {
    return `/tabs/groups/${encodeURIComponent(item.groupId)}/settlements/${encodeURIComponent(item.settlementId)}`
  }
  if (!item.expenseId || !isStrictId(item.expenseId)) return undefined
  return `/tabs/${origin}/expenses/${encodeURIComponent(item.expenseId)}?groupId=${encodeURIComponent(item.groupId)}`
}

export function activityText(item: ActivityItem): string {
  const label = item.subject.label ?? item.subject.id
  if (item.kind === 'expense.created') return `${item.actor.displayName} added ${label}`
  if (item.kind === 'expense.updated') return `${item.actor.displayName} updated ${label}`
  if (item.kind === 'expense.deleted') return `${item.actor.displayName} deleted ${label}`
  if (item.kind === 'comment.added') return `${item.actor.displayName} commented on ${label}`
  if (item.kind === 'comment.deleted') return `${item.actor.displayName} deleted a comment`
  if (item.kind === 'settlement.created') return `${item.actor.displayName} recorded ${label}`
  if (item.kind === 'settlement.voided') return `${item.actor.displayName} voided ${label}`
  if (item.kind === 'membership.changed') return `${item.actor.displayName} changed membership for ${label}`
  return `${item.actor.displayName} updated ${label}`
}

function projectQueueActivity(operations: readonly CommandOperation[], base: readonly ActivityItem[], user: Member | undefined): readonly ActivityItem[] {
  if (!user) return []
  const actor: ActorSnapshot = { id: user.id, displayName: user.displayName }
  return operations.flatMap((operation) => {
    if (operation.status === 'conflicted') return []
    if ((operation.status === 'fresh' || operation.status === 'stale') && operation.result.status === 'saved') {
      if ('activity' in operation.result) return [clone(operation.result.activity)]
      const saved = savedExpenseActivity(operation, actor, base)
      return saved ? [saved] : []
    }
    if (operation.status !== 'pending' && operation.status !== 'failed') return []
    const projected = pendingActivity(operation, actor, base)
    return projected ? [projected] : []
  })
}

function savedExpenseActivity(operation: Extract<CommandOperation, { status: 'fresh' | 'stale' }>, actor: ActorSnapshot, base: readonly ActivityItem[]): ActivityItem | undefined {
  const envelope = operation.envelope
  if (envelope.kind === 'expense.add' || envelope.kind === 'expense.edit') {
    if (!('expense' in operation.result)) return undefined
    const expense = operation.result.expense
    const kind = envelope.kind === 'expense.add' ? 'expense.created' : 'expense.updated'
    return activity(operation.envelope.operationId, expense.groupId, kind, { kind: 'expense', id: expense.id, label: expense.description }, actor, expense.updatedAt, operation.status, expense.id, expense.revision)
  }
  if (envelope.kind === 'expense.delete' && 'tombstone' in operation.result) {
    const label = expenseLabel(base, envelope.expenseId)
    return activity(envelope.operationId, envelope.groupId, 'expense.deleted', { kind: 'expense', id: envelope.expenseId, label }, actor, operation.result.tombstone.deletedAt, operation.status, envelope.expenseId, operation.result.tombstone.revision)
  }
  return undefined
}

function pendingActivity(operation: Extract<CommandOperation, { status: 'failed' | 'pending' }>, actor: ActorSnapshot, base: readonly ActivityItem[]): ActivityItem | undefined {
  const envelope = operation.envelope
  const syncState = operation.status
  const submittedAt = operation.submittedAt
  if (envelope.kind === 'expense.add') {
    return activity(envelope.operationId, envelope.groupId, 'expense.created', { kind: 'expense', id: envelope.operationId, label: envelope.description }, actor, submittedAt, syncState)
  }
  if (envelope.kind === 'expense.edit') {
    return activity(envelope.operationId, envelope.groupId, 'expense.updated', { kind: 'expense', id: envelope.expenseId, label: envelope.draft.description }, actor, submittedAt, syncState, envelope.expenseId, envelope.expectedRevision + 1)
  }
  if (envelope.kind === 'expense.delete') {
    return activity(envelope.operationId, envelope.groupId, 'expense.deleted', { kind: 'expense', id: envelope.expenseId, label: expenseLabel(base, envelope.expenseId) }, actor, submittedAt, syncState, envelope.expenseId, envelope.expectedRevision + 1)
  }
  if (envelope.kind === 'comment.add') {
    return activity(envelope.operationId, envelope.groupId, 'comment.added', { kind: 'comment', id: envelope.operationId, label: envelope.body.trim() }, actor, submittedAt, syncState, envelope.expenseId, undefined, envelope.operationId)
  }
  if (envelope.kind === 'comment.delete') {
    return activity(envelope.operationId, envelope.groupId, 'comment.deleted', { kind: 'comment', id: envelope.commentId }, actor, submittedAt, syncState, envelope.expenseId, undefined, envelope.commentId)
  }
  return undefined
}

function activity(
  operationId: string,
  groupId: string,
  kind: ActivityKind,
  subject: ActivityItem['subject'],
  actor: ActorSnapshot,
  createdAt: string,
  syncState: ActivityItem['syncState'],
  expenseId?: string,
  revision?: number,
  commentId?: string,
): ActivityItem {
  return { id: `pending:${operationId}`, groupId, operationId, kind, subject, actor, createdAt, syncState, ...(expenseId ? { expenseId } : {}), ...(revision ? { revision } : {}), ...(commentId ? { commentId } : {}) }
}

function expenseLabel(base: readonly ActivityItem[], expenseId: string): string {
  return base.find((item) => item.expenseId === expenseId && item.subject.kind === 'expense')?.subject.label ?? 'expense'
}
function matchesFilter(item: ActivityItem, filter: ActivityFilter): boolean {
  return filter === 'all' || (filter === 'expenses' && item.kind.startsWith('expense.')) || (filter === 'comments' && item.kind.startsWith('comment.')) || (filter === 'payments' && item.kind.startsWith('settlement.'))
}
export function newestActivityFirst(left: ActivityItem, right: ActivityItem): number { return compareTimelineDescending(left, right) }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
