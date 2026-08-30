<script setup lang="ts">
import { ref, watch } from 'vue'
import type { Group } from '../../../data/repositories'

const props = defineProps<{ groups: readonly Group[]; modelValue: string }>()
const emit = defineEmits<{ apply: [groupId: string]; cancel: [] }>()
const draft = ref(props.modelValue)
const error = ref('')

watch(() => props.modelValue, (value) => { draft.value = value; error.value = '' })

function apply(): void {
  if (!draft.value) {
    error.value = 'Choose a group or friend.'
    return
  }
  emit('apply', draft.value)
}
</script>

<template>
  <section class="expense-sheet" aria-labelledby="context-title">
    <header>
      <button type="button" data-action="cancel-context" @click="emit('cancel')">Cancel</button>
      <h2 id="context-title">Group or friend</h2>
      <button type="button" data-action="apply-context" @click="apply">Apply</button>
    </header>
    <p>Choose where this expense belongs. Two-person groups are direct friend expenses in the same private ledger.</p>
    <div class="sheet-list" role="radiogroup" aria-label="Expense context">
      <label v-for="group in groups" :key="group.id">
        <input
          v-model="draft"
          type="radio"
          name="expense-context"
          :value="group.id"
          :data-context-id="group.id"
        >
        <span>{{ group.name }}</span>
        <small>{{ group.memberIds.length === 2 ? 'Direct expense' : `${group.memberIds.length} people` }}</small>
      </label>
    </div>
    <p v-if="!groups.length" role="status" class="sheet-note">No available groups or friends.</p>
    <p v-if="error" role="alert" class="sheet-error">{{ error }}</p>
  </section>
</template>

<style scoped src="./expense-sheet.css"></style>
