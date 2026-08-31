<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import { IonButton, IonContent, IonHeader, IonLabel, IonPage, IonSegment, IonSegmentButton, IonTitle, IonToolbar } from '@ionic/vue'
import { activityDestination, activityText, useActivityStore } from './activityStore'
import NotificationCenter from '../notifications/NotificationCenter.vue'
import type { ActivityFilter } from '../../data/repositories'

const store = useActivityStore()
const { error, filter, isFiltering, isLoading, isLoadingMore, items, nextCursor } = storeToRefs(store)

const filters: readonly { value: ActivityFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'expenses', label: 'Expenses' },
  { value: 'comments', label: 'Comments' },
  { value: 'payments', label: 'Payments' },
]
const status = computed(() => isLoading.value || isFiltering.value ? 'Loading activity…' : error.value)

onMounted(() => { void store.load() })

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
  <ion-page data-testid="activity-page">
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
        <p v-else-if="items.length === 0" class="activity-page__status">No activity matches this filter.</p>
        <ol v-else class="activity-list" aria-label="Account activity">
          <li v-for="item in items" :key="item.id" :data-activity-id="item.id" :data-sync-state="item.syncState">
            <router-link v-if="activityDestination(item, 'activity')" :to="activityDestination(item, 'activity')!" class="activity-list__body">
              <strong>{{ activityText(item) }}</strong>
              <time :datetime="item.createdAt">{{ formatDate(item.createdAt) }}</time>
              <span v-if="item.syncState !== 'fresh'" class="activity-list__state">{{ item.syncState }}</span>
            </router-link>
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
  </ion-page>
</template>

<style scoped>
.activity-page { width: min(100%, 760px); margin: 0 auto; padding: 22px 18px calc(28px + env(safe-area-inset-bottom)); }
.activity-page h1 { margin: 0; font-size: clamp(1.65rem, 4.5vw, 2.15rem); line-height: 1.15; }
.activity-page__intro { margin: 7px 0 18px; color: var(--ion-color-medium); line-height: 1.45; }
.activity-page ion-segment { min-height: 46px; margin-bottom: 16px; border: 1px solid color-mix(in srgb, var(--su-divider) 42%, transparent); border-radius: 13px; }
.activity-page ion-segment-button { min-height: 44px; --border-radius: 11px; --color: var(--ion-color-medium); --color-checked: var(--ion-color-primary); --indicator-color: var(--su-surface); text-transform: none; }
.activity-page__status { min-height: 44px; margin: 16px 0; color: var(--ion-color-medium); line-height: 1.45; }
.activity-list { margin: 0; padding: 0; list-style: none; }
.activity-list li { border-bottom: 1px solid color-mix(in srgb, var(--su-divider) 45%, transparent); }
.activity-list__body { display: grid; min-height: 70px; align-content: center; gap: 5px; padding: 11px 4px; color: inherit; text-decoration: none; overflow-wrap: anywhere; }
a.activity-list__body { border-radius: 10px; }
a.activity-list__body:focus-visible { outline: 3px solid color-mix(in srgb, var(--ion-color-primary) 48%, transparent); outline-offset: -3px; }
.activity-list__body strong { font-size: 0.94rem; font-weight: 650; line-height: 1.35; }
.activity-list__body time,
.activity-list__state { color: var(--ion-color-medium); font-size: 0.76rem; line-height: 1.3; }
.activity-list__state { text-transform: capitalize; }
.activity-list li[data-sync-state="pending"] { animation: activity-enter 160ms ease-out both; }
@keyframes activity-enter { from { opacity: 0; transform: translateY(7px); } to { opacity: 1; transform: translateY(0); } }

@media (prefers-reduced-motion: reduce) {
  .activity-list li[data-sync-state="pending"] { animation: none; }
}
</style>
