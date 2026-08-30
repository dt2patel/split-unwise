<script setup lang="ts">
import { computed } from 'vue'
import { formatMoney } from '../../../components/MoneyAmount.vue'
import type { Money } from '../../../domain/model'

const props = defineProps<{ money: Money }>()

const direction = computed(() => props.money.minorAmount > 0 ? 'You are owed' : props.money.minorAmount < 0 ? 'You owe' : 'You are settled up')
const displayMoney = computed(() => ({ ...props.money, minorAmount: Math.abs(props.money.minorAmount) }))
const formatted = computed(() => formatMoney(displayMoney.value))
</script>

<template>
  <p class="balance-summary" :class="{ 'balance-summary--owing': money.minorAmount < 0 }" data-testid="group-balance">
    <span>{{ direction }}</span>
    <strong v-if="money.minorAmount !== 0">{{ formatted }}</strong>
  </p>
</template>

<style scoped>
.balance-summary {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.35rem;
  margin: 0;
  color: var(--ion-color-medium);
  font-size: clamp(0.98rem, 4.2vw, 1.12rem);
  line-height: 1.25;
}

.balance-summary strong { color: var(--su-accent); font-variant-numeric: tabular-nums; font-weight: 620; }
.balance-summary--owing strong { color: var(--su-owing); }
</style>
