<script setup lang="ts">
import { ref, watch } from 'vue'
import type { Member } from '../../../data/repositories'
import { toMinorUnits, type CurrencyCode } from '../../../domain/money'
import { computeAllocations } from '../../../domain/splits'
import type { ReceiptItemInput } from '../expenseStore'

const props = defineProps<{
  modelValue: readonly ReceiptItemInput[]
  members: readonly Member[]
  currency: CurrencyCode
  totalMinorAmount: number
  providerMessage?: string
  imageUrl?: string
}>()
const emit = defineEmits<{ confirm: [value: readonly ReceiptItemInput[]]; cancel: [] }>()
const items = ref<ReceiptItemInput[]>(props.modelValue.map((item) => ({ ...item, participantIds: [...item.participantIds] })))
const taxText = ref('')
const tipText = ref('')
const error = ref('')
watch(() => props.modelValue, (value) => { items.value = value.map((item) => ({ ...item, participantIds: [...item.participantIds] })); error.value = '' }, { deep: true })
function addItem(): void { items.value = [...items.value, { description: '', amountText: '', participantIds: props.members.map(({ id }) => id) }] }
function update(index: number, field: 'amountText' | 'description', value: string): void { items.value = items.value.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: value } : item) }
function toggle(index: number, memberId: string, checked: boolean): void {
  items.value = items.value.map((item, itemIndex) => itemIndex === index ? { ...item, participantIds: checked ? [...new Set([...item.participantIds, memberId])] : item.participantIds.filter((id) => id !== memberId) } : item)
}
function confirm(): void {
  try {
    const extras: ReceiptItemInput[] = []
    if (taxText.value.trim() && toMinorUnits(taxText.value, props.currency) > 0) extras.push({ description: 'Tax', amountText: taxText.value, participantIds: props.members.map(({ id }) => id) })
    if (tipText.value.trim() && toMinorUnits(tipText.value, props.currency) > 0) extras.push({ description: 'Tip', amountText: tipText.value, participantIds: props.members.map(({ id }) => id) })
    const confirmed = [...items.value, ...extras].map((item) => ({ ...item, description: item.description.trim(), participantIds: [...item.participantIds] }))
    if (confirmed.some((item) => !item.description || item.participantIds.length === 0)) throw new Error('Every item needs a description and at least one person.')
    computeAllocations({ currency: props.currency, minorAmount: props.totalMinorAmount }, {
      type: 'itemized', items: confirmed.map((item) => ({ description: item.description, money: { currency: props.currency, minorAmount: toMinorUnits(item.amountText, props.currency) }, participantIds: item.participantIds })),
    })
    error.value = ''
    emit('confirm', confirmed)
  } catch (reason) { error.value = reason instanceof Error ? reason.message : 'Receipt items could not be confirmed.' }
}
</script>

<template>
  <section class="expense-sheet receipt-review" aria-labelledby="receipt-title">
    <header><button type="button" @click="emit('cancel')">Cancel</button><h2 id="receipt-title">Receipt review</h2><button type="button" data-action="confirm-receipt" @click="confirm">Confirm</button></header>
    <img v-if="imageUrl" :src="imageUrl" alt="Attached receipt preview" class="receipt-review__image">
    <p v-if="providerMessage" role="status" class="provider-message">{{ providerMessage }}</p>
    <article v-for="(item, index) in items" :key="index" class="receipt-item">
      <label><span>Item</span><input :value="item.description" :data-item-description="index" @input="update(index, 'description', ($event.target as HTMLInputElement).value)"></label>
      <label><span>Amount</span><input inputmode="decimal" :value="item.amountText" :data-item-amount="index" @input="update(index, 'amountText', ($event.target as HTMLInputElement).value)"></label>
      <fieldset><legend>Assign to</legend><label v-for="member in members" :key="member.id"><input type="checkbox" :checked="item.participantIds.includes(member.id)" @change="toggle(index, member.id, ($event.target as HTMLInputElement).checked)">{{ member.displayName }}</label></fieldset>
    </article>
    <button type="button" class="add-line" @click="addItem">Add item</button>
    <div class="receipt-extras">
      <label><span>Tax</span><input v-model="taxText" data-testid="receipt-tax" inputmode="decimal"></label>
      <label><span>Tip</span><input v-model="tipText" data-testid="receipt-tip" inputmode="decimal"></label>
    </div>
    <p class="sheet-note">Items remain suggestions until you explicitly confirm them.</p>
    <p v-if="error" role="alert" class="sheet-error">{{ error }}</p>
  </section>
</template>

<style scoped src="./expense-sheet.css"></style>
<style scoped>
.receipt-review__image { display: block; width: 100%; max-height: 190px; margin: 12px 0; border-radius: 14px; object-fit: cover; }
.provider-message { padding: 10px 12px; border-radius: 10px; background: color-mix(in srgb, var(--su-lilac) 52%, var(--su-surface)); color: var(--ion-color-medium); font-size: 0.84rem; }
.receipt-item { display: grid; gap: 8px; padding: 12px 0; border-bottom: 1px solid var(--su-divider); }
.receipt-item > label, .receipt-extras label { display: grid; grid-template-columns: 72px 1fr; align-items: center; gap: 8px; }
.receipt-item input, .receipt-extras input { min-height: 44px; border: 1px solid var(--su-divider); border-radius: 10px; padding: 0 10px; background: var(--su-surface); color: inherit; font: inherit; }
.receipt-item fieldset { display: flex; flex-wrap: wrap; gap: 8px 14px; border: 0; padding: 0; }
.receipt-item legend { width: 100%; color: var(--ion-color-medium); font-size: 0.78rem; }
.receipt-extras { display: grid; gap: 8px; margin-top: 12px; }
.add-line { min-height: 44px; color: var(--su-accent); }
</style>
