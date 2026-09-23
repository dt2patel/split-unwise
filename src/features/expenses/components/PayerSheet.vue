<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { IonButton, IonButtons, IonCheckbox, IonContent, IonHeader, IonInput, IonItem, IonList, IonTitle, IonToolbar } from '@ionic/vue'
import type { Member } from '../../../data/repositories'
import { toMinorUnits, type CurrencyCode } from '../../../domain/money'
import type { PaymentInput } from '../expenseStore'
import { focusSheetControl, vFieldAria, type FieldAria } from './sheetControls'
import { useSheetKeyboardAvoidance } from './useSheetKeyboardAvoidance'

const props = defineProps<{ modelValue: readonly PaymentInput[]; members: readonly Member[]; currency: CurrencyCode; totalMinorAmount: number; reimbursement?: boolean }>()
const emit = defineEmits<{ apply: [value: readonly PaymentInput[]]; cancel: []; dirty: [] }>()
const draft = ref<PaymentInput[]>(props.modelValue.map((item) => ({ ...item })))
const error = ref('')
const errorKind = ref<'amount' | 'selection'>()
const errorParticipantId = ref<string>()
const sheet = ref<HTMLElement>()
useSheetKeyboardAvoidance(sheet)
watch(() => props.modelValue, (value) => { draft.value = value.map((item) => ({ ...item })); error.value = ''; errorKind.value = undefined; errorParticipantId.value = undefined }, { deep: true })

function selected(memberId: string): boolean { return draft.value.some(({ participantId }) => participantId === memberId) }
function toggle(memberId: string, checked: boolean): void {
  draft.value = checked ? [...draft.value, { participantId: memberId, amountText: '' }] : draft.value.filter(({ participantId }) => participantId !== memberId)
  error.value = ''
  errorKind.value = undefined
  errorParticipantId.value = undefined
  emit('dirty')
}
function amount(memberId: string): string { return draft.value.find(({ participantId }) => participantId === memberId)?.amountText ?? '' }
function amountAria(memberId: string): FieldAria {
  return errorKind.value === 'amount' && (!errorParticipantId.value || errorParticipantId.value === memberId)
    ? { 'aria-invalid': 'true', 'aria-describedby': 'payer-error' }
    : {}
}
function update(memberId: string, value: string | null | undefined): void {
  draft.value = draft.value.map((item) => item.participantId === memberId ? { ...item, amountText: value ?? '' } : item)
  error.value = ''
  errorKind.value = undefined
  errorParticipantId.value = undefined
  emit('dirty')
}
function fail(message: string, kind: 'amount' | 'selection', participantId?: string): void {
  error.value = message
  errorKind.value = kind
  errorParticipantId.value = participantId
  void nextTick(() => {
    const candidates = sheet.value?.querySelectorAll<HTMLElement>(kind === 'amount' ? '[data-payer-id]' : '[data-payer-select-id]') ?? []
    const target = participantId ? [...candidates].find(({ dataset }) => (dataset.payerId ?? dataset.payerSelectId) === participantId) : candidates[0]
    focusSheetControl(target)
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
  <ion-header>
    <ion-toolbar>
      <ion-buttons slot="start"><ion-button @click="emit('cancel')">Cancel</ion-button></ion-buttons>
      <ion-title id="payer-title" role="heading" aria-level="2">{{ reimbursement ? 'Refund received by' : 'Paid by' }}</ion-title>
      <ion-buttons slot="end"><ion-button :strong="true" data-action="apply-payers" @click="apply">Done</ion-button></ion-buttons>
    </ion-toolbar>
  </ion-header>
  <ion-content>
    <section ref="sheet" class="expense-sheet expense-sheet--ionic-content" data-sheet-scroll aria-labelledby="payer-title">
      <p>{{ reimbursement ? 'Choose one or more people and enter what each received.' : 'Choose one or more people and enter what each paid.' }}</p>
      <ion-list inset lines="full" class="sheet-list">
        <ion-item v-for="member in members" :key="member.id">
          <ion-checkbox
            :checked="selected(member.id)"
            :data-payer-select-id="member.id"
            justify="start"
            label-placement="end"
            :aria-label="`Select ${member.displayName} as payer`"
            :aria-invalid="errorKind === 'selection' ? 'true' : undefined"
            :aria-describedby="errorKind === 'selection' ? 'payer-error' : undefined"
            @ion-change="toggle(member.id, $event.detail.checked)"
          ><span>{{ member.displayName }}</span></ion-checkbox>
          <ion-input
            v-if="selected(member.id)"
            v-field-aria="amountAria(member.id)"
            slot="end"
            class="sheet-amount"
            inputmode="decimal"
            :value="amount(member.id)"
            :data-payer-id="member.id"
            :aria-label="`${member.displayName} ${reimbursement ? 'received' : 'paid'} amount`"
            @ion-input="update(member.id, $event.detail.value)"
          />
        </ion-item>
      </ion-list>
      <p v-if="error" id="payer-error" role="alert" class="sheet-error">{{ error }}</p>
    </section>
  </ion-content>
</template>

<style scoped src="./expense-sheet.css"></style>
<style scoped>
ion-list.sheet-list { margin: 0; border-radius: 14px; }
.sheet-list ion-item { --background: var(--su-surface); --border-color: color-mix(in srgb, var(--su-divider) 62%, transparent); --min-height: 54px; --padding-start: 12px; --inner-padding-end: 12px; }
.sheet-list ion-checkbox::part(label) { min-width: 0; overflow: visible; text-overflow: clip; white-space: normal; overflow-wrap: anywhere; }
.sheet-amount { width: 34%; min-width: 88px; margin-inline-start: 8px; font-size: max(16px, 1rem); text-align: end; }
</style>
