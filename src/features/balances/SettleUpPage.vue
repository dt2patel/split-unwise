<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useRoute, useRouter } from 'vue-router'
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonLabel,
  IonPage,
  IonSegment,
  IonSegmentButton,
  IonTitle,
  IonToolbar,
} from '@ionic/vue'
import { formatMoney } from '../../components/MoneyAmount.vue'
import { createClientOperationId } from '../../data/clientOperationId'
import { isStrictId } from '../../data/identifiers'
import type { SettlementBasis, SettlementMethod } from '../../data/repositories'
import type { Debt } from '../../domain/model'
import { fromMinorUnits, toMinorUnits } from '../../domain/money'
import { useMotion } from '../../composables/useMotion'
import {
  createPaymentHandoff,
  EMPTY_PAYMENT_PROVIDER_CONFIGURATION,
  type PaymentHandoff,
  type PaymentProviderConfiguration,
} from './paymentProviders'
import { useSettlementStore } from './settlementStore'
import { useSettlementOperationAnnouncement } from './useSettlementOperationAnnouncement'

type BalancePlan = SettlementBasis['kind']

const props = withDefaults(defineProps<{
  providerConfiguration?: PaymentProviderConfiguration
}>(), {
  providerConfiguration: () => EMPTY_PAYMENT_PROVIDER_CONFIGURATION,
})

const route = useRoute()
const router = useRouter()
const store = useSettlementStore()
const {
  balanceSnapshot,
  currentUser,
  error: storeError,
  group,
  isLoading,
  memberNames,
  pendingSettlements,
  settlements,
} = storeToRefs(store)
const { className: motionClass } = useMotion()
const selectedPlan = ref<BalancePlan>(queryPlan() ?? 'simplified')
const selectedCurrency = ref('')
const selectedBasisKey = ref('')
const amount = ref('')
const method = ref<SettlementMethod>('cash')
const occurredOn = ref(new Date().toISOString().slice(0, 10))
const note = ref('')
const outsidePaymentConfirmed = ref(false)
const validationError = ref('')
const isSubmitting = ref(false)
const amountInput = ref<HTMLInputElement>()
const operationAnnouncement = useSettlementOperationAnnouncement(pendingSettlements)

const groupId = computed(() => typeof route.params.groupId === 'string' && isStrictId(route.params.groupId) ? route.params.groupId : '')
const allCandidateDebts = computed(() => {
  const userId = currentUser.value?.id
  if (!userId || !balanceSnapshot.value) return []
  const eligibleIds = new Set(store.members.filter(({ accountStatus }) => accountStatus !== 'deleted').map(({ id }) => id))
  return balanceSnapshot.value[selectedPlan.value]
    .filter((debt) => debt.fromParticipantId === userId || debt.toParticipantId === userId)
    .filter((debt) => eligibleIds.has(debt.fromParticipantId) && eligibleIds.has(debt.toParticipantId))
})
const availableCurrencies = computed(() => {
  const currencies = [...new Set(allCandidateDebts.value.map((debt) => debt.money.currency))].sort()
  const defaultCurrency = group.value?.currency
  return defaultCurrency && currencies.includes(defaultCurrency)
    ? [defaultCurrency, ...currencies.filter((currency) => currency !== defaultCurrency)]
    : currencies
})
const candidateDebts = computed(() => allCandidateDebts.value.filter((debt) => debt.money.currency === selectedCurrency.value))
const selectedDebt = computed(() => candidateDebts.value.find((debt) => basisKey(selectedPlan.value, debt) === selectedBasisKey.value))
const selectedBasis = computed<SettlementBasis | undefined>(() => {
  const debt = selectedDebt.value
  return debt ? {
    kind: selectedPlan.value,
    senderId: debt.fromParticipantId,
    recipientId: debt.toParticipantId,
    currency: debt.money.currency,
    debtMinor: debt.money.minorAmount,
  } : undefined
})
const canSubmit = computed(() => Boolean(selectedBasis.value && outsidePaymentConfirmed.value && !isSubmitting.value))
const providerHandoffs = computed<readonly PaymentHandoff[]>(() => {
  const basis = selectedBasis.value
  if (!basis) return []
  if (currentUser.value?.id !== basis.senderId) {
    return unavailableProviderHandoffs('Only the payer can open a payment-provider link. Ask them to pay outside Split Unwise, then record it here after it happens.')
  }
  let minorAmount: number
  try {
    minorAmount = toMinorUnits(amount.value, basis.currency)
  } catch {
    return unavailableProviderHandoffs(`Enter a valid amount up to ${formatMoney({ currency: basis.currency, minorAmount: basis.debtMinor })} to open a payment-provider link.`)
  }
  if (!Number.isSafeInteger(minorAmount) || minorAmount <= 0 || minorAmount > basis.debtMinor) {
    return unavailableProviderHandoffs(`Enter a valid amount up to ${formatMoney({ currency: basis.currency, minorAmount: basis.debtMinor })} to open a payment-provider link.`)
  }
  return paymentProviders.map((provider) => createPaymentHandoff({
    provider,
    recipientId: basis.recipientId,
    money: { currency: basis.currency, minorAmount },
    note: note.value || `${group.value?.name ?? 'Group'} settlement`,
    configuration: props.providerConfiguration,
  }))
})

