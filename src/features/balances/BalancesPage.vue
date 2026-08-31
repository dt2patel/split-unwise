<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useRoute } from 'vue-router'
import {
  IonBackButton,
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
import { isStrictId } from '../../data/identifiers'
import type { Debt } from '../../domain/model'
import { useMotion } from '../../composables/useMotion'
import { useSettlementStore } from './settlementStore'

type BalancePlan = 'pairwise' | 'simplified'

const route = useRoute()
const store = useSettlementStore()
const { balanceSnapshot, currentUser, error, group, isLoading, memberNames } = storeToRefs(store)
const selectedPlan = ref<BalancePlan>('simplified')
const { className: motionClass } = useMotion()
const groupId = computed(() => typeof route.params.groupId === 'string' && isStrictId(route.params.groupId) ? route.params.groupId : '')
const debts = computed(() => balanceSnapshot.value?.[selectedPlan.value] ?? [])
const currencySections = computed(() => {
  const byCurrency = new Map<string, Debt[]>()
  for (const debt of debts.value) {
    const items = byCurrency.get(debt.money.currency) ?? []
    items.push(debt)
    byCurrency.set(debt.money.currency, items)
  }
  return [...byCurrency.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, items]) => ({ currency, items }))
})
const planLabel = computed(() => selectedPlan.value === 'simplified' ? 'Simplified' : 'Pairwise')

watch(groupId, (id) => {
  if (id) void store.loadGroup(id)
  else store.clear()
}, { immediate: true })

function selectPlan(plan: BalancePlan): void {
  selectedPlan.value = plan
}

function memberName(memberId: string): string {
  return memberNames.value.get(memberId) ?? 'Unknown member'
}

function debtSentence(debt: Debt): string {
  return `${memberName(debt.fromParticipantId)} owes ${memberName(debt.toParticipantId)} ${formatMoney(debt.money)}`
}

function canSettle(debt: Debt): boolean {
  return currentUser.value?.id === debt.fromParticipantId || currentUser.value?.id === debt.toParticipantId
}

function settleDestination(debt: Debt): string {
  const query = new URLSearchParams({
    plan: selectedPlan.value,
    senderId: debt.fromParticipantId,
    recipientId: debt.toParticipantId,
    currency: debt.money.currency,
    debtMinor: String(debt.money.minorAmount),
  })
  return `/tabs/groups/${encodeURIComponent(groupId.value)}/settle-up?${query.toString()}`
}
</script>

<template>
  <ion-page class="balances-page" :class="motionClass">
    <ion-header translucent>
      <ion-toolbar>
        <ion-buttons slot="start">
          <ion-back-button :default-href="`/tabs/groups/${encodeURIComponent(groupId)}`" text="Back" />
        </ion-buttons>
        <ion-title>{{ group?.name ?? 'Balances' }}</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content :fullscreen="true">
      <main class="balances-page__main">
        <div class="balances-page__heading">
          <div>
            <p class="balances-page__eyebrow">Group ledger</p>
            <h1>Balances</h1>
          </div>
          <p v-if="balanceSnapshot" data-testid="balance-revision">Balance revision {{ balanceSnapshot.balanceRevision }}</p>
        </div>

        <p v-if="isLoading && !balanceSnapshot" role="status" class="balances-page__status">Loading balances…</p>
        <p v-else-if="error" role="alert" class="balances-page__status balances-page__status--error">{{ error }}</p>

        <template v-else-if="balanceSnapshot">
          <ion-segment :value="selectedPlan" aria-label="Balance view" class="balances-page__segment">
            <ion-segment-button value="simplified" @click="selectPlan('simplified')">
              <ion-label>Simplified</ion-label>
            </ion-segment-button>
            <ion-segment-button value="pairwise" @click="selectPlan('pairwise')">
              <ion-label>Pairwise</ion-label>
            </ion-segment-button>
          </ion-segment>

          <p class="balances-page__explanation">
            {{ selectedPlan === 'simplified' ? 'Fewer payments, without changing anyone’s net balance.' : 'Every direct balance created by the group ledger.' }}
          </p>

          <div v-if="currencySections.length" class="balances-page__currencies">
            <section
              v-for="section in currencySections"
              :key="section.currency"
              data-testid="currency-balance-section"
              class="balance-card"
              :aria-label="`${planLabel} ${section.currency} balances`"
            >
              <header class="balance-card__header">
                <h2>{{ section.currency }}</h2>
                <span>{{ section.items.length }} {{ section.items.length === 1 ? 'payment' : 'payments' }}</span>
              </header>
              <ul class="balance-card__list">
                <li v-for="debt in section.items" :key="`${debt.fromParticipantId}:${debt.toParticipantId}:${debt.money.currency}`">
                  <div class="balance-card__debt">
                    <span class="balance-card__avatars" aria-hidden="true">
                      <span>{{ memberName(debt.fromParticipantId).charAt(0) }}</span>
                      <span>{{ memberName(debt.toParticipantId).charAt(0) }}</span>
                    </span>
                    <span>{{ debtSentence(debt) }}</span>
                  </div>
                  <router-link
                    v-if="canSettle(debt)"
                    :to="settleDestination(debt)"
                    data-action="settle-debt"
                    class="balance-card__settle"
                    :aria-label="`Settle ${debtSentence(debt)}`"
                  >
                    Settle
                  </router-link>
                </li>
              </ul>
            </section>
          </div>
          <section v-else class="balances-page__settled" aria-live="polite">
            <span aria-hidden="true">✓</span>
            <h2>All settled up</h2>
            <p>No one owes anything in this balance view.</p>
          </section>
        </template>
      </main>
    </ion-content>
  </ion-page>
