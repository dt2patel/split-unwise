import { computed, onScopeDispose, ref } from 'vue'
import { defineStore } from 'pinia'
import { getAppSession } from '../../data'
import type { ActivityFilter, ActivityItem, ActivityKind, ActorSnapshot, CommandEnvelope, Member, TimelineCursor } from '../../data/repositories'
import type { CommandOperation } from '../../data/commandQueue'

export const useActivityStore = defineStore('activity', () => {
  const session = getAppSession()
  const canonical = ref<readonly ActivityItem[]>([])
  const filter = ref<ActivityFilter>('all')
  const isLoading = ref(false)
  const error = ref('')
  const nextCursor = ref<TimelineCursor>()
  const currentUser = ref<Member>()
  const queueRevision = ref(0)
  let request = 0
  const unsubscribe = session.queue.subscribe(() => { queueRevision.value += 1 })
  onScopeDispose(unsubscribe)

  const allItems = computed(() => {
    queueRevision.value
    const byOperation = new Map<string, ActivityItem>()
    for (const item of canonical.value) byOperation.set(item.operationId, clone(item))
    for (const projected of projectQueueActivity(session.queue.snapshot(), canonical.value, currentUser.value)) {
      if (!byOperation.has(projected.operationId) || projected.syncState !== 'fresh') byOperation.set(projected.operationId, projected)
    }
    return [...byOperation.values()].sort(newestActivityFirst)
  })
  const items = computed(() => allItems.value.filter((item) => matchesFilter(item, filter.value)))

  async function load(): Promise<void> {
    const active = ++request
    isLoading.value = true
    error.value = ''
    try {
      await session.ready
      const [page, user] = await Promise.all([
        session.repository.activity.listForAccount({ filter: 'all', limit: 100 }),
        session.repository.app.getCurrentUser(),
      ])
      if (active !== request) return
      canonical.value = page.items
      nextCursor.value = page.nextCursor
      currentUser.value = user
    } catch (reason) {
      if (active === request) error.value = reason instanceof Error ? reason.message : 'Activity could not be loaded.'
    } finally {
      if (active === request) isLoading.value = false
    }
  }

  function setFilter(next: ActivityFilter): void { filter.value = next }

  return { items, allItems, filter, isLoading, error, nextCursor, load, setFilter }
})

export function activityDestination(item: ActivityItem, origin: 'account' | 'activity' | 'groups' | 'home'): string | undefined {
  if (!item.expenseId || !validId(item.groupId) || !validId(item.expenseId) || !['account', 'activity', 'groups', 'home'].includes(origin)) return undefined
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
    const projected = pendingActivity(operation.envelope, actor, base, operation.status)
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

function pendingActivity(envelope: CommandEnvelope, actor: ActorSnapshot, base: readonly ActivityItem[], syncState: 'failed' | 'pending'): ActivityItem | undefined {
  if (envelope.kind === 'expense.add') {
    return activity(envelope.operationId, envelope.groupId, 'expense.created', { kind: 'expense', id: envelope.operationId, label: envelope.description }, actor, `${envelope.date}T23:59:59.999Z`, syncState)
  }
  if (envelope.kind === 'expense.edit') {
    return activity(envelope.operationId, envelope.groupId, 'expense.updated', { kind: 'expense', id: envelope.expenseId, label: envelope.draft.description }, actor, `${envelope.draft.date}T23:59:59.999Z`, syncState, envelope.expenseId, envelope.expectedRevision + 1)
  }
  if (envelope.kind === 'expense.delete') {
    return activity(envelope.operationId, envelope.groupId, 'expense.deleted', { kind: 'expense', id: envelope.expenseId, label: expenseLabel(base, envelope.expenseId) }, actor, relatedTimestamp(base, envelope.expenseId), syncState, envelope.expenseId, envelope.expectedRevision + 1)
  }
  if (envelope.kind === 'comment.add') {
    return activity(envelope.operationId, envelope.groupId, 'comment.added', { kind: 'comment', id: envelope.operationId, label: envelope.body.trim() }, actor, relatedTimestamp(base, envelope.expenseId), syncState, envelope.expenseId, undefined, envelope.operationId)
  }
  if (envelope.kind === 'comment.delete') {
    return activity(envelope.operationId, envelope.groupId, 'comment.deleted', { kind: 'comment', id: envelope.commentId }, actor, relatedTimestamp(base, envelope.expenseId), syncState, envelope.expenseId, undefined, envelope.commentId)
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
function relatedTimestamp(base: readonly ActivityItem[], expenseId: string): string {
  return base.filter((item) => item.expenseId === expenseId).sort(newestActivityFirst)[0]?.createdAt ?? '1970-01-01T00:00:00.000Z'
}
function matchesFilter(item: ActivityItem, filter: ActivityFilter): boolean {
  return filter === 'all' || (filter === 'expenses' && item.kind.startsWith('expense.')) || (filter === 'comments' && item.kind.startsWith('comment.')) || (filter === 'payments' && item.kind.startsWith('settlement.'))
}
export function newestActivityFirst(left: ActivityItem, right: ActivityItem): number { return right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id) }
function validId(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
