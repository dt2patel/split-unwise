<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { Member } from '../../../data/repositories'
import { toMinorUnits, type CurrencyCode } from '../../../domain/money'
import { computeSplitPreview, type SplitInput } from '../expenseStore'
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

function onMethodKeydown(event: KeyboardEvent, type: SplitInput['type']): void {
  const currentIndex = methods.findIndex(([method]) => method === type)
  let nextIndex: number | undefined
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (currentIndex + 1) % methods.length
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (currentIndex - 1 + methods.length) % methods.length
  else if (event.key === 'Home') nextIndex = 0
  else if (event.key === 'End') nextIndex = methods.length - 1
  if (nextIndex === undefined) return
  event.preventDefault()
  const nextType = methods[nextIndex][0]
  choose(nextType)
  void nextTick(() => sheet.value?.querySelector<HTMLButtonElement>(`[data-method="${nextType}"]`)?.focus())
}

function updateValue(participantId: string, event: Event): void {
  const current = draft.value
  if (current.type === 'equal' || current.type === 'itemized') return
  draft.value = { ...current, values: { ...current.values, [participantId]: (event.target as HTMLInputElement).value } }
  error.value = ''
  errorParticipantId.value = undefined
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
        : values[0] ?? sheet.value?.querySelector<HTMLElement>('[data-method][aria-checked="true"]')
      target?.focus()
    })
  }
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
</script>

<template>
  <section ref="sheet" class="expense-sheet split-editor" data-sheet-scroll aria-labelledby="split-editor-title">
    <header class="expense-sheet__header">
      <button type="button" data-action="cancel-split" @click="emit('cancel')">Cancel</button>
      <h2 id="split-editor-title">Split expense</h2>
      <button type="button" data-action="apply-split" @click="apply">Apply</button>
    </header>

    <div class="split-editor__methods" role="radiogroup" aria-label="Split method">
      <button
        v-for="[type, label] in methods"
        :key="type"
        type="button"
        role="radio"
        :aria-checked="draft.type === type"
        :tabindex="draft.type === type ? 0 : -1"
        :data-method="type"
        :aria-invalid="error && draft.type === 'itemized' && type === 'itemized' ? 'true' : undefined"
        :aria-describedby="error && draft.type === 'itemized' && type === 'itemized' ? 'split-error' : undefined"
        @click="choose(type)"
        @keydown="onMethodKeydown($event, type)"
      >{{ label }}</button>
    </div>

    <p v-if="draft.type === 'equal'" class="split-editor__hint">The total is shared equally, with any minor-unit remainder assigned in participant order.</p>
    <p v-else-if="draft.type === 'reimbursement'" class="split-editor__hint">Enter the amount each person should receive from this refund. The person who received the refund will owe these amounts back.</p>
    <div v-if="draft.type === 'itemized'" class="split-editor__items">
      <p v-if="draft.items.length === 0">Add and assign receipt items from Receipt review.</p>
      <article v-for="(item, index) in draft.items" :key="`${item.description}-${index}`">
        <strong>{{ item.description }}</strong>
        <span>{{ item.amountText }} {{ currency }} · {{ item.participantIds.map((id) => memberById.get(id)?.displayName ?? id).join(', ') }}</span>
      </article>
    </div>
    <div v-else-if="draft.type !== 'equal'" class="split-editor__values">
      <label v-for="member in participants" :key="member.id">
        <span>{{ member.displayName }}</span>
        <input
          inputmode="decimal"
          :value="draft.values[member.id]"
          :data-participant-id="member.id"
          :aria-label="`${member.displayName} ${draft.type}`"
          :aria-invalid="error && (!errorParticipantId || errorParticipantId === member.id) ? 'true' : undefined"
          :aria-describedby="error && (!errorParticipantId || errorParticipantId === member.id) ? 'split-error' : undefined"
          @input="updateValue(member.id, $event)"
        >
      </label>
    </div>
    <p v-if="error" id="split-error" class="split-editor__error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped src="./expense-sheet.css"></style>
<style scoped>
.split-editor h2 { margin: 0; font-size: 1.04rem; text-align: center; }
.split-editor button { min-height: 44px; border: 0; background: transparent; color: var(--ion-color-primary); font: inherit; }
.split-editor header button:first-child { text-align: start; }
.split-editor header button:last-child { font-weight: 680; text-align: end; }
.split-editor__methods { display: flex; gap: 6px; margin: 14px 0 18px; overflow-x: auto; scrollbar-width: none; }
.split-editor__methods button { flex: 0 0 auto; min-height: 44px; padding: 0 13px; border-radius: 22px; background: color-mix(in srgb, var(--su-lilac) 52%, var(--su-surface)); color: var(--ion-color-medium); font-size: 0.82rem; transition: background-color var(--su-motion-fast) ease, color var(--su-motion-fast) ease; }
.split-editor__methods button[aria-checked="true"] { background: var(--ion-color-primary); color: var(--ion-color-primary-contrast); }
.split-editor__values { overflow: hidden; border: 1px solid color-mix(in srgb, var(--su-divider) 62%, transparent); border-radius: 14px; }
.split-editor__values label { display: grid; min-height: 54px; grid-template-columns: minmax(0, 1fr) 112px; align-items: center; gap: 12px; padding: 0 14px; border-bottom: 1px solid var(--su-divider); }
.split-editor__values label:last-child { border-bottom: 0; }
.split-editor__values input { width: 100%; min-height: 44px; border: 0; background: transparent; color: inherit; font: inherit; text-align: end; }
.split-editor__hint, .split-editor__items { color: var(--ion-color-medium); font-size: 0.9rem; line-height: 1.45; }
.split-editor__items article { display: grid; gap: 4px; padding: 11px 0; border-bottom: 1px solid var(--su-divider); color: var(--ion-text-color); }
.split-editor__items span { min-width: 0; color: var(--ion-color-medium); font-size: 0.82rem; overflow-wrap: anywhere; }
.split-editor__error { padding: 10px 12px; border-radius: 10px; background: color-mix(in srgb, var(--ion-color-danger) 10%, transparent); color: var(--ion-color-danger); font-size: 0.86rem; }
@media (prefers-reduced-motion: reduce) { .split-editor__methods button { transition: none; } }
</style>
