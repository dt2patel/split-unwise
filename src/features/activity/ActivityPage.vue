<script setup lang="ts">
import { computed, nextTick, onMounted, ref, shallowRef, type ComponentPublicInstance } from 'vue'
import { storeToRefs } from 'pinia'
import { IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonLabel, IonModal, IonPage, IonSegment, IonSegmentButton, IonTitle, IonToolbar } from '@ionic/vue'
import { arrowUndoOutline } from 'ionicons/icons'
import { activityDestination, activityText, useActivityStore } from './activityStore'
import NotificationCenter from '../notifications/NotificationCenter.vue'
import type { ActivityFilter, ActivityItem } from '../../data/repositories'
import { createClientOperationId } from '../../data/clientOperationId'
import { getAppSession } from '../../data'

const store = useActivityStore()
const { allItems, error, filter, isFiltering, isLoading, isLoadingMore, items, nextCursor } = storeToRefs(store)
const presentingElement = shallowRef<HTMLElement>()
const restoreTarget = ref<ActivityItem>()
const restoring = ref(false)
const restoreError = ref('')
const feedback = ref('')

const filters: readonly { value: ActivityFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'expenses', label: 'Expenses' },
  { value: 'comments', label: 'Comments' },
  { value: 'payments', label: 'Payments' },
]
const status = computed(() => isLoading.value || isFiltering.value ? 'Loading activity…' : error.value)

onMounted(() => { void store.load() })

function setPresentingElement(value: Element | ComponentPublicInstance | null): void {
  const element = value && '$el' in value ? value.$el : value
  presentingElement.value = element instanceof HTMLElement ? element : undefined
}
function isRestorable(item: ActivityItem): boolean {
  if (item.kind !== 'group.deleted' || item.syncState !== 'fresh') return false
  const latest = allItems.value.find((candidate) => candidate.groupId === item.groupId && (candidate.kind === 'group.deleted' || candidate.kind === 'group.restored'))
  return latest?.operationId === item.operationId && latest.kind === 'group.deleted'
}
function openRestore(item: ActivityItem): void {
  if (!isRestorable(item)) return
  restoreError.value = ''; feedback.value = ''; restoreTarget.value = item
}
function closeRestore(): void {
  if (restoring.value) return
  restoreTarget.value = undefined; restoreError.value = ''
}
async function restoreGroup(): Promise<void> {
  const target = restoreTarget.value
  if (!target || restoring.value || !isRestorable(target)) return
  restoring.value = true; restoreError.value = ''
  try {
    const result = await getAppSession().queue.submit({
      kind: 'group.restore', operationId: createClientOperationId('group-restore'), groupId: target.groupId,
    }).result()
    if (result.status !== 'saved') throw new Error(result.reason)
    const label = target.subject.label ?? 'Group'
    await store.load('all')
    restoreTarget.value = undefined
    feedback.value = `${label} was restored for everyone.`
    await nextTick()
  } catch (reason) { restoreError.value = reason instanceof Error ? reason.message : String(reason) } finally { restoring.value = false }
}
async function canDismissRestore(): Promise<boolean> { return !restoring.value }

function selectFilter(next: ActivityFilter): void { store.setFilter(next) }
function onSegmentChange(event: CustomEvent<{ value?: string | number }>): void {
  const value = event.detail.value
  if (value === 'all' || value === 'expenses' || value === 'comments' || value === 'payments') selectFilter(value)
}
function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}
</script>

