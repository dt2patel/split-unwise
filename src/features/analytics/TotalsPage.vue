<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonPage, IonTitle, IonToolbar } from '@ionic/vue'
import { formatMoney } from '../../components/MoneyAmount.vue'
import { isStrictId } from '../../data/identifiers'
import type { GroupPremiumSnapshot } from '../premium/premiumData'
import { loadGroupPremiumSnapshot } from '../premium/premiumData'

const route = useRoute()
const snapshot = ref<GroupPremiumSnapshot>()
const error = ref('')
const loading = ref(false)
let request = 0
const groupId = computed(() => typeof route.params.groupId === 'string' && isStrictId(route.params.groupId) ? route.params.groupId : '')
const backPath = computed(() => groupId.value ? `/tabs/groups/${encodeURIComponent(groupId.value)}` : '/tabs/groups')
watch(groupId, (id) => { void load(id) }, { immediate: true })

async function load(id: string): Promise<void> {
  const current = ++request; loading.value = true; error.value = ''; snapshot.value = undefined
  try { const loaded = await loadGroupPremiumSnapshot(id); if (current === request) snapshot.value = loaded } catch (reason) { if (current === request) error.value = message(reason) } finally { if (current === request) loading.value = false }
}
function money(currency: Parameters<typeof formatMoney>[0]['currency'], minorAmount: number): string { return formatMoney({ currency, minorAmount: Math.abs(minorAmount) }) }
function signed(currency: Parameters<typeof formatMoney>[0]['currency'], minorAmount: number): string { return `${minorAmount > 0 ? '+' : minorAmount < 0 ? '−' : ''}${money(currency, minorAmount)}` }
function coverage(): string { return snapshot.value?.report.coverage.status === 'complete' ? 'Complete demo history · confirmed current records only' : 'Bounded authorized snapshot · a server export is required for full history' }
function message(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason) }
</script>

<template>
  <ion-page class="premium-page">
    <ion-header translucent><ion-toolbar><ion-buttons slot="start"><ion-back-button :default-href="backPath" text="Group" /></ion-buttons><ion-title>Totals</ion-title></ion-toolbar></ion-header>
    <ion-content :fullscreen="true">
      <main class="premium-main">
        <p class="premium-eyebrow">{{ snapshot?.group.name ?? 'Group report' }}</p>
        <h1>Totals</h1>
        <p class="premium-intro">Paid, shared, and settled amounts stay separate for every currency.</p>
        <p v-if="loading" role="status">Loading confirmed totals…</p>
        <p v-else-if="error" role="alert" class="premium-error">{{ error }}</p>
        <template v-else-if="snapshot">
          <p data-testid="coverage" class="authority-note">{{ coverage() }}</p>
          <section v-for="row in snapshot.report.totals" :key="row.currency" class="report-card">
            <header><span>{{ row.currency }}</span><strong>{{ money(row.currency, row.expenseTotal) }}</strong></header>
            <table :aria-label="`${row.currency} period totals`">
              <tbody>
                <tr><th scope="row">Expense total</th><td>{{ money(row.currency, row.expenseTotal) }}</td></tr>
                <tr><th scope="row">You paid</th><td>{{ money(row.currency, row.currentUserPaid) }}</td></tr>
                <tr><th scope="row">Your share</th><td>{{ money(row.currency, row.currentUserShare) }}</td></tr>
                <tr><th scope="row">Payments sent</th><td>{{ money(row.currency, row.settlementSent) }}</td></tr>
                <tr><th scope="row">Payments received</th><td>{{ money(row.currency, row.settlementReceived) }}</td></tr>
                <tr class="report-card__total"><th scope="row">Period ledger net</th><td>{{ signed(row.currency, row.periodNet) }}</td></tr>
              </tbody>
            </table>
          </section>
          <p v-if="!snapshot.report.totals.length" class="empty-state">No confirmed expenses in this group yet.</p>
          <p class="report-explainer"><strong>Period net is not your current balance.</strong> It summarizes confirmed activity in this report; Balances reflects the current ledger after all saved activity.</p>
          <div class="premium-actions"><ion-button fill="outline" :router-link="`/tabs/groups/${encodeURIComponent(groupId)}/charts`">View charts</ion-button><ion-button fill="outline" :router-link="`/tabs/groups/${encodeURIComponent(groupId)}/export`">Export</ion-button></div>
        </template>
      </main>
    </ion-content>
  </ion-page>
</template>

<style scoped>
.premium-main { width: min(100%, 680px); margin: 0 auto; padding: 22px 18px calc(40px + env(safe-area-inset-bottom)); }
.premium-eyebrow { margin: 0 0 4px; color: var(--su-accent); font-size: .78rem; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
h1 { margin: 0; font-size: clamp(2rem, 9vw, 2.55rem); letter-spacing: -.045em; }
.premium-intro { margin: 8px 0 20px; color: var(--ion-color-medium); line-height: 1.45; }
.authority-note { padding: 11px 13px; border-radius: 13px; background: var(--su-lilac); color: var(--su-category-fg); font-size: .84rem; line-height: 1.35; }
.report-card { margin-top: 14px; overflow: hidden; border: 1px solid color-mix(in srgb, var(--su-divider) 35%, transparent); border-radius: 18px; background: var(--su-surface); }
.report-card header { display: flex; align-items: baseline; justify-content: space-between; padding: 16px; background: color-mix(in srgb, var(--su-lilac) 68%, var(--su-surface)); }
.report-card header span { color: var(--su-category-fg); font-size: .8rem; font-weight: 760; letter-spacing: .08em; }
.report-card header strong { font-size: 1.45rem; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 12px 16px; border-top: 1px solid color-mix(in srgb, var(--su-divider) 28%, transparent); font-size: .92rem; }
th { font-weight: 540; text-align: left; } td { font-variant-numeric: tabular-nums; text-align: right; }
.report-card__total { color: var(--su-category-fg); font-weight: 720; }
.report-explainer { margin: 18px 0; padding: 14px; border-left: 3px solid var(--su-accent); color: var(--ion-color-medium); line-height: 1.45; }
.report-explainer strong { color: var(--su-text); }.premium-actions { display: flex; gap: 8px; }.premium-actions ion-button { min-height: 44px; margin: 0; }
.premium-error { color: var(--su-owing); }.empty-state { color: var(--ion-color-medium); text-align: center; }
</style>
