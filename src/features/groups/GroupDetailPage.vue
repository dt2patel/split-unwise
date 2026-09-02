<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useRoute } from 'vue-router'
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonFooter,
  IonHeader,
  IonIcon,
  IonLabel,
  IonPage,
  IonSegment,
  IonSegmentButton,
  IonSkeletonText,
  IonTitle,
  IonToolbar,
  onIonViewWillEnter,
} from '@ionic/vue'
import { listOutline, settingsOutline, timeOutline } from 'ionicons/icons'
import AppFab from '../../components/AppFab.vue'
import ExpenseRow from '../../components/ExpenseRow.vue'
import ActionRail from './components/ActionRail.vue'
import GroupHero from './components/GroupHero.vue'
import { useGroupStore } from './groupStore'
import { activityDestination, activityText } from '../activity/activityStore'
import { getAppSession } from '../../data'
import { isStrictId } from '../../data/identifiers'
import { useI18n } from '../../app/i18n'
import { displayMessageText } from '../../app/displayMessages'

type GroupView = 'expenses' | 'activity'

const route = useRoute()
const store = useGroupStore()
const session = getAppSession()
const { t } = useI18n()
const { activeGroup, currentUserNets, error, isActivityLoading, isLoading, journalExpenses, members, recentActivity } = storeToRefs(store)
const selectedView = ref<GroupView>('expenses')
const isCollapsed = ref(false)
const groupId = computed(() => String(route.params.groupId ?? ''))
const isFriendship = computed(() => activeGroup.value?.kind === 'friendship')
const canInvite = computed(() => !isFriendship.value || members.value.length < 2)
const groupError = computed(() => {
  return displayMessageText(error.value, t)
})
const monthLabel = computed(() => {
  const date = journalExpenses.value[0]?.date
  if (!date) return ''
  return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00.000Z`))
})
const groupedActivity = computed(() => {
  const groups: Array<{ readonly key: string; readonly label: string; readonly items: typeof recentActivity.value }> = []
  for (const item of recentActivity.value) {
    const key = item.createdAt.slice(0, 10)
    const existing = groups.at(-1)
    if (existing?.key === key) {
      groups[groups.length - 1] = { ...existing, items: [...existing.items, item] }
    } else {
      groups.push({ key, label: formatActivityDay(item.createdAt), items: [item] })
    }
  }
  return groups
})
let recurringCatchUp: { readonly groupId: string; readonly promise: Promise<void> } | undefined
let skipInitialIonicEntry = true

watch(groupId, (id) => {
  if (id) void loadGroupForEntry(id)
}, { immediate: true })
onIonViewWillEnter(() => {
  if (skipInitialIonicEntry) {
    skipInitialIonicEntry = false
    return
  }
  void refreshOnViewEntry()
})

async function refreshOnViewEntry(): Promise<void> {
  if (isStrictId(groupId.value)) await loadGroupForEntry(groupId.value)
  if (selectedView.value === 'activity' && isStrictId(groupId.value)) await store.loadActivity(groupId.value, true)
}

async function loadGroupForEntry(id: string): Promise<void> {
  await store.loadGroup(id)
  if (activeGroup.value?.id === id) void startRecurringCatchUp(id)
}

function startRecurringCatchUp(id: string): Promise<void> {
  if (recurringCatchUp?.groupId === id) return recurringCatchUp.promise
  let pending!: Promise<void>
  pending = (async () => {
    try {
      const result = await session.repository.groups.materializeDue(id, localToday(), 24)
      if (result.occurrences.length > 0 && groupId.value === id) await store.loadGroup(id)
    } catch {
      if (groupId.value === id) await store.loadGroup(id)
    }
  })().catch(() => undefined).finally(() => {
    if (recurringCatchUp?.promise === pending) recurringCatchUp = undefined
  })
  recurringCatchUp = { groupId: id, promise: pending }
  return pending
}

function localToday(value = new Date()): string {
  return `${String(value.getFullYear()).padStart(4, '0')}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
}

function selectView(view: GroupView): void {
  selectedView.value = view
  if (view === 'activity' && isStrictId(groupId.value)) void store.loadActivity(groupId.value)
}

function onSegmentChange(event: CustomEvent<{ value?: string | number }>): void {
  if (event.detail.value === 'expenses' || event.detail.value === 'activity') selectView(event.detail.value)
}

function onScroll(event: CustomEvent<{ scrollTop?: number }>): void {
  isCollapsed.value = (event.detail.scrollTop ?? 0) > 72
}
function formatActivityDay(timestamp: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(timestamp))
}
function retryExpense(operationId: string | undefined): void { if (operationId) void store.retryOperation(operationId).result().catch(() => undefined) }
function discardExpense(operationId: string | undefined): void { if (operationId) store.discardFailedOperation(operationId) }
function expenseDetailDestination(expenseId: string): string | undefined {
  if (expenseId.startsWith('pending:') || !isStrictId(groupId.value) || !isStrictId(expenseId)) return undefined
  return `/tabs/groups/expenses/${encodeURIComponent(expenseId)}?groupId=${encodeURIComponent(groupId.value)}`
}
async function reloadRemoteExpense(operationId: string | undefined): Promise<void> {
  if (!operationId) return
  await store.reloadRemoteConflict(operationId).catch(() => false)
}
async function retainLocalExpense(operationId: string | undefined): Promise<void> {
  if (!operationId) return
  const retained = await store.retainAndSaveLocal(operationId).catch(() => undefined)
  await retained?.result().catch(() => undefined)
}
async function deleteRemoteExpense(operationId: string | undefined): Promise<void> {
  if (!operationId) return
  const retained = await store.deleteAgainstRemoteRevision(operationId).catch(() => undefined)
  await retained?.result().catch(() => undefined)
}
</script>

