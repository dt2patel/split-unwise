<script setup lang="ts">
import { computed } from 'vue'
import { currencyExponent, fromMinorUnits } from '../domain/money'
import type { Money } from '../domain/model'

type DebtDirection = 'owed' | 'owing' | 'settled'

const props = withDefaults(defineProps<{
  money: Money
  direction?: DebtDirection
  showDirection?: boolean
  label?: string
}>(), {
  direction: 'settled',
  showDirection: true,
})

const directionCopy: Record<DebtDirection, string> = {
  owed: 'You are owed',
  owing: 'You owe',
  settled: 'Settled',
}

const formatted = computed(() => formatMoney({ ...props.money, minorAmount: Math.abs(props.money.minorAmount) }))
const directionText = computed(() => props.label ?? directionCopy[props.direction])
const accessibleLabel = computed(() => `${directionText.value} ${formatted.value}`)

function formatMoney(money: Money): string {
  const exponent = currencyExponent(money.currency)
  const decimal = Number(fromMinorUnits(money.minorAmount, money.currency))
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: money.currency,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  }).format(decimal)
}
</script>

<template>
  <span
    class="money-amount"
    :class="`money-amount--${direction}`"
    :aria-label="accessibleLabel"
    data-money-motion="none"
  >
    <span class="money-amount__value">{{ formatted }}</span>
    <span v-if="showDirection" class="money-amount__direction">{{ directionText }}</span>
  </span>
</template>

<style scoped>
.money-amount {
  display: inline-flex;
  min-width: 0;
  flex-direction: column;
  align-items: flex-end;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
  text-align: end;
}

.money-amount__value { white-space: nowrap; }
.money-amount__direction { color: var(--ion-color-medium); font-size: 0.78em; overflow-wrap: anywhere; }
.money-amount--owed .money-amount__value { color: var(--su-owed); }
.money-amount--owing .money-amount__value { color: var(--su-owing); }
</style>
