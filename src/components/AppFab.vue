<script setup lang="ts">
import { IonFab, IonFabButton, IonIcon } from '@ionic/vue'
import { add } from 'ionicons/icons'
import { useHaptics } from '../composables/useHaptics'

withDefaults(defineProps<{ to: string; label?: string }>(), { label: 'Add expense' })
const haptics = useHaptics()
</script>

<template>
  <ion-fab vertical="bottom" horizontal="end" class="app-fab">
    <ion-fab-button :router-link="to" :aria-label="label" @click="void haptics.light()">
      <ion-icon :icon="add" aria-hidden="true" />
    </ion-fab-button>
  </ion-fab>
</template>

<style scoped>
.app-fab { position: fixed; right: 1rem; bottom: calc(var(--ion-safe-area-bottom, 0px) + 4.5rem); z-index: 20; }
.app-fab ion-fab-button { --background: var(--su-accent); --color: #fff; min-width: 44px; min-height: 44px; transition: transform var(--su-motion-fast) ease-out; }
.app-fab ion-fab-button:active { transform: scale(0.98); }
@media (prefers-reduced-motion: reduce) { .app-fab ion-fab-button { transition: none; } .app-fab ion-fab-button:active { transform: none; } }
</style>