<template>
  <ion-page data-testid="group-detail" class="group-detail" :class="{ 'group-detail--collapsed': isCollapsed }">
    <ion-header class="group-detail__header" translucent>
      <ion-toolbar>
        <ion-buttons slot="start">
          <ion-back-button :default-href="isFriendship ? '/tabs/home/friends' : '/tabs/groups'" text="Back" />
        </ion-buttons>
        <ion-title>{{ activeGroup?.name ?? 'Group' }}</ion-title>
        <ion-buttons slot="end">
          <ion-button
            v-if="activeGroup"
            fill="clear"
            :router-link="`/tabs/groups/${groupId}/settings`"
            :aria-label="isFriendship ? 'Friend settings' : 'Group settings'"
          >
            <ion-icon :icon="settingsOutline" aria-hidden="true" />
          </ion-button>
        </ion-buttons>
      </ion-toolbar>
    </ion-header>

    <ion-content class="group-detail__scroller" data-testid="group-detail-scroll" :fullscreen="true" :scroll-events="true" @ion-scroll="onScroll">
      <p v-if="isLoading && !activeGroup" class="group-detail__status" role="status">Loading expenses…</p>
      <main v-else-if="activeGroup" class="group-detail__main">
        <group-hero :group="activeGroup" :balances="currentUserNets" :collapsed="isCollapsed" />
        <action-rail :group-id="groupId" :context-kind="activeGroup.kind" :can-invite="canInvite" />

        <section class="group-detail__ledger" :aria-label="isFriendship ? 'Friend expense journal' : 'Group journal'">
          <div v-if="isLoading && selectedView === 'expenses' && journalExpenses.length === 0" class="journal-loading" data-testid="journal-loading" role="status" aria-label="Loading expenses">
            <span class="su-visually-hidden">Loading expenses…</span>
            <div v-for="index in 3" :key="index" class="journal-loading__row" aria-hidden="true">
              <ion-skeleton-text animated class="journal-loading__date" />
              <ion-skeleton-text animated class="journal-loading__icon" />
              <span class="journal-loading__summary">
                <ion-skeleton-text animated />
                <ion-skeleton-text animated />
              </span>
              <ion-skeleton-text animated class="journal-loading__amount" />
            </div>
          </div>
          <h2 v-if="selectedView === 'expenses' && monthLabel" class="month-divider" data-testid="month-divider">{{ monthLabel }}</h2>

          <transition name="journal-fade" mode="out-in">
            <div v-if="selectedView === 'expenses'" key="expenses" data-testid="expense-journal">
              <expense-row
                v-for="expense in journalExpenses"
                :key="expense.id"
                :data-expense-id="expense.id"
                :expense="expense"
                :balance="store.positionFor(expense).money"
                :balance-direction="store.positionFor(expense).direction"
                :balance-label="store.positionFor(expense).label"
                :payer-name="store.payerName(expense)"
                :participant-count="expense.allocations.length"
                :detail-to="expenseDetailDestination(expense.id)"
                :retryable="expense.retryable === true"
                :conflict-remote="expense.conflictRemote"
                :conflict-intent="expense.conflictIntent"
                journal
                @retry="retryExpense(expense.clientOperationId)"
                @discard="discardExpense(expense.clientOperationId)"
                @reload-remote="reloadRemoteExpense(expense.clientOperationId)"
                @retain-local="retainLocalExpense(expense.clientOperationId)"
                @delete-remote="deleteRemoteExpense(expense.clientOperationId)"
              />
            </div>
            <div v-else key="activity" data-testid="group-activity">
              <p v-if="isActivityLoading" class="activity-loading" role="status">Loading activity…</p>
              <section v-for="day in groupedActivity" :key="day.key" class="activity-day">
                <h3 class="activity-day__heading" data-testid="activity-date-divider">{{ day.label }}</h3>
                <ol class="activity-list">
                  <li v-for="item in day.items" :key="item.id" :data-activity-id="item.id" :data-sync-state="item.syncState">
                    <router-link v-if="activityDestination(item, 'groups')" :to="activityDestination(item, 'groups')!" class="activity-list__body">
                      <span>{{ activityText(item) }}</span>
                      <time :datetime="item.createdAt">{{ new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(item.createdAt)) }}</time>
                    </router-link>
                    <div v-else class="activity-list__body">
                      <span>{{ activityText(item) }}</span>
                      <time :datetime="item.createdAt">{{ new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(item.createdAt)) }}</time>
                    </div>
                  </li>
                </ol>
              </section>
            </div>
          </transition>
        </section>
      </main>
      <p v-else class="group-detail__status" role="alert">{{ groupError ?? 'These shared expenses are not available.' }}</p>

      <app-fab
        v-if="activeGroup"
        slot="fixed"
        class="group-detail__fab"
        :to="`/tabs/groups/expenses/new?groupId=${encodeURIComponent(groupId)}`"
        label="Add expense"
      />
    </ion-content>

    <ion-footer v-if="activeGroup" class="group-detail__footer">
      <ion-segment :value="selectedView" @ion-change="onSegmentChange">
        <ion-segment-button value="expenses" @click="selectView('expenses')">
          <ion-icon :icon="listOutline" aria-hidden="true" />
          <ion-label>Expenses</ion-label>
        </ion-segment-button>
        <ion-segment-button value="activity" @click="selectView('activity')">
          <ion-icon :icon="timeOutline" aria-hidden="true" />
          <ion-label>Activity</ion-label>
        </ion-segment-button>
      </ion-segment>
    </ion-footer>
  </ion-page>
