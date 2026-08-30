<script setup lang="ts">
import { IonButton, IonIcon } from '@ionic/vue'
import { pricetagOutline } from 'ionicons/icons'
import MoneyAmount from './MoneyAmount.vue'
import SyncStatus from './SyncStatus.vue'
import type { ExpenseRow as ExpenseRowRecord } from '../data/repositories'
import type { Money } from '../domain/model'

defineProps<{
  expense: ExpenseRowRecord
  balance: Money
  balanceDirection: 'owed' | 'owing' | 'settled'
}>()
</script>

<template>
  <article class="expense-row" :data-sync-state="expense.syncState">
    <ion-button fill="clear" class="expense-row__category" :aria-label="expense.category">
      <ion-icon :icon="pricetagOutline" aria-hidden="true" />
    </ion-button>
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
.expense-row { display: grid; grid-template-columns: 44px minmax(0, 1fr) minmax(4.8rem, auto) minmax(5.8rem, auto); align-items: center; column-gap: 0.35rem; min-height: 76px; padding: 0.5rem 0; border-bottom: 1px solid var(--su-divider); }
.expense-row__category { --padding-start: 0; --padding-end: 0; --color: var(--su-indigo); width: 44px; min-width: 44px; height: 44px; margin: 0; }
.expense-row__summary { display: grid; min-width: 0; gap: 0.18rem; overflow-wrap: anywhere; }
.expense-row__summary strong { font-size: 0.95rem; font-weight: 650; }
.expense-row__summary > span { color: var(--ion-color-medium); font-size: 0.8rem; }
.expense-row__amount { min-width: 0; }
.expense-row__amount--aligned { justify-self: end; text-align: end; }
@media (max-width: 359px) { .expense-row { grid-template-columns: 44px minmax(0, 1fr) minmax(4rem, auto); } .expense-row__amount--paid { display: none; } }
</style>
