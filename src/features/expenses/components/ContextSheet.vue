<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { IonButton, IonButtons, IonContent, IonHeader, IonItem, IonList, IonRadio, IonRadioGroup, IonTitle, IonToolbar } from '@ionic/vue'
import type { Group } from '../../../data/repositories'
import { focusSheetControl } from './sheetControls'
import { useSheetKeyboardAvoidance } from './useSheetKeyboardAvoidance'

const props = defineProps<{ groups: readonly Group[]; modelValue: string }>()
const emit = defineEmits<{ apply: [groupId: string]; cancel: []; dirty: [] }>()
const draft = ref(props.modelValue)
const error = ref('')
const sheet = ref<HTMLElement>()
useSheetKeyboardAvoidance(sheet)

watch(() => props.modelValue, (value) => { draft.value = value; error.value = '' })

function choose(event: CustomEvent<{ value?: unknown }>): void {
  const value = event.detail.value
  if (typeof value !== 'string' || value === draft.value) return
  draft.value = value
  error.value = ''
  emit('dirty')
}

function apply(): void {
  if (!draft.value) {
    error.value = 'Choose a group or friend.'
    void nextTick(() => focusSheetControl(sheet.value?.querySelector('[data-context-id]')))
    return
  }
  emit('apply', draft.value)
}
</script>

<template>
  <ion-header>
    <ion-toolbar>
      <ion-buttons slot="start"><ion-button data-action="cancel-context" @click="emit('cancel')">Cancel</ion-button></ion-buttons>
      <ion-title id="context-title" role="heading" aria-level="2">Group or friend</ion-title>
      <ion-buttons slot="end"><ion-button :strong="true" data-action="apply-context" @click="apply">Done</ion-button></ion-buttons>
    </ion-toolbar>
  </ion-header>
  <ion-content>
    <section ref="sheet" class="expense-sheet expense-sheet--ionic-content" data-sheet-scroll aria-labelledby="context-title">
      <p>Choose where this expense belongs. Two-person groups are direct friend expenses in the same private ledger.</p>
      <ion-list inset lines="full" class="sheet-list">
        <ion-radio-group :value="draft" aria-label="Expense context" :aria-invalid="error ? 'true' : undefined" :aria-describedby="error ? 'context-error' : undefined" @ion-change="choose">
          <ion-item v-for="group in groups" :key="group.id">
            <ion-radio
              :value="group.id"
              :data-context-id="group.id"
              justify="space-between"
              :aria-invalid="error ? 'true' : undefined"
              :aria-describedby="error ? 'context-error' : undefined"
            >
              <div class="context-option">
                <span>{{ group.name }}</span>
                <small>{{ group.memberIds.length === 2 ? 'Direct expense' : `${group.memberIds.length} people` }}</small>
              </div>
            </ion-radio>
          </ion-item>
        </ion-radio-group>
      </ion-list>
      <p v-if="!groups.length" role="status" class="sheet-note">No available groups or friends.</p>
      <p v-if="error" id="context-error" role="alert" class="sheet-error">{{ error }}</p>
    </section>
  </ion-content>
</template>

<style scoped src="./expense-sheet.css"></style>
<style scoped>
ion-list.sheet-list { margin: 0; border-radius: 14px; }
.sheet-list ion-item { --background: var(--su-surface); --border-color: color-mix(in srgb, var(--su-divider) 62%, transparent); --min-height: 54px; --padding-start: 12px; --inner-padding-end: 12px; }
.sheet-list ion-radio::part(label) { flex: 1 1 auto; min-width: 0; overflow: visible; text-overflow: clip; white-space: normal; }
.context-option { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 34%); align-items: center; gap: 8px; }
</style>
