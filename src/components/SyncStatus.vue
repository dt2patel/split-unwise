<script setup lang="ts">
import { IonIcon } from '@ionic/vue'
import { alertCircleOutline, checkmarkCircleOutline, cloudOfflineOutline, cloudUploadOutline, gitCompareOutline } from 'ionicons/icons'
import { computed } from 'vue'
import type { SyncState } from '../data/repositories'

const props = defineProps<{ state: SyncState }>()

const presentations: Record<SyncState, { label: string; icon: string }> = {
  fresh: { label: 'Saved', icon: checkmarkCircleOutline },
  stale: { label: 'Saved copy may be out of date', icon: cloudOfflineOutline },
  pending: { label: 'Saving', icon: cloudUploadOutline },
  failed: { label: 'Save failed', icon: alertCircleOutline },
  conflicted: { label: 'Conflict needs review', icon: gitCompareOutline },
}

const presentation = computed(() => presentations[props.state])
</script>

<template>
  <span class="sync-status" :class="`sync-status--${state}`" role="status" aria-live="polite" aria-atomic="true">
    <ion-icon :icon="presentation.icon" aria-hidden="true" />
    <span>{{ presentation.label }}</span>
  </span>
</template>

<style scoped>
.sync-status { display: inline-flex; align-items: center; gap: 0.3rem; max-width: 100%; color: var(--ion-color-medium); font-size: 0.82rem; overflow-wrap: anywhere; }
.sync-status--failed, .sync-status--conflicted { color: var(--ion-color-danger); }
.sync-status--pending { color: var(--su-accent); }
</style>