</template>

<style scoped>
.balances-page { background: var(--su-surface); }
.balances-page ion-toolbar { --min-height: 58px; --border-color: color-mix(in srgb, var(--su-divider) 38%, transparent); }
.balances-page__main { width: min(100%, 680px); min-height: 100%; margin: 0 auto; padding: 20px 16px calc(32px + env(safe-area-inset-bottom)); }
.balances-page__heading { display: flex; align-items: end; justify-content: space-between; gap: 16px; }
.balances-page__heading h1 { margin: 2px 0 0; font-size: clamp(1.8rem, 7vw, 2.35rem); letter-spacing: -0.045em; }
.balances-page__heading > p { margin: 0 0 4px; color: var(--ion-color-medium); font-size: .72rem; text-align: end; }
.balances-page__eyebrow { margin: 0; color: var(--ion-color-primary); font-size: .72rem; font-weight: 720; letter-spacing: .08em; text-transform: uppercase; }
.balances-page__segment { min-height: 46px; margin-top: 22px; border: 1px solid color-mix(in srgb, var(--su-divider) 38%, transparent); border-radius: 13px; background: color-mix(in srgb, var(--su-lilac) 48%, var(--su-surface)); }
.balances-page__segment ion-segment-button { min-height: 44px; --border-radius: 11px; --color: var(--ion-color-medium); --color-checked: var(--ion-color-primary); --indicator-color: var(--su-surface); text-transform: none; }
.balances-page__explanation { margin: 12px 4px 18px; color: var(--ion-color-medium); font-size: .84rem; line-height: 1.45; }
.balances-page__currencies { display: grid; gap: 14px; }
.balance-card { overflow: hidden; border: 1px solid color-mix(in srgb, var(--su-divider) 42%, transparent); border-radius: 18px; background: var(--su-surface); box-shadow: 0 5px 20px rgb(40 33 92 / 6%); }
.balance-card__header { display: flex; min-height: 48px; align-items: center; justify-content: space-between; padding: 0 15px; border-bottom: 1px solid color-mix(in srgb, var(--su-divider) 38%, transparent); background: color-mix(in srgb, var(--su-lilac) 28%, var(--su-surface)); }
.balance-card__header h2 { margin: 0; font-size: .92rem; letter-spacing: .04em; }
.balance-card__header span { color: var(--ion-color-medium); font-size: .75rem; }
.balance-card__list { margin: 0; padding: 0; list-style: none; }
.balance-card__list li { display: flex; min-height: 64px; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 12px; }
.balance-card__list li + li { border-top: 1px solid color-mix(in srgb, var(--su-divider) 34%, transparent); }
.balance-card__debt { display: flex; min-width: 0; align-items: center; gap: 10px; overflow-wrap: anywhere; font-size: .9rem; line-height: 1.35; }
.balance-card__avatars { position: relative; width: 48px; min-width: 48px; height: 34px; }
.balance-card__avatars span { position: absolute; display: grid; width: 34px; height: 34px; place-items: center; border: 2px solid var(--su-surface); border-radius: 50%; background: var(--su-lilac); color: var(--ion-color-primary); font-size: .73rem; font-weight: 750; }
.balance-card__avatars span:last-child { left: 14px; background: color-mix(in srgb, var(--su-mint) 78%, var(--su-surface)); color: var(--su-owed); }
.balance-card__settle { display: inline-grid; min-width: 58px; min-height: 44px; flex: 0 0 auto; place-items: center; border-radius: 12px; color: var(--ion-color-primary); font-size: .82rem; font-weight: 700; text-decoration: none; transition: background-color var(--su-motion-fast) ease; }
.balance-card__settle:active { background: var(--su-lilac); }
.balances-page__settled { margin-top: 26px; padding: 28px 18px; border: 1px solid color-mix(in srgb, var(--su-divider) 40%, transparent); border-radius: 18px; text-align: center; }
.balances-page__settled > span { display: grid; width: 44px; height: 44px; margin: 0 auto 10px; place-items: center; border-radius: 50%; background: var(--su-mint); color: var(--su-owed); }
.balances-page__settled h2 { margin: 0; font-size: 1rem; }
.balances-page__settled p, .balances-page__status { color: var(--ion-color-medium); }
.balances-page__status { padding: 40px 8px; text-align: center; }
.balances-page__status--error { color: var(--ion-color-danger); }
@media (max-width: 360px) { .balances-page__heading { align-items: start; flex-direction: column; gap: 4px; } .balances-page__heading > p { text-align: start; } .balance-card__list li { align-items: start; flex-direction: column; } .balance-card__settle { width: 100%; } }
@media (prefers-reduced-motion: reduce) { .balances-page * { transition-duration: 0ms !important; animation-duration: 0ms !important; } }
</style>