const paymentProviders = ['paypal', 'venmo'] as const

function unavailableProviderHandoffs(reason: string): readonly PaymentHandoff[] {
  return paymentProviders.map((provider) => ({ status: 'unavailable', provider, reason }))
}

watch(groupId, (id) => {
  selectedPlan.value = queryPlan() ?? 'simplified'
  selectedCurrency.value = ''
  selectedBasisKey.value = ''
  if (id) void store.loadGroup(id)
  else store.clear()
}, { immediate: true })

watch(availableCurrencies, (currencies) => {
  if (currencies.some((currency) => currency === selectedCurrency.value)) return
  const requested = queryScalar('currency')
  selectedCurrency.value = currencies.find((currency) => currency === requested) ?? currencies[0] ?? ''
}, { immediate: true })

watch(candidateDebts, (debts) => {
  if (!debts.length) {
    selectedBasisKey.value = ''
    amount.value = ''
    return
  }
  const current = debts.find((debt) => basisKey(selectedPlan.value, debt) === selectedBasisKey.value)
  const requested = debts.find(matchesQuery)
  const next = current ?? requested ?? debts[0]
  const nextKey = basisKey(selectedPlan.value, next)
  if (selectedBasisKey.value !== nextKey) {
    selectedBasisKey.value = nextKey
    amount.value = fromMinorUnits(next.money.minorAmount, next.money.currency)
  }
}, { immediate: true })

function selectPlan(plan: BalancePlan): void {
  if (selectedPlan.value === plan) return
  selectedPlan.value = plan
  selectedBasisKey.value = ''
}

function onSegmentChange(event: CustomEvent<{ value?: string | number }>): void {
  if (event.detail.value === 'simplified' || event.detail.value === 'pairwise') selectPlan(event.detail.value)
}

function selectDebt(debt: Debt): void {
  selectedBasisKey.value = basisKey(selectedPlan.value, debt)
  amount.value = fromMinorUnits(debt.money.minorAmount, debt.money.currency)
  validationError.value = ''
}

function memberName(memberId: string): string {
  return memberNames.value.get(memberId) ?? 'Unknown member'
}

function direction(debt: Debt, verb = 'pays'): string {
  return `${memberName(debt.fromParticipantId)} ${verb} ${memberName(debt.toParticipantId)}`
}

async function recordPayment(): Promise<void> {
  if (isSubmitting.value) return
  validationError.value = ''
  const basis = selectedBasis.value
  const snapshot = balanceSnapshot.value
  if (!basis || !snapshot || !groupId.value || !currentUser.value) {
    validationError.value = 'Reload current balances before recording a payment.'
    return
  }
  if (basis.senderId !== currentUser.value.id && basis.recipientId !== currentUser.value.id) {
    validationError.value = 'Choose a payment involving your account.'
    return
  }
  let minorAmount: number
  try {
    minorAmount = toMinorUnits(amount.value, basis.currency)
  } catch {
    await showAmountError('Enter a valid amount.')
    return
  }
  if (!Number.isSafeInteger(minorAmount) || minorAmount <= 0 || minorAmount > basis.debtMinor) {
    await showAmountError(`Enter a valid amount up to ${formatMoney({ currency: basis.currency, minorAmount: basis.debtMinor })}.`)
    return
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(occurredOn.value)) {
    validationError.value = 'Choose the date the outside payment happened.'
    return
  }
  if (!outsidePaymentConfirmed.value) {
    validationError.value = 'Confirm that this payment already happened outside Split Unwise.'
    return
  }

  isSubmitting.value = true
  const operationId = createClientOperationId('settlement-record')
  const saved = await store.recordPayment({
    kind: 'settlement.record',
    operationId,
    groupId: groupId.value,
    expectedBalanceRevision: snapshot.balanceRevision,
    basis,
    money: { currency: basis.currency, minorAmount },
    method: method.value,
    occurredOn: occurredOn.value,
    ...(note.value.trim() ? { note: note.value.trim() } : {}),
    outsidePaymentConfirmed: true,
  })
  isSubmitting.value = false
  if (!saved) return
  const record = settlements.value.find((settlement) => settlement.operationId === operationId)
  if (!record) {
    validationError.value = 'The saved payment is not yet available. Refresh balances before trying again.'
    return
  }
  await router.replace({ name: 'group-settlement-detail', params: { groupId: groupId.value, settlementId: record.settlementId } })
}

