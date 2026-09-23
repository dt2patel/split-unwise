<script setup lang="ts">
import { computed, ref } from 'vue'
import { IonButton, IonIcon, IonPopover } from '@ionic/vue'
import { analyticsOutline, cashOutline, ellipsisHorizontal, peopleOutline, personAddOutline, repeatOutline, searchOutline, shareOutline, statsChartOutline, swapHorizontalOutline } from 'ionicons/icons'

import type { ExpenseContextKind } from '../../../data'

const props = withDefaults(defineProps<{ groupId: string; contextKind?: ExpenseContextKind; canInvite?: boolean; settleDisabled?: boolean }>(), { contextKind: 'group', canInvite: true, settleDisabled: false })

const showingMore = ref(false)
// Ionic anchors the popover to the tapped button through the click event.
const moreEvent = ref<Event>()
function openMore(event: Event): void { moreEvent.value = event; showingMore.value = true }
function closeMore(): void { showingMore.value = false }

const primaryActions = computed(() => [
  { id: 'settle-up', label: 'Settle up', icon: cashOutline, suffix: 'settle-up', primary: true },
  { id: 'balances', label: 'Balances', icon: peopleOutline, suffix: 'balances', primary: false },
  ...(props.canInvite ? [{ id: 'invite' as const, label: 'Invite', icon: personAddOutline, suffix: 'invite', primary: false }] : []),
])

const moreActions = [
  { id: 'search', label: 'Search', icon: searchOutline, suffix: 'search', primary: false },
  { id: 'totals', label: 'Totals', icon: analyticsOutline, suffix: 'totals', primary: false },
  { id: 'charts', label: 'Charts', icon: statsChartOutline, suffix: 'charts', primary: false },
  { id: 'recurring', label: 'Recurring', icon: repeatOutline, suffix: 'recurring', primary: false },
  { id: 'convert', label: 'Convert', icon: swapHorizontalOutline, suffix: 'convert', primary: false },
  { id: 'export', label: 'Export', icon: shareOutline, suffix: 'export', primary: false },
] as const

const routeFor = (suffix: string) => `/tabs/groups/${props.groupId}/${suffix}`
</script>

<template>
  <section class="action-rail" :aria-label="contextKind === 'friendship' ? 'Friend actions' : 'Group actions'">
    <nav class="action-rail__primary" :class="{ 'action-rail__primary--three': !canInvite }" :aria-label="contextKind === 'friendship' ? 'Common friend actions' : 'Common group actions'">
      <ion-button
        v-for="action in primaryActions"
        :key="action.id"
        class="action-rail__button"
        :data-action="action.id"
        :fill="action.primary ? 'solid' : 'outline'"
        shape="round"
        size="small"
        :router-link="action.id === 'settle-up' && settleDisabled ? undefined : routeFor(action.suffix)"
        :disabled="action.id === 'settle-up' && settleDisabled"
      >
        <span class="action-rail__button-content">
          <ion-icon :icon="action.icon" aria-hidden="true" />
          <span>{{ action.label }}</span>
        </span>
      </ion-button>
      <ion-button
        class="action-rail__button"
        data-action="more"
        fill="outline"
        shape="round"
        size="small"
        aria-haspopup="true"
        :aria-expanded="showingMore"
        @click="openMore"
      >
        <span class="action-rail__button-content">
          <ion-icon :icon="ellipsisHorizontal" aria-hidden="true" />
          <span>More</span>
        </span>
      </ion-button>
    </nav>

    <!-- An anchored iOS popover instead of an inline panel: nothing on the page moves when More opens or closes. -->
    <ion-popover class="action-rail__popover" :is-open="showingMore" :event="moreEvent" side="bottom" @did-dismiss="closeMore">
      <nav class="action-rail__more" :aria-label="contextKind === 'friendship' ? 'More friend actions' : 'More group actions'">
        <ion-button
          v-for="action in moreActions"
          :key="action.id"
          class="action-rail__more-button"
          :data-action="action.id"
          fill="clear"
          :router-link="routeFor(action.suffix)"
          @click="closeMore"
        >
          <span class="action-rail__button-content">
            <ion-icon :icon="action.icon" aria-hidden="true" />
            <span>{{ action.label }}</span>
          </span>
        </ion-button>
      </nav>
    </ion-popover>
  </section>
</template>

<style scoped>
.action-rail { display: grid; gap: 10px; padding: 0 18px 2px; }
.action-rail__primary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 7px; }
.action-rail__primary--three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.action-rail__button { min-width: 0; min-height: 50px; margin: 0; text-transform: none; letter-spacing: 0; font-size: 0.76rem; font-weight: 620; --border-color: color-mix(in srgb, var(--su-accent) 42%, transparent); --border-width: 1px; --border-radius: 16px; --box-shadow: none; --padding-start: 5px; --padding-end: 5px; }
.action-rail__button-content { display: grid; min-width: 0; justify-items: center; gap: 2px; white-space: nowrap; }
.action-rail__button ion-icon { margin: 0; font-size: 1.12rem; }
.action-rail__button:first-child { --box-shadow: 0 4px 12px rgb(95 67 219 / 18%); }
/* A lifted surface so the popover (and iOS's arrow, which shares --background) reads as a layer above the journal in both themes. */
.action-rail__popover { --width: min(300px, calc(100vw - 32px)); --background: color-mix(in srgb, var(--su-lilac) 72%, var(--su-surface)); --box-shadow: 0 14px 36px rgb(0 0 0 / 22%); }
.action-rail__more { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 5px; padding: 8px; }
.action-rail__more-button { min-height: 48px; margin: 0; --padding-start: 6px; --padding-end: 6px; color: var(--ion-color-primary); font-size: 0.76rem; text-transform: none; }
.action-rail__more-button ion-icon { margin: 0; font-size: 1.08rem; }
@media (min-width: 560px) { .action-rail__primary { grid-template-columns: repeat(4, minmax(104px, 1fr)); } }
</style>
