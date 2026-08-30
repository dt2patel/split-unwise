<script setup lang="ts">
import { IonIcon } from '@ionic/vue'
import { pricetagOutline } from 'ionicons/icons'
import MoneyAmount from './MoneyAmount.vue'
import SyncStatus from './SyncStatus.vue'
import { useExpenseRowLayout } from '../composables/useExpenseRowLayout'
import type { ExpenseRow as ExpenseRowRecord } from '../data/repositories'
import type { Money } from '../domain/model'

defineProps<{
  expense: ExpenseRowRecord
  balance: Money
  balanceDirection: 'owed' | 'owing' | 'settled'
}>()

const { row, isReflow } = useExpenseRowLayout()
</script>

<template>
  <article ref="row" class="expense-row" :class="{ 'expense-row--reflow': isReflow }" :data-sync-state="expense.syncState">
    <span class="expense-row__category">
      <ion-icon :icon="pricetagOutline" aria-hidden="true" />
      <span class="su-visually-hidden">Category: {{ expense.category }}</span>
    </span>
    <div class="expense-row__summary">
      <strong>{{ expense.description }}</strong>
      <span>{{ expense.date }}</span>
      <sync-status :state="expense.syncState" />
    </div>
    <money-amount class="expense-row__amount expense-row__amount--paid expense-row__amount--aligned" :money="expense.total" label="Paid" :show-direction="false" />
    <money-amount class="expense-row__amount expense-row__amount--balance expense-row__amount--aligned" :money="balance" :direction="balanceDirection" />
  </article>
</template>

<style scoped>
.expense-row { --su-financial-track: 62px; display: grid; grid-template-columns: 44px minmax(0, 1fr) var(--su-financial-track) var(--su-financial-track); align-items: center; column-gap: 0.35rem; min-height: 76px; padding: 0.5rem 0; border-bottom: 1px solid var(--su-divider); }
.expense-row__category { display: grid; width: 44px; min-width: 44px; height: 44px; place-items: center; color: var(--su-category-fg); }
.expense-row__summary { display: grid; min-width: 0; gap: 0.18rem; overflow-wrap: anywhere; }
.expense-row__summary strong { font-size: 0.95rem; font-weight: 650; }
.expense-row__summary > span { color: var(--ion-color-medium); font-size: 0.8rem; }
.expense-row__amount { min-width: 0; }
.expense-row__amount--aligned { justify-self: end; text-align: end; }
.expense-row--reflow { grid-template-areas: "category summary" "category paid" "category balance"; grid-template-columns: 44px minmax(0, 1fr); row-gap: 0.3rem; }
.expense-row--reflow .expense-row__category { grid-area: category; }
.expense-row--reflow .expense-row__summary { grid-area: summary; }
.expense-row--reflow .expense-row__amount--paid { grid-area: paid; }
.expense-row--reflow .expense-row__amount--balance { grid-area: balance; }
</style>
