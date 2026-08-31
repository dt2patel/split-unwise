<script setup lang="ts">
import { ref } from 'vue'
import { IonBackButton, IonButtons, IonContent, IonHeader, IonIcon, IonPage, IonTitle, IonToolbar } from '@ionic/vue'
import { checkmark, moonOutline, phonePortraitOutline, sunnyOutline } from 'ionicons/icons'
import { getAppearanceController, type AppearancePreference } from '../../app/appearance'

const controller = getAppearanceController()
const preference = ref<AppearancePreference>(controller.preference)
const options = [
  { value: 'system' as const, label: 'Automatic', detail: 'Match this iPhone or device', icon: phonePortraitOutline },
  { value: 'light' as const, label: 'Light', detail: 'Always use the light appearance', icon: sunnyOutline },
  { value: 'dark' as const, label: 'Dark', detail: 'Always use the dark appearance', icon: moonOutline },
]

function choose(value: AppearancePreference): void { controller.setPreference(value); preference.value = value }
</script>

<template>
  <ion-page>
    <ion-header translucent><ion-toolbar><ion-buttons slot="start"><ion-back-button default-href="/tabs/account" text="Account" /></ion-buttons><ion-title>Appearance</ion-title></ion-toolbar></ion-header>
    <ion-content :fullscreen="true">
      <main class="settings-page">
        <h1>Appearance</h1>
        <p>Choose how Split Unwise looks on this device.</p>
        <section class="settings-group" aria-label="Appearance preference">
          <button v-for="option in options" :key="option.value" type="button" class="settings-row" :aria-pressed="preference === option.value" @click="choose(option.value)">
            <span class="settings-icon"><ion-icon :icon="option.icon" aria-hidden="true" /></span>
            <span><strong>{{ option.label }}</strong><small>{{ option.detail }}</small></span>
            <ion-icon v-if="preference === option.value" class="check" :icon="checkmark" aria-label="Selected" />
          </button>
        </section>
        <p class="settings-footnote">High contrast follows your accessibility preference in every appearance.</p>
      </main>
    </ion-content>
  </ion-page>
</template>

<style scoped>
.settings-page { padding: 18px 16px 38px; }.settings-page h1 { margin: 4px 4px 5px; font-size: 2rem; letter-spacing: -.04em; }.settings-page > p { margin: 0 4px 26px; color: var(--ion-color-medium); line-height: 1.4; }.settings-group { overflow: hidden; border-radius: 14px; background: var(--su-surface); box-shadow: 0 0 0 1px color-mix(in srgb,var(--su-divider) 22%,transparent); }.settings-row { display: grid; width: 100%; min-height: 62px; grid-template-columns: 32px 1fr 28px; align-items: center; gap: 10px; padding: 8px 14px; border: 0; border-bottom: 1px solid color-mix(in srgb,var(--su-divider) 26%,transparent); background: transparent; color: inherit; font: inherit; text-align: start; }.settings-row:last-child{border-bottom:0}.settings-row > span:nth-child(2){display:grid;gap:2px}.settings-row small{color:var(--ion-color-medium);font-size:.78rem;line-height:1.3}.settings-icon,.check{color:var(--ion-color-primary);font-size:1.25rem}.settings-footnote{font-size:.75rem!important;margin-top:12px!important}
</style>
