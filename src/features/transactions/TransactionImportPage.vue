<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonPage, IonTitle, IonToolbar } from '@ionic/vue'
import { cardOutline, checkmarkCircleOutline, documentAttachOutline, lockClosedOutline } from 'ionicons/icons'
import { getAppSession } from '../../data/session'
import type { AppPrincipal } from '../../data/principal'
import { fromMinorUnits } from '../../domain/money'
import { parseTransactionStatementCsv, type ImportedTransactionProposal, type TransactionImportResult } from '../../domain/transactionImport'
import { loadCurrencyPreferences } from '../account/currencyPreferences'
import { storeTransactionImportDraft } from './transactionImportDrafts'

const router = useRouter()
const session = getAppSession()
const principal = ref<AppPrincipal>()
const result = ref<TransactionImportResult>()
const fileName = ref('')
const loading = ref(true)
const parsing = ref(false)
const activeFingerprint = ref('')
const error = ref('')

onMounted(async () => {
  try {
    await session.ready
    principal.value = await session.principal
  } catch (reason) { error.value = message(reason) }
  finally { loading.value = false }
})

async function selectStatement(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !principal.value || parsing.value) return
  parsing.value = true
  error.value = ''
  result.value = undefined
  fileName.value = file.name
  try {
    const preferences = loadCurrencyPreferences(principal.value)
    result.value = await parseTransactionStatementCsv(await readFileText(file), { defaultCurrency: preferences.defaultCurrency })
    if (!result.value.proposals.length) error.value = 'No debit transactions were ready to split. Review the rejected rows below.'
  } catch (reason) { error.value = message(reason) }
  finally { parsing.value = false }
}

async function splitTransaction(proposal: ImportedTransactionProposal): Promise<void> {
  if (!principal.value || activeFingerprint.value) return
  activeFingerprint.value = proposal.fingerprint
  error.value = ''
  try {
    const importDraft = storeTransactionImportDraft(principal.value, proposal)
    await router.push({ path: '/tabs/account/expenses/new', query: { importDraft } })
  } catch (reason) {
    activeFingerprint.value = ''
    error.value = message(reason)
  }
}

function readFileText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Statement could not be read as text.')))
    reader.addEventListener('error', () => reject(new Error('Statement could not be read.')))
    reader.readAsText(file)
  })
}
function message(reason: unknown): string { return reason instanceof Error ? reason.message : 'The statement could not be imported.' }
</script>

<template>
  <ion-page class="import-page">
    <ion-header translucent>
      <ion-toolbar>
        <ion-buttons slot="start"><ion-back-button default-href="/tabs/account" text="Back" /></ion-buttons>
        <ion-title>Import</ion-title>
      </ion-toolbar>
    </ion-header>
    <ion-content :fullscreen="true">
      <main class="import-main">
        <header class="import-hero">
          <span class="import-hero__icon"><ion-icon :icon="cardOutline" aria-hidden="true" /></span>
          <p class="eyebrow">Split Unwise Pro</p>
          <h1>Import transactions</h1>
          <p>Choose a bank statement CSV, review the debit rows, then send only the transaction you select to the expense composer.</p>
        </header>

        <section class="privacy-card" aria-label="Statement privacy">
          <ion-icon :icon="lockClosedOutline" aria-hidden="true" />
          <span><strong>Your statement stays on this device</strong><small>It is parsed in this app and is never uploaded to Split Unwise or Firebase.</small></span>
        </section>

        <label class="file-picker" :class="{ 'file-picker--busy': parsing || loading }">
          <ion-icon :icon="documentAttachOutline" aria-hidden="true" />
          <span><strong>{{ parsing ? 'Reading statement…' : 'Choose CSV statement' }}</strong><small>Date, Description or Merchant, Amount or Debit, and optional Currency</small></span>
          <input type="file" accept=".csv,text/csv,text/plain" :disabled="parsing || loading" @change="selectStatement">
        </label>

        <p v-if="fileName" class="file-name">{{ fileName }}</p>
        <p v-if="error" class="import-error" role="alert">{{ error }}</p>

        <template v-if="result">
          <div class="result-heading">
            <p data-testid="import-summary"><strong>{{ result.proposals.length }}</strong> transaction{{ result.proposals.length === 1 ? '' : 's' }} ready</p>
            <small v-if="result.rejections.length">{{ result.rejections.length }} skipped</small>
          </div>
          <ol v-if="result.proposals.length" class="transaction-list" aria-label="Imported transactions">
            <li v-for="(proposal, index) in result.proposals" :key="proposal.fingerprint" data-testid="import-transaction" :style="{ '--entry-index': index }">
              <span class="transaction-status"><ion-icon :icon="checkmarkCircleOutline" aria-hidden="true" /></span>
              <span class="transaction-copy"><strong>{{ proposal.description }}</strong><small>{{ proposal.date }} · {{ proposal.money.currency }}</small></span>
              <span class="transaction-amount">{{ fromMinorUnits(proposal.money.minorAmount, proposal.money.currency) }}</span>
              <ion-button fill="clear" size="small" data-action="split-imported-transaction" :disabled="Boolean(activeFingerprint)" @click="splitTransaction(proposal)">{{ activeFingerprint === proposal.fingerprint ? 'Opening…' : 'Split this' }}</ion-button>
            </li>
          </ol>
          <details v-if="result.rejections.length" class="rejections">
            <summary>{{ result.rejections.length }} row{{ result.rejections.length === 1 ? '' : 's' }} not imported</summary>
            <ul><li v-for="row in result.rejections" :key="`${row.sourceRow}:${row.reason}`">Row {{ row.sourceRow }}: {{ row.reason }}</li></ul>
          </details>
        </template>

        <section class="provider-note">
          <strong>Connected bank import</strong>
          <p>A verified financial-data provider is not connected yet. CSV import provides the review flow without sharing bank credentials or silently changing the ledger.</p>
        </section>
      </main>
    </ion-content>
  </ion-page>
