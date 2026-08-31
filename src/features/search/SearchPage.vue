<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonPage, IonTitle, IonToolbar } from '@ionic/vue'
import { formatMoney } from '../../components/MoneyAmount.vue'
import { isStrictId } from '../../data/identifiers'
import { toMinorUnits, type CurrencyCode } from '../../domain/money'
import type { ExpenseSearchResult } from '../../domain/search'
import { runPremiumSearch } from '../premium/premiumData'

const route = useRoute(); const query = ref(''); const selectedGroups = ref<string[]>([]); const selectedParticipants = ref<string[]>([]); const selectedCategories = ref<string[]>([]); const currency = ref(''); const dateFrom = ref(''); const dateTo = ref(''); const minimum = ref(''); const maximum = ref('')
const result = ref<ExpenseSearchResult>(); const loading = ref(false); const error = ref(''); let request = 0
const isGroupSearch = computed(() => route.name === 'group-search')
const groupId = computed(() => typeof route.params.groupId === 'string' && isStrictId(route.params.groupId) ? route.params.groupId : undefined)
const backPath = computed(() => isGroupSearch.value ? groupId.value ? `/tabs/groups/${encodeURIComponent(groupId.value)}` : '/tabs/groups' : '/tabs/home')
const groups = computed(() => result.value?.facets.groups ?? [])
const participants = computed(() => result.value?.facets.participants ?? [])
const categories = computed(() => result.value?.facets.categories ?? [])
const currencies = computed(() => result.value?.facets.currencies ?? [])
const resultLabel = computed(() => `${result.value?.items.length ?? 0} ${(result.value?.items.length ?? 0) === 1 ? 'result' : 'results'}`)
watch(() => route.fullPath, () => { reset(); void search() })
onMounted(() => { void search() })

function reset(): void { selectedGroups.value = []; selectedParticipants.value = []; selectedCategories.value = []; result.value = undefined; error.value = '' }
async function search(): Promise<void> {
  const current = ++request; loading.value = true; error.value = ''
  try {
    if (isGroupSearch.value && !groupId.value) throw new Error('Open search from a valid group link.')
    if ((minimum.value || maximum.value) && !currency.value) throw new Error('Choose a currency before filtering by amount.')
    const loaded = await runPremiumSearch({
      query: query.value, groupIds: selectedGroups.value, participantIds: selectedParticipants.value, categories: selectedCategories.value,
      ...(dateFrom.value ? { dateFrom: dateFrom.value } : {}), ...(dateTo.value ? { dateTo: dateTo.value } : {}),
      ...(currency.value ? { currency: currency.value as CurrencyCode } : {}), ...(minimum.value ? { minMinor: toMinorUnits(minimum.value, currency.value) } : {}), ...(maximum.value ? { maxMinor: toMinorUnits(maximum.value, currency.value) } : {}),
    }, groupId.value)
    if (current === request) result.value = loaded
  } catch (reason) { if (current === request) error.value = reason instanceof Error ? reason.message : String(reason) } finally { if (current === request) loading.value = false }
}
function coverage(): string { return result.value?.coverage.status === 'complete' ? 'Complete demo history' : `Bounded search · ${result.value?.coverage.scannedGroups ?? 0} groups and ${result.value?.coverage.scannedExpenses ?? 0} expenses scanned` }
function destination(group: string, expense: string): string { const origin = isGroupSearch.value ? 'groups' : 'home'; return `/tabs/${origin}/expenses/${encodeURIComponent(expense)}?groupId=${encodeURIComponent(group)}` }
</script>

