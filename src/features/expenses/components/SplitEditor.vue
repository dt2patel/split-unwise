<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Member } from '../../../data/repositories'
import type { CurrencyCode } from '../../../domain/money'
import { computeSplitPreview, type SplitInput } from '../expenseStore'

const props = defineProps<{
  modelValue: SplitInput
  participants: readonly Member[]
  currency: CurrencyCode
  totalMinorAmount: number
}>()
const emit = defineEmits<{
  apply: [value: { readonly input: SplitInput; readonly allocations: ReturnType<typeof computeSplitPreview> }]
  cancel: []
}>()

const methods = [
  ['equal', 'Equal'],
  ['exact', 'Exact'],
  ['percentage', 'Percent'],
  ['shares', 'Shares'],
  ['adjustment', 'Adjust'],
  ['itemized', 'Items'],
] as const
const draft = ref<SplitInput>(clone(props.modelValue))
const error = ref('')
const memberById = computed(() => new Map(props.participants.map((member) => [member.id, member])))

watch(() => props.modelValue, (value) => { draft.value = clone(value); error.value = '' }, { deep: true })

function choose(type: SplitInput['type']): void {
  if (type === draft.value.type) return
  const ids = props.participants.map(({ id }) => id)
  if (type === 'equal') draft.value = { type }
  else if (type === 'itemized') draft.value = { type, items: [] }
  else if (type === 'shares') draft.value = { type, values: Object.fromEntries(ids.map((id) => [id, '1'])) }
  else if (type === 'percentage') {
    const equal = ids.length ? String(100 / ids.length) : '0'
    draft.value = { type, values: Object.fromEntries(ids.map((id) => [id, equal])) }
  } else draft.value = { type, values: Object.fromEntries(ids.map((id) => [id, '0'])) }
  error.value = ''
}

function updateValue(participantId: string, event: Event): void {
  const current = draft.value
  if (current.type === 'equal' || current.type === 'itemized') return
  draft.value = { ...current, values: { ...current.values, [participantId]: (event.target as HTMLInputElement).value } }
}

function apply(): void {
  try {
    const allocations = computeSplitPreview(props.totalMinorAmount, props.currency, props.participants.map(({ id }) => id), draft.value)
    error.value = ''
    emit('apply', { input: clone(draft.value), allocations })
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : 'The split could not be applied.'
  }
}
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }
</script>

<template>
  <section class="split-editor" aria-labelledby="split-editor-title">
    <header>
      <button type="button" data-action="cancel-split" @click="emit('cancel')">Cancel</button>
      <h2 id="split-editor-title">Split expense</h2>
      <button type="button" data-action="apply-split" @click="apply">Apply</button>
    </header>

    <div class="split-editor__methods" role="tablist" aria-label="Split method">
      <button
        v-for="[type, label] in methods"
        :key="type"
        type="button"
        role="tab"
        :aria-selected="draft.type === type"
        :data-method="type"
        @click="choose(type)"
      >{{ label }}</button>
    </div>

    <p v-if="draft.type === 'equal'" class="split-editor__hint">The total is shared equally, with any minor-unit remainder assigned in participant order.</p>
    <div v-else-if="draft.type === 'itemized'" class="split-editor__items">
      <p v-if="draft.items.length === 0">Add and assign receipt items from Receipt review.</p>
      <article v-for="(item, index) in draft.items" :key="`${item.description}-${index}`">
        <strong>{{ item.description }}</strong>
        <span>{{ item.amountText }} {{ currency }} · {{ item.participantIds.map((id) => memberById.get(id)?.displayName ?? id).join(', ') }}</span>
      </article>
    </div>
    <div v-else class="split-editor__values">
      <label v-for="member in participants" :key="member.id">
        <span>{{ member.displayName }}</span>
        <input
          inputmode="decimal"
          :value="draft.values[member.id]"
          :data-participant-id="member.id"
          :aria-label="`${member.displayName} ${draft.type}`"
          @input="updateValue(member.id, $event)"
        >
      </label>
    </div>
    <p v-if="error" class="split-editor__error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.split-editor { min-height: 55vh; padding: 0 18px calc(18px + env(safe-area-inset-bottom)); background: var(--su-surface); color: var(--ion-text-color); }
.split-editor header { display: grid; min-height: 54px; grid-template-columns: 72px 1fr 72px; align-items: center; border-bottom: 1px solid var(--su-divider); }
.split-editor h2 { margin: 0; font-size: 1.04rem; text-align: center; }
.split-editor button { min-height: 44px; border: 0; background: transparent; color: var(--su-accent); font: inherit; }
.split-editor header button:first-child { text-align: start; }
.split-editor header button:last-child { font-weight: 680; text-align: end; }
.split-editor__methods { display: flex; gap: 6px; margin: 14px 0 18px; overflow-x: auto; scrollbar-width: none; }
.split-editor__methods button { flex: 0 0 auto; min-height: 44px; padding: 0 13px; border-radius: 22px; background: color-mix(in srgb, var(--su-lilac) 52%, var(--su-surface)); color: var(--ion-color-medium); font-size: 0.82rem; transition: background-color var(--su-motion-fast) ease, color var(--su-motion-fast) ease; }
.split-editor__methods button[aria-selected="true"] { background: var(--su-accent); color: var(--ion-color-primary-contrast); }
.split-editor__values { overflow: hidden; border: 1px solid color-mix(in srgb, var(--su-divider) 62%, transparent); border-radius: 14px; }
.split-editor__values label { display: grid; min-height: 54px; grid-template-columns: minmax(0, 1fr) 112px; align-items: center; gap: 12px; padding: 0 14px; border-bottom: 1px solid var(--su-divider); }
.split-editor__values label:last-child { border-bottom: 0; }
.split-editor__values input { width: 100%; min-height: 44px; border: 0; background: transparent; color: inherit; font: inherit; text-align: end; }
.split-editor__hint, .split-editor__items { color: var(--ion-color-medium); font-size: 0.9rem; line-height: 1.45; }
.split-editor__items article { display: grid; gap: 4px; padding: 11px 0; border-bottom: 1px solid var(--su-divider); color: var(--ion-text-color); }
.split-editor__items span { color: var(--ion-color-medium); font-size: 0.82rem; }
.split-editor__error { padding: 10px 12px; border-radius: 10px; background: color-mix(in srgb, var(--ion-color-danger) 10%, transparent); color: var(--ion-color-danger); font-size: 0.86rem; }
@media (prefers-reduced-motion: reduce) { .split-editor__methods button { transition: none; } }
</style>