async function showAmountError(message: string): Promise<void> {
  validationError.value = message
  await nextTick()
  amountInput.value?.focus()
}

async function retry(operationId: string): Promise<void> {
  await store.retryOperation(operationId)
}

async function discard(operationId: string): Promise<void> {
  await store.discardOperation(operationId)
}

async function reloadOperation(): Promise<void> {
  if (groupId.value) await store.loadGroup(groupId.value)
}

async function dismiss(operationId: string): Promise<void> {
  await store.dismissOperation(operationId)
}

function queryPlan(): BalancePlan | undefined {
  return route.query.plan === 'pairwise' || route.query.plan === 'simplified' ? route.query.plan : undefined
}

function queryScalar(key: 'currency' | 'debtMinor' | 'recipientId' | 'senderId'): string | undefined {
  const value = route.query[key]
  return typeof value === 'string' ? value : undefined
}

function matchesQuery(debt: Debt): boolean {
  const requestedMinor = Number(queryScalar('debtMinor'))
  return queryPlan() === selectedPlan.value
    && queryScalar('senderId') === debt.fromParticipantId
    && queryScalar('recipientId') === debt.toParticipantId
    && queryScalar('currency') === debt.money.currency
    && Number.isSafeInteger(requestedMinor)
    && requestedMinor === debt.money.minorAmount
}

function basisKey(plan: BalancePlan, debt: Debt): string {
  return `${plan}:${debt.fromParticipantId}:${debt.toParticipantId}:${debt.money.currency}:${debt.money.minorAmount}`
}

function operationStatus(status: string): string {
  if (status === 'failed') return 'Failed'
  if (status === 'conflicted') return 'Conflict'
  if (status === 'succeeded') return 'Saved'
  return 'Pending'
}
</script>

