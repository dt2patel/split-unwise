<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonPage, IonTitle, IonToolbar } from '@ionic/vue'
import { shieldCheckmarkOutline, swapHorizontalOutline } from 'ionicons/icons'
import { formatMoney } from '../../components/MoneyAmount.vue'
import { getAppSession } from '../../data/session'
import { isStrictId } from '../../data/identifiers'
import type { Money } from '../../domain/model'
import { assertCurrencyCode, type CurrencyCode } from '../../domain/money'
import { createFxPreview, fetchReferenceRate } from '../../domain/premiumProviders'
import { currencyPickerOrder, loadCurrencyPreferences } from '../account/currencyPreferences'
import type { GroupPremiumSnapshot } from '../premium/premiumData'
import { loadGroupPremiumSnapshot } from '../premium/premiumData'

interface ConversionRow {
  readonly source: Money
  readonly converted?: Money
  readonly authority?: string
  readonly effectiveDate?: string
  readonly identity?: boolean
  readonly error?: string
}

const route = useRoute()
const session = getAppSession()
const snapshot = ref<GroupPremiumSnapshot>()
const targetCurrency = ref<CurrencyCode>('USD')
const targetOptions = ref<readonly CurrencyCode[]>(['USD'])
const rows = ref<readonly ConversionRow[]>([])
const loading = ref(false)
const converting = ref(false)
const error = ref('')
let loadRequest = 0
let conversionRequest = 0
let rateController: AbortController | undefined
const groupId = computed(() => typeof route.params.groupId === 'string' && isStrictId(route.params.groupId) ? route.params.groupId : '')
const backPath = computed(() => groupId.value ? `/tabs/groups/${encodeURIComponent(groupId.value)}` : '/tabs/groups')

watch(groupId, (id) => { void load(id) }, { immediate: true })
onBeforeUnmount(() => rateController?.abort())

async function load(id: string): Promise<void> {
  const current = ++loadRequest
  rateController?.abort()
  loading.value = true
  error.value = ''
  snapshot.value = undefined
  rows.value = []
  try {
    const [loaded, principal] = await Promise.all([loadGroupPremiumSnapshot(id), session.principal])
    if (current !== loadRequest) return
    const preferences = loadCurrencyPreferences(principal)
    const order = currencyPickerOrder(preferences)
    const sourceCurrencies = new Set(loaded.report.totals.map(({ currency }) => currency))
    targetOptions.value = order
    targetCurrency.value = order.find((currency) => !sourceCurrencies.has(currency)) ?? preferences.defaultCurrency
    snapshot.value = loaded
    await convert(current)
  } catch (reason) {
    if (current === loadRequest) error.value = message(reason)
  } finally {
    if (current === loadRequest) loading.value = false
  }
}

function changeTarget(event: Event): void {
  const value = (event.target as HTMLSelectElement).value
  assertCurrencyCode(value)
  targetCurrency.value = value
  void convert(loadRequest)
}

