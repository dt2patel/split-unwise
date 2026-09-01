<script setup lang="ts">
import { computed } from 'vue'
import { useNetwork } from '../composables/useNetwork'
import { activatePwaUpdate, dismissOfflineReady, dismissPwaUpdate, usePwaStatus } from '../app/pwa'

const network = useNetwork()
const networkStatus = network.status
const pwa = usePwaStatus()
const showUpdate = computed(() => pwa.prompt.waiting && !pwa.prompt.dismissed)
</script>

<template>
  <aside class="app-status" aria-live="polite" aria-atomic="true">
    <section v-if="networkStatus === 'offline'" class="app-status__notice app-status__notice--offline" role="status">
      <strong>Offline</strong><span>Saved work stays on this device. Reconnect to sync.</span>
    </section>
    <section v-if="showUpdate" class="app-status__notice app-status__notice--update" role="status">
      <div><strong>Update ready</strong><span>{{ pwa.message || 'Install after your local work is safely settled.' }}</span></div>
      <div class="app-status__actions"><button type="button" @click="dismissPwaUpdate">Later</button><button type="button" :disabled="pwa.applying" @click="activatePwaUpdate">{{ pwa.applying ? 'Checking…' : 'Update now' }}</button></div>
    </section>
    <section v-else-if="pwa.offlineReady" class="app-status__notice" role="status">
      <span>Split Unwise is ready for offline use.</span><button type="button" @click="dismissOfflineReady">OK</button>
    </section>
    <section v-else-if="pwa.message" class="app-status__notice app-status__notice--warning" role="status"><span>{{ pwa.message }}</span></section>
  </aside>
</template>

<style scoped>
.app-status { position: fixed; z-index: 10000; top: calc(env(safe-area-inset-top) + 7px); left: 50%; width: min(calc(100% - 24px), 520px); transform: translateX(-50%); pointer-events: none; }
.app-status__notice { display: flex; min-height: 44px; box-sizing: border-box; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 12px; border: 1px solid color-mix(in srgb, var(--su-divider) 30%, transparent); border-radius: 14px; background: color-mix(in srgb, var(--su-surface) 94%, transparent); color: var(--su-text); box-shadow: 0 8px 24px rgb(29 27 43 / 16%); backdrop-filter: blur(18px); pointer-events: auto; font-size: .78rem; line-height: 1.25; }
.app-status__notice strong { margin-inline-end: 7px; }.app-status__notice span { color: var(--ion-color-medium); }.app-status__notice--offline { border-color: color-mix(in srgb, var(--su-owing) 35%, transparent); }.app-status__notice--update > div:first-child { display: grid; gap: 2px; }.app-status__notice--warning { border-color: color-mix(in srgb, var(--su-owing) 40%, transparent); }
.app-status__actions { display: flex; flex: 0 0 auto; gap: 2px; }.app-status button { min-width: 44px; min-height: 44px; padding: 0 9px; border: 0; border-radius: 11px; background: transparent; color: var(--ion-color-primary); font: inherit; font-weight: 700; }.app-status button:last-child { background: var(--ion-color-primary); color: var(--ion-color-primary-contrast); }.app-status button:disabled { opacity: .55; }
@media (max-width: 390px), (min-resolution: 1.2dppx) { .app-status__notice--update { align-items: stretch; flex-direction: column; }.app-status__actions { justify-content: flex-end; } }
@media (prefers-reduced-motion: reduce) { .app-status { scroll-behavior: auto; } }
</style>
