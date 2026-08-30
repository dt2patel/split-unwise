<script setup lang="ts">
import { ref, watch } from 'vue'
import type { Recurrence } from '../../../domain/model'

const props = defineProps<{ modelValue?: Recurrence; date: string }>()
const emit = defineEmits<{ apply: [value: Recurrence | undefined]; cancel: [] }>()
const frequency = ref<Recurrence['frequency'] | 'none'>(props.modelValue?.frequency ?? 'none')
const timeZone = ref(props.modelValue?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC')
const error = ref('')
watch(() => props.modelValue, (value) => { frequency.value = value?.frequency ?? 'none'; timeZone.value = value?.timeZone ?? timeZone.value; error.value = '' })
function apply(): void {
  if (frequency.value === 'none') { emit('apply', undefined); return }
  try { new Intl.DateTimeFormat('en-US', { timeZone: timeZone.value }).format(new Date(0)) } catch { error.value = 'Enter a valid IANA time zone.'; return }
  const [year, month, day] = props.date.split('-').map(Number)
  if (!year || !month || !day) { error.value = 'Choose a valid expense date first.'; return }
  emit('apply', { frequency: frequency.value, anchor: { month, day }, timeZone: timeZone.value })
}
</script>

<template>
  <section class="expense-sheet" aria-labelledby="recurrence-title">
    <header><button type="button" @click="emit('cancel')">Cancel</button><h2 id="recurrence-title">Repeat</h2><button type="button" data-action="apply-recurrence" @click="apply">Apply</button></header>
    <div class="frequency-grid" role="radiogroup" aria-label="Repeat frequency">
      <button v-for="item in ['none', 'weekly', 'fortnightly', 'monthly', 'yearly'] as const" :key="item" type="button" role="radio" :aria-checked="frequency === item" :data-frequency="item" @click="frequency = item">{{ item === 'none' ? 'Does not repeat' : item }}</button>
    </div>
    <label class="stacked-label"><span>Time zone</span><input v-model="timeZone" data-testid="recurrence-time-zone" autocomplete="off"></label>
    <p class="sheet-note">Monthly and yearly schedules retain their original calendar anchor after shorter months.</p>
    <p v-if="error" role="alert" class="sheet-error">{{ error }}</p>
  </section>
</template>

<style scoped src="./expense-sheet.css"></style>