</template>

<style scoped>
.import-main { width: min(100%, 620px); margin: 0 auto; padding: 18px 16px calc(40px + env(safe-area-inset-bottom)); }
.import-hero { display: grid; grid-template-columns: 54px minmax(0, 1fr); gap: 2px 13px; align-items: center; margin-bottom: 20px; }
.import-hero__icon { display: grid; width: 54px; height: 54px; grid-row: 1 / 4; place-items: center; border-radius: 16px; background: linear-gradient(145deg, var(--ion-color-primary), var(--su-indigo)); color: #fff; font-size: 1.55rem; box-shadow: 0 10px 26px rgb(69 42 183 / 22%); }
.eyebrow { margin: 0; color: var(--ion-color-primary); font-size: .72rem; font-weight: 750; letter-spacing: .06em; text-transform: uppercase; }
.import-hero h1 { margin: 0; font-size: clamp(1.65rem, 7vw, 2.2rem); letter-spacing: -.04em; }
.import-hero > p:last-child { grid-column: 1 / -1; margin: 13px 0 0; color: var(--ion-color-medium); font-size: .9rem; line-height: 1.5; }
.privacy-card, .file-picker { box-sizing: border-box; display: grid; width: 100%; grid-template-columns: 36px minmax(0, 1fr); align-items: center; gap: 10px; border-radius: 16px; }
.privacy-card { padding: 13px; background: color-mix(in srgb, var(--su-owed) 10%, var(--su-surface)); color: var(--su-owed); }
.privacy-card ion-icon { justify-self: center; font-size: 1.2rem; }
.privacy-card span, .file-picker span { display: grid; gap: 3px; min-width: 0; }
.privacy-card small, .file-picker small { color: var(--ion-color-medium); font-size: .76rem; line-height: 1.35; }
.file-picker { position: relative; min-height: 78px; margin-top: 14px; padding: 14px; border: 1.5px dashed color-mix(in srgb, var(--ion-color-primary) 50%, var(--su-divider)); background: color-mix(in srgb, var(--su-lilac) 38%, var(--su-surface)); color: var(--ion-color-primary); transition: transform 160ms ease, background-color 160ms ease; }
.file-picker:active { transform: scale(.985); }
.file-picker--busy { opacity: .65; }
.file-picker > ion-icon { justify-self: center; font-size: 1.35rem; }
.file-picker input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
.file-name { margin: 8px 4px 0; color: var(--ion-color-medium); font-size: .76rem; overflow-wrap: anywhere; }
.import-error { margin: 12px 0; padding: 11px 13px; border-radius: 12px; background: color-mix(in srgb, var(--ion-color-danger) 9%, var(--su-surface)); color: var(--ion-color-danger); font-size: .82rem; }
.result-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin: 23px 3px 8px; }.result-heading p { margin: 0; }.result-heading small { color: var(--ion-color-medium); }
.transaction-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.transaction-list li { display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; align-items: center; gap: 8px; min-height: 70px; padding: 8px 8px 8px 10px; border: 1px solid color-mix(in srgb, var(--su-divider) 28%, transparent); border-radius: 15px; background: var(--su-surface); box-shadow: 0 3px 12px rgb(39 29 88 / 6%); animation: transaction-in 260ms cubic-bezier(.2,.75,.25,1) both; animation-delay: calc(min(var(--entry-index), 8) * 35ms); }
.transaction-status { color: var(--su-owed); font-size: 1.15rem; }.transaction-copy { display: grid; gap: 3px; min-width: 0; }.transaction-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.transaction-copy small { color: var(--ion-color-medium); font-size: .74rem; }.transaction-amount { font-variant-numeric: tabular-nums; font-weight: 700; }
.transaction-list ion-button { min-height: 42px; grid-column: 2 / -1; justify-self: end; margin: -4px 0 0; text-transform: none; }
.rejections { margin-top: 14px; color: var(--ion-color-medium); font-size: .8rem; }.rejections summary { min-height: 44px; padding: 12px 3px; color: var(--ion-color-danger); font-weight: 650; cursor: pointer; }.rejections ul { margin: 0; padding-left: 22px; line-height: 1.45; }
.provider-note { margin-top: 26px; padding-top: 18px; border-top: 1px solid color-mix(in srgb, var(--su-divider) 35%, transparent); }.provider-note p { margin: 5px 0 0; color: var(--ion-color-medium); font-size: .8rem; line-height: 1.45; }
@keyframes transaction-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
@media (prefers-reduced-motion: reduce) { .file-picker { transition: none; }.transaction-list li { animation: none; } }
</style>
