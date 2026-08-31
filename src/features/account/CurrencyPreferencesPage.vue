<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonPage, IonTitle, IonToolbar } from '@ionic/vue'
import type { CurrencyCode } from '../../domain/money'
import { getAppSession } from '../../data/session'
import { loadCurrencyPreferences, saveCurrencyPreferences, SUPPORTED_CURRENCIES } from './currencyPreferences'

const session = getAppSession()
const defaultCurrency = ref<CurrencyCode>('USD')
const preferred = ref<CurrencyCode[]>(['USD'])
const status = ref('')
let principal: Awaited<typeof session.principal>

onMounted(async () => {
  principal = await session.principal
  const value = loadCurrencyPreferences(principal)
  defaultCurrency.value = value.defaultCurrency
  preferred.value = [...value.preferredCurrencies]
})

function toggle(currency: CurrencyCode): void {
  if (currency === defaultCurrency.value) return
  preferred.value = preferred.value.includes(currency) ? preferred.value.filter((item) => item !== currency) : [...preferred.value, currency]
}
function changeDefault(event: Event): void {
  const currency = (event.target as HTMLSelectElement).value as CurrencyCode
  defaultCurrency.value = currency
  if (!preferred.value.includes(currency)) preferred.value = [currency, ...preferred.value]
}
function save(): void {
  const value = saveCurrencyPreferences(principal, { defaultCurrency: defaultCurrency.value, preferredCurrencies: preferred.value })
  preferred.value = [...value.preferredCurrencies]
  status.value = 'Currency preferences saved on this device.'
}
</script>

<template>
  <ion-page>
    <ion-header translucent><ion-toolbar><ion-buttons slot="start"><ion-back-button default-href="/tabs/account" text="Account" /></ion-buttons><ion-title>Currencies</ion-title><ion-buttons slot="end"><ion-button strong @click="save">Save</ion-button></ion-buttons></ion-toolbar></ion-header>
    <ion-content :fullscreen="true">
      <main class="currency-page">
        <h1>Currencies</h1><p>Preferred currencies appear first. Your default seeds only a new expense without a group.</p>
        <label class="default-row" for="default-currency"><span>Default currency</span><select id="default-currency" :value="defaultCurrency" @change="changeDefault"><option v-for="currency in SUPPORTED_CURRENCIES" :key="currency">{{ currency }}</option></select></label>
        <h2>Preferred</h2>
        <div class="currency-grid" aria-label="Preferred currencies">
          <button v-for="currency in SUPPORTED_CURRENCIES" :key="currency" type="button" :class="{ selected: preferred.includes(currency) }" :aria-pressed="preferred.includes(currency)" @click="toggle(currency)">{{ currency }}</button>
        </div>
        <p v-if="status" role="status" aria-live="polite" class="save-status">{{ status }}</p>
        <p class="footnote">Group currencies and saved expenses never change when you edit these preferences.</p>
      </main>
    </ion-content>
  </ion-page>
</template>

<style scoped>
.currency-page{padding:18px 16px 40px}.currency-page h1{margin:4px 0 5px;font-size:2rem;letter-spacing:-.04em}.currency-page>p{margin:0 0 22px;color:var(--ion-color-medium);line-height:1.45}.default-row{display:flex;min-height:58px;align-items:center;justify-content:space-between;gap:12px;padding:0 14px;border-radius:14px;background:var(--su-surface);box-shadow:0 0 0 1px color-mix(in srgb,var(--su-divider) 25%,transparent)}.default-row select{min-height:44px;border:0;background:transparent;color:var(--ion-color-primary);font:inherit;font-size:16px;font-weight:650}.currency-page h2{margin:26px 2px 10px;font-size:.82rem;color:var(--ion-color-medium);text-transform:uppercase;letter-spacing:.06em}.currency-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}.currency-grid button{min-height:44px;border:1px solid color-mix(in srgb,var(--su-divider) 35%,transparent);border-radius:12px;background:var(--su-surface);color:inherit;font:inherit;font-weight:650}.currency-grid button.selected{border-color:var(--ion-color-primary);background:var(--su-lilac);color:var(--su-indigo)}.save-status{color:var(--ion-color-primary)!important;margin-top:16px!important}.footnote{margin-top:18px!important;font-size:.76rem}@media(max-width:350px){.currency-grid{grid-template-columns:repeat(3,1fr)}}
</style>
