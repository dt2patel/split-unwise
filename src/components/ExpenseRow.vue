<script setup lang="ts">
import { IonIcon } from '@ionic/vue'
import { boatOutline, cartOutline, carOutline, homeOutline, pricetagOutline, restaurantOutline } from 'ionicons/icons'
import { computed, watch } from 'vue'
import { RouterLink } from 'vue-router'
import MoneyAmount from './MoneyAmount.vue'
import SyncStatus from './SyncStatus.vue'
import { useExpenseRowLayout } from '../composables/useExpenseRowLayout'
import type { ExpenseRow as ExpenseRowRecord } from '../data/repositories'
import type { Money } from '../domain/model'

const props = withDefaults(defineProps<{
  expense: ExpenseRowRecord
  balance: Money
  balanceDirection: 'owed' | 'owing' | 'settled'
  balanceLabel?: string
  journal?: boolean
  payerName?: string
  participantCount?: number
  retryable?: boolean
  conflictRemote?: ExpenseRowRecord
  conflictIntent?: 'delete' | 'edit'
  detailTo?: string
}>(), {
  balanceLabel: undefined,
  journal: false,
  payerName: undefined,
  participantCount: undefined,
  retryable: false,
  conflictRemote: undefined,
  conflictIntent: undefined,
  detailTo: undefined,
})
const emit = defineEmits<{ retry: []; discard: []; reloadRemote: []; retainLocal: []; deleteRemote: [] }>()

