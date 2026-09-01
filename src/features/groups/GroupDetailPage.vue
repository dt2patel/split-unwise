<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
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
  IonList,
  IonMenu,
  IonPage,
  IonSegment,
  IonSegmentButton,
  IonTitle,
  IonToolbar,
  IonSplitPane,
  onIonViewWillEnter,
} from '@ionic/vue'
import { listOutline, settingsOutline, timeOutline } from 'ionicons/icons'
import AppFab from '../../components/AppFab.vue'
import ExpenseRow from '../../components/ExpenseRow.vue'
import ActionRail from './components/ActionRail.vue'
import GroupHero from './components/GroupHero.vue'
import { useGroupStore } from './groupStore'
import { activityDestination, activityText } from '../activity/activityStore'
import { isStrictId } from '../../data/identifiers'

type GroupView = 'expenses' | 'activity'

const route = useRoute()
const store = useGroupStore()
const { activeGroup, currentUserNets, error, groups, isLoading, journalExpenses, recentActivity } = storeToRefs(store)
const selectedView = ref<GroupView>('expenses')
const isCollapsed = ref(false)
const groupId = computed(() => String(route.params.groupId ?? ''))
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

watch(groupId, (id) => {
  if (id) void store.loadGroup(id)
}, { immediate: true })
onMounted(() => { if (!groups.value.length) void store.loadGroupList() })
onIonViewWillEnter(() => { void refreshOnViewEntry() })

async function refreshOnViewEntry(): Promise<void> {
  if (isStrictId(groupId.value)) await store.loadGroup(groupId.value)
}

function selectView(view: GroupView): void {
  selectedView.value = view
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
    <ion-split-pane content-id="group-detail-content" when="md" data-testid="group-split-pane">
      <ion-menu content-id="group-detail-content" type="overlay" class="group-detail__master" menu-id="groups-master">
        <ion-header translucent><ion-toolbar><ion-title>Groups</ion-title></ion-toolbar></ion-header>
        <ion-content>
          <nav aria-label="Your groups">
            <ion-list lines="none">
              <router-link v-for="group in groups" :key="group.id" :to="`/tabs/groups/${group.id}`" class="master-group" :class="{ 'master-group--active': group.id === groupId }" :aria-current="group.id === groupId ? 'page' : undefined">
                <img v-if="group.coverImageUrl" :src="group.coverImageUrl" alt="" aria-hidden="true">
                <span v-else class="master-group__monogram" aria-hidden="true">{{ group.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase() }}</span>
                <span><strong>{{ group.name }}</strong><small>{{ group.memberIds.length }} people · {{ group.currency }}</small></span>
              </router-link>
            </ion-list>
          </nav>
        </ion-content>
      </ion-menu>

      <section id="group-detail-content" class="ion-page group-detail__detail">
    <ion-header class="group-detail__header" translucent>
      <ion-toolbar>
        <ion-buttons slot="start">
          <ion-back-button default-href="/tabs/groups" text="Back" />
        </ion-buttons>
        <ion-title>{{ activeGroup?.name ?? 'Group' }}</ion-title>
        <ion-buttons slot="end">
          <ion-button
            v-if="activeGroup"
            fill="clear"
            :router-link="`/tabs/groups/${groupId}/settings`"
            aria-label="Group settings"
          >
            <ion-icon :icon="settingsOutline" aria-hidden="true" />
          </ion-button>
        </ion-buttons>
      </ion-toolbar>
    </ion-header>

    <ion-content class="group-detail__scroller" data-testid="group-detail-scroll" :fullscreen="true" :scroll-events="true" @ion-scroll="onScroll">
      <p v-if="isLoading && !activeGroup" class="group-detail__status" role="status">Loading group…</p>
      <main v-else-if="activeGroup" class="group-detail__main">
        <group-hero :group="activeGroup" :balances="currentUserNets" :collapsed="isCollapsed" />
        <action-rail :group-id="groupId" />

        <section class="group-detail__ledger" aria-label="Group journal">
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
      <p v-else class="group-detail__status" role="alert">{{ error ?? 'This group is not available.' }}</p>

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
      </section>
    </ion-split-pane>
  </ion-page>
</template>

<style scoped>
.group-detail { --su-journal-gutter: 18px; }
.group-detail ion-split-pane { --side-width: 310px; --side-max-width: 340px; --border: 1px solid color-mix(in srgb, var(--su-divider) 28%, transparent); }
.group-detail__detail { position: relative; min-width: 0; background: var(--su-surface); }
.group-detail__master { --width: 310px; --max-width: 340px; }.group-detail__master ion-toolbar { --min-height: 58px; }.group-detail__master ion-list { padding: 8px; background: transparent; }
.master-group { display: grid; grid-template-columns: 48px minmax(0, 1fr); align-items: center; gap: 11px; min-height: 64px; padding: 7px 9px; border-radius: 14px; color: inherit; text-decoration: none; }.master-group img,.master-group__monogram { display: grid; width: 48px; height: 48px; place-items: center; border-radius: 14px; object-fit: cover; background: var(--su-indigo); color: #fff; font-weight: 700; }.master-group>span:last-child { display: grid; min-width: 0; gap: 3px; }.master-group strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.master-group small { color: var(--ion-color-medium); }.master-group--active { background: color-mix(in srgb, var(--su-lilac) 78%, var(--su-surface)); color: var(--ion-color-primary); }
.group-detail__header ion-toolbar { --min-height: 58px; --border-color: color-mix(in srgb, var(--su-divider) 34%, transparent); }
.group-detail__header ion-title { font-size: 1rem; font-weight: 680; }
.group-detail__header ion-button { width: 44px; height: 44px; margin: 0; font-size: 1.35rem; }
.group-detail__main { min-height: 100%; padding-bottom: 16px; background: var(--su-surface); }
.group-detail__main > :deep(.action-rail) { margin-top: 16px; }
.group-detail__ledger { padding: 0 var(--su-journal-gutter) 10px; }
.month-divider { margin: 20px 0 0; padding: 0 3px 7px; border-bottom: 1px solid color-mix(in srgb, var(--su-divider) 45%, transparent); color: var(--ion-color-medium); font-size: 0.82rem; font-weight: 520; line-height: 1.2; }
.activity-day__heading { margin: 18px 0 0; padding: 0 3px 7px; border-bottom: 1px solid color-mix(in srgb, var(--su-divider) 45%, transparent); color: var(--ion-color-medium); font-size: 0.82rem; font-weight: 520; }
.activity-list { margin: 0; padding: 0; list-style: none; }
.activity-list li { border-bottom: 1px solid color-mix(in srgb, var(--su-divider) 45%, transparent); font-size: 0.9rem; }
.activity-list__body { display: flex; min-height: 44px; align-items: center; justify-content: space-between; gap: 12px; padding: 9px 2px; color: inherit; text-decoration: none; }
.activity-list time { flex: 0 0 auto; color: var(--ion-color-medium); font-size: 0.75rem; }
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
