<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useRoute } from 'vue-router'
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonPage,
  IonTitle,
  IonToolbar,
} from '@ionic/vue'
import { formatMoney } from '../../components/MoneyAmount.vue'
import { createClientOperationId } from '../../data/clientOperationId'
import { isStrictId } from '../../data/identifiers'
import { useMotion } from '../../composables/useMotion'
import { useSettlementStore } from './settlementStore'
import { useSettlementOperationAnnouncement } from './useSettlementOperationAnnouncement'

const route = useRoute()
const store = useSettlementStore()
const { balanceSnapshot, group, isLoading, memberNames, pendingSettlements, settlements } = storeToRefs(store)
const { className: motionClass } = useMotion()
const pageError = ref('')
const showVoidForm = ref(false)
const voidReason = ref('')
const voidError = ref('')
const isVoiding = ref(false)
const voidReasonInput = ref<HTMLTextAreaElement>()
let loadNumber = 0

const groupId = computed(() => typeof route.params.groupId === 'string' && isStrictId(route.params.groupId) ? route.params.groupId : '')
const settlementId = computed(() => typeof route.params.settlementId === 'string' && isStrictId(route.params.settlementId) ? route.params.settlementId : '')
const settlement = computed(() => settlements.value.find((record) => record.settlementId === settlementId.value))
const canVoid = computed(() => Boolean(settlement.value && store.canVoid(settlement.value)))
const matchingVoidOperations = computed(() => pendingSettlements.value.filter((operation) => operation.kind === 'void'
  && operation.settlementId === settlementId.value))
const voidOperations = computed(() => matchingVoidOperations.value.filter((operation) => operation.status === 'pending'
  || operation.status === 'failed' || operation.status === 'conflicted'))
const operationAnnouncement = useSettlementOperationAnnouncement(matchingVoidOperations)

watch(() => route.fullPath, () => { void load() }, { immediate: true })

async function load(): Promise<void> {
  const request = ++loadNumber
  pageError.value = ''
  showVoidForm.value = false
  voidReason.value = ''
  voidError.value = ''
  if (!groupId.value || !settlementId.value) {
    store.clear()
    pageError.value = 'Open this payment from a valid group link.'
    return
  }
  await store.loadGroup(groupId.value)
  if (request !== loadNumber) return
  if (!group.value) {
    pageError.value = 'This group is not available.'
    return
  }
  if (!settlement.value) pageError.value = 'Settlement not found.'
}

function memberName(memberId: string): string {
  return memberNames.value.get(memberId) ?? 'Unknown member'
}

function methodLabel(method: string): string {
  if (method === 'bank-transfer') return 'Bank transfer'
  if (method === 'payment-app') return 'Payment app'
  return method.charAt(0).toUpperCase() + method.slice(1)
}

