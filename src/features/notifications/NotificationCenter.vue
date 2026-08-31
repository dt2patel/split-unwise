<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { IonButton, IonToggle } from '@ionic/vue'
import { getAppSession } from '../../data'
import type { NotificationItem, NotificationPreferences, TimelineCursor } from '../../data/repositories'

const session = getAppSession()
const notifications = ref<readonly NotificationItem[]>([])
const preferences = ref<NotificationPreferences>({ emailEnabled: true, pushEnabled: true })
const isLoading = ref(true)
const error = ref('')
const status = ref('')
const inFlight = ref(new Set<string>())
const queueRevision = ref(0)
let request = 0
let unsubscribe: (() => void) | undefined

const rows = computed(() => {
  queueRevision.value
  const byId = new Map(notifications.value.map((notification) => [notification.notificationId, clone(notification)]))
  for (const operation of relevantOperations()) {
    const envelope = operation.envelope
    if (envelope.kind === 'notification.read') {
      const current = byId.get(envelope.notificationId)
      if (!current) continue
      if ((operation.status === 'fresh' || operation.status === 'stale') && operation.result.status === 'saved' && operation.result.kind === 'notification.read') {
        byId.set(envelope.notificationId, clone(operation.result.notification))
      } else if (operation.status === 'pending' || operation.status === 'failed') {
        byId.set(envelope.notificationId, { ...current, syncState: operation.status })
      }
    } else if (envelope.kind === 'notification.read-all') {
      if ((operation.status === 'fresh' || operation.status === 'stale') && operation.result.status === 'saved' && operation.result.kind === 'notification.read-all') {
        const readIds = new Set(operation.result.readNotificationIds)
        for (const [id, current] of byId) if (readIds.has(id)) byId.set(id, { ...current, readAt: current.readAt ?? current.createdAt })
      } else if (operation.status === 'pending' || operation.status === 'failed') {
        for (const [id, current] of byId) if (atOrBefore(current, envelope.cutoff)) byId.set(id, { ...current, syncState: operation.status })
      }
    }
  }
  return [...byId.values()].sort(newestFirst)
})

const projectedPreferences = computed(() => {
  queueRevision.value
  let projected = { ...preferences.value }
  for (const operation of relevantOperations()) {
    if (operation.envelope.kind !== 'notification.preferences') continue
    if (operation.status === 'pending' || operation.status === 'failed') projected = { ...operation.envelope.preferences }
    else if ((operation.status === 'fresh' || operation.status === 'stale') && operation.result.status === 'saved' && operation.result.kind === 'notification.preferences') projected = { ...operation.result.preferences }
  }
  return projected
})

const unreadCount = computed(() => rows.value.filter(({ readAt }) => !readAt).length)
const unreadLabel = computed(() => `${unreadCount.value} unread notification${unreadCount.value === 1 ? '' : 's'}`)
const latestCutoff = computed<TimelineCursor | undefined>(() => rows.value[0] ? { createdAt: rows.value[0].createdAt, id: rows.value[0].notificationId } : undefined)
const failedOperation = computed(() => [...relevantOperations()].reverse().find((operation) => operation.status === 'failed'))

onMounted(() => {
  unsubscribe = session.queue.subscribe(() => {
    queueRevision.value += 1
    if (!relevantOperations().some(({ status: operationStatus }) => operationStatus === 'pending')) void load()
  })
  void load()
})
onBeforeUnmount(() => { ++request; unsubscribe?.() })

async function load(): Promise<void> {
  const active = ++request
  try {
    await session.ready
    const [page, savedPreferences] = await Promise.all([
      session.repository.notifications.list({ limit: 100 }),
      session.repository.notifications.getPreferences(),
    ])
    if (active !== request) return
    notifications.value = page.items
    preferences.value = savedPreferences
  } catch (reason) {
    if (active === request) error.value = message(reason, 'Notifications could not be loaded.')
  } finally {
    if (active === request) isLoading.value = false
  }
}

