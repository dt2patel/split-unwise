<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useRouter } from 'vue-router'
import { IonAvatar, IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonItem, IonLabel, IonList, IonNote, IonPage, IonSkeletonText, IonTitle, IonToolbar, onIonViewWillEnter } from '@ionic/vue'
import { add, chevronDown, chevronForward, chevronUp, copyOutline, peopleOutline } from 'ionicons/icons'
import { useGroupStore } from '../groups/groupStore'
import { getAppSession } from '../../data/session'
import { createClientOperationId } from '../../data/clientOperationId'
import { getActiveRuntimeConfiguration } from '../../data/firebase'
import { createSparkFriendship } from '../../data/firebaseSparkMutations'
import { loadCurrencyPreferences, SUPPORTED_CURRENCIES } from '../account/currencyPreferences'
import { sharePreparedInvitation } from '../invitations/shareInvitation'
import type { PreparedInvitation } from '../invitations/invitations'
import MoneyAmount, { type DebtDirection } from '../../components/MoneyAmount.vue'
import type { AccountFriendBalance, FriendBalanceBreakdown, SignedCurrencyPosition } from '../../domain/accountBalances'
import { useAccountBalanceStore } from '../home/accountBalanceStore'
import { compareFirestoreStrings } from '../../data/timeline'
import type { Group } from '../../data/repositories'
import { useI18n } from '../../app/i18n'
import { displayMessageText } from '../../app/displayMessages'

interface UnavailableFriendContext {
  readonly contextId: string
  readonly contextName: string
  readonly contextKind: 'friendship'
  readonly currency: Group['currency']
}

interface FriendListItem extends AccountFriendBalance { readonly unavailableContexts?: readonly UnavailableFriendContext[] }

const store = useGroupStore()
const balanceStore = useAccountBalanceStore()
const { t } = useI18n()
const { groups, currentUser, error, isLoading } = storeToRefs(store)
const { projection, isLoading: balancesLoading, notice: balanceNotice } = storeToRefs(balanceStore)
const session = getAppSession()
const router = useRouter()
const groupError = computed(() => {
  return displayMessageText(error.value, t)
})
const balanceNoticeCopy = computed(() => balanceNotice.value === 'partial'
  ? t('home.balancePartial')
  : balanceNotice.value === 'unavailable' ? t('home.balanceUnavailable') : undefined)
const friends = computed<readonly FriendListItem[]>(() => {
  const result: FriendListItem[] = projection.value.friends.map((friend) => ({ ...friend }))
  const represented = new Set(result.flatMap((friend) => [friend.directContextId, ...friend.breakdowns.map(({ contextId }) => contextId)].filter((id): id is string => Boolean(id))))
  for (const group of groups.value.filter(({ kind }) => kind === 'friendship')) {
    if (represented.has(group.id)) continue
    const counterpartId = group.memberIds.find((id) => id !== currentUser.value?.id)
    const id = counterpartId ?? `pending:${group.id}`
    const unavailable = { contextId: group.id, contextName: group.name, contextKind: 'friendship' as const, currency: group.currency }
    const existing = result.findIndex((friend) => friend.id === id)
    if (existing >= 0) {
      const friend = result[existing]!
      result[existing] = {
        ...friend,
        directContextId: friend.directContextId ?? group.id,
        unavailableContexts: [...(friend.unavailableContexts ?? []), unavailable],
      }
      continue
    }
    result.push({
      id,
      displayName: group.name,
      initials: initialsFor(group.name),
      pending: group.memberIds.length < 2,
      directContextId: group.id,
      positions: [],
      breakdowns: [],
      unavailableContexts: [unavailable],
    })
  }
  return result.sort((left, right) => compareFirestoreStrings(left.displayName, right.displayName) || compareFirestoreStrings(left.id, right.id))
})
const expandedFriendId = ref<string>()
const showingCreate = ref(false)
const displayName = ref('')
const email = ref('')
const currency = ref('USD')
const creating = ref(false)
const createError = ref('')
const invitation = ref<PreparedInvitation>()
const notice = ref('')

