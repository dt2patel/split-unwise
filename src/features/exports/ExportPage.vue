<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonPage, IonTitle, IonToolbar } from '@ionic/vue'
import { isStrictId } from '../../data/identifiers'
import { buildAccountBackup, buildTransactionCsv } from '../../domain/premiumExports'
import { getPremiumProviderStates } from '../../domain/premiumProviders'
import type { PremiumExportSnapshot } from '../premium/premiumData'
import { loadPremiumExportSnapshot } from '../premium/premiumData'
import { createClientDownloadManager } from './clientDownload'

const route = useRoute(); const snapshot = ref<PremiumExportSnapshot>(); const loading = ref(false); const error = ref(''); const status = ref(''); const manager = createClientDownloadManager(); const providerStates = getPremiumProviderStates(); let request = 0
const accountScope = computed(() => route.name === 'account-export')
const groupScope = computed(() => route.name === 'group-export')
const groupId = computed(() => typeof route.params.groupId === 'string' && isStrictId(route.params.groupId) ? route.params.groupId : undefined)
const backPath = computed(() => groupScope.value ? groupId.value ? `/tabs/groups/${encodeURIComponent(groupId.value)}` : '/tabs/groups' : '/tabs/account')
watch(() => route.fullPath, () => { manager.dispose(); void load() }, { immediate: true })
onBeforeUnmount(() => manager.dispose())

async function load(): Promise<void> { const current = ++request; loading.value = true; error.value = ''; status.value = ''; snapshot.value = undefined; try { if (groupScope.value && !groupId.value) throw new Error('Open export from a valid group link.'); const loaded = await loadPremiumExportSnapshot(groupScope.value ? groupId.value : undefined); if (current === request) snapshot.value = loaded } catch (reason) { if (current === request) error.value = message(reason) } finally { if (current === request) loading.value = false } }
function downloadCsv(): void { if (!snapshot.value) return; download(buildTransactionCsv(snapshot.value), `${fileStem()}-transactions.csv`, 'text/csv;charset=utf-8') }
function downloadJson(): void { if (!snapshot.value) return; download(buildAccountBackup({ ...snapshot.value, exportedAt: new Date().toISOString() }), `${fileStem()}-backup.json`, 'application/json;charset=utf-8') }
function download(exported: { content: string; rowCount: number }, fileName: string, mimeType: string): void { error.value = ''; status.value = ''; try { const result = manager.download(exported.content, exported.rowCount, fileName, mimeType); status.value = result.status === 'ready' ? `Downloaded ${fileName}.` : 'This export is too large for a safe mobile download. Secure server export is not configured yet.' } catch (reason) { error.value = message(reason) } }
function fileStem(): string { return accountScope.value ? 'split-unwise-account' : `split-unwise-${groupId.value ?? 'group'}` }
function coverage(): string { return snapshot.value?.coverage.status === 'complete' ? 'Complete demo history is ready for export.' : 'This is a bounded authorized snapshot. Complete server export is not configured yet.' }
function message(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason) }
</script>

<template>
  <ion-page><ion-header translucent><ion-toolbar><ion-buttons slot="start"><ion-back-button :default-href="backPath" text="Back" /></ion-buttons><ion-title>Export</ion-title></ion-toolbar></ion-header>
    <ion-content :fullscreen="true"><main class="export-main"><p class="eyebrow">{{ accountScope ? 'Your data' : 'Group data' }}</p><h1>Export data</h1><p class="intro">Download confirmed current transactions or a versioned, private-field-safe backup.</p>
      <p v-if="loading" role="status">Preparing export summary…</p><p v-else-if="error && !snapshot" role="alert" class="error">{{ error }}</p>
      <template v-else-if="snapshot"><p class="coverage" data-testid="coverage">{{ coverage() }}</p>
        <section class="export-card"><div><h2>Transactions CSV</h2><p>Expenses and saved payments with currency and signed impact for each authorized member.</p></div><ion-button fill="outline" @click="downloadCsv">Download CSV</ion-button></section>
        <section class="export-card"><div><h2>Auditable JSON</h2><p>Versioned groups, members, ledger history, comments, settings, recurrence, and allowlisted durable attachment descriptors. No local files, URLs, tokens, or secrets.</p></div><ion-button fill="outline" @click="downloadJson">Download JSON</ion-button></section>
        <p class="limits">Mobile downloads are limited to 5,000 rows and 5 MiB. Larger exports require the secure server job.</p><p v-if="error" role="alert" class="error">{{ error }}</p><p role="status" aria-live="polite" class="status">{{ status }}</p>
        <section class="provider-card" aria-labelledby="connected-heading"><h2 id="connected-heading">Connected services</h2><article><div><strong>Transaction import</strong><p>Requires a verified financial-data provider.</p></div><span>{{ providerStates.import.status === 'unavailable' ? 'Unavailable' : 'Available' }}</span></article><article><div><strong>Live currency conversion</strong><p>Requires an authoritative rate source and timestamp. Stored money is never relabeled.</p></div><span>{{ providerStates.fx.status === 'unavailable' ? 'Unavailable' : 'Available' }}</span></article></section>
      </template>
    </main></ion-content></ion-page>
</template>

<style scoped>
.export-main { width: min(100%, 640px); margin: 0 auto; padding: 22px 18px calc(42px + env(safe-area-inset-bottom)); }.eyebrow { margin: 0 0 4px; color: var(--su-accent); font-size: .78rem; font-weight: 700; text-transform: uppercase; }.export-main h1 { margin: 0; font-size: clamp(2rem, 9vw, 2.55rem); letter-spacing: -.045em; }.intro { margin: 8px 0 18px; color: var(--ion-color-medium); line-height: 1.45; }.coverage { padding: 11px 13px; border-radius: 13px; background: var(--su-lilac); color: var(--su-category-fg); font-size: .84rem; }.export-card { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 14px; padding: 17px 0; border-bottom: 1px solid color-mix(in srgb, var(--su-divider) 35%, transparent); }.export-card h2, .provider-card h2 { margin: 0; font-size: 1rem; }.export-card p { margin: 5px 0 0; color: var(--ion-color-medium); font-size: .84rem; line-height: 1.4; }.export-card ion-button { min-height: 44px; margin: 0; }.limits, .status { color: var(--ion-color-medium); font-size: .82rem; line-height: 1.4; }.provider-card { margin-top: 22px; padding: 16px; border-radius: 18px; background: color-mix(in srgb, var(--su-lilac) 55%, var(--su-surface)); }.provider-card article { display: flex; min-height: 58px; align-items: center; justify-content: space-between; gap: 12px; border-top: 1px solid color-mix(in srgb, var(--su-divider) 28%, transparent); }.provider-card article:first-of-type { margin-top: 10px; }.provider-card p { margin: 3px 0 0; color: var(--ion-color-medium); font-size: .78rem; }.provider-card span { color: var(--su-owing); font-size: .76rem; font-weight: 700; }.error { color: var(--su-owing); }
@media (max-width: 390px) { .export-card { grid-template-columns: 1fr; }.export-card ion-button { justify-self: stretch; } }
</style>
