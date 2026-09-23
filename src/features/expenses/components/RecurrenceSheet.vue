<script setup lang="ts">
import { computed, nextTick, ref, watch, type ComponentPublicInstance } from 'vue'
import { IonButton, IonButtons, IonContent, IonHeader, IonInput, IonItem, IonLabel, IonList, IonRadio, IonRadioGroup, IonSegment, IonSegmentButton, IonTitle, IonToolbar } from '@ionic/vue'
import type { Recurrence } from '../../../domain/model'
import { focusSheetControl, vFieldAria, type FieldAria } from './sheetControls'
import { useSheetKeyboardAvoidance } from './useSheetKeyboardAvoidance'

type OccurrenceEditScope = 'occurrence' | 'future'
interface RecurrenceApplyValue { readonly recurrence: Recurrence | undefined; readonly occurrenceEditScope?: OccurrenceEditScope }
// Five frequencies do not fit one segmented row on a phone, so they stay a vertical radio list.
const frequencyOptions = ['none', 'weekly', 'fortnightly', 'monthly', 'yearly'] as const
const scopeOptions = [['occurrence', 'This occurrence'], ['future', 'This and future expenses']] as const

const props = defineProps<{ modelValue?: Recurrence; date: string; occurrenceEditScope?: OccurrenceEditScope; isRecurringInstance?: boolean }>()
const emit = defineEmits<{ apply: [value: RecurrenceApplyValue]; cancel: []; dirty: [] }>()
const frequency = ref<Recurrence['frequency'] | 'none'>(props.modelValue?.frequency ?? 'none')
const timeZone = ref(props.modelValue?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC')
const editScope = ref<OccurrenceEditScope | undefined>(props.occurrenceEditScope)
const error = ref('')
const errorKind = ref<'scope' | 'time-zone' | 'date'>()
const sheet = ref<HTMLElement>()
const header = ref<ComponentPublicInstance>()
const timeZoneAria = computed<FieldAria>(() => errorKind.value === 'time-zone' ? { 'aria-invalid': 'true', 'aria-describedby': 'recurrence-error' } : {})
useSheetKeyboardAvoidance(sheet)
watch(() => props.modelValue, (value) => { frequency.value = value?.frequency ?? 'none'; timeZone.value = value?.timeZone ?? timeZone.value; error.value = ''; errorKind.value = undefined })
watch(() => props.occurrenceEditScope, (value) => { editScope.value = value; error.value = ''; errorKind.value = undefined })
function chooseFrequency(value: typeof frequencyOptions[number]): void {
  if (frequency.value === value) return
  frequency.value = value
  error.value = ''
  errorKind.value = undefined
  emit('dirty')
}
function chooseScope(scope: OccurrenceEditScope): void {
  if (editScope.value === scope) return
  editScope.value = scope
  error.value = ''
  errorKind.value = undefined
  emit('dirty')
}
function onFrequencyChange(event: CustomEvent<{ value?: unknown }>): void {
  const value = frequencyOptions.find((option) => option === event.detail.value)
  if (value) chooseFrequency(value)
}
function onScopeChange(event: CustomEvent<{ value?: unknown }>): void {
  const scope = scopeOptions.find(([option]) => option === event.detail.value)
  if (scope) chooseScope(scope[0])
}
function editTimeZone(): void {
  error.value = ''
  errorKind.value = undefined
  emit('dirty')
}
function fail(message: string, kind: 'scope' | 'time-zone' | 'date', selector: string): void {
  error.value = message
  errorKind.value = kind
  // Done lives in the toolbar header, outside the scrolling sheet body.
  void nextTick(() => focusSheetControl(sheet.value?.querySelector(selector) ?? (header.value?.$el as HTMLElement | undefined)?.querySelector(selector)))
}
function apply(): void {
  if (props.isRecurringInstance && !editScope.value) {
    fail('Choose whether to change this occurrence or this and future expenses.', 'scope', '[data-occurrence-scope="occurrence"]')
    return
  }
  if (frequency.value === 'none') {
    emit('apply', { recurrence: undefined, ...(editScope.value ? { occurrenceEditScope: editScope.value } : {}) })
    return
  }
  try { new Intl.DateTimeFormat('en-US', { timeZone: timeZone.value }).format(new Date(0)) } catch {
    fail('Enter a valid IANA time zone.', 'time-zone', '[data-testid="recurrence-time-zone"]')
    return
  }
  const [year, month, day] = props.date.split('-').map(Number)
  if (!year || !month || !day) {
    fail('Choose a valid expense date first.', 'date', '[data-action="apply-recurrence"]')
    return
  }
  emit('apply', {
    recurrence: { frequency: frequency.value, anchor: { month, day }, timeZone: timeZone.value },
    ...(editScope.value ? { occurrenceEditScope: editScope.value } : {}),
  })
}
</script>

<template>
  <ion-header ref="header">
    <ion-toolbar>
      <ion-buttons slot="start"><ion-button @click="emit('cancel')">Cancel</ion-button></ion-buttons>
      <ion-title id="recurrence-title" role="heading" aria-level="2">Repeat</ion-title>
      <ion-buttons slot="end"><ion-button :strong="true" data-action="apply-recurrence" @click="apply">Done</ion-button></ion-buttons>
    </ion-toolbar>
  </ion-header>
  <ion-content>
    <section ref="sheet" class="expense-sheet expense-sheet--ionic-content" data-sheet-scroll aria-labelledby="recurrence-title">
      <ion-list inset lines="full" class="sheet-list frequency-list">
        <ion-radio-group :value="frequency" aria-label="Repeat frequency" @ion-change="onFrequencyChange">
          <ion-item v-for="item in frequencyOptions" :key="item">
            <ion-radio :value="item" :data-frequency="item" justify="space-between"><span class="frequency-label">{{ item === 'none' ? 'Does not repeat' : item }}</span></ion-radio>
          </ion-item>
        </ion-radio-group>
      </ion-list>
      <ion-list inset lines="none" class="sheet-list">
        <ion-item>
          <ion-input
            v-model="timeZone"
            v-field-aria="timeZoneAria"
            class="time-zone-input"
            data-testid="recurrence-time-zone"
            label="Time zone"
            label-placement="stacked"
            autocomplete="off"
            @ion-input="editTimeZone"
          />
        </ion-item>
      </ion-list>
      <fieldset v-if="isRecurringInstance" class="occurrence-scope">
        <legend>Apply changes to</legend>
        <ion-segment
          :value="editScope"
          :select-on-focus="true"
          aria-label="Recurring expense edit scope"
          :aria-invalid="errorKind === 'scope' ? 'true' : undefined"
          :aria-describedby="errorKind === 'scope' ? 'recurrence-error' : undefined"
          @ion-change="onScopeChange"
        >
          <ion-segment-button
            v-for="[scope, label] in scopeOptions"
            :key="scope"
            :value="scope"
            :data-occurrence-scope="scope"
            :aria-invalid="errorKind === 'scope' ? 'true' : undefined"
            :aria-describedby="errorKind === 'scope' ? 'recurrence-error' : undefined"
            @click="chooseScope(scope)"
          ><ion-label>{{ label }}</ion-label></ion-segment-button>
        </ion-segment>
      </fieldset>
      <p class="sheet-note">Monthly and yearly schedules retain their original calendar anchor after shorter months.</p>
      <p v-if="error" id="recurrence-error" role="alert" class="sheet-error">{{ error }}</p>
    </section>
  </ion-content>
</template>

<style scoped src="./expense-sheet.css"></style>
<style scoped>
ion-list.sheet-list { margin: 0; border-radius: 14px; }
.sheet-list ion-item { --background: var(--su-surface); --border-color: color-mix(in srgb, var(--su-divider) 62%, transparent); --min-height: 46px; --padding-start: 12px; --inner-padding-end: 12px; }
ion-list.frequency-list { margin: 14px 0; }
.frequency-label { text-transform: capitalize; }
.time-zone-input { font-size: max(16px, 1rem); }
.occurrence-scope ion-segment { padding: 3px; border-radius: 11px; background: color-mix(in srgb, var(--su-lilac) 42%, var(--su-surface)); }
.occurrence-scope ion-segment-button { min-width: 0; min-height: 44px; --border-radius: 8px; --color-checked: var(--ion-color-primary); --indicator-color: var(--su-surface); --padding-start: 8px; --padding-end: 8px; font-size: 0.82rem; text-transform: none; }
/* Keep "This and future expenses" whole on narrow phones instead of truncating it. */
.occurrence-scope ion-label { overflow: visible; line-height: 1.25; text-overflow: clip; white-space: normal; }
</style>
