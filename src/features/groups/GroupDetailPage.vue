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
  IonTitle,
  IonToolbar,
} from '@ionic/vue'
import { listOutline, settingsOutline, timeOutline } from 'ionicons/icons'
import AppFab from '../../components/AppFab.vue'
import ExpenseRow from '../../components/ExpenseRow.vue'
import ActionRail from './components/ActionRail.vue'
import GroupHero from './components/GroupHero.vue'
import { useGroupStore } from './groupStore'

type GroupView = 'expenses' | 'activity'

const route = useRoute()
const store = useGroupStore()
const { activeGroup, currentUserNet, error, isLoading, journalExpenses, recentActivity } = storeToRefs(store)
const selectedView = ref<GroupView>('expenses')
const isCollapsed = ref(false)
const groupId = computed(() => String(route.params.groupId ?? ''))
const monthLabel = computed(() => {
  const date = journalExpenses.value[0]?.date
  if (!date) return ''
  return new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00.000Z`))
})

watch(groupId, (id) => {
  if (id) void store.loadGroup(id)
}, { immediate: true })

function selectView(view: GroupView): void {
  selectedView.value = view
}

function onSegmentChange(event: CustomEvent<{ value?: string | number }>): void {
  if (event.detail.value === 'expenses' || event.detail.value === 'activity') selectView(event.detail.value)
}

function onScroll(event: CustomEvent<{ scrollTop?: number }>): void {
  isCollapsed.value = (event.detail.scrollTop ?? 0) > 72
}
</script>

<template>
  <ion-page data-testid="group-detail" class="group-detail" :class="{ 'group-detail--collapsed': isCollapsed }">
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

    <ion-content :fullscreen="true" :scroll-events="true" @ion-scroll="onScroll">
      <p v-if="isLoading && !activeGroup" class="group-detail__status" role="status">Loading group…</p>
      <main v-else-if="activeGroup" class="group-detail__main">
        <group-hero :group="activeGroup" :balance="currentUserNet" :collapsed="isCollapsed" />
        <action-rail :group-id="groupId" />

        <section class="group-detail__ledger" aria-label="Group journal">
          <h2 v-if="monthLabel" class="month-divider" data-testid="month-divider">{{ monthLabel }}</h2>

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
                journal
              />
            </div>
            <ol v-else key="activity" class="activity-list" data-testid="group-activity">
              <li v-for="item in recentActivity" :key="item.id">
                <span>{{ item.summary }}</span>
                <time :datetime="item.createdAt">{{ new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(item.createdAt)) }}</time>
              </li>
            </ol>
          </transition>
        </section>
      </main>
      <p v-else class="group-detail__status" role="alert">{{ error ?? 'This group is not available.' }}</p>

      <app-fab
        v-if="activeGroup"
        slot="fixed"
        class="group-detail__fab"
        :to="`/tabs/groups/${groupId}/expenses/new`"
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
.activity-list { min-height: 415px; margin: 0; padding: 0; list-style: none; }
.activity-list li { display: flex; min-height: 62px; align-items: center; justify-content: space-between; gap: 12px; border-bottom: 1px solid color-mix(in srgb, var(--su-divider) 45%, transparent); font-size: 0.9rem; }
.activity-list time { flex: 0 0 auto; color: var(--ion-color-medium); font-size: 0.75rem; }
.group-detail__status { padding: 32px 18px; color: var(--ion-color-medium); text-align: center; }
.group-detail__footer { padding: 5px 14px calc(5px + env(safe-area-inset-bottom)); background: color-mix(in srgb, var(--su-surface) 94%, transparent); backdrop-filter: blur(18px); }
.group-detail__footer ion-segment { min-height: 46px; border: 1px solid color-mix(in srgb, var(--su-divider) 34%, transparent); border-radius: 13px; background: color-mix(in srgb, var(--su-surface) 90%, var(--su-lilac)); }
.group-detail__footer ion-segment-button { min-height: 44px; --border-radius: 11px; --color: var(--ion-color-medium); --color-checked: var(--su-accent); --indicator-color: var(--su-surface); --indicator-box-shadow: 0 2px 8px rgb(38 32 127 / 10%); text-transform: none; }
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
</style>