onMounted(async () => {
  currency.value = loadCurrencyPreferences(await session.principal).defaultCurrency
  await store.loadOverview()
  if (currentUser.value) await balanceStore.load(groups.value, currentUser.value.id)
})
onIonViewWillEnter(() => {
  if (currentUser.value && groups.value.length > 0) void balanceStore.load(groups.value, currentUser.value.id, { force: true })
})

function toggleFriend(friend: AccountFriendBalance): void { expandedFriendId.value = expandedFriendId.value === friend.id ? undefined : friend.id }
function friendDomId(friend: AccountFriendBalance): string { return friend.directContextId ?? friend.id }
function friendStatus(friend: AccountFriendBalance): string {
  if (friend.pending) return 'Invitation pending'
  const count = new Set(friend.breakdowns.map(({ contextId }) => contextId)).size
  if (count === 0 && (friend as FriendListItem).unavailableContexts?.length) return balancesLoading.value ? 'Updating balance…' : 'Balance unavailable'
  if ((friend as FriendListItem).unavailableContexts?.length) return `Across ${count} ${count === 1 ? 'shared context' : 'shared contexts'} · some unavailable`
  return `Across ${count} ${count === 1 ? 'shared context' : 'shared contexts'}`
}
function direction(position: SignedCurrencyPosition | FriendBalanceBreakdown): DebtDirection { return position.minorAmount > 0 ? 'owed' : position.minorAmount < 0 ? 'owing' : 'settled' }
function directionLabel(position: SignedCurrencyPosition | FriendBalanceBreakdown): string { return position.minorAmount > 0 ? 'owes you' : position.minorAmount < 0 ? 'you owe' : 'settled' }
function absolute<T extends SignedCurrencyPosition | FriendBalanceBreakdown>(position: T): T { return { ...position, minorAmount: Math.abs(position.minorAmount) } }
function initialsFor(displayName: string): string { return displayName.trim().split(/\s+/u).filter(Boolean).slice(0, 2).map((part) => part.slice(0, 1).toUpperCase()).join('') || '?' }

async function createFriend(): Promise<void> {
  const name = displayName.value.trim()
  if (!name) { createError.value = 'Enter your friend’s name.'; return }
  if (!email.value.trim()) { createError.value = 'Enter the email your friend uses for Split Unwise.'; return }
  creating.value = true; createError.value = ''; notice.value = ''
  try {
    const runtime = getActiveRuntimeConfiguration()
    if (session.repository.mode !== 'firebase' || runtime.kind !== 'firebase') throw new Error('Sign in to add a friend.')
    const result = await createSparkFriendship(runtime.firebase, {
      operationId: createClientOperationId('friend'), displayName: name, email: email.value, currency: currency.value,
      canonicalOrigin: String(import.meta.env.VITE_CANONICAL_ORIGIN ?? 'https://split-unwise-aditya.web.app'),
    })
    if (result.status === 'invitation-required') {
      await store.loadOverview()
      await router.push(`/tabs/groups/${encodeURIComponent(result.groupId)}/invite`)
      return
    }
    invitation.value = result.invitation
    notice.value = `Private invitation ready for ${result.invitation.targetEmail}.`
    showingCreate.value = false
    await store.loadOverview()
    if (currentUser.value) await balanceStore.load(groups.value, currentUser.value.id, { force: true })
  } catch (reason) {
    createError.value = reason instanceof Error ? reason.message : 'Your friend could not be added.'
  } finally { creating.value = false }
}

async function shareInvitation(): Promise<void> {
  if (!invitation.value) return
  const result = await sharePreparedInvitation(invitation.value.link)
  notice.value = result.status === 'shared' ? 'Invitation shared.' : result.status === 'copied' ? 'Invitation copied.' : result.status === 'cancelled' ? 'Sharing cancelled.' : 'Select and copy the invitation link.'
}
</script>

