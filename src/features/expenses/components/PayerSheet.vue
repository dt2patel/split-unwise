<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import type { Member } from '../../../data/repositories'
import { toMinorUnits, type CurrencyCode } from '../../../domain/money'
import type { PaymentInput } from '../expenseStore'
import { useSheetKeyboardAvoidance } from './useSheetKeyboardAvoidance'

const props = defineProps<{ modelValue: readonly PaymentInput[]; members: readonly Member[]; currency: CurrencyCode; totalMinorAmount: number }>()
const emit = defineEmits<{ apply: [value: readonly PaymentInput[]]; cancel: [] }>()
const draft = ref<PaymentInput[]>(props.modelValue.map((item) => ({ ...item })))
const error = ref('')
const errorKind = ref<'amount' | 'selection'>()
const errorParticipantId = ref<string>()
const sheet = ref<HTMLElement>()
useSheetKeyboardAvoidance(sheet)
watch(() => props.modelValue, (value) => { draft.value = value.map((item) => ({ ...item })); error.value = ''; errorKind.value = undefined; errorParticipantId.value = undefined }, { deep: true })

function selected(memberId: string): boolean { return draft.value.some(({ participantId }) => participantId === memberId) }
function toggle(memberId: string, event: Event): void {
  const checked = (event.target as HTMLInputElement).checked
  draft.value = checked ? [...draft.value, { participantId: memberId, amountText: '' }] : draft.value.filter(({ participantId }) => participantId !== memberId)
  error.value = ''
  errorKind.value = undefined
  errorParticipantId.value = undefined
}
function amount(memberId: string): string { return draft.value.find(({ participantId }) => participantId === memberId)?.amountText ?? '' }
function update(memberId: string, event: Event): void {
  draft.value = draft.value.map((item) => item.participantId === memberId ? { ...item, amountText: (event.target as HTMLInputElement).value } : item)
  error.value = ''
  errorKind.value = undefined
  errorParticipantId.value = undefined
}
function fail(message: string, kind: 'amount' | 'selection', participantId?: string): void {
  error.value = message
  errorKind.value = kind
  errorParticipantId.value = participantId
  void nextTick(() => {
    const candidates = sheet.value?.querySelectorAll<HTMLInputElement>(kind === 'amount' ? '[data-payer-id]' : '[data-payer-select-id]') ?? []
    const target = participantId ? [...candidates].find(({ dataset }) => (dataset.payerId ?? dataset.payerSelectId) === participantId) : candidates[0]
    target?.focus()
  })
}
function apply(): void {
  if (!draft.value.length || new Set(draft.value.map(({ participantId }) => participantId)).size !== draft.value.length) {
    fail('Choose at least one payer.', 'selection')
    return
  }
  let total = 0n
  for (const item of draft.value) {
    try {
      total += BigInt(toMinorUnits(item.amountText, props.currency))
    } catch (reason) {
      fail(reason instanceof Error ? reason.message : 'Payer amounts are invalid.', 'amount', item.participantId)
      return
    }
  }
  if (total !== BigInt(props.totalMinorAmount)) {
    fail('Payer amounts must equal the expense total.', 'amount')
    return
  }
  error.value = ''
  errorKind.value = undefined
  errorParticipantId.value = undefined
  emit('apply', clone(draft.value))
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
</script>

<template>
  <section ref="sheet" class="expense-sheet" data-sheet-scroll aria-labelledby="payer-title">
    <header class="expense-sheet__header"><button type="button" @click="emit('cancel')">Cancel</button><h2 id="payer-title">Paid by</h2><button type="button" data-action="apply-payers" @click="apply">Apply</button></header>
    <p>Choose one or more people and enter what each paid.</p>
    <div class="sheet-list">
      <label v-for="member in members" :key="member.id">
        <input type="checkbox" :checked="selected(member.id)" :data-payer-select-id="member.id" :aria-label="`Select ${member.displayName} as payer`" :aria-invalid="errorKind === 'selection' ? 'true' : undefined" :aria-describedby="errorKind === 'selection' ? 'payer-error' : undefined" @change="toggle(member.id, $event)">
        <span>{{ member.displayName }}</span>
        <input v-if="selected(member.id)" inputmode="decimal" :value="amount(member.id)" :data-payer-id="member.id" :aria-label="`${member.displayName} paid amount`" :aria-invalid="errorKind === 'amount' && (!errorParticipantId || errorParticipantId === member.id) ? 'true' : undefined" :aria-describedby="errorKind === 'amount' && (!errorParticipantId || errorParticipantId === member.id) ? 'payer-error' : undefined" @input="update(member.id, $event)">
      </label>
    </div>
    <p v-if="error" id="payer-error" role="alert" class="sheet-error">{{ error }}</p>
  </section>
</template>

<style scoped src="./expense-sheet.css"></style>
