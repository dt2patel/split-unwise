<script setup lang="ts">
import { ref } from 'vue'
import { IonBackButton, IonButtons, IonContent, IonHeader, IonIcon, IonItem, IonLabel, IonList, IonNote, IonPage, IonRadio, IonRadioGroup, IonTitle, IonToolbar } from '@ionic/vue'
import { moonOutline, phonePortraitOutline, sunnyOutline } from 'ionicons/icons'
import { getAppearanceController, type AppearancePreference } from '../../app/appearance'

const controller = getAppearanceController()
const preference = ref<AppearancePreference>(controller.preference)
const options = [
  { value: 'system' as const, label: 'Automatic', detail: 'Match this iPhone or device', icon: phonePortraitOutline },
  { value: 'light' as const, label: 'Light', detail: 'Always use the light appearance', icon: sunnyOutline },
  { value: 'dark' as const, label: 'Dark', detail: 'Always use the dark appearance', icon: moonOutline },
]

function choose(value: AppearancePreference): void { controller.setPreference(value); preference.value = value }
function onAppearanceChange(event: CustomEvent<{ value?: unknown }>): void {
  const option = options.find(({ value }) => value === event.detail.value)
  if (option) choose(option.value)
}
</script>

<template>
  <ion-page>
    <ion-header translucent><ion-toolbar><ion-buttons slot="start"><ion-back-button default-href="/tabs/account" text="Account" /></ion-buttons><ion-title>Appearance</ion-title></ion-toolbar></ion-header>
    <ion-content :fullscreen="true">
      <main class="settings-page">
        <h1>Appearance</h1>
        <p>Choose how Split Unwise looks on this device.</p>
        <ion-list inset lines="full" class="settings-group">
          <ion-radio-group :value="preference" aria-label="Appearance preference" @ion-change="onAppearanceChange">
            <ion-item v-for="option in options" :key="option.value" class="settings-row" :data-appearance="option.value">
              <ion-icon slot="start" class="settings-icon" :icon="option.icon" aria-hidden="true" />
              <ion-label><strong>{{ option.label }}</strong><ion-note>{{ option.detail }}</ion-note></ion-label>
              <ion-radio slot="end" :value="option.value" :aria-label="option.label" />
            </ion-item>
          </ion-radio-group>
        </ion-list>
        <p class="settings-footnote">High contrast follows your accessibility preference in every appearance.</p>
      </main>
    </ion-content>
  </ion-page>
</template>

<style scoped>
.settings-page { padding: 18px 16px 38px; }.settings-page h1 { margin: 4px 4px 5px; font-size: 2rem; letter-spacing: -.04em; }.settings-page > p { margin: 0 4px 26px; color: var(--ion-color-medium); line-height: 1.4; }.settings-group { overflow: hidden; margin: 0; border-radius: 14px; background: var(--su-surface); box-shadow: 0 0 0 1px color-mix(in srgb,var(--su-divider) 22%,transparent); }.settings-row { --background: var(--su-surface); --border-color: color-mix(in srgb,var(--su-divider) 26%,transparent); --min-height: 62px; --padding-start: 14px; --inner-padding-end: 14px; color: var(--su-text); }.settings-row ion-label { display: grid; gap: 2px; white-space: normal; }.settings-row ion-note { color: var(--ion-color-medium); font-size: .78rem; line-height: 1.3; }.settings-icon { margin-inline: 0 22px; color: var(--ion-color-primary); font-size: 1.25rem; }.settings-footnote{font-size:.75rem!important;margin-top:12px!important}
</style>