async function convert(expectedLoad = loadRequest): Promise<void> {
  const loaded = snapshot.value
  if (!loaded) return
  const current = ++conversionRequest
  rateController?.abort()
  const controller = new AbortController()
  rateController = controller
  converting.value = true
  rows.value = loaded.report.totals.map(({ currency, expenseTotal }) => ({ source: { currency, minorAmount: expenseTotal } }))
  const converted = await Promise.all(loaded.report.totals.map(async ({ currency, expenseTotal }): Promise<ConversionRow> => {
    const source = { currency, minorAmount: expenseTotal }
    if (currency === targetCurrency.value) return { source, converted: { ...source }, identity: true, authority: 'Same currency' }
    try {
      const rate = await fetchReferenceRate(currency, targetCurrency.value, { signal: controller.signal })
      const preview = createFxPreview(source, rate)
      return { source: preview.source, converted: preview.converted, authority: preview.authority, effectiveDate: preview.effectiveDate }
    } catch (reason) {
      if (controller.signal.aborted) return { source }
      return { source, error: message(reason) }
    }
  }))
  if (current === conversionRequest && expectedLoad === loadRequest && !controller.signal.aborted) {
    rows.value = converted
    converting.value = false
  }
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00.000Z`))
}
function message(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason) }
</script>

<template>
  <ion-page class="conversion-page">
    <ion-header translucent><ion-toolbar><ion-buttons slot="start"><ion-back-button :default-href="backPath" text="Group" /></ion-buttons><ion-title>Convert</ion-title></ion-toolbar></ion-header>
    <ion-content :fullscreen="true">
      <main class="conversion-main">
        <p class="eyebrow">{{ snapshot?.group.name ?? 'Group totals' }}</p>
        <h1>Convert currencies</h1>
        <p class="intro">See confirmed group spending in one currency while every original amount stays intact.</p>

        <p v-if="loading && !snapshot" role="status">Loading confirmed totals…</p>
        <p v-else-if="error" role="alert" class="error">{{ error }}</p>
        <template v-else-if="snapshot">
          <label class="target-card" for="target-currency">
            <span><small>Show reference values in</small><strong>{{ targetCurrency }}</strong></span>
            <select id="target-currency" :value="targetCurrency" aria-label="Target currency" @change="changeTarget">
              <option v-for="currency in targetOptions" :key="currency" :value="currency">{{ currency }}</option>
            </select>
          </label>

          <section class="authority-note" aria-label="Rate authority">
            <ion-icon :icon="shieldCheckmarkOutline" aria-hidden="true" />
            <p><strong>European Central Bank via Frankfurter</strong><span>This is a reference preview only—not a settlement or transaction rate.</span></p>
          </section>

          <p class="section-label">Confirmed group spending</p>
          <transition-group name="conversion-list" tag="div" class="conversion-list" aria-live="polite" :aria-busy="converting">
            <article v-for="row in rows" :key="`${row.source.currency}-${targetCurrency}`" class="conversion-card" :data-testid="`conversion-${row.source.currency}`">
              <div class="money-side"><small>Stored in {{ row.source.currency }}</small><strong>{{ formatMoney(row.source) }}</strong></div>
              <span class="swap" aria-hidden="true"><ion-icon :icon="swapHorizontalOutline" /></span>
              <div class="money-side money-side--target">
                <small>{{ row.identity ? 'Same currency' : `Reference in ${targetCurrency}` }}</small>
                <strong v-if="row.converted">{{ formatMoney(row.converted) }}</strong>
                <span v-else-if="row.error" role="alert" class="row-error">Unavailable</span>
                <span v-else class="rate-skeleton" aria-hidden="true" />
              </div>
              <p v-if="row.effectiveDate" class="rate-meta">Rate dated {{ formatDate(row.effectiveDate) }}</p>
              <p v-else-if="row.error" class="rate-meta rate-meta--error">{{ row.error }}</p>
            </article>
          </transition-group>

          <ion-button v-if="rows.some((row) => row.error)" class="retry" fill="outline" :disabled="converting" @click="convert()">Retry rates</ion-button>
          <p v-if="!rows.length" class="empty">There are no confirmed expenses to convert yet.</p>
          <p class="ledger-note">Split Unwise never changes or combines your saved currencies. Settlement and balance screens continue to use the original ledger amounts.</p>
        </template>
      </main>
    </ion-content>
  </ion-page>
</template>

<style scoped>
.conversion-main { width: min(100%, 640px); margin: 0 auto; padding: 22px 18px calc(42px + env(safe-area-inset-bottom)); }
.eyebrow { margin: 0 0 4px; color: var(--su-accent); font-size: .78rem; font-weight: 720; letter-spacing: .04em; text-transform: uppercase; }
h1 { margin: 0; font-size: clamp(2rem, 9vw, 2.55rem); letter-spacing: -.045em; }
.intro { margin: 8px 0 20px; color: var(--ion-color-medium); line-height: 1.45; }
.target-card { display: flex; min-height: 68px; align-items: center; justify-content: space-between; gap: 16px; padding: 10px 12px 10px 16px; border: 1px solid color-mix(in srgb, var(--su-divider) 30%, transparent); border-radius: 18px; background: var(--su-surface); box-shadow: 0 8px 24px rgb(24 18 54 / 6%); }
.target-card > span { display: flex; min-width: 0; flex-direction: column; }.target-card small { color: var(--ion-color-medium); font-size: .75rem; }.target-card strong { margin-top: 2px; font-size: 1.05rem; }
.target-card select { min-width: 96px; min-height: 48px; padding: 0 34px 0 14px; border: 0; border-radius: 13px; background: var(--su-lilac); color: var(--su-category-fg); font: inherit; font-size: 16px; font-weight: 750; text-align: center; }
.authority-note { display: flex; align-items: flex-start; gap: 11px; margin: 14px 0 24px; padding: 13px 14px; border-radius: 15px; background: color-mix(in srgb, var(--su-lilac) 58%, var(--su-surface)); color: var(--su-category-fg); }.authority-note ion-icon { flex: 0 0 auto; margin-top: 2px; font-size: 1.15rem; }.authority-note p { display: flex; margin: 0; flex-direction: column; gap: 2px; font-size: .79rem; line-height: 1.35; }.authority-note span { color: var(--ion-color-medium); }
.section-label { margin: 0 2px 9px; color: var(--ion-color-medium); font-size: .75rem; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
.conversion-list { display: grid; gap: 10px; }.conversion-card { display: grid; grid-template-columns: minmax(0, 1fr) 34px minmax(0, 1fr); align-items: center; padding: 16px; border: 1px solid color-mix(in srgb, var(--su-divider) 30%, transparent); border-radius: 18px; background: var(--su-surface); box-shadow: 0 5px 18px rgb(24 18 54 / 5%); }.money-side { display: flex; min-width: 0; flex-direction: column; gap: 4px; }.money-side small { color: var(--ion-color-medium); font-size: .72rem; }.money-side strong { overflow: hidden; font-size: clamp(1.06rem, 5vw, 1.32rem); font-variant-numeric: tabular-nums; text-overflow: ellipsis; white-space: nowrap; }.money-side--target { align-items: flex-end; text-align: right; }.money-side--target strong { color: var(--su-owed); }.swap { display: grid; width: 28px; height: 28px; place-items: center; border-radius: 50%; background: var(--su-lilac); color: var(--su-accent); }.rate-meta { grid-column: 1 / -1; margin: 12px 0 -3px; padding-top: 10px; border-top: 1px solid color-mix(in srgb, var(--su-divider) 25%, transparent); color: var(--ion-color-medium); font-size: .72rem; text-align: right; }.rate-meta--error, .row-error, .error { color: var(--su-owing); }.row-error { font-size: .86rem; font-weight: 700; }.rate-skeleton { width: 76px; height: 20px; border-radius: 8px; background: linear-gradient(90deg, var(--su-lilac), color-mix(in srgb, var(--su-lilac) 35%, white), var(--su-lilac)); background-size: 220% 100%; animation: rate-loading 1.2s ease-in-out infinite; }
.ledger-note { margin: 20px 2px 0; color: var(--ion-color-medium); font-size: .79rem; line-height: 1.45; }.retry { min-height: 44px; margin: 14px 0 0; }.empty { color: var(--ion-color-medium); text-align: center; }
.conversion-list-enter-active { transition: opacity 260ms ease, transform 300ms cubic-bezier(.2,.8,.2,1); }.conversion-list-enter-from { opacity: 0; transform: translateY(10px) scale(.985); }
@keyframes rate-loading { to { background-position: -220% 0; } }
@media (max-width: 350px) { .conversion-card { grid-template-columns: minmax(0, 1fr) 28px minmax(0, 1fr); padding: 14px 12px; } }
@media (prefers-reduced-motion: reduce) { .conversion-list-enter-active { transition: none; }.rate-skeleton { animation: none; } }
</style>