const dateParts = computed(() => {
  const date = new Date(`${props.expense.date}T00:00:00.000Z`)
  return {
    month: new Intl.DateTimeFormat(undefined, { month: 'short', timeZone: 'UTC' }).format(date).toUpperCase(),
    day: new Intl.DateTimeFormat(undefined, { day: 'numeric', timeZone: 'UTC' }).format(date),
  }
})
const categoryIcon = computed(() => {
  const description = props.expense.description.toLocaleLowerCase()
  if (description.includes('grocer')) return cartOutline
  if (description.includes('dinner')) return restaurantOutline
  if (description.includes('cabin')) return homeOutline
  if (description.includes('kayak')) return boatOutline
  if (description.includes('gas')) return carOutline
  return pricetagOutline
})
const categoryTone = computed(() => props.expense.category.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-'))

const { row, isReflow, invalidateContent } = useExpenseRowLayout()

watch(
  () => [
    props.expense.description,
    props.expense.date,
    props.expense.category,
    props.expense.syncState,
    props.expense.total.currency,
    props.expense.total.minorAmount,
    props.balance.currency,
    props.balance.minorAmount,
    props.balanceDirection,
    props.balanceLabel,
    props.journal,
    props.payerName,
    props.participantCount,
    props.conflictRemote?.description,
    props.conflictRemote?.revision,
    props.conflictRemote?.total.currency,
    props.conflictRemote?.total.minorAmount,
    props.conflictIntent,
    props.detailTo,
  ],
  invalidateContent,
)
</script>

<template>
  <article ref="row" class="expense-row" :class="{ 'expense-row--reflow': isReflow, 'expense-row--journal': journal }" :data-sync-state="expense.syncState">
    <component :is="detailTo ? RouterLink : 'div'" class="expense-row__body" v-bind="detailTo ? { to: detailTo } : {}">
      <time v-if="journal" class="expense-row__date" :datetime="expense.date">
        <span>{{ dateParts.month }}</span>
        <strong>{{ dateParts.day }}</strong>
      </time>
      <span class="expense-row__category" :class="`expense-row__category--${categoryTone}`">
        <ion-icon :icon="categoryIcon" aria-hidden="true" />
        <span class="su-visually-hidden">Category: {{ expense.category }}</span>
      </span>
      <div class="expense-row__summary">
        <template v-if="journal && expense.syncState === 'conflicted' && conflictRemote">
          <div class="expense-row__conflict-versions" role="group" aria-label="Expense conflict versions">
            <section data-testid="local-conflict-version">
              <span>{{ conflictIntent === 'delete' ? 'Delete requested' : 'Your draft' }}</span>
              <strong>{{ expense.description }}</strong>
              <money-amount :money="expense.total" :label="conflictIntent === 'delete' ? 'Delete request total' : 'Local draft total'" :show-direction="false" />
            </section>
            <section data-testid="remote-conflict-version">
              <span>Remote version · revision {{ conflictRemote.revision }}</span>
              <strong>{{ conflictRemote.description }}</strong>
              <money-amount :money="conflictRemote.total" label="Remote version total" :show-direction="false" />
            </section>
          </div>
          <sync-status state="conflicted" />
        </template>
        <template v-else>
          <strong>{{ expense.description }}</strong>
        </template>
        <template v-if="journal && !(expense.syncState === 'conflicted' && conflictRemote)">
          <span>Paid by {{ payerName }}</span>
          <span>Split between {{ participantCount }} of you<span v-if="expense.recurringTemplateId"> · Recurring</span></span>
          <sync-status v-if="expense.syncState !== 'fresh'" :state="expense.syncState" />
        </template>
        <template v-else-if="!journal">
          <span>{{ expense.date }}</span>
          <sync-status :state="expense.syncState" />
        </template>
      </div>
      <money-amount class="expense-row__amount expense-row__amount--paid expense-row__amount--aligned" :money="expense.total" label="Expense total" :show-direction="false" />
      <money-amount class="expense-row__amount expense-row__amount--balance expense-row__amount--aligned" :money="balance" :direction="balanceDirection" :label="balanceLabel" />
    </component>
    <span v-if="journal && expense.syncState === 'conflicted' && conflictRemote" class="expense-row__sync-actions expense-row__sync-actions--conflict">
      <button type="button" data-action="reload-remote" @click="emit('reloadRemote')">Reload remote</button>
      <button v-if="conflictIntent === 'delete'" type="button" data-action="delete-remote" @click="emit('deleteRemote')">Delete latest version</button>
      <button v-else type="button" data-action="retain-save-local" @click="emit('retainLocal')">Retain and save local</button>
    </span>
    <span v-else-if="journal && expense.syncState === 'failed'" class="expense-row__sync-actions">
      <button v-if="retryable" type="button" data-action="retry-expense" @click="emit('retry')">Retry</button>
      <button type="button" data-action="discard-expense" @click="emit('discard')">Discard</button>
    </span>
  </article>
</template>

<style scoped>
.expense-row { --su-financial-track: 62px; min-height: 76px; border-bottom: 1px solid var(--su-divider); }
.expense-row__body { display: grid; grid-template-columns: 44px minmax(0, 1fr) var(--su-financial-track) var(--su-financial-track); align-items: center; column-gap: 0.35rem; min-height: 76px; padding: 0.5rem 0; color: inherit; text-decoration: none; }
.expense-row__body:focus-visible { border-radius: 10px; outline: 3px solid color-mix(in srgb, var(--ion-color-primary) 48%, transparent); outline-offset: -3px; }
.expense-row__category { display: grid; width: 44px; min-width: 44px; height: 44px; place-items: center; border-radius: 50%; background: var(--su-avatar-bg); color: var(--su-category-fg); font-size: 1.25rem; }
.expense-row__summary { display: grid; min-width: 0; gap: 0.18rem; overflow-wrap: anywhere; }
.expense-row__summary strong { font-size: 0.95rem; font-weight: 650; }
.expense-row__summary > span { color: var(--ion-color-medium); font-size: 0.8rem; }
.expense-row__amount { min-width: 0; }
.expense-row__amount--aligned { justify-self: end; text-align: end; }
.expense-row--journal { min-height: 83px; border-color: color-mix(in srgb, var(--su-divider) 42%, transparent); }
.expense-row--journal .expense-row__body { grid-template-columns: 30px 44px minmax(0, 1fr) var(--su-financial-track) var(--su-financial-track); column-gap: 8px; min-height: 83px; padding: 7px 0; }
.expense-row__date { display: grid; align-self: center; color: var(--ion-color-medium); line-height: 1; text-align: center; }
.expense-row__date span { font-size: 0.72rem; font-weight: 560; }
.expense-row__date strong { margin-top: 5px; font-size: 1.22rem; font-weight: 450; }
.expense-row--journal .expense-row__summary { gap: 2px; }
.expense-row--journal .expense-row__summary strong { font-size: 0.91rem; line-height: 1.15; }
.expense-row--journal .expense-row__summary > span { font-size: 0.72rem; line-height: 1.28; }
.expense-row--journal .expense-row__summary :deep(.sync-status) { justify-self: start; font-size: 0.72rem; }
.expense-row__sync-actions { display: flex; flex-wrap: wrap; gap: 4px; margin: -4px 0 7px 82px; }
.expense-row__sync-actions button { min-width: 44px; min-height: 44px; margin: -5px 0; padding: 0 5px; border: 0; background: transparent; color: var(--ion-color-primary); font: inherit; font-weight: 650; }
.expense-row__conflict-versions { display: grid; gap: 6px; }
.expense-row__conflict-versions section { display: grid; gap: 2px; padding: 6px 8px; border: 1px solid color-mix(in srgb, var(--su-divider) 72%, transparent); border-radius: 9px; background: color-mix(in srgb, var(--su-surface) 92%, var(--su-lilac)); }
.expense-row__conflict-versions section > span { color: var(--ion-color-medium); font-size: 0.72rem; font-weight: 650; }
.expense-row__conflict-versions :deep(.money-amount) { justify-self: start; font-size: 0.72rem; }
.expense-row__sync-actions--conflict { flex-wrap: wrap; }
.expense-row--journal .expense-row__amount { font-size: 0.78rem; }
.expense-row--journal .expense-row__amount--balance :deep(.money-amount__direction) { order: -1; color: var(--ion-color-primary); font-size: 0.72rem; line-height: 1.1; }
.expense-row--journal .expense-row__category--transport { background: #E6F5FF; }
.expense-row--journal .expense-row__category--lodging { background: #EEE8FF; }
.expense-row--reflow .expense-row__body { grid-template-areas: "category summary" "category paid" "category balance"; grid-template-columns: 44px minmax(0, 1fr); row-gap: 0.3rem; }
.expense-row--reflow .expense-row__category { grid-area: category; }
.expense-row--reflow .expense-row__summary { grid-area: summary; }
.expense-row--reflow .expense-row__amount--paid { grid-area: paid; }
.expense-row--reflow .expense-row__amount--balance { grid-area: balance; }
.expense-row--journal.expense-row--reflow .expense-row__body { grid-template-areas: "date category summary" "date category paid" "date category balance"; grid-template-columns: 30px 44px minmax(0, 1fr); }
.expense-row--journal.expense-row--reflow .expense-row__date { grid-area: date; }
.expense-row[data-sync-state="pending"] { animation: pending-row-enter 200ms ease-out both; }
@keyframes pending-row-enter { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

@media (prefers-color-scheme: dark) {
  .expense-row--journal .expense-row__category--transport { background: #1E3950; }
  .expense-row--journal .expense-row__category--lodging { background: #342B5A; }
}
@media (prefers-reduced-motion: reduce) {
  .expense-row[data-sync-state="pending"] { animation: none; }
}
@media (max-width: 520px) {
  .expense-row--journal .expense-row__body,
  .expense-row--journal.expense-row--reflow .expense-row__body {
    grid-template-areas:
      "date category summary balance"
      "date category summary paid";
    grid-template-columns: 28px 40px minmax(0, 1fr) 72px;
    column-gap: 7px;
    row-gap: 4px;
    min-height: 88px;
    padding: 8px 0;
  }
  .expense-row--journal .expense-row__date { grid-area: date; }
  .expense-row--journal .expense-row__category { grid-area: category; width: 40px; min-width: 40px; height: 40px; }
  .expense-row--journal .expense-row__summary { grid-area: summary; align-self: center; }
  .expense-row--journal .expense-row__amount--paid { grid-area: paid; align-self: start; color: var(--ion-color-medium); font-size: 0.72rem; }
  .expense-row--journal .expense-row__amount--balance { grid-area: balance; align-self: end; font-size: 0.82rem; font-weight: 650; }
  .expense-row--journal .expense-row__summary strong { font-size: 0.92rem; line-height: 1.18; }
  .expense-row--journal .expense-row__summary > span:last-of-type { display: none; }
  .expense-row__sync-actions { margin-left: 75px; }
}
</style>
