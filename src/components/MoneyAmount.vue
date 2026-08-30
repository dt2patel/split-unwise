<script lang="ts">
import { currencyExponent } from '../domain/money'
import type { Money as MoneyValue } from '../domain/model'

export type DebtDirection = 'owed' | 'owing' | 'settled'

export function formatMoney(money: MoneyValue, locale?: string): string {
  const exponent = currencyExponent(money.currency)
  const minor = BigInt(money.minorAmount)
  const negative = minor < 0n
  const magnitude = negative ? -minor : minor
  const scale = 10n ** BigInt(exponent)
  const formatter = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: money.currency,
    minimumFractionDigits: exponent,
    maximumFractionDigits: exponent,
  })
  const template = formatter.formatToParts(negative ? -0 : 0)
  const nativeWholeParts = formatter.formatToParts(magnitude / scale).filter(({ type }) => type === 'group' || type === 'integer')
  const fraction = localizeDigits((magnitude % scale).toString().padStart(exponent, '0'), locale)
  let injectedWhole = false

  return template.map((part) => {
    if (part.type === 'integer') {
      if (injectedWhole) return ''
      injectedWhole = true
      return nativeWholeParts.map(({ value }) => value).join('')
    }
    if (part.type === 'group') return ''
    if (part.type === 'fraction') return fraction
    if (part.type === 'decimal') return exponent === 0 ? '' : part.value
    return part.value
  }).join('')
}

function localizeDigits(value: string, locale?: string): string {
  const parts = new Intl.NumberFormat(locale, { useGrouping: false, maximumFractionDigits: 0 }).formatToParts(9876543210)
  const localized = parts.filter(({ type }) => type === 'integer').map(({ value }) => value).join('')
  const glyphs = Array.from(localized)
  const digits = new Map(Array.from('9876543210').map((digit, index) => [digit, glyphs[index] ?? digit]))
  return Array.from(value).map((character) => digits.get(character) ?? character).join('')
}
</script>

<script setup lang="ts">
import { computed } from 'vue'
import type { Money } from '../domain/model'

const props = withDefaults(defineProps<{
  money: Money
  direction?: DebtDirection
  showDirection?: boolean
  label?: string
  locale?: string
}>(), {
  direction: 'settled',
  showDirection: true,
})

const directionCopy: Record<DebtDirection, string> = {
  owed: 'You are owed',
  owing: 'You owe',
  settled: 'Settled',
}

const formatted = computed(() => formatMoney(props.money, props.locale))
const directionText = computed(() => props.label ?? directionCopy[props.direction])
const accessibleLabel = computed(() => `${directionText.value} ${formatted.value}`)

</script>

<template>
  <span
    class="money-amount"
    :class="`money-amount--${direction}`"
    data-money-motion="none"
  >
    <span class="money-amount__value" aria-hidden="true">{{ formatted }}</span>
    <span v-if="showDirection" class="money-amount__direction" aria-hidden="true">{{ directionText }}</span>
    <span class="su-visually-hidden money-amount__context">{{ accessibleLabel }}</span>
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