async function markRead(notification: NotificationItem): Promise<void> {
  if (notification.readAt || inFlight.value.has(notification.notificationId)) return
  const pending = new Set(inFlight.value).add(notification.notificationId)
  inFlight.value = pending
  error.value = ''
  status.value = 'Marking notification read…'
  const operationId = createOperationId('notification-read')
  try {
    await session.queue.submit({ kind: 'notification.read', operationId, notificationId: notification.notificationId }).result()
    status.value = 'Notification marked read.'
    await load()
  } catch (reason) {
    error.value = message(reason, 'Notification read state could not be saved.')
    status.value = ''
  } finally {
    const next = new Set(inFlight.value)
    next.delete(notification.notificationId)
    inFlight.value = next
  }
}

async function markAllRead(): Promise<void> {
  const cutoff = latestCutoff.value
  if (!cutoff || unreadCount.value === 0 || inFlight.value.has('all')) return
  inFlight.value = new Set(inFlight.value).add('all')
  error.value = ''
  status.value = 'Marking notifications read…'
  try {
    await session.queue.submit({ kind: 'notification.read-all', operationId: createOperationId('notification-read-all'), cutoff }).result()
    status.value = 'Notifications marked read.'
    await load()
  } catch (reason) {
    error.value = message(reason, 'Notification read state could not be saved.')
    status.value = ''
  } finally {
    const next = new Set(inFlight.value)
    next.delete('all')
    inFlight.value = next
  }
}

async function updatePreference(key: keyof NotificationPreferences, event: CustomEvent<{ checked?: boolean }>): Promise<void> {
  const checked = event.detail.checked
  if (typeof checked !== 'boolean') return
  const next = { ...projectedPreferences.value, [key]: checked }
  if (next.emailEnabled === projectedPreferences.value.emailEnabled && next.pushEnabled === projectedPreferences.value.pushEnabled) return
  error.value = ''
  status.value = 'Saving notification preferences…'
  try {
    await session.queue.submit({ kind: 'notification.preferences', operationId: createOperationId('notification-preferences'), preferences: next }).result()
    status.value = 'Notification preferences saved.'
    await load()
  } catch (reason) {
    error.value = message(reason, 'Notification preferences could not be saved.')
    status.value = ''
  }
}

async function retryFailed(): Promise<void> {
  const failed = failedOperation.value
  if (!failed) return
  error.value = ''
  status.value = 'Retrying notification change…'
  try {
    await session.queue.retry(failed.envelope.operationId).result()
    status.value = 'Notification change saved.'
    await load()
  } catch (reason) {
    error.value = message(reason, 'Notification change could not be saved.')
    status.value = ''
  }
}

async function discardFailed(): Promise<void> {
  const failed = failedOperation.value
  if (!failed) return
  try {
    await session.queue.discard(failed.envelope.operationId)
    error.value = ''
    status.value = 'Notification change discarded.'
    queueRevision.value += 1
  } catch (reason) {
    error.value = message(reason, 'Notification change could not be discarded.')
  }
}

