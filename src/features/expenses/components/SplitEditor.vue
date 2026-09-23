<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { IonButton, IonButtons, IonContent, IonHeader, IonInput, IonItem, IonList, IonRadio, IonRadioGroup, IonTitle, IonToolbar } from '@ionic/vue'
import type { Member } from '../../../data/repositories'
import { toMinorUnits, type CurrencyCode } from '../../../domain/money'
import { computeSplitPreview, type SplitInput } from '../expenseStore'
import { focusSheetControl, vFieldAria, type FieldAria } from './sheetControls'
import { useSheetKeyboardAvoidance } from './useSheetKeyboardAvoidance'

const props = defineProps<{
  modelValue: SplitInput
  participants: readonly Member[]
  currency: CurrencyCode
  totalMinorAmount: number
}>()
const emit = defineEmits<{
  apply: [value: { readonly input: SplitInput; readonly allocations: ReturnType<typeof computeSplitPreview> }]
  cancel: []
  dirty: []
}>()

// Seven methods cannot share one row on a phone, so they stay a vertical radio list rather than a scrolling segment.
const methods = [
  ['equal', 'Equal'],
  ['exact', 'Exact'],
  ['percentage', 'Percent'],
  ['shares', 'Shares'],
  ['adjustment', 'Adjust'],
  ['itemized', 'Items'],
  ['reimbursement', 'Reimburse'],
] as const
const draft = ref<SplitInput>(clone(props.modelValue))
const error = ref('')
const errorParticipantId = ref<string>()
const sheet = ref<HTMLElement>()
useSheetKeyboardAvoidance(sheet)
const memberById = computed(() => new Map(props.participants.map((member) => [member.id, member])))

watch(() => props.modelValue, (value) => { draft.value = clone(value); error.value = ''; errorParticipantId.value = undefined }, { deep: true })

function choose(type: SplitInput['type']): void {
  if (type === draft.value.type) return
  const ids = props.participants.map(({ id }) => id)
  if (type === 'equal') draft.value = { type }
  else if (type === 'itemized') draft.value = { type, items: [] }
  else if (type === 'shares') draft.value = { type, values: Object.fromEntries(ids.map((id) => [id, '1'])) }
  else if (type === 'percentage') {
    draft.value = { type, values: defaultPercentages(ids) }
  } else draft.value = { type, values: Object.fromEntries(ids.map((id) => [id, '0'])) }
  error.value = ''
  errorParticipantId.value = undefined
  emit('dirty')
}

function onMethodChange(event: CustomEvent<{ value?: unknown }>): void {
  const method = methods.find(([type]) => type === event.detail.value)
  if (method) choose(method[0])
}

function defaultPercentages(participantIds: readonly string[]): Readonly<Record<string, string>> {
  if (participantIds.length === 0) return {}
  const baseHundredths = Math.floor(10_000 / participantIds.length)
  const remainder = 10_000 % participantIds.length
  return Object.fromEntries(participantIds.map((participantId, index) => {
    const hundredths = baseHundredths + (index < remainder ? 1 : 0)
    const whole = Math.floor(hundredths / 100)
    const fractional = hundredths % 100
    const value = fractional === 0 ? String(whole) : `${whole}.${String(fractional).padStart(2, '0').replace(/0$/, '')}`
    return [participantId, value]
  }))
}

function updateValue(participantId: string, value: string | null | undefined): void {
  const current = draft.value
  if (current.type === 'equal' || current.type === 'itemized') return
  draft.value = { ...current, values: { ...current.values, [participantId]: value ?? '' } }
  error.value = ''
  errorParticipantId.value = undefined
  emit('dirty')
}

function valueAria(participantId: string): FieldAria {
  return error.value && (!errorParticipantId.value || errorParticipantId.value === participantId)
    ? { 'aria-invalid': 'true', 'aria-describedby': 'split-error' }
    : {}
}

function malformedParticipantId(): string | undefined {
  const current = draft.value
  if (current.type === 'equal' || current.type === 'itemized') return undefined
  for (const { id } of props.participants) {
    const value = current.values[id] ?? ''
    try {
      if (current.type === 'exact' || current.type === 'adjustment' || current.type === 'reimbursement') {
        if (toMinorUnits(value, props.currency) < 0) return id
      } else {
        const numeric = Number(value)
        if (!value.trim() || !Number.isFinite(numeric) || numeric < 0) return id
      }
    } catch {
      return id
    }
  }
  return undefined
}