<template>
  <ion-page class="settle-page" :class="motionClass">
    <ion-header translucent>
      <ion-toolbar>
        <ion-buttons slot="start">
          <ion-back-button :default-href="`/tabs/groups/${encodeURIComponent(groupId)}/balances`" text="Balances" />
        </ion-buttons>
        <ion-title>{{ group?.name ?? 'Settle up' }}</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content :fullscreen="true">
      <main class="settle-page__main">
        <p class="su-visually-hidden" role="status" aria-live="polite" aria-atomic="true" data-testid="settlement-operation-announcement">{{ operationAnnouncement }}</p>
        <header class="settle-page__heading">
          <p>Manual payment</p>
          <h1>Settle up</h1>
          <span id="outside-payment-copy" data-testid="outside-payment-copy">Record money that already happened outside Split Unwise.</span>
        </header>

        <p v-if="isLoading && !balanceSnapshot" role="status" class="settle-page__status">Loading current balances…</p>
        <p v-else-if="storeError && !balanceSnapshot" role="alert" class="settle-page__status settle-page__error">{{ storeError }}</p>

        <form v-else-if="balanceSnapshot" class="settle-form" @submit.prevent="recordPayment">
          <section class="settle-card" aria-labelledby="choose-balance-heading">
            <div class="settle-card__title">
              <div>
                <span>1</span>
                <h2 id="choose-balance-heading">Choose a balance</h2>
              </div>
              <small>Revision {{ balanceSnapshot.balanceRevision }}</small>
            </div>

            <ion-segment :value="selectedPlan" aria-label="Settlement balance basis" class="settle-form__segment" @ion-change="onSegmentChange">
              <ion-segment-button value="simplified" @click="selectPlan('simplified')"><ion-label>Simplified</ion-label></ion-segment-button>
              <ion-segment-button value="pairwise" @click="selectPlan('pairwise')"><ion-label>Pairwise</ion-label></ion-segment-button>
            </ion-segment>

            <label v-if="availableCurrencies.length > 1" class="field currency-picker">
              <span>Currency</span>
              <select v-model="selectedCurrency" data-testid="currency-selector" aria-label="Settlement currency">
                <option v-for="currency in availableCurrencies" :key="currency" :value="currency">{{ currency }}</option>
              </select>
            </label>

            <fieldset v-if="candidateDebts.length" class="basis-list">
              <legend class="su-visually-hidden">Payment direction</legend>
              <label v-for="debt in candidateDebts" :key="basisKey(selectedPlan, debt)" class="basis-option" :class="{ 'basis-option--selected': selectedBasisKey === basisKey(selectedPlan, debt) }">
                <input
                  v-model="selectedBasisKey"
                  type="radio"
                  name="settlement-basis"
                  :value="basisKey(selectedPlan, debt)"
                  @change="selectDebt(debt)"
                >
                <span class="basis-option__people" aria-hidden="true">{{ memberName(debt.fromParticipantId).charAt(0) }} → {{ memberName(debt.toParticipantId).charAt(0) }}</span>
                <span><strong>{{ direction(debt) }}</strong><small>{{ formatMoney(debt.money) }} remaining</small></span>
                <span aria-hidden="true">✓</span>
              </label>
            </fieldset>
            <p v-else class="settle-card__empty">You do not have a balance to settle in this view.</p>
          </section>

          <section v-if="selectedBasis" class="settle-card" aria-labelledby="payment-details-heading">
            <div class="settle-card__title">
              <div><span>2</span><h2 id="payment-details-heading">Payment details</h2></div>
            </div>
            <p data-testid="selected-direction" class="settle-form__direction">{{ direction(selectedDebt!) }}</p>

            <label class="field field--amount">
              <span>Amount ({{ selectedBasis.currency }})</span>
              <div>
                <span aria-hidden="true">{{ selectedBasis.currency }}</span>
                <input ref="amountInput" v-model="amount" data-testid="amount-input" inputmode="decimal" autocomplete="off" aria-describedby="amount-help" required>
              </div>
              <small id="amount-help">Up to {{ formatMoney({ currency: selectedBasis.currency, minorAmount: selectedBasis.debtMinor }) }}</small>
            </label>

            <div class="settle-form__row">
              <label class="field"><span>Method</span><select v-model="method"><option value="cash">Cash</option><option value="bank-transfer">Bank transfer</option><option value="payment-app">Payment app</option><option value="other">Other</option></select></label>
              <label class="field"><span>Date paid</span><input v-model="occurredOn" type="date" required></label>
            </div>
            <label class="field"><span>Note <small>optional</small></span><textarea v-model="note" maxlength="500" rows="3" placeholder="What was this payment for?" /></label>
          </section>

          <section v-if="selectedBasis" class="settle-card provider-card" aria-labelledby="payment-apps-heading">
            <div class="settle-card__title"><div><span>↗</span><h2 id="payment-apps-heading">Pay outside the app</h2></div></div>
            <p>These links only open a configured provider. Returning here never records a payment.</p>
            <ul>
              <li v-for="handoff in providerHandoffs" :key="handoff.provider">
                <a v-if="handoff.status === 'available'" :href="handoff.url" target="_blank" rel="noopener noreferrer">{{ handoff.label }}</a>
                <span v-else>{{ handoff.reason }}</span>
              </li>
            </ul>
          </section>

          <label v-if="selectedBasis" class="confirmation-card">
            <input v-model="outsidePaymentConfirmed" data-testid="outside-payment-confirmation" type="checkbox">
            <span><strong>I confirm this payment already happened outside Split Unwise.</strong><small>This creates an audited ledger record; it does not move money.</small></span>
          </label>

          <p v-if="validationError" role="alert" class="settle-page__error">{{ validationError }}</p>
          <p v-else-if="storeError" role="alert" class="settle-page__error">{{ storeError }}</p>
          <ion-button v-if="selectedBasis" expand="block" type="submit" data-action="record-payment" :disabled="!canSubmit" @click="recordPayment">
            {{ isSubmitting ? 'Recording…' : 'Record payment' }}
          </ion-button>
        </form>

        <section v-if="pendingSettlements.length" class="operations" aria-labelledby="operations-heading">
          <h2 id="operations-heading">Payment updates</h2>
          <article v-for="operation in pendingSettlements" :key="operation.operationId" :data-operation-id="operation.operationId" :data-status="operation.status">
            <div><strong>{{ operationStatus(operation.status) }}</strong><small>{{ operation.error ?? 'Saving this ledger update.' }}</small></div>
            <div v-if="operation.status === 'failed'" class="operations__actions">
              <button type="button" data-action="retry-operation" :disabled="!operation.retryable" @click="retry(operation.operationId)">Retry</button>
              <button type="button" data-action="discard-operation" @click="discard(operation.operationId)">Discard</button>
            </div>
            <div v-else-if="operation.status === 'conflicted'" class="operations__actions">
              <button type="button" data-action="reload-operation" @click="reloadOperation">Reload</button>
              <button type="button" data-action="dismiss-operation" @click="dismiss(operation.operationId)">Dismiss</button>
            </div>
          </article>
        </section>
      </main>
    </ion-content>
  </ion-page>