function relevantOperations() {
  return session.queue.snapshot().filter(({ envelope }) => envelope.kind === 'notification.read' || envelope.kind === 'notification.read-all' || envelope.kind === 'notification.preferences')
}
function formatTime(timestamp: string): string { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp)) }
function notificationText(notification: NotificationItem): string {
  const label = notification.subject.label ?? notification.subject.id
  if (notification.kind === 'expense.created') return `${notification.actor.displayName} added ${label}`
  if (notification.kind === 'expense.updated') return `${notification.actor.displayName} updated ${label}`
  if (notification.kind === 'comment.added') return `${notification.actor.displayName} commented on ${label}`
  return `${notification.actor.displayName} changed ${label}`
}
function atOrBefore(notification: NotificationItem, cutoff: TimelineCursor): boolean { return notification.createdAt.localeCompare(cutoff.createdAt) < 0 || (notification.createdAt === cutoff.createdAt && notification.notificationId.localeCompare(cutoff.id) <= 0) }
function newestFirst(left: NotificationItem, right: NotificationItem): number { return right.createdAt.localeCompare(left.createdAt) || right.notificationId.localeCompare(left.notificationId) }
function message(reason: unknown, fallback: string): string { return reason instanceof Error && reason.message.trim() ? reason.message : fallback }
function createOperationId(prefix: string): string { return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}` }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
</script>

<template>
  <section class="notification-center" aria-labelledby="notifications-title">
    <div class="notification-center__heading">
      <div>
        <h2 id="notifications-title">Notifications</h2>
        <p data-testid="unread-count">{{ unreadLabel }}</p>
      </div>
      <ion-button fill="clear" :disabled="unreadCount === 0 || inFlight.has('all')" data-action="mark-all-read" @click="markAllRead">Mark all read</ion-button>
    </div>

    <p v-if="isLoading" role="status">Loading notifications…</p>
    <ol v-else class="notification-list" aria-labelledby="notifications-title">
      <li v-for="notification in rows" :key="notification.notificationId" :data-notification-id="notification.notificationId" :data-sync-state="notification.syncState">
        <div>
          <strong>{{ notificationText(notification) }}</strong>
          <time :datetime="notification.createdAt">{{ formatTime(notification.createdAt) }}</time>
          <span>{{ notification.readAt ? 'Read' : 'Unread' }}</span>
          <span v-if="notification.syncState !== 'fresh'">{{ notification.syncState }}</span>
        </div>
        <ion-button
          v-if="!notification.readAt"
          fill="clear"
          :disabled="inFlight.has(notification.notificationId)"
          :data-action="`mark-read-${notification.notificationId}`"
          :aria-label="`Mark ${notificationText(notification)} read`"
          @click="markRead(notification)"
        >Mark read</ion-button>
      </li>
    </ol>

    <div class="notification-preferences" role="group" aria-labelledby="notification-preferences-title">
      <h3 id="notification-preferences-title">Future delivery</h3>
      <label>Email notifications <ion-toggle :model-value="projectedPreferences.emailEnabled" @ion-change="updatePreference('emailEnabled', $event)" /></label>
      <label>Push notifications <ion-toggle :model-value="projectedPreferences.pushEnabled" @ion-change="updatePreference('pushEnabled', $event)" /></label>
      <p>Preferences change future email and push delivery. They do not erase Activity.</p>
    </div>

    <p v-if="status" role="status">{{ status }}</p>
    <div v-if="error" class="notification-center__error" role="alert">
      <p data-testid="notification-error">{{ error }}</p>
      <ion-button v-if="failedOperation?.error.retryable" fill="clear" data-action="retry-notification" @click="retryFailed">Retry</ion-button>
      <ion-button v-if="failedOperation" fill="clear" data-action="discard-notification" @click="discardFailed">Discard</ion-button>
    </div>
  </section>
</template>

<style scoped>
.notification-center { display: grid; gap: 14px; padding: 20px 0 6px; border-top: 1px solid var(--su-divider); overflow-wrap: anywhere; }
.notification-center__heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
.notification-center h2,
.notification-center h3,
.notification-center p { margin: 0; }
.notification-center h2 { font-size: 1.2rem; }
.notification-center h3 { font-size: 1rem; }
.notification-center__heading p,
.notification-preferences p { margin-top: 4px; color: var(--ion-color-medium); font-size: 0.8rem; line-height: 1.4; }
.notification-center ion-button,
.notification-center ion-toggle { min-width: 44px; min-height: 44px; }
.notification-list { display: grid; margin: 0; padding: 0; list-style: none; }
.notification-list > li { display: flex; min-height: 68px; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 0; border-bottom: 1px solid color-mix(in srgb, var(--su-divider) 45%, transparent); }
.notification-list > li > div { display: grid; min-width: 0; gap: 3px; }
.notification-list strong { font-size: 0.9rem; line-height: 1.35; }
.notification-list time,
.notification-list span { color: var(--ion-color-medium); font-size: 0.75rem; line-height: 1.3; }
.notification-preferences { display: grid; gap: 8px; padding: 13px; border: 1px solid color-mix(in srgb, var(--su-divider) 55%, transparent); border-radius: 14px; }
.notification-preferences label { display: flex; min-height: 44px; align-items: center; justify-content: space-between; gap: 12px; }
.notification-center__error { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; color: var(--su-owing); }
@media (prefers-reduced-motion: reduce) { .notification-center * { transition-duration: 0ms; } }
</style>