</template>

<style scoped>
.group-detail { --su-journal-gutter: 18px; }
.group-detail__header ion-toolbar { --min-height: 58px; --border-color: color-mix(in srgb, var(--su-divider) 34%, transparent); }
.group-detail__header ion-title { font-size: 1rem; font-weight: 680; }
.group-detail__header ion-button { width: 44px; height: 44px; margin: 0; font-size: 1.35rem; }
.group-detail__main { min-height: 100%; padding-bottom: 16px; background: var(--su-surface); }
.group-detail__main > :deep(.action-rail) { margin-top: 16px; }
.group-detail__ledger { padding: 0 var(--su-journal-gutter) 10px; }
.month-divider { margin: 20px 0 0; padding: 0 3px 7px; border-bottom: 1px solid color-mix(in srgb, var(--su-divider) 45%, transparent); color: var(--ion-color-medium); font-size: 0.82rem; font-weight: 520; line-height: 1.2; }
.journal-loading { margin-top: 18px; }
.journal-loading__row { display: grid; grid-template-columns: 30px 44px minmax(0, 1fr) 62px; min-height: 83px; align-items: center; gap: 8px; border-bottom: 1px solid color-mix(in srgb, var(--su-divider) 42%, transparent); }
.journal-loading ion-skeleton-text { margin: 0; border-radius: 7px; }
.journal-loading__date { width: 24px; height: 30px; justify-self: center; }
.journal-loading__icon { width: 44px; height: 44px; border-radius: 50% !important; }
.journal-loading__summary { display: grid; gap: 8px; }
.journal-loading__summary ion-skeleton-text:first-child { width: min(132px, 92%); height: 14px; }
.journal-loading__summary ion-skeleton-text:last-child { width: min(104px, 76%); height: 10px; }
.journal-loading__amount { width: 54px; height: 14px; justify-self: end; }
.activity-day__heading { margin: 18px 0 0; padding: 0 3px 7px; border-bottom: 1px solid color-mix(in srgb, var(--su-divider) 45%, transparent); color: var(--ion-color-medium); font-size: 0.82rem; font-weight: 520; }
.activity-list { margin: 0; padding: 0; list-style: none; }
.activity-list li { border-bottom: 1px solid color-mix(in srgb, var(--su-divider) 45%, transparent); font-size: 0.9rem; }
.activity-list__body { display: flex; min-height: 44px; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 2px; color: inherit; text-decoration: none; }
.activity-list time { flex: 0 0 auto; color: var(--ion-color-medium); font-size: 0.75rem; }
.activity-loading { margin: 22px 0; color: var(--ion-color-medium); text-align: center; }
.group-detail__status { padding: 32px 18px; color: var(--ion-color-medium); text-align: center; }
.group-detail__footer { padding: 5px 14px calc(5px + env(safe-area-inset-bottom)); background: color-mix(in srgb, var(--su-surface) 94%, transparent); backdrop-filter: blur(18px); }
.group-detail__footer ion-segment { min-height: 46px; border: 1px solid color-mix(in srgb, var(--su-divider) 34%, transparent); border-radius: 13px; background: color-mix(in srgb, var(--su-surface) 90%, var(--su-lilac)); }
.group-detail__footer ion-segment-button { min-height: 44px; --border-radius: 11px; --color: var(--ion-color-medium); --color-checked: var(--ion-color-primary); --indicator-color: var(--su-surface); --indicator-box-shadow: 0 2px 8px rgb(38 32 127 / 10%); text-transform: none; }
.group-detail__footer ion-icon { margin-inline-end: 5px; }
.group-detail__fab :deep(ion-fab-button) { width: 52px; height: 52px; --box-shadow: 0 7px 18px rgb(63 45 164 / 36%); }
.journal-fade-enter-active,
.journal-fade-leave-active { transition: opacity 160ms ease-out, transform 160ms ease-out; }
.journal-fade-enter-from { opacity: 0; transform: translateY(8px); }
.journal-fade-leave-to { opacity: 0; transform: translateY(-4px); }

@media (prefers-reduced-motion: reduce) {
  .journal-fade-enter-active,
  .journal-fade-leave-active { transition: none; }
  .journal-fade-enter-from,
  .journal-fade-leave-to { transform: none; }
}
@media (min-width: 768px) { .group-detail { --su-journal-gutter: clamp(22px, 4vw, 42px); }.group-detail__main { max-width: 760px; margin: 0 auto; }.group-detail__footer { padding-inline: clamp(22px, 4vw, 42px); }.group-detail__header ion-back-button { display: none; } }
</style>
