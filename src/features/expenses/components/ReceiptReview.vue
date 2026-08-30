<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
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
const errorTarget = ref('')
const sheet = ref<HTMLElement>()
watch(() => props.modelValue, (value) => { items.value = value.map((item) => ({ ...item, participantIds: [...item.participantIds] })); error.value = '' }, { deep: true })
function clearError(): void { error.value = ''; errorTarget.value = '' }
function addItem(): void { items.value = [...items.value, { description: '', amountText: '', participantIds: props.members.map(({ id }) => id) }]; clearError() }
function update(index: number, field: 'amountText' | 'description', value: string): void { items.value = items.value.map((item, itemIndex) => itemIndex === index ? { ...item, [field]: value } : item); clearError() }
function toggle(index: number, memberId: string, checked: boolean): void {
  items.value = items.value.map((item, itemIndex) => itemIndex === index ? { ...item, participantIds: checked ? [...new Set([...item.participantIds, memberId])] : item.participantIds.filter((id) => id !== memberId) } : item)
  clearError()
}
function fail(message: string, target: string, selector: string): void {
  error.value = message
  errorTarget.value = target
  void nextTick(() => sheet.value?.querySelector<HTMLElement>(selector)?.focus())
}
function confirm(): void {
  const confirmedItems: ReceiptItemInput[] = []
  for (const [index, item] of items.value.entries()) {
    const description = item.description.trim()
    if (!description) {
      fail('Every item needs a description.', `description-${index}`, `[data-item-description="${index}"]`)
      return
    }
    try {
      toMinorUnits(item.amountText, props.currency)
    } catch (reason) {
      fail(reason instanceof Error ? reason.message : 'Enter a valid item amount.', `amount-${index}`, `[data-item-amount="${index}"]`)
      return
    }
    if (item.participantIds.length === 0) {
      fail('Every item needs at least one person.', `assignment-${index}`, `[data-item-assignment="${index}"]`)
      return
    }
    confirmedItems.push({ ...item, description, participantIds: [...item.participantIds] })
  }

  const extras: ReceiptItemInput[] = []
  if (taxText.value.trim()) {
    try {
      const tax = toMinorUnits(taxText.value, props.currency)
      if (tax < 0) throw new Error('Tax cannot be negative.')
      if (tax > 0) extras.push({ description: 'Tax', amountText: taxText.value, participantIds: props.members.map(({ id }) => id) })
    } catch (reason) {
      fail(reason instanceof Error ? reason.message : 'Enter a valid tax amount.', 'tax', '[data-testid="receipt-tax"]')
      return
    }
  }
  if (tipText.value.trim()) {
    try {
      const tip = toMinorUnits(tipText.value, props.currency)
      if (tip < 0) throw new Error('Tip cannot be negative.')
      if (tip > 0) extras.push({ description: 'Tip', amountText: tipText.value, participantIds: props.members.map(({ id }) => id) })
    } catch (reason) {
      fail(reason instanceof Error ? reason.message : 'Enter a valid tip amount.', 'tip', '[data-testid="receipt-tip"]')
      return
    }
  }

  const confirmed = [...confirmedItems, ...extras]
  try {
    computeAllocations({ currency: props.currency, minorAmount: props.totalMinorAmount }, {
      type: 'itemized', items: confirmed.map((item) => ({ description: item.description, money: { currency: props.currency, minorAmount: toMinorUnits(item.amountText, props.currency) }, participantIds: item.participantIds })),
    })
    clearError()
    emit('confirm', confirmed)
  } catch (reason) {
    const target = items.value.length ? 'amount-0' : (taxText.value.trim() ? 'tax' : 'tip')
    const selector = items.value.length ? '[data-item-amount="0"]' : (taxText.value.trim() ? '[data-testid="receipt-tax"]' : '[data-testid="receipt-tip"]')
    fail(reason instanceof Error ? reason.message : 'Receipt items could not be confirmed.', target, selector)
  }
}
</script>

