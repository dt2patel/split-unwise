<script setup lang="ts">
import { computed } from 'vue'
import {
  IonBackButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonPage,
  IonRadio,
  IonRadioGroup,
  IonTitle,
  IonToolbar,
} from '@ionic/vue'
import { SUPPORTED_LOCALES, type LocalePreference, type SupportedLocale, useI18n } from '../../app/i18n'

const { locale, preference, setPreference, t } = useI18n()
const options = computed(() => [
  { value: 'system' as const, label: t('language.system'), detail: t('language.systemDetail') },
  ...SUPPORTED_LOCALES.map((value) => ({ value, label: languageName(value), detail: value })),
])

function onLanguageChange(event: CustomEvent<{ value?: string | number }>): void {
  const value = event.detail.value
  if (value === 'system' || SUPPORTED_LOCALES.some((supported) => supported === value)) setPreference(value as LocalePreference)
}

function languageName(value: SupportedLocale): string {
  try {
    return new Intl.DisplayNames([locale.value], { type: 'language' }).of(value) ?? value
  } catch {
    return value
  }
}
</script>

<template>
  <ion-page>
    <ion-header translucent>
      <ion-toolbar>
        <ion-buttons slot="start"><ion-back-button default-href="/tabs/account" :text="t('nav.account')" /></ion-buttons>
        <ion-title>{{ t('language.title') }}</ion-title>
      </ion-toolbar>
    </ion-header>
    <ion-content :fullscreen="true">
      <main class="language-page">
        <header>
          <p>Split Unwise</p>
          <h2>{{ t('language.heading') }}</h2>
          <span>{{ t('language.description') }}</span>
        </header>
        <ion-list inset lines="full" aria-labelledby="language-options-heading">
          <ion-radio-group :value="preference" @ion-change="onLanguageChange">
            <ion-item v-for="option in options" :key="option.value" :data-locale="option.value">
              <ion-label>
                <strong>{{ option.label }}</strong>
                <ion-note>{{ option.detail }}</ion-note>
              </ion-label>
              <ion-radio slot="end" :value="option.value" :aria-label="option.label" />
            </ion-item>
          </ion-radio-group>
        </ion-list>
        <p id="language-options-heading" class="su-visually-hidden">{{ t('language.heading') }}</p>
      </main>
    </ion-content>
  </ion-page>
</template>

<style scoped>
.language-page{box-sizing:border-box;width:min(100%,680px);min-height:100%;margin:0 auto;padding:22px 14px calc(36px + env(safe-area-inset-bottom));background:color-mix(in srgb,var(--su-lilac) 22%,var(--su-surface))}.language-page>header{padding:4px 8px 18px}.language-page>header p{margin:0;color:var(--ion-color-primary);font-size:.72rem;font-weight:750;letter-spacing:.08em;text-transform:uppercase}.language-page h2{margin:3px 0 7px;font-size:clamp(1.8rem,7vw,2.35rem);letter-spacing:-.045em}.language-page>header span{display:block;color:var(--ion-color-medium);font-size:.88rem;line-height:1.45}.language-page ion-list{overflow:hidden;margin:0;border-radius:16px;background:var(--su-surface);box-shadow:0 0 0 1px color-mix(in srgb,var(--su-divider) 22%,transparent)}.language-page ion-item{--min-height:62px;--padding-start:16px;--inner-padding-end:14px;--background:var(--su-surface)}.language-page ion-label{display:grid;gap:3px}.language-page ion-label strong{font-size:.96rem}.language-page ion-note{font-size:.73rem}
</style>