</template>

<style scoped>
.settle-page { background: var(--su-surface); }
.settle-page ion-toolbar { --min-height: 58px; --border-color: color-mix(in srgb, var(--su-divider) 38%, transparent); }
.settle-page__main { width: min(100%, 680px); margin: 0 auto; padding: 20px 16px calc(36px + env(safe-area-inset-bottom)); }
.settle-page__heading > p { margin: 0; color: var(--ion-color-primary); font-size: .72rem; font-weight: 720; letter-spacing: .08em; text-transform: uppercase; }
.settle-page__heading h1 { margin: 2px 0 6px; font-size: clamp(1.8rem, 7vw, 2.35rem); letter-spacing: -.045em; }
.settle-page__heading > span { color: var(--ion-color-medium); font-size: .87rem; line-height: 1.4; }
.settle-form { display: grid; gap: 14px; margin-top: 20px; }
.settle-card { padding: 16px; border: 1px solid color-mix(in srgb, var(--su-divider) 42%, transparent); border-radius: 18px; background: var(--su-surface); box-shadow: 0 5px 20px rgb(40 33 92 / 6%); }
.settle-card__title, .settle-card__title > div { display: flex; align-items: center; justify-content: space-between; gap: 9px; }
.settle-card__title > div > span { display: grid; width: 28px; height: 28px; place-items: center; border-radius: 9px; background: var(--su-lilac); color: var(--ion-color-primary); font-size: .75rem; font-weight: 800; }
.settle-card__title h2 { margin: 0; font-size: .98rem; }
.settle-card__title small { color: var(--ion-color-medium); font-size: .72rem; }
.settle-form__segment { min-height: 44px; margin-top: 14px; border-radius: 12px; background: color-mix(in srgb, var(--su-lilac) 48%, var(--su-surface)); }
.settle-form__segment ion-segment-button { min-height: 44px; --border-radius: 10px; --color-checked: var(--ion-color-primary); --indicator-color: var(--su-surface); text-transform: none; }
.currency-picker { margin-top: 12px; }
.basis-list { display: grid; gap: 8px; margin: 13px 0 0; padding: 0; border: 0; }
.basis-option { display: grid; min-height: 58px; grid-template-columns: auto 1fr auto; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid color-mix(in srgb, var(--su-divider) 42%, transparent); border-radius: 13px; cursor: pointer; transition: border-color var(--su-motion-fast), background-color var(--su-motion-fast); }
.basis-option--selected { border-color: color-mix(in srgb, var(--ion-color-primary) 55%, transparent); background: color-mix(in srgb, var(--su-lilac) 42%, var(--su-surface)); }
.basis-option:focus-within { border-color: var(--ion-color-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ion-color-primary) 18%, transparent); }
.basis-option input { position: absolute; width: 1px; height: 1px; opacity: 0; }
.basis-option__people { display: grid; min-width: 52px; min-height: 36px; place-items: center; border-radius: 11px; background: var(--su-lilac); color: var(--ion-color-primary); font-size: .7rem; font-weight: 750; }
.basis-option strong, .basis-option small { display: block; overflow-wrap: anywhere; }
.basis-option strong { font-size: .85rem; }
.basis-option small { margin-top: 2px; color: var(--ion-color-medium); font-size: .72rem; }
.basis-option > span:last-child { color: var(--ion-color-primary); opacity: 0; }
.basis-option--selected > span:last-child { opacity: 1; }
.settle-form__direction { margin: 15px 0 8px; font-size: .9rem; font-weight: 680; }
.settle-form__row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.field { display: grid; gap: 6px; margin-top: 11px; color: var(--ion-color-medium); font-size: .75rem; font-weight: 650; }
.field input, .field select, .field textarea { width: 100%; min-height: 44px; padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--su-divider) 70%, transparent); border-radius: 12px; outline: none; background: var(--su-surface); color: var(--ion-text-color); font: inherit; font-size: 16px; font-weight: 500; }
.field textarea { min-height: 74px; resize: vertical; }
.field input:focus, .field select:focus, .field textarea:focus { border-color: var(--ion-color-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ion-color-primary) 14%, transparent); }
.field--amount > div { position: relative; }
.field--amount > div > span { position: absolute; top: 50%; left: 12px; transform: translateY(-50%); color: var(--ion-color-primary); font-size: .73rem; font-weight: 750; }
.field--amount input { padding-left: 48px; font-variant-numeric: tabular-nums; }
.field > small, .field span small { color: var(--ion-color-medium); font-size: .72rem; font-weight: 450; }
.provider-card > p { margin: 10px 0; color: var(--ion-color-medium); font-size: .78rem; line-height: 1.4; }
.provider-card ul { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
.provider-card li { min-height: 44px; padding: 10px 12px; border-radius: 11px; background: color-mix(in srgb, var(--su-lilac) 32%, var(--su-surface)); font-size: .75rem; line-height: 1.35; }
.provider-card a { display: flex; min-width: 44px; min-height: 44px; align-items: center; color: var(--ion-color-primary); font-weight: 700; text-decoration: none; }
.confirmation-card { display: grid; min-height: 64px; grid-template-columns: auto 1fr; align-items: start; gap: 11px; padding: 13px; border: 1px solid color-mix(in srgb, var(--ion-color-primary) 30%, var(--su-divider)); border-radius: 15px; background: color-mix(in srgb, var(--su-lilac) 28%, var(--su-surface)); font-size: .78rem; line-height: 1.35; }
.confirmation-card input { width: 22px; height: 22px; margin: 0; accent-color: var(--ion-color-primary); }
.confirmation-card strong, .confirmation-card small { display: block; }
.confirmation-card small { margin-top: 3px; color: var(--ion-color-medium); }
.settle-form > ion-button { min-height: 48px; margin: 2px 0; --border-radius: 14px; font-weight: 720; text-transform: none; }
.settle-page__status { padding: 40px 8px; color: var(--ion-color-medium); text-align: center; }
.settle-page__error { margin: 0; color: var(--ion-color-danger); font-size: .8rem; line-height: 1.4; }
.settle-card__empty { margin: 16px 0 0; color: var(--ion-color-medium); font-size: .84rem; }
.operations { margin-top: 22px; }
.operations h2 { font-size: .9rem; }
.operations article { display: flex; min-height: 64px; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--su-divider) 42%, transparent); border-radius: 13px; }
.operations article + article { margin-top: 8px; }
.operations strong, .operations small { display: block; }
.operations strong { font-size: .8rem; }
.operations small { margin-top: 2px; color: var(--ion-color-medium); font-size: .7rem; }
.operations__actions { display: flex; gap: 6px; }
.operations button { min-width: 54px; min-height: 44px; border: 0; border-radius: 10px; background: var(--su-lilac); color: var(--ion-color-primary); font-weight: 700; }
@media (max-width: 400px) { .settle-form__row { grid-template-columns: 1fr; gap: 0; } .operations article { align-items: stretch; flex-direction: column; } .operations__actions button { flex: 1; } }
@media (prefers-reduced-motion: reduce) { .settle-page * { transition-duration: 0ms !important; animation-duration: 0ms !important; scroll-behavior: auto !important; } .field--amount > div > span { transform: translateY(-50%); } }
</style>
