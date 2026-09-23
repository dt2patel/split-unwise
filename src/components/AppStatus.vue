<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { IonToast, type ToastButton } from '@ionic/vue'
import { useNetwork } from '../composables/useNetwork'
import { activatePwaUpdate, dismissOfflineReady, dismissPwaUpdate, usePwaStatus } from '../app/pwa'

/** The id TabsShell gives its ion-tab-bar. */
const TAB_BAR_ID = 'app-tab-bar'

const network = useNetwork()
const networkStatus = network.status
const pwa = usePwaStatus()
const route = useRoute()
const showUpdate = computed(() => pwa.prompt.waiting && !pwa.prompt.dismissed)
const showOfflineReady = computed(() => !showUpdate.value && pwa.offlineReady)
const showWarning = computed(() => !showUpdate.value && !pwa.offlineReady && Boolean(pwa.message))
// Same rule TabsShell uses to render the tab bar: /tabs routes unless the route hides the app chrome.
const tabBarShowing = computed(() => Boolean(route?.matched.some((record) => record.name === 'tabs')) && route?.meta.hideAppChrome !== true)
const positionAnchor = computed(() => tabBarShowing.value ? TAB_BAR_ID : undefined)
// Ionic measures positionAnchor only while presenting, so an open toast is presented again when the tab bar comes or goes.
const repositioning = ref(false)
watch(positionAnchor, async () => {
  if (!showUpdate.value && !showOfflineReady.value) return
  repositioning.value = true
  await nextTick()
  repositioning.value = false
})

const updateButtons = computed<ToastButton[]>(() => [
  { text: 'Later', role: 'cancel', handler: () => { dismissPwaUpdate() } },
  {
    text: pwa.applying ? 'Checking…' : 'Update now',
    // Toast buttons have no disabled option: disable the native button, and ignore any tap that still arrives.
    htmlAttributes: pwa.applying ? { disabled: true, 'aria-disabled': 'true' } : {},
    handler: () => {
      if (!pwa.applying) void activatePwaUpdate()
      return false // stay open: the prompt closes once the update activates, or shows why it could not
    },
  },
])
const offlineReadyButtons: ToastButton[] = [{ text: 'OK', role: 'cancel', handler: () => { dismissOfflineReady() } }]
</script>

<template>
  <aside class="app-status app-status__banner" aria-live="polite" aria-atomic="true">
    <section v-if="networkStatus === 'offline'" class="app-status__notice app-status__notice--offline" role="status">
      <strong>Offline</strong><span>Saved work stays on this device. Reconnect to sync.</span>
    </section>
    <section v-if="showWarning" class="app-status__notice app-status__notice--warning" role="status"><span>{{ pwa.message }}</span></section>
  </aside>
  <!-- Rendered as ion-app children (App.vue), outside the fixed banner, so Ionic positions them against the app. -->
  <ion-toast
    class="app-status app-status__toast"
    :is-open="showUpdate && !repositioning"
    header="Update ready"
    :message="pwa.message || 'Install after your local work is safely settled.'"
    :buttons="updateButtons"
    :duration="0"
    position="bottom"
    :position-anchor="positionAnchor"
    layout="stacked"
    translucent
  />
  <ion-toast
    class="app-status app-status__toast"
    :is-open="showOfflineReady && !repositioning"
    message="Split Unwise is ready for offline use."
    :buttons="offlineReadyButtons"
    :duration="0"
    position="bottom"
    :position-anchor="positionAnchor"
    translucent
  />
</template>

<style scoped>
.app-status__banner { position: fixed; z-index: 10000; top: calc(env(safe-area-inset-top) + 7px); left: 50%; width: min(calc(100% - 24px), 520px); transform: translateX(-50%); pointer-events: none; }
.app-status__notice { display: flex; min-height: 44px; box-sizing: border-box; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 12px; border: 1px solid color-mix(in srgb, var(--su-divider) 30%, transparent); border-radius: 14px; background: color-mix(in srgb, var(--su-surface) 94%, transparent); color: var(--su-text); box-shadow: 0 8px 24px rgb(29 27 43 / 16%); backdrop-filter: blur(18px); pointer-events: auto; font-size: .78rem; line-height: 1.25; }
.app-status__notice strong { margin-inline-end: 7px; }.app-status__notice span { color: var(--ion-color-medium); }.app-status__notice--offline { border-color: color-mix(in srgb, var(--su-owing) 35%, transparent); }.app-status__notice--warning { border-color: color-mix(in srgb, var(--su-owing) 40%, transparent); }
.app-status__toast { --background: color-mix(in srgb, var(--su-surface) 94%, transparent); --border-color: color-mix(in srgb, var(--su-divider) 30%, transparent); --border-style: solid; --border-width: 1px; --border-radius: 14px; --box-shadow: 0 8px 24px rgb(29 27 43 / 16%); --button-color: var(--ion-color-primary); --color: var(--su-text); --max-width: 520px; --start: 12px; --end: 12px; }
.app-status__toast::part(header) { font-weight: 700; }.app-status__toast::part(message) { color: var(--ion-color-medium); }.app-status__toast::part(button) { font-weight: 700; }.app-status__toast::part(cancel) { font-weight: 500; }.app-status__toast::part(button):disabled { opacity: .55; }
</style>