<template>
  <ion-page><ion-header translucent><ion-toolbar><ion-buttons slot="start"><ion-back-button :default-href="backPath" text="Back" /></ion-buttons><ion-title>Search</ion-title></ion-toolbar></ion-header>
    <ion-content :fullscreen="true"><main class="search-main"><p class="eyebrow">{{ isGroupSearch ? 'This group' : 'All groups' }}</p><h1>Search</h1><p class="intro">Match words plus exact groups, people, categories, dates, amounts, and currency.</p>
      <form class="search-form" @submit.prevent="search">
        <label for="search-query"><span>Description or notes</span><input id="search-query" v-model="query" type="search" autocomplete="off" placeholder="Coffee, cabin, train…"></label>
        <details><summary>Filters</summary><div class="filter-grid">
          <label v-if="!isGroupSearch"><span>Groups</span><select v-model="selectedGroups" multiple><option v-for="group in groups" :key="group.id" :value="group.id">{{ group.name }}</option></select></label>
          <label><span>People</span><select v-model="selectedParticipants" multiple><option v-for="participant in participants" :key="participant.id" :value="participant.id">{{ participant.displayName }}</option></select></label>
          <label><span>Categories</span><select v-model="selectedCategories" multiple><option v-for="category in categories" :key="category" :value="category">{{ category }}</option></select></label>
          <label><span>From</span><input v-model="dateFrom" type="date"></label><label><span>Through</span><input v-model="dateTo" type="date"></label>
          <label><span>Currency</span><select v-model="currency"><option value="">Any currency</option><option v-for="code in currencies" :key="code" :value="code">{{ code }}</option></select></label>
          <label><span>Minimum amount</span><input v-model="minimum" inputmode="decimal" placeholder="0.00"></label><label><span>Maximum amount</span><input v-model="maximum" inputmode="decimal" placeholder="No maximum"></label>
        </div></details>
        <ion-button type="submit" expand="block" :disabled="loading">{{ loading ? 'Searching…' : 'Search expenses' }}</ion-button>
      </form>
      <p v-if="error" role="alert" class="error">{{ error }}</p>
      <section v-if="result" aria-labelledby="results-heading"><header class="results-heading"><h2 id="results-heading">Results</h2><span data-testid="result-count">{{ resultLabel }}</span></header><p data-testid="coverage" class="coverage">{{ coverage() }}</p>
        <p v-if="!result.items.length" data-testid="empty-results" class="empty">No expenses match these filters.</p>
        <ol v-else class="result-list"><li v-for="item in result.items" :key="`${item.group.id}:${item.expense.id}`" :data-expense-id="item.expense.id"><a :href="destination(item.group.id, item.expense.id)"><span><strong>{{ item.expense.description }}</strong><small>{{ item.group.name }} · {{ item.expense.category }} · {{ item.expense.date }}</small></span><b>{{ formatMoney(item.expense.total) }}</b></a></li></ol>
      </section>
    </main></ion-content></ion-page>
</template>

<style scoped>
.search-main { width: min(100%, 680px); margin: 0 auto; padding: 22px 18px calc(42px + env(safe-area-inset-bottom)); }.eyebrow { margin: 0 0 4px; color: var(--su-accent); font-size: .78rem; font-weight: 700; text-transform: uppercase; }.search-main h1 { margin: 0; font-size: clamp(2rem, 9vw, 2.55rem); letter-spacing: -.045em; }.intro { margin: 8px 0 18px; color: var(--ion-color-medium); line-height: 1.45; }.search-form { display: grid; gap: 12px; }.search-form label { display: grid; gap: 6px; font-size: .82rem; font-weight: 650; }.search-form input, .search-form select { min-height: 44px; width: 100%; box-sizing: border-box; border: 1px solid color-mix(in srgb, var(--su-divider) 54%, transparent); border-radius: 12px; padding: 9px 11px; background: var(--su-surface); color: var(--su-text); font: inherit; }.search-form select[multiple] { min-height: 92px; }.search-form details { border-radius: 14px; background: color-mix(in srgb, var(--su-lilac) 56%, var(--su-surface)); }.search-form summary { min-height: 44px; padding: 12px; font-weight: 650; cursor: pointer; }.filter-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; padding: 0 12px 12px; }.filter-grid label:first-child, .filter-grid label:nth-child(2), .filter-grid label:nth-child(3) { grid-column: 1 / -1; }.search-form ion-button { min-height: 44px; margin: 0; }.results-heading { display: flex; align-items: baseline; justify-content: space-between; margin-top: 24px; }.results-heading h2 { margin: 0; font-size: 1.15rem; }.results-heading span { color: var(--ion-color-medium); font-size: .84rem; }.coverage { margin: 8px 0; color: var(--su-category-fg); font-size: .82rem; }.result-list { margin: 0; padding: 0; list-style: none; }.result-list li { border-top: 1px solid color-mix(in srgb, var(--su-divider) 35%, transparent); }.result-list a { display: flex; min-height: 58px; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 0; color: inherit; text-decoration: none; }.result-list span { display: grid; gap: 3px; }.result-list small { color: var(--ion-color-medium); }.result-list b { flex: 0 0 auto; font-variant-numeric: tabular-nums; }.error { color: var(--su-owing); }.empty { padding: 32px 0; color: var(--ion-color-medium); text-align: center; }
@media (max-width: 360px) { .filter-grid { grid-template-columns: 1fr; }.filter-grid label { grid-column: 1 !important; } }
</style>