<template>
  <ion-page>
    <ion-header translucent>
      <ion-toolbar>
        <ion-title>Friends</ion-title>
        <ion-buttons slot="end"><ion-button aria-label="Add friend" @click="showingCreate = !showingCreate"><ion-icon :icon="add" aria-hidden="true" /></ion-button></ion-buttons>
      </ion-toolbar>
    </ion-header>
    <ion-content :fullscreen="true">
      <main class="friends-page">
        <div class="friends-page__heading">
          <span class="friends-page__icon" aria-hidden="true"><ion-icon :icon="peopleOutline" /></span>
          <div><p>FRIEND BALANCES</p><h1>Friends</h1></div>
        </div>
        <p class="friends-page__intro">See what you owe each person across direct expenses and every shared group.</p>

        <form v-if="showingCreate" class="friend-form" @submit.prevent="createFriend">
          <label><span>Friend’s name</span><input v-model="displayName" autocomplete="name" maxlength="120" placeholder="Jordan Lee"></label>
          <label><span>Email</span><input v-model="email" type="email" inputmode="email" autocomplete="email" placeholder="jordan@example.com"></label>
          <label><span>Currency</span><select v-model="currency"><option v-for="code in SUPPORTED_CURRENCIES" :key="code" :value="code">{{ code }}</option></select></label>
          <p v-if="createError" role="alert">{{ createError }}</p>
          <div class="friend-form__actions"><ion-button type="button" fill="clear" @click="showingCreate = false">Cancel</ion-button><ion-button type="submit" shape="round" :disabled="creating">{{ creating ? 'Adding…' : 'Add friend' }}</ion-button></div>
        </form>

        <section v-if="invitation" class="invitation-ready" aria-labelledby="friend-invitation-title">
          <div><h2 id="friend-invitation-title">Invitation ready</h2><p>Send this private seven-day link to {{ invitation.targetEmail }}.</p></div>
          <ion-button shape="round" @click="shareInvitation"><ion-icon slot="start" :icon="copyOutline" />Share link</ion-button>
        </section>
        <p v-if="notice" class="friends-page__notice" role="status" aria-live="polite">{{ notice }}</p>
        <p v-if="isLoading" role="status">Loading friends…</p>
        <p v-else-if="groupError" role="alert">{{ groupError }}</p>
        <section v-else aria-labelledby="friend-list-title">
          <div class="section-title"><h2 id="friend-list-title">Your friends</h2><span>{{ friends.length }}</span></div>
          <p v-if="balanceNoticeCopy" class="friends-page__balance-notice" role="status">{{ balanceNoticeCopy }}</p>
          <div v-if="balancesLoading && friends.length === 0" class="friend-skeletons" aria-hidden="true"><ion-skeleton-text animated /><ion-skeleton-text animated /><ion-skeleton-text animated /></div>
          <p v-else-if="friends.length === 0" class="empty-friends">No shared balances yet. Add a friend or join a group to get started.</p>
          <ion-list v-else class="friend-list" lines="none">
            <div v-for="friend in friends" :key="friend.id" class="friend-entry">
              <ion-item
                class="friend-row"
                button
                :detail="false"
                :data-friend-id="friendDomId(friend)"
                :aria-expanded="expandedFriendId === friend.id"
                @click="toggleFriend(friend)"
              >
                <ion-avatar slot="start" class="friend-row__avatar"><img v-if="friend.avatarUrl" :src="friend.avatarUrl" alt=""><span v-else aria-hidden="true">{{ friend.initials }}</span></ion-avatar>
                <ion-label><strong>{{ friend.displayName }}</strong><ion-note>{{ friendStatus(friend) }}</ion-note></ion-label>
                <div slot="end" class="friend-row__end">
                  <div v-if="friend.positions.length" class="friend-row__amounts">
                    <MoneyAmount v-for="position in friend.positions" :key="position.currency" :money="absolute(position)" :direction="direction(position)" :label="directionLabel(position)" />
                  </div>
                  <ion-note v-else class="friend-row__unavailable">{{ balancesLoading ? 'Updating…' : 'Unavailable' }}</ion-note>
                  <ion-icon :icon="expandedFriendId === friend.id ? chevronUp : chevronDown" aria-hidden="true" />
                </div>
              </ion-item>
              <div v-if="expandedFriendId === friend.id" class="friend-breakdown" :data-breakdown-for="friend.id">
                <router-link v-for="item in friend.breakdowns" :key="`${item.contextId}:${item.currency}`" class="friend-breakdown__link" :to="`/tabs/groups/${encodeURIComponent(item.contextId)}`">
                  <span><strong>{{ item.contextName }}</strong><small>{{ item.contextKind === 'friendship' ? (friend.pending ? 'Invitation' : 'Direct expenses') : 'Shared group' }}</small></span>
                  <MoneyAmount :money="absolute(item)" :direction="direction(item)" :label="directionLabel(item)" />
                  <ion-icon :icon="chevronForward" aria-hidden="true" />
                </router-link>
                <router-link v-for="item in friend.unavailableContexts" :key="`unavailable:${item.contextId}`" class="friend-breakdown__link" :to="`/tabs/groups/${encodeURIComponent(item.contextId)}`">
                  <span><strong>{{ item.contextName }}</strong><small>{{ friend.pending ? 'Invitation' : 'Direct expenses' }}</small></span>
                  <small class="friend-breakdown__unavailable">{{ balancesLoading ? 'Updating balance…' : 'Balance unavailable' }}</small>
                  <ion-icon :icon="chevronForward" aria-hidden="true" />
                </router-link>
              </div>
            </div>
          </ion-list>
        </section>
      </main>
    </ion-content>
  </ion-page>