function apply(): void {
  try {
    const allocations = computeSplitPreview(props.totalMinorAmount, props.currency, props.participants.map(({ id }) => id), draft.value)
    error.value = ''
    emit('apply', { input: clone(draft.value), allocations })
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : 'The split could not be applied.'
    errorParticipantId.value = malformedParticipantId()
    void nextTick(() => {
      const values = sheet.value?.querySelectorAll<HTMLElement>('[data-participant-id]') ?? []
      const target = errorParticipantId.value
        ? [...values].find(({ dataset }) => dataset.participantId === errorParticipantId.value)
        : values[0] ?? sheet.value?.querySelector<HTMLElement>(`[data-method="${draft.value.type}"]`)
      focusSheetControl(target)
    })
  }
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
</script>

<template>
  <ion-header>
    <ion-toolbar>
      <ion-buttons slot="start"><ion-button data-action="cancel-split" @click="emit('cancel')">Cancel</ion-button></ion-buttons>
      <ion-title id="split-editor-title" role="heading" aria-level="2">Split expense</ion-title>
      <ion-buttons slot="end"><ion-button :strong="true" data-action="apply-split" @click="apply">Done</ion-button></ion-buttons>
    </ion-toolbar>
  </ion-header>
  <ion-content>
    <section ref="sheet" class="expense-sheet expense-sheet--ionic-content split-editor" data-sheet-scroll aria-labelledby="split-editor-title">
      <ion-list inset lines="full" class="sheet-list split-editor__methods">
        <ion-radio-group :value="draft.type" aria-label="Split method" @ion-change="onMethodChange">
          <ion-item v-for="[type, label] in methods" :key="type">
            <ion-radio
              :value="type"
              :data-method="type"
              justify="space-between"
              :aria-invalid="error && draft.type === 'itemized' && type === 'itemized' ? 'true' : undefined"
              :aria-describedby="error && draft.type === 'itemized' && type === 'itemized' ? 'split-error' : undefined"
            >{{ label }}</ion-radio>
          </ion-item>
        </ion-radio-group>
      </ion-list>

      <p v-if="draft.type === 'equal'" class="split-editor__hint">The total is shared equally, with any minor-unit remainder assigned in participant order.</p>
      <p v-else-if="draft.type === 'reimbursement'" class="split-editor__hint">Enter the amount each person should receive from this refund. The person who received the refund will owe these amounts back.</p>
      <div v-if="draft.type === 'itemized'" class="split-editor__items">
        <p v-if="draft.items.length === 0">Add and assign receipt items from Receipt review.</p>
        <article v-for="(item, index) in draft.items" :key="`${item.description}-${index}`">
          <strong>{{ item.description }}</strong>
          <span>{{ item.amountText }} {{ currency }} · {{ item.participantIds.map((id) => memberById.get(id)?.displayName ?? id).join(', ') }}</span>
        </article>
      </div>
      <ion-list v-else-if="draft.type !== 'equal'" inset lines="full" class="sheet-list split-editor__values">
        <!-- Keyed by method: Ionic reads an input's aria-label only when it loads, and the label names the method. -->
        <ion-item v-for="member in participants" :key="`${draft.type}:${member.id}`">
          <ion-input
            v-field-aria="valueAria(member.id)"
            class="split-editor__value"
            inputmode="decimal"
            :label="member.displayName"
            label-placement="start"
            :value="draft.values[member.id]"
            :data-participant-id="member.id"
            :aria-label="`${member.displayName} ${draft.type}`"
            @ion-input="updateValue(member.id, $event.detail.value)"
          />
        </ion-item>
      </ion-list>
      <p v-if="error" id="split-error" class="split-editor__error" role="alert">{{ error }}</p>
    </section>
  </ion-content>
</template>

<style scoped src="./expense-sheet.css"></style>
<style scoped>
ion-list.sheet-list { margin: 0; border-radius: 14px; }
.sheet-list ion-item { --background: var(--su-surface); --border-color: color-mix(in srgb, var(--su-divider) 62%, transparent); --min-height: 54px; --padding-start: 12px; --inner-padding-end: 12px; }
ion-list.split-editor__methods { margin: 14px 0 18px; }
.split-editor__methods ion-item { --min-height: 44px; }
.split-editor__value { font-size: max(16px, 1rem); text-align: end; }
.split-editor__hint, .split-editor__items { color: var(--ion-color-medium); font-size: 0.9rem; line-height: 1.45; }
.split-editor__items article { display: grid; gap: 4px; padding: 11px 0; border-bottom: 1px solid var(--su-divider); color: var(--ion-text-color); }
.split-editor__items span { min-width: 0; color: var(--ion-color-medium); font-size: 0.82rem; overflow-wrap: anywhere; }
.split-editor__error { padding: 10px 12px; border-radius: 10px; background: color-mix(in srgb, var(--ion-color-danger) 10%, transparent); color: var(--ion-color-danger); font-size: 0.86rem; }
</style>
