<script setup lang="ts">
import { IonButton, IonIcon } from '@ionic/vue'
import { analyticsOutline, cashOutline, peopleOutline, personAddOutline, searchOutline, shareOutline, statsChartOutline, swapHorizontalOutline } from 'ionicons/icons'

const props = defineProps<{ groupId: string }>()

const actions = [
  { id: 'settle-up', label: 'Settle up', icon: cashOutline, suffix: 'settle-up', primary: true },
  { id: 'balances', label: 'Balances', icon: peopleOutline, suffix: 'balances', primary: false },
  { id: 'invite', label: 'Invite', icon: personAddOutline, suffix: 'invite', primary: false },
  { id: 'search', label: 'Search', icon: searchOutline, suffix: 'search', primary: false },
  { id: 'totals', label: 'Totals', icon: analyticsOutline, suffix: 'totals', primary: false },
  { id: 'charts', label: 'Charts', icon: statsChartOutline, suffix: 'charts', primary: false },
  { id: 'convert', label: 'Convert', icon: swapHorizontalOutline, suffix: 'convert', primary: false },
  { id: 'export', label: 'Export', icon: shareOutline, suffix: 'export', primary: false },
] as const

const routeFor = (suffix: string) => `/tabs/groups/${props.groupId}/${suffix}`
</script>

<template>
  <nav class="action-rail" aria-label="Group actions">
    <ion-button
      v-for="action in actions"
      :key="action.id"
      class="action-rail__button"
      :data-action="action.id"
      :fill="action.primary ? 'solid' : 'outline'"
      shape="round"
      size="small"
      :router-link="routeFor(action.suffix)"
    >
      <ion-icon slot="start" :icon="action.icon" aria-hidden="true" />
      {{ action.label }}
    </ion-button>
  </nav>
</template>

<style scoped>
.action-rail { display: flex; gap: 6px; padding: 0 18px 2px; overflow-x: auto; overscroll-behavior-x: contain; scrollbar-width: none; -webkit-overflow-scrolling: touch; }
.action-rail::-webkit-scrollbar { display: none; }
.action-rail__button { flex: 0 0 auto; min-height: 44px; margin: 0; text-transform: none; letter-spacing: 0; font-size: 0.84rem; font-weight: 570; --border-color: color-mix(in srgb, var(--su-accent) 42%, transparent); --border-width: 1px; --border-radius: 22px; --box-shadow: none; --padding-start: 12px; --padding-end: 12px; }
.action-rail__button:first-child { --box-shadow: 0 4px 12px rgb(95 67 219 / 18%); }
</style>