<template>
  <ion-page :ref="setPresentingElement" data-testid="activity-page">
    <ion-header translucent>
      <ion-toolbar>
        <ion-title>Activity</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content :fullscreen="true">
      <main class="activity-page">
        <h1>Activity</h1>
        <p class="activity-page__intro">A permanent record of changes across your groups.</p>

        <ion-segment :value="filter" aria-label="Filter activity" @ion-change="onSegmentChange">
          <ion-segment-button
            v-for="option in filters"
            :key="option.value"
            :value="option.value"
            @click="selectFilter(option.value)"
          >
            <ion-label>{{ option.label }}</ion-label>
          </ion-segment-button>
        </ion-segment>

        <p v-if="status" class="activity-page__status" :role="error ? 'alert' : 'status'">{{ status }}</p>
        <p v-if="feedback" class="activity-page__feedback" role="status" aria-live="polite">{{ feedback }}</p>
        <p v-if="!status && items.length === 0" class="activity-page__status">No activity matches this filter.</p>
        <ol v-else-if="!status" class="activity-list" aria-label="Account activity">
          <li v-for="item in items" :key="item.id" :data-activity-id="item.id" :data-sync-state="item.syncState">
            <router-link v-if="activityDestination(item, 'activity')" :to="activityDestination(item, 'activity')!" class="activity-list__body">
              <strong>{{ activityText(item) }}</strong>
              <time :datetime="item.createdAt">{{ formatDate(item.createdAt) }}</time>
              <span v-if="item.syncState !== 'fresh'" class="activity-list__state">{{ item.syncState }}</span>
            </router-link>
            <button v-else-if="isRestorable(item)" type="button" class="activity-list__body activity-list__restore" data-action="restore-group" @click="openRestore(item)">
              <span class="activity-list__copy"><strong>{{ activityText(item) }}</strong><time :datetime="item.createdAt">{{ formatDate(item.createdAt) }}</time></span>
              <span class="activity-list__restore-action"><ion-icon :icon="arrowUndoOutline" aria-hidden="true" />Restore</span>
            </button>
            <div v-else class="activity-list__body">
              <strong>{{ activityText(item) }}</strong>
              <time :datetime="item.createdAt">{{ formatDate(item.createdAt) }}</time>
              <span v-if="item.syncState !== 'fresh'" class="activity-list__state">{{ item.syncState }}</span>
            </div>
          </li>
        </ol>
        <ion-button v-if="nextCursor" expand="block" fill="outline" data-action="load-more-activity" :disabled="isLoading || isFiltering || isLoadingMore" @click="store.loadMore">
          {{ isLoadingMore ? 'Loading…' : 'Load more activity' }}
        </ion-button>
        <notification-center />
      </main>
    </ion-content>

    <ion-modal :is-open="Boolean(restoreTarget)" :presenting-element="presentingElement" :can-dismiss="canDismissRestore" @did-dismiss="closeRestore">
      <ion-header translucent>
        <ion-toolbar>
          <ion-buttons slot="start"><ion-button :disabled="restoring" @click="closeRestore">Cancel</ion-button></ion-buttons>
          <ion-title>Restore group</ion-title>
        </ion-toolbar>
      </ion-header>
      <ion-content>
        <main v-if="restoreTarget" class="restore-card" data-testid="restore-group-modal">
          <span class="restore-card__mark" aria-hidden="true"><ion-icon :icon="arrowUndoOutline" /></span>
          <h2>Restore {{ restoreTarget.subject.label ?? 'this group' }}?</h2>
          <p>This restores the group for everyone, including all expenses and payments.</p>
          <div class="restore-card__note"><strong>Everything comes back together</strong><p>Members, recurring expenses, comments, and payment history return exactly as they were.</p></div>
          <p v-if="restoreError" class="restore-card__error" role="alert">{{ restoreError }}</p>
          <ion-button data-testid="confirm-group-restore" expand="block" shape="round" :disabled="restoring" @click="restoreGroup">{{ restoring ? 'Restoring group…' : 'Restore group' }}</ion-button>
        </main>
      </ion-content>
    </ion-modal>
  </ion-page>
</template>

