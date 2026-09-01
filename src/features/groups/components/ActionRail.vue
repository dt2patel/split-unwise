<script setup lang="ts">
import { ref } from 'vue'
import { IonButton, IonIcon } from '@ionic/vue'
import { analyticsOutline, cashOutline, ellipsisHorizontal, peopleOutline, personAddOutline, searchOutline, shareOutline, statsChartOutline, swapHorizontalOutline } from 'ionicons/icons'

const props = defineProps<{ groupId: string }>()

const showingMore = ref(false)

const primaryActions = [
  { id: 'settle-up', label: 'Settle up', icon: cashOutline, suffix: 'settle-up', primary: true },
  { id: 'balances', label: 'Balances', icon: peopleOutline, suffix: 'balances', primary: false },
  { id: 'invite', label: 'Invite', icon: personAddOutline, suffix: 'invite', primary: false },
] as const

const moreActions = [
  { id: 'search', label: 'Search', icon: searchOutline, suffix: 'search', primary: false },
  { id: 'totals', label: 'Totals', icon: analyticsOutline, suffix: 'totals', primary: false },
  { id: 'charts', label: 'Charts', icon: statsChartOutline, suffix: 'charts', primary: false },
  { id: 'convert', label: 'Convert', icon: swapHorizontalOutline, suffix: 'convert', primary: false },
  { id: 'export', label: 'Export', icon: shareOutline, suffix: 'export', primary: false },
] as const

const routeFor = (suffix: string) => `/tabs/groups/${props.groupId}/${suffix}`
</script>

<template>
  <section class="action-rail" aria-label="Group actions">
    <nav class="action-rail__primary" aria-label="Common group actions">
      <ion-button
        v-for="action in primaryActions"
        :key="action.id"
        class="action-rail__button"
        :data-action="action.id"
        :fill="action.primary ? 'solid' : 'outline'"
        shape="round"
        size="small"
        :router-link="routeFor(action.suffix)"
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
        :aria-expanded="showingMore"
        aria-controls="group-more-actions"
        @click="showingMore = !showingMore"
      >
        <span class="action-rail__button-content">
          <ion-icon :icon="ellipsisHorizontal" aria-hidden="true" />
          <span>More</span>
        </span>
      </ion-button>
    </nav>

    <transition name="more-actions">
      <nav v-if="showingMore" id="group-more-actions" class="action-rail__more" aria-label="More group actions">
        <ion-button
          v-for="action in moreActions"
          :key="action.id"
          class="action-rail__more-button"
          :data-action="action.id"
          fill="clear"
          :router-link="routeFor(action.suffix)"
        >
          <span class="action-rail__button-content">
            <ion-icon :icon="action.icon" aria-hidden="true" />
            <span>{{ action.label }}</span>
          </span>
        </ion-button>
      </nav>
    </transition>
  </section>
</template>

<style scoped>
.action-rail { display: grid; gap: 10px; padding: 0 18px 2px; }
.action-rail__primary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 7px; }
.action-rail__button { min-width: 0; min-height: 50px; margin: 0; text-transform: none; letter-spacing: 0; font-size: 0.76rem; font-weight: 620; --border-color: color-mix(in srgb, var(--su-accent) 42%, transparent); --border-width: 1px; --border-radius: 16px; --box-shadow: none; --padding-start: 5px; --padding-end: 5px; }
.action-rail__button-content { display: grid; min-width: 0; justify-items: center; gap: 2px; white-space: nowrap; }
.action-rail__button ion-icon { margin: 0; font-size: 1.12rem; }
.action-rail__button:first-child { --box-shadow: 0 4px 12px rgb(95 67 219 / 18%); }
.action-rail__more { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 5px; padding: 8px; border: 1px solid color-mix(in srgb, var(--su-divider) 44%, transparent); border-radius: 18px; background: color-mix(in srgb, var(--su-surface) 94%, var(--su-lilac)); box-shadow: 0 10px 24px rgb(36 28 83 / 8%); transform-origin: top center; }
.action-rail__more-button { min-height: 48px; margin: 0; --padding-start: 6px; --padding-end: 6px; color: var(--ion-color-primary); font-size: 0.76rem; text-transform: none; }
.action-rail__more-button ion-icon { margin: 0; font-size: 1.08rem; }
.more-actions-enter-active,.more-actions-leave-active { transition: opacity 180ms ease-out, transform 180ms cubic-bezier(.2,.8,.2,1); }
.more-actions-enter-from,.more-actions-leave-to { opacity: 0; transform: translateY(-6px) scale(.985); }
@media (prefers-reduced-motion: reduce) { .more-actions-enter-active,.more-actions-leave-active { transition: none; } }
@media (min-width: 560px) { .action-rail__primary { grid-template-columns: repeat(4, minmax(104px, 1fr)); }.action-rail__more { grid-template-columns: repeat(5, minmax(0, 1fr)); } }
</style>
