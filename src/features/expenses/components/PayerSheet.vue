<script setup lang="ts">
import { ref, watch } from 'vue'
import type { Member } from '../../../data/repositories'
import { toMinorUnits, type CurrencyCode } from '../../../domain/money'
import type { PaymentInput } from '../expenseStore'

const props = defineProps<{ modelValue: readonly PaymentInput[]; members: readonly Member[]; currency: CurrencyCode; totalMinorAmount: number }>()
const emit = defineEmits<{ apply: [value: readonly PaymentInput[]]; cancel: [] }>()
const draft = ref<PaymentInput[]>(props.modelValue.map((item) => ({ ...item })))
const error = ref('')
watch(() => props.modelValue, (value) => { draft.value = value.map((item) => ({ ...item })); error.value = '' }, { deep: true })

function selected(memberId: string): boolean { return draft.value.some(({ participantId }) => participantId === memberId) }
function toggle(memberId: string, event: Event): void {
  const checked = (event.target as HTMLInputElement).checked
  draft.value = checked ? [...draft.value, { participantId: memberId, amountText: '' }] : draft.value.filter(({ participantId }) => participantId !== memberId)
}
function amount(memberId: string): string { return draft.value.find(({ participantId }) => participantId === memberId)?.amountText ?? '' }
function update(memberId: string, event: Event): void {
  draft.value = draft.value.map((item) => item.participantId === memberId ? { ...item, amountText: (event.target as HTMLInputElement).value } : item)
}
function apply(): void {
  try {
    if (!draft.value.length || new Set(draft.value.map(({ participantId }) => participantId)).size !== draft.value.length) throw new Error('Choose at least one payer.')
    const total = draft.value.reduce((sum, item) => sum + BigInt(toMinorUnits(item.amountText, props.currency)), 0n)
    if (total !== BigInt(props.totalMinorAmount)) throw new Error('Payer amounts must equal the expense total.')
    error.value = ''
    emit('apply', clone(draft.value))
  } catch (reason) { error.value = reason instanceof Error ? reason.message : 'Payer amounts are invalid.' }
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
</script>

<template>
  <section class="expense-sheet" aria-labelledby="payer-title">
    <header><button type="button" @click="emit('cancel')">Cancel</button><h2 id="payer-title">Paid by</h2><button type="button" data-action="apply-payers" @click="apply">Apply</button></header>
    <p>Choose one or more people and enter what each paid.</p>
    <div class="sheet-list">
      <label v-for="member in members" :key="member.id">
        <input type="checkbox" :checked="selected(member.id)" :aria-label="`Select ${member.displayName} as payer`" @change="toggle(member.id, $event)">
        <span>{{ member.displayName }}</span>
        <input v-if="selected(member.id)" inputmode="decimal" :value="amount(member.id)" :data-payer-id="member.id" :aria-label="`${member.displayName} paid amount`" @input="update(member.id, $event)">
      </label>
    </div>
    <p v-if="error" role="alert" class="sheet-error">{{ error }}</p>
  </section>
</template>

<style scoped src="./expense-sheet.css"></style>