<style scoped>
.activity-page { width: min(100%, 760px); margin: 0 auto; padding: 22px 18px calc(28px + env(safe-area-inset-bottom)); }
.activity-page h1 { margin: 0; font-size: clamp(1.65rem, 4.5vw, 2.15rem); line-height: 1.15; }
.activity-page__intro { margin: 7px 0 18px; color: var(--ion-color-medium); line-height: 1.45; }
.activity-page ion-segment { min-height: 46px; margin-bottom: 16px; border: 1px solid color-mix(in srgb, var(--su-divider) 42%, transparent); border-radius: 13px; }
.activity-page ion-segment-button { min-width: 0; min-height: 44px; --border-radius: 11px; --color: var(--ion-color-medium); --color-checked: var(--ion-color-primary); --indicator-color: var(--su-surface); --padding-end: 6px; --padding-start: 6px; font-size: .75rem; text-transform: none; }
.activity-page__status { min-height: 44px; margin: 16px 0; color: var(--ion-color-medium); line-height: 1.45; }
.activity-page__feedback { margin: 0 0 12px; padding: 10px 12px; border-radius: 11px; background: color-mix(in srgb, var(--ion-color-success) 10%, var(--su-surface)); color: var(--ion-color-success-shade); font-size: .84rem; line-height: 1.4; }
.activity-list { margin: 0; padding: 0; list-style: none; }
.activity-list li { border-bottom: 1px solid color-mix(in srgb, var(--su-divider) 45%, transparent); }
.activity-list__body { display: grid; min-height: 70px; align-content: center; gap: 5px; padding: 11px 4px; color: inherit; text-decoration: none; overflow-wrap: anywhere; }
.activity-list__restore { box-sizing: border-box; width: 100%; grid-template-columns: minmax(0, 1fr) auto; align-items: center; border: 0; border-radius: 10px; background: transparent; font: inherit; text-align: start; }
.activity-list__copy { display: grid; min-width: 0; gap: 5px; }
.activity-list__restore-action { display: inline-flex; min-height: 44px; align-items: center; gap: 5px; margin-inline-start: 12px; color: var(--ion-color-primary); font-size: .78rem; font-weight: 700; }
.activity-list__restore-action ion-icon { font-size: 1.05rem; }
a.activity-list__body { border-radius: 10px; }
a.activity-list__body:focus-visible { outline: 3px solid color-mix(in srgb, var(--ion-color-primary) 48%, transparent); outline-offset: -3px; }
.activity-list__restore:focus-visible { outline: 3px solid color-mix(in srgb, var(--ion-color-primary) 48%, transparent); outline-offset: -3px; }
.activity-list__body strong { font-size: 0.94rem; font-weight: 650; line-height: 1.35; }
.activity-list__body time,
.activity-list__state { color: var(--ion-color-medium); font-size: 0.76rem; line-height: 1.3; }
.activity-list__state { text-transform: capitalize; }
.activity-list li[data-sync-state="pending"] { animation: activity-enter 160ms ease-out both; }
@keyframes activity-enter { from { opacity: 0; transform: translateY(7px); } to { opacity: 1; transform: translateY(0); } }
.restore-card { box-sizing: border-box; display: flex; width: min(100%, 520px); min-height: 100%; flex-direction: column; align-items: center; margin: 0 auto; padding: 36px 20px calc(24px + env(safe-area-inset-bottom)); text-align: center; }
.restore-card__mark { display: grid; width: 54px; height: 54px; place-items: center; border-radius: 50%; background: color-mix(in srgb, var(--ion-color-primary) 11%, var(--su-surface)); color: var(--ion-color-primary); }
.restore-card__mark ion-icon { font-size: 1.5rem; }
.restore-card h2 { margin: 15px 0 7px; font-size: 1.35rem; letter-spacing: -.025em; }
.restore-card > p { max-width: 390px; margin: 0; color: var(--ion-color-medium); font-size: .88rem; line-height: 1.45; }
.restore-card__note { margin: 24px 0 18px; padding: 14px 15px; border: 1px solid color-mix(in srgb, var(--su-divider) 58%, transparent); border-radius: 14px; background: color-mix(in srgb, var(--su-lilac) 34%, var(--su-surface)); text-align: start; }
.restore-card__note strong { font-size: .83rem; }
.restore-card__note p { margin: 4px 0 0; color: var(--ion-color-medium); font-size: .78rem; line-height: 1.45; }
.restore-card__error { width: 100%; margin: 0 0 12px; color: var(--ion-color-danger); text-align: start; }
.restore-card > ion-button { width: 100%; min-height: 48px; margin-top: auto; text-transform: none; }

@media (prefers-reduced-motion: reduce) {
  .activity-list li[data-sync-state="pending"] { animation: none; }
}
@media (max-width: 360px) {
  .activity-page ion-segment-button { --padding-end: 4px; --padding-start: 4px; font-size: .7rem; }
}
</style>
