<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import type { Recurrence } from '../../../domain/model'
import { useSheetKeyboardAvoidance } from './useSheetKeyboardAvoidance'

type OccurrenceEditScope = 'occurrence' | 'future'
interface RecurrenceApplyValue { readonly recurrence: Recurrence | undefined; readonly occurrenceEditScope?: OccurrenceEditScope }
const frequencyOptions = ['none', 'weekly', 'fortnightly', 'monthly', 'yearly'] as const
const scopeOptions = ['occurrence', 'future'] as const

const props = defineProps<{ modelValue?: Recurrence; date: string; occurrenceEditScope?: OccurrenceEditScope; isRecurringInstance?: boolean }>()
const emit = defineEmits<{ apply: [value: RecurrenceApplyValue]; cancel: []; dirty: [] }>()
const frequency = ref<Recurrence['frequency'] | 'none'>(props.modelValue?.frequency ?? 'none')
const timeZone = ref(props.modelValue?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC')
const editScope = ref<OccurrenceEditScope | undefined>(props.occurrenceEditScope)
const error = ref('')
const errorKind = ref<'scope' | 'time-zone' | 'date'>()
const sheet = ref<HTMLElement>()
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
function onFrequencyKeydown(event: KeyboardEvent, current: typeof frequencyOptions[number]): void {
  moveRadio(event, frequencyOptions, current, chooseFrequency, 'frequency')
}
function onScopeKeydown(event: KeyboardEvent, current: OccurrenceEditScope): void {
  moveRadio(event, scopeOptions, current, chooseScope, 'occurrence-scope')
}
function moveRadio<T extends string>(event: KeyboardEvent, options: readonly T[], current: T, choose: (value: T) => void, dataName: string): void {
  const currentIndex = options.indexOf(current)
  let nextIndex: number | undefined
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % options.length
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + options.length) % options.length
  else if (event.key === 'Home') nextIndex = 0
  else if (event.key === 'End') nextIndex = options.length - 1
  if (nextIndex === undefined) return
  event.preventDefault()
  const next = options[nextIndex]
  choose(next)
  void nextTick(() => sheet.value?.querySelector<HTMLButtonElement>(`[data-${dataName}="${next}"]`)?.focus())
}
function fail(message: string, kind: 'scope' | 'time-zone' | 'date', selector: string): void {
  error.value = message
  errorKind.value = kind
  void nextTick(() => sheet.value?.querySelector<HTMLElement>(selector)?.focus())
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
  <section ref="sheet" class="expense-sheet" data-sheet-scroll aria-labelledby="recurrence-title">
    <header class="expense-sheet__header"><button type="button" @click="emit('cancel')">Cancel</button><h2 id="recurrence-title">Repeat</h2><button type="button" data-action="apply-recurrence" @click="apply">Apply</button></header>
    <div class="frequency-grid" role="radiogroup" aria-label="Repeat frequency">
      <button v-for="item in frequencyOptions" :key="item" type="button" role="radio" :aria-checked="frequency === item" :tabindex="frequency === item ? 0 : -1" :data-frequency="item" @click="chooseFrequency(item)" @keydown="onFrequencyKeydown($event, item)">{{ item === 'none' ? 'Does not repeat' : item }}</button>
    </div>
    <label class="stacked-label"><span>Time zone</span><input v-model="timeZone" data-testid="recurrence-time-zone" autocomplete="off" :aria-invalid="errorKind === 'time-zone' ? 'true' : undefined" :aria-describedby="errorKind === 'time-zone' ? 'recurrence-error' : undefined" @input="error = ''; errorKind = undefined"></label>
    <fieldset v-if="isRecurringInstance" class="occurrence-scope">
      <legend>Apply changes to</legend>
      <div role="radiogroup" aria-label="Recurring expense edit scope" :aria-invalid="errorKind === 'scope' ? 'true' : undefined" :aria-describedby="errorKind === 'scope' ? 'recurrence-error' : undefined">
        <button type="button" role="radio" data-occurrence-scope="occurrence" :aria-checked="editScope === 'occurrence'" :tabindex="editScope === 'occurrence' || !editScope ? 0 : -1" :aria-invalid="errorKind === 'scope' ? 'true' : undefined" :aria-describedby="errorKind === 'scope' ? 'recurrence-error' : undefined" @click="chooseScope('occurrence')" @keydown="onScopeKeydown($event, 'occurrence')">This occurrence</button>
        <button type="button" role="radio" data-occurrence-scope="future" :aria-checked="editScope === 'future'" :tabindex="editScope === 'future' ? 0 : -1" :aria-invalid="errorKind === 'scope' ? 'true' : undefined" :aria-describedby="errorKind === 'scope' ? 'recurrence-error' : undefined" @click="chooseScope('future')" @keydown="onScopeKeydown($event, 'future')">This and future expenses</button>
      </div>
    </fieldset>
    <p class="sheet-note">Monthly and yearly schedules retain their original calendar anchor after shorter months.</p>
    <p v-if="error" id="recurrence-error" role="alert" class="sheet-error">{{ error }}</p>
  </section>
</template>

<style scoped src="./expense-sheet.css"></style>