function formatDate(date: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00.000Z`))
}

async function openVoidForm(): Promise<void> {
  showVoidForm.value = true
  voidError.value = ''
  await nextTick()
  voidReasonInput.value?.focus()
}

async function voidSettlement(): Promise<void> {
  if (isVoiding.value) return
  const record = settlement.value
  const snapshot = balanceSnapshot.value
  const reason = voidReason.value.normalize('NFC').trim()
  if (!record || !snapshot || !groupId.value || !canVoid.value) {
    voidError.value = 'Reload this payment before voiding it.'
    return
  }
  if (!reason) {
    voidError.value = 'Enter a reason for voiding this payment record.'
    await nextTick()
    voidReasonInput.value?.focus()
    return
  }
  isVoiding.value = true
  const saved = await store.voidSettlement({
    kind: 'settlement.void',
    operationId: createClientOperationId('settlement-void'),
    groupId: groupId.value,
    settlementId: record.settlementId,
    expectedRevision: record.revision,
    expectedBalanceRevision: snapshot.balanceRevision,
    reason,
  })
  isVoiding.value = false
  if (!saved) {
    voidError.value = store.error ?? 'This payment record could not be voided.'
    return
  }
  showVoidForm.value = false
  voidReason.value = ''
}

function operationStatus(status: string): string {
  if (status === 'failed') return 'Failed'
  if (status === 'conflicted') return 'Conflict'
  return 'Pending'
}

async function retryOperation(operationId: string): Promise<void> {
  await store.retryOperation(operationId)
}

async function discardOperation(operationId: string): Promise<void> {
  await store.discardOperation(operationId)
}

async function reloadOperation(): Promise<void> {
  await load()
}

async function dismissOperation(operationId: string): Promise<void> {
  await store.dismissOperation(operationId)
}
</script>

<template>
  <ion-page class="settlement-detail" :class="motionClass">
    <ion-header translucent>
      <ion-toolbar>
        <ion-buttons slot="start">
          <ion-back-button :default-href="`/tabs/groups/${encodeURIComponent(groupId)}/balances`" text="Balances" />
        </ion-buttons>
        <ion-title>Payment</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content :fullscreen="true">
      <main class="settlement-detail__main">
        <p class="su-visually-hidden" role="status" aria-live="polite" aria-atomic="true" data-testid="void-operation-announcement">{{ operationAnnouncement }}</p>
        <p v-if="isLoading && !group" role="status" class="settlement-detail__status">Loading payment…</p>
        <p v-else-if="pageError" role="alert" class="settlement-detail__status settlement-detail__error">{{ pageError }}</p>

        <template v-else-if="settlement">
          <header class="settlement-detail__heading">
            <p>{{ settlement.void ? 'Audited void' : 'Recorded payment' }}</p>
            <h1>Payment</h1>
          </header>

          <section class="payment-hero" :class="{ 'payment-hero--voided': settlement.void }" aria-labelledby="payment-direction">
            <span class="payment-hero__icon" aria-hidden="true">{{ settlement.void ? '×' : '✓' }}</span>
            <p id="payment-direction" data-testid="payment-direction">{{ memberName(settlement.senderId) }} paid {{ memberName(settlement.recipientId) }}</p>
            <strong>{{ formatMoney(settlement.money) }}</strong>
            <span>{{ formatDate(settlement.occurredOn) }} · {{ methodLabel(settlement.method) }}</span>
            <span v-if="settlement.void" data-testid="voided-state" class="payment-hero__voided">Voided</span>
          </section>

          <section class="audit-card" aria-labelledby="audit-heading">
            <h2 id="audit-heading">Record details</h2>
            <dl>
              <div><dt>Recorded by</dt><dd>{{ settlement.createdBy.displayName }}</dd></div>
              <div><dt>Ledger basis</dt><dd>{{ settlement.basis.kind === 'simplified' ? 'Simplified' : 'Pairwise' }} · {{ settlement.basis.currency }}</dd></div>
              <div><dt>Record revision</dt><dd>{{ settlement.revision }}</dd></div>
              <div v-if="settlement.note"><dt>Note</dt><dd>{{ settlement.note }}</dd></div>
            </dl>
          </section>

          <section v-if="settlement.void" class="voided-card" aria-labelledby="voided-heading">
            <h2 id="voided-heading">Void audit</h2>
            <p>{{ settlement.void.reason }}</p>
            <small>Voided by {{ settlement.void.actor.displayName }} · record revision {{ settlement.void.revision }}</small>
          </section>

          <section class="outside-notice" aria-label="Outside payment notice">
            <strong>Outside funds are unchanged</strong>
            <p>Voiding this ledger record does not cancel or refund money sent outside Split Unwise.</p>
          </section>

          <section v-if="voidOperations.length" class="settlement-operations" aria-labelledby="void-updates-heading">
            <h2 id="void-updates-heading">Void updates</h2>
            <article v-for="operation in voidOperations" :key="operation.operationId" :data-operation-id="operation.operationId" :data-status="operation.status">
              <div><strong>{{ operationStatus(operation.status) }}</strong><small>{{ operation.error ?? 'Saving this void request.' }}</small></div>
              <div v-if="operation.status === 'failed'" class="settlement-operations__actions">
                <button type="button" data-action="retry-operation" :disabled="!operation.retryable" @click="retryOperation(operation.operationId)">Retry</button>
                <button type="button" data-action="discard-operation" @click="discardOperation(operation.operationId)">Discard</button>
              </div>
              <div v-else-if="operation.status === 'conflicted'" class="settlement-operations__actions">
                <button type="button" data-action="reload-operation" @click="reloadOperation">Reload</button>
                <button type="button" data-action="dismiss-operation" @click="dismissOperation(operation.operationId)">Dismiss</button>
              </div>
              <button v-else type="button" data-action="reload-operation" @click="reloadOperation">Reload</button>
            </article>
          </section>

          <ion-button v-if="!settlement.void && canVoid && !showVoidForm" fill="outline" expand="block" color="danger" data-action="show-void-form" @click="openVoidForm">
            Void payment record
          </ion-button>

          <form v-if="!settlement.void && canVoid && showVoidForm" class="void-form" @submit.prevent="voidSettlement">
            <h2>Why is this record being voided?</h2>
            <label>
              <span>Reason</span>
              <textarea ref="voidReasonInput" v-model="voidReason" data-testid="void-reason" maxlength="500" rows="3" required />
            </label>
            <p v-if="voidError" role="alert" class="settlement-detail__error">{{ voidError }}</p>
            <div>
              <button type="button" :disabled="isVoiding" @click="showVoidForm = false">Cancel</button>
              <ion-button type="submit" color="danger" data-action="void-settlement" :disabled="isVoiding" @click="voidSettlement">{{ isVoiding ? 'Voiding…' : 'Void record' }}</ion-button>
            </div>
          </form>
        </template>
      </main>
    </ion-content>
  </ion-page>
</template>

<style scoped>
.settlement-detail { background: var(--su-surface); }
.settlement-detail ion-toolbar { --min-height: 58px; --border-color: color-mix(in srgb, var(--su-divider) 38%, transparent); }
.settlement-detail__main { width: min(100%, 620px); margin: 0 auto; padding: 20px 16px calc(36px + env(safe-area-inset-bottom)); }
.settlement-detail__heading > p { margin: 0; color: var(--ion-color-primary); font-size: .72rem; font-weight: 720; letter-spacing: .08em; text-transform: uppercase; }
.settlement-detail__heading h1 { margin: 2px 0 18px; font-size: clamp(1.8rem, 7vw, 2.35rem); letter-spacing: -.045em; }
.payment-hero { display: grid; justify-items: center; padding: 25px 16px; border: 1px solid color-mix(in srgb, var(--su-divider) 40%, transparent); border-radius: 20px; background: linear-gradient(145deg, color-mix(in srgb, var(--su-mint) 35%, var(--su-surface)), var(--su-surface)); text-align: center; }
.payment-hero__icon { display: grid; width: 42px; height: 42px; place-items: center; border-radius: 50%; background: var(--su-mint); color: var(--su-owed); font-size: 1.2rem; font-weight: 800; }
.payment-hero p { margin: 12px 0 4px; font-size: .92rem; font-weight: 680; }
.payment-hero > strong { color: var(--su-owed); font-size: 2rem; font-variant-numeric: tabular-nums; letter-spacing: -.035em; }
.payment-hero > span:not(.payment-hero__icon, .payment-hero__voided) { margin-top: 5px; color: var(--ion-color-medium); font-size: .76rem; }
.payment-hero--voided { background: color-mix(in srgb, var(--su-divider) 20%, var(--su-surface)); }
.payment-hero--voided .payment-hero__icon { background: color-mix(in srgb, var(--ion-color-danger) 12%, var(--su-surface)); color: var(--ion-color-danger); }
.payment-hero__voided { margin-top: 10px; padding: 4px 10px; border-radius: 999px; background: color-mix(in srgb, var(--ion-color-danger) 12%, var(--su-surface)); color: var(--ion-color-danger); font-size: .7rem; font-weight: 750; text-transform: uppercase; }
.audit-card, .voided-card, .outside-notice, .void-form, .settlement-operations { margin-top: 14px; padding: 15px; border: 1px solid color-mix(in srgb, var(--su-divider) 42%, transparent); border-radius: 16px; }
.audit-card h2, .voided-card h2, .void-form h2, .settlement-operations h2 { margin: 0 0 10px; font-size: .92rem; }
.audit-card dl { margin: 0; }
.audit-card dl > div { display: flex; min-height: 42px; align-items: center; justify-content: space-between; gap: 16px; }
.audit-card dl > div + div { border-top: 1px solid color-mix(in srgb, var(--su-divider) 32%, transparent); }
.audit-card dt { color: var(--ion-color-medium); font-size: .74rem; }
.audit-card dd { margin: 0; overflow-wrap: anywhere; font-size: .78rem; font-weight: 650; text-align: end; }
.voided-card { border-color: color-mix(in srgb, var(--ion-color-danger) 26%, var(--su-divider)); background: color-mix(in srgb, var(--ion-color-danger) 5%, var(--su-surface)); }
.voided-card p { margin: 0 0 6px; overflow-wrap: anywhere; font-size: .83rem; }
.voided-card small { color: var(--ion-color-medium); font-size: .7rem; }
.outside-notice { background: color-mix(in srgb, var(--su-lilac) 28%, var(--su-surface)); }
.outside-notice strong { font-size: .8rem; }
.outside-notice p { margin: 4px 0 0; color: var(--ion-color-medium); font-size: .75rem; line-height: 1.4; }
.settlement-operations article { display: flex; min-height: 58px; align-items: center; justify-content: space-between; gap: 10px; }
.settlement-operations article + article { border-top: 1px solid color-mix(in srgb, var(--su-divider) 32%, transparent); }
.settlement-operations strong, .settlement-operations small { display: block; }
.settlement-operations strong { font-size: .8rem; }
.settlement-operations small { margin-top: 2px; color: var(--ion-color-medium); font-size: .7rem; }
.settlement-operations__actions { display: flex; gap: 6px; }
.settlement-operations button { min-width: 62px; min-height: 44px; border: 0; border-radius: 10px; background: var(--su-lilac); color: var(--ion-color-primary); font-weight: 700; }
.settlement-detail__main > ion-button { min-height: 46px; margin-top: 16px; --border-radius: 13px; text-transform: none; }
.void-form label { display: grid; gap: 6px; color: var(--ion-color-medium); font-size: .75rem; font-weight: 650; }
.void-form textarea { min-height: 76px; padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--su-divider) 70%, transparent); border-radius: 12px; outline: none; background: var(--su-surface); color: var(--ion-text-color); font: inherit; font-size: 16px; resize: vertical; }
.void-form textarea:focus { border-color: var(--ion-color-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ion-color-primary) 14%, transparent); }
.void-form > div { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
.void-form button { min-width: 72px; min-height: 44px; border: 0; border-radius: 11px; background: var(--su-lilac); color: var(--ion-color-primary); font-weight: 700; }
.void-form ion-button { min-height: 44px; margin: 0; --border-radius: 11px; text-transform: none; }
.settlement-detail__status { padding: 44px 8px; color: var(--ion-color-medium); text-align: center; }
.settlement-detail__error { color: var(--ion-color-danger); font-size: .8rem; line-height: 1.4; }
@media (prefers-reduced-motion: reduce) { .settlement-detail * { transition-duration: 0ms !important; animation-duration: 0ms !important; } }
</style>