<template>
  <section ref="sheet" class="expense-sheet receipt-review" data-sheet-scroll aria-labelledby="receipt-title">
    <header class="expense-sheet__header"><button type="button" @click="emit('cancel')">Cancel</button><h2 id="receipt-title">Receipt review</h2><button type="button" data-action="confirm-receipt" @click="confirm">Confirm</button></header>
    <img v-if="imageUrl" :src="imageUrl" alt="Attached receipt preview" class="receipt-review__image">
    <p v-if="providerMessage" role="status" class="provider-message">{{ providerMessage }}</p>
    <article v-for="(item, index) in items" :key="index" class="receipt-item">
      <label><span>Item</span><input :value="item.description" :data-item-description="index" :aria-invalid="errorTarget === `description-${index}` ? 'true' : undefined" :aria-describedby="errorTarget === `description-${index}` ? 'receipt-error' : undefined" @input="update(index, 'description', ($event.target as HTMLInputElement).value)"></label>
      <label><span>Amount</span><input inputmode="decimal" :value="item.amountText" :data-item-amount="index" :aria-invalid="errorTarget === `amount-${index}` ? 'true' : undefined" :aria-describedby="errorTarget === `amount-${index}` ? 'receipt-error' : undefined" @input="update(index, 'amountText', ($event.target as HTMLInputElement).value)"></label>
      <fieldset :aria-invalid="errorTarget === `assignment-${index}` ? 'true' : undefined" :aria-describedby="errorTarget === `assignment-${index}` ? 'receipt-error' : undefined"><legend>Assign to</legend><label v-for="member in members" :key="member.id"><input type="checkbox" :checked="item.participantIds.includes(member.id)" :data-item-assignment="index" :aria-invalid="errorTarget === `assignment-${index}` ? 'true' : undefined" :aria-describedby="errorTarget === `assignment-${index}` ? 'receipt-error' : undefined" @change="toggle(index, member.id, ($event.target as HTMLInputElement).checked)">{{ member.displayName }}</label></fieldset>
    </article>
    <button type="button" class="add-line" @click="addItem">Add item</button>
    <div class="receipt-extras">
      <label><span>Tax</span><input v-model="taxText" data-testid="receipt-tax" inputmode="decimal" :aria-invalid="errorTarget === 'tax' ? 'true' : undefined" :aria-describedby="errorTarget === 'tax' ? 'receipt-error' : undefined" @input="clearError"></label>
      <label><span>Tip</span><input v-model="tipText" data-testid="receipt-tip" inputmode="decimal" :aria-invalid="errorTarget === 'tip' ? 'true' : undefined" :aria-describedby="errorTarget === 'tip' ? 'receipt-error' : undefined" @input="clearError"></label>
    </div>
    <p class="sheet-note">Items remain suggestions until you explicitly confirm them.</p>
    <p v-if="error" id="receipt-error" role="alert" class="sheet-error">{{ error }}</p>
  </section>
</template>

<style scoped src="./expense-sheet.css"></style>
<style scoped>
.receipt-review__image { display: block; width: 100%; max-height: 190px; margin: 12px 0; border-radius: 14px; object-fit: cover; }
.provider-message { padding: 10px 12px; border-radius: 10px; background: color-mix(in srgb, var(--su-lilac) 52%, var(--su-surface)); color: var(--ion-color-medium); font-size: 0.84rem; }
.receipt-item { display: grid; gap: 8px; padding: 12px 0; border-bottom: 1px solid var(--su-divider); }
.receipt-item > label, .receipt-extras label { display: grid; grid-template-columns: max-content minmax(0, 1fr); align-items: center; gap: 8px; }
.receipt-item input, .receipt-extras input { min-width: 0; min-height: 44px; border: 1px solid var(--su-divider); border-radius: 10px; padding: 0 10px; background: var(--su-surface); color: inherit; font: inherit; }
.receipt-item fieldset { display: flex; flex-wrap: wrap; gap: 8px 14px; border: 0; padding: 0; }
.receipt-item legend { width: 100%; color: var(--ion-color-medium); font-size: 0.78rem; }
.receipt-extras { display: grid; gap: 8px; margin-top: 12px; }
.add-line { min-height: 44px; color: var(--ion-color-primary); }
</style>
