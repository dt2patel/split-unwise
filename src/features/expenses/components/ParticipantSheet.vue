<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import type { Member } from '../../../data/repositories'
import { useSheetKeyboardAvoidance } from './useSheetKeyboardAvoidance'

const props = defineProps<{ modelValue: readonly string[]; members: readonly Member[] }>()
const emit = defineEmits<{ apply: [value: readonly string[]]; cancel: [] }>()
const draft = ref<string[]>([...props.modelValue])
const error = ref('')
const sheet = ref<HTMLElement>()
useSheetKeyboardAvoidance(sheet)
watch(() => props.modelValue, (value) => { draft.value = [...value]; error.value = '' }, { deep: true })
function toggle(id: string, event: Event): void { draft.value = (event.target as HTMLInputElement).checked ? [...new Set([...draft.value, id])] : draft.value.filter((value) => value !== id); error.value = '' }
function apply(): void {
  if (!draft.value.length) {
    error.value = 'Choose at least one participant.'
    void nextTick(() => sheet.value?.querySelector<HTMLInputElement>('[data-participant-id]')?.focus())
    return
  }
  emit('apply', [...draft.value])
}
</script>

<template>
  <section ref="sheet" class="expense-sheet" data-sheet-scroll aria-labelledby="participant-title">
    <header class="expense-sheet__header"><button type="button" data-action="cancel-participants" @click="emit('cancel')">Cancel</button><h2 id="participant-title">Split with</h2><button type="button" data-action="apply-participants" @click="apply">Apply</button></header>
    <p>Only selected active members are included in the expense.</p>
    <div class="sheet-list">
      <label v-for="member in members" :key="member.id">
        <input type="checkbox" :checked="draft.includes(member.id)" :data-participant-id="member.id" :aria-invalid="error ? 'true' : undefined" :aria-describedby="error ? 'participant-error' : undefined" @change="toggle(member.id, $event)">
        <span>{{ member.displayName }}</span>
      </label>
    </div>
    <p v-if="error" id="participant-error" role="alert" class="sheet-error">{{ error }}</p>
  </section>
</template>

<style scoped src="./expense-sheet.css"></style>