</template>

<style scoped>
.friends-page{box-sizing:border-box;width:min(100%,560px);margin:auto;padding:20px 18px 112px}.friends-page__heading{display:flex;align-items:center;gap:13px}.friends-page__icon{display:grid;width:52px;height:52px;place-items:center;border-radius:17px;background:var(--su-lilac);color:var(--ion-color-primary);font-size:1.45rem}.friends-page__heading p{margin:0 0 3px;color:var(--ion-color-primary);font-size:.68rem;font-weight:800;letter-spacing:.13em}.friends-page h1{margin:0;font-size:2rem;letter-spacing:-.045em}.friends-page__intro{margin:12px 0 22px;color:var(--ion-color-medium);line-height:1.45}.friend-form{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) 92px;gap:12px;margin-bottom:22px;padding:16px;border:1px solid color-mix(in srgb,var(--su-divider) 35%,transparent);border-radius:20px;background:var(--su-surface);box-shadow:0 14px 34px rgb(37 29 87 / 9%);transform-origin:top center}.friend-form label{display:grid;gap:6px;color:var(--ion-color-medium);font-size:.75rem;font-weight:650}.friend-form input,.friend-form select{box-sizing:border-box;width:100%;min-height:48px;padding:0 12px;border:1px solid color-mix(in srgb,var(--su-divider) 40%,transparent);border-radius:13px;background:var(--su-surface);color:var(--su-text);font:inherit;font-size:16px}.friend-form>p,.friend-form__actions{grid-column:1/-1}.friend-form>p{margin:0;color:var(--ion-color-danger);font-size:.8rem}.friend-form__actions{display:flex;justify-content:flex-end}.friend-form ion-button,.invitation-ready ion-button{min-height:44px;margin:0;text-transform:none}.invitation-ready{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 14px;padding:14px;border-radius:18px;background:var(--su-lilac);color:var(--su-text)}.invitation-ready h2,.invitation-ready p{margin:0}.invitation-ready h2{font-size:.95rem}.invitation-ready p{margin-top:3px;color:var(--ion-color-medium);font-size:.75rem;line-height:1.35}.friends-page__notice{margin:0 0 14px;color:var(--ion-color-primary);font-size:.8rem}.friends-page__balance-notice{margin:10px 0;color:var(--ion-color-medium);font-size:.78rem}.section-title{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--su-divider)}.section-title h2{font-size:1rem}.section-title span{display:grid;min-width:25px;height:25px;place-items:center;border-radius:999px;background:var(--su-lilac);color:var(--ion-color-primary);font-size:.72rem;font-weight:750}.friend-list{padding:0;background:transparent}.friend-entry{border-bottom:1px solid var(--su-divider)}.friend-row{--background:transparent;--border-color:transparent;--inner-padding-end:2px;--min-height:78px;--padding-start:0;color:var(--su-text)}.friend-row__avatar{display:grid;width:48px;height:48px;place-items:center;overflow:hidden;background:linear-gradient(145deg,var(--su-indigo),var(--ion-color-primary));color:#fff;font-size:.78rem;font-weight:800}.friend-row__avatar img{width:100%;height:100%;object-fit:cover}.friend-row ion-label{display:grid;min-width:0;gap:4px}.friend-row ion-label strong,.friend-row ion-label ion-note{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.friend-row ion-label ion-note{color:var(--ion-color-medium);font-size:.72rem}.friend-row__end{display:flex;min-width:92px;align-items:center;justify-content:flex-end;gap:8px}.friend-row__end>ion-icon{flex:0 0 auto;color:var(--ion-color-primary);font-size:1rem}.friend-row__amounts{display:grid;gap:3px;justify-items:end}.friend-row__unavailable{max-width:72px;color:var(--ion-color-medium);font-size:.67rem;text-align:right}.friend-row__amounts :deep(.money-amount__value),.friend-breakdown :deep(.money-amount__value){font-size:.84rem;font-weight:750}.friend-row__amounts :deep(.money-amount__direction),.friend-breakdown :deep(.money-amount__direction){font-size:.63rem}.friend-breakdown{display:grid;margin:0 0 10px 60px;padding:4px 10px;border-radius:14px;background:color-mix(in srgb,var(--su-lilac) 72%,transparent);transform-origin:top center}.friend-breakdown__link{display:grid;grid-template-columns:minmax(0,1fr) auto 18px;align-items:center;gap:10px;min-height:56px;color:inherit;text-decoration:none}.friend-breakdown__link+.friend-breakdown__link{border-top:1px solid color-mix(in srgb,var(--su-divider) 30%,transparent)}.friend-breakdown__link>span{display:grid;min-width:0;gap:3px}.friend-breakdown__link strong,.friend-breakdown__link small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.friend-breakdown__link small,.empty-friends{color:var(--ion-color-medium);font-size:.7rem}.friend-breakdown__unavailable{max-width:106px;text-align:right}.friend-breakdown__link>ion-icon{color:var(--ion-color-primary)}.friend-skeletons{display:grid;gap:10px;padding:12px 0}.friend-skeletons ion-skeleton-text{height:66px;margin:0;border-radius:15px}
@media(prefers-reduced-motion:no-preference){.friend-form{animation:friend-form-in 220ms cubic-bezier(.2,.8,.2,1) both}.friend-breakdown{animation:friend-breakdown-in 180ms cubic-bezier(.2,.8,.2,1) both}@keyframes friend-form-in{from{opacity:0;transform:translateY(-8px) scale(.985)}}@keyframes friend-breakdown-in{from{opacity:0;transform:translateY(-4px) scaleY(.98)}}}
@media(max-width:520px){.friend-form{grid-template-columns:1fr;padding:14px;border-radius:17px}.friend-form>p,.friend-form__actions{grid-column:1}.friend-form__actions{justify-content:stretch}.friend-form__actions ion-button{flex:1}.invitation-ready{align-items:stretch;flex-direction:column}.friend-breakdown{margin-left:54px}.friend-row__end{min-width:82px}}
@media(max-width:360px){.friends-page{padding-inline:14px}.friend-row__end{min-width:72px;gap:5px}.friend-breakdown{margin-left:0}.friend-breakdown__link{grid-template-columns:minmax(0,1fr) auto 14px}}
@media(prefers-reduced-motion:reduce){.friend-form,.friend-breakdown{animation:none}}
</style>
