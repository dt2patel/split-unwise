<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { IonButton, IonButtons, IonCheckbox, IonContent, IonHeader, IonItem, IonList, IonTitle, IonToolbar } from '@ionic/vue'
import type { Member } from '../../../data/repositories'
import { focusSheetControl } from './sheetControls'
import { useSheetKeyboardAvoidance } from './useSheetKeyboardAvoidance'

const props = defineProps<{ modelValue: readonly string[]; members: readonly Member[] }>()
const emit = defineEmits<{ apply: [value: readonly string[]]; cancel: []; dirty: [] }>()
const draft = ref<string[]>([...props.modelValue])
const error = ref('')
const sheet = ref<HTMLElement>()
useSheetKeyboardAvoidance(sheet)
watch(() => props.modelValue, (value) => { draft.value = [...value]; error.value = '' }, { deep: true })
function toggle(id: string, checked: boolean): void {
  draft.value = checked ? [...new Set([...draft.value, id])] : draft.value.filter((value) => value !== id)
  error.value = ''
  emit('dirty')
}
function apply(): void {
  if (!draft.value.length) {
    error.value = 'Choose at least one participant.'
    void nextTick(() => focusSheetControl(sheet.value?.querySelector('[data-participant-id]')))
    return
  }
  emit('apply', [...draft.value])
}
</script>

<template>
  <ion-header>
    <ion-toolbar>
      <ion-buttons slot="start"><ion-button data-action="cancel-participants" @click="emit('cancel')">Cancel</ion-button></ion-buttons>
      <ion-title id="participant-title" role="heading" aria-level="2">Split with</ion-title>
      <ion-buttons slot="end"><ion-button :strong="true" data-action="apply-participants" @click="apply">Done</ion-button></ion-buttons>
    </ion-toolbar>
  </ion-header>
  <ion-content>
    <section ref="sheet" class="expense-sheet expense-sheet--ionic-content" data-sheet-scroll aria-labelledby="participant-title">
      <p>Only selected active members are included in the expense.</p>
      <ion-list inset lines="full" class="sheet-list">
        <ion-item v-for="member in members" :key="member.id">
          <ion-checkbox
            :checked="draft.includes(member.id)"
            :data-participant-id="member.id"
            justify="start"
            label-placement="end"
            :aria-invalid="error ? 'true' : undefined"
            :aria-describedby="error ? 'participant-error' : undefined"
            @ion-change="toggle(member.id, $event.detail.checked)"
          ><span>{{ member.displayName }}</span></ion-checkbox>
        </ion-item>
      </ion-list>
      <p v-if="error" id="participant-error" role="alert" class="sheet-error">{{ error }}</p>
    </section>
  </ion-content>
</template>

<style scoped src="./expense-sheet.css"></style>
<style scoped>
ion-list.sheet-list { margin: 0; border-radius: 14px; }
.sheet-list ion-item { --background: var(--su-surface); --border-color: color-mix(in srgb, var(--su-divider) 62%, transparent); --min-height: 54px; --padding-start: 12px; --inner-padding-end: 12px; }
.sheet-list ion-checkbox::part(label) { min-width: 0; overflow: visible; text-overflow: clip; white-space: normal; overflow-wrap: anywhere; }
</style>
