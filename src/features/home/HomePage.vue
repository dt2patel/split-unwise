<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import {
  IonAvatar,
  IonButton,
  IonButtons,
  IonCard,
  IonCardContent,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonPage,
  IonSkeletonText,
  IonTitle,
  IonToolbar,
  onIonViewWillEnter,
} from '@ionic/vue'
import { chevronForward, peopleOutline, searchOutline } from 'ionicons/icons'
import { useI18n } from '../../app/i18n'
import MoneyAmount, { formatMoney, type DebtDirection } from '../../components/MoneyAmount.vue'
import type { AccountFriendBalance, SignedCurrencyPosition } from '../../domain/accountBalances'
import { friendshipContexts, groupContexts } from '../../domain/expenseContexts'
import { compareFirestoreStrings } from '../../data/timeline'
import { useGroupStore } from '../groups/groupStore'
import { useAccountBalanceStore } from './accountBalanceStore'
import { displayMessageText } from '../../app/displayMessages'

const groupStore = useGroupStore()
const balanceStore = useAccountBalanceStore()
const { t } = useI18n()
const { groups, currentUser, error, isLoading } = storeToRefs(groupStore)
const { projection, isLoading: balancesLoading, notice: balanceNotice } = storeToRefs(balanceStore)
const groupError = computed(() => {
  return displayMessageText(error.value, t)
})
const balanceNoticeCopy = computed(() => balanceNotice.value === 'partial'
  ? t('home.balancePartial')
  : balanceNotice.value === 'unavailable' ? t('home.balanceUnavailable') : undefined)
const recentGroups = computed(() => groupContexts(groups.value))
const directFriendCount = computed(() => friendshipContexts(groups.value).length)
const balanceByGroup = computed(() => new Map(projection.value.groups.map((balance) => [balance.groupId, balance])))
const homeFriends = computed(() => [...projection.value.friends].sort((left, right) => {
  const unsettled = Number(hasOpenBalance(right)) - Number(hasOpenBalance(left))
  return unsettled || compareFirestoreStrings(left.displayName, right.displayName) || compareFirestoreStrings(left.id, right.id)
}))

onMounted(() => { void loadPage() })
onIonViewWillEnter(() => {
  if (currentUser.value && groups.value.length > 0) void balanceStore.load(groups.value, currentUser.value.id, { force: true })
})

async function loadPage(): Promise<void> {
  await groupStore.loadOverview()
  if (currentUser.value) await balanceStore.load(groups.value, currentUser.value.id)
}

function direction(position: SignedCurrencyPosition): DebtDirection {
  return position.minorAmount > 0 ? 'owed' : position.minorAmount < 0 ? 'owing' : 'settled'
}

function directionLabel(position: SignedCurrencyPosition): string {
  return position.minorAmount > 0 ? t('home.direction.owesYou') : position.minorAmount < 0 ? t('home.direction.youOwe') : t('home.direction.settled')
}

function groupDirectionLabel(position: SignedCurrencyPosition): string {
  return position.minorAmount > 0 ? t('home.direction.youAreOwed') : position.minorAmount < 0 ? t('home.direction.youOwe') : t('home.direction.settled')
}

function overallLabel(netMinor: number): string {
  return netMinor > 0 ? t('home.overallOwed') : netMinor < 0 ? t('home.overallOwing') : t('home.overallSettled')
}

function friendStatus(friend: AccountFriendBalance): string {
  if (friend.pending) return t('home.invitationPending')
  const groups = new Set(friend.breakdowns.map(({ contextId }) => contextId)).size
  return t(groups === 1 ? 'home.sharedContext.one' : 'home.sharedContext.other', { count: groups })
}

function friendSummary(): string {
  const friends = projection.value.friends.length
  if (friends) return t(friends === 1 ? 'home.friendAcrossGroups.one' : 'home.friendAcrossGroups.other', { count: friends })
  if (directFriendCount.value) return t(directFriendCount.value === 1 ? 'home.directFriendship.one' : 'home.directFriendship.other', { count: directFriendCount.value })
  return t('home.addSomeone')
}

function memberCount(count: number): string { return t(count === 1 ? 'home.member.one' : 'home.member.other', { count }) }

function friendDestination(friend: AccountFriendBalance): string {
  const open = friend.breakdowns.find(({ minorAmount }) => minorAmount !== 0)
  const groupId = friend.directContextId ?? open?.contextId ?? friend.breakdowns[0]?.contextId
  return groupId ? `/tabs/groups/${encodeURIComponent(groupId)}` : '/tabs/home/friends'
}

function hasOpenBalance(friend: AccountFriendBalance): boolean { return friend.positions.some(({ minorAmount }) => minorAmount !== 0) }
function absolute(position: SignedCurrencyPosition): SignedCurrencyPosition { return { ...position, minorAmount: Math.abs(position.minorAmount) } }
</script>

<template>
  <ion-page>
    <ion-header translucent>
      <ion-toolbar>
        <ion-title>Split Unwise</ion-title>
        <ion-buttons slot="end"><ion-button class="home-search-button" router-link="/tabs/home/search" :aria-label="t('home.searchExpenses')"><ion-icon :icon="searchOutline" aria-hidden="true" /></ion-button></ion-buttons>
      </ion-toolbar>
    </ion-header>
    <ion-content :fullscreen="true">
      <main class="browse-page">
        <p class="browse-page__eyebrow">{{ currentUser ? t('home.welcomeBack', { name: currentUser.displayName }) : t('home.sharedExpenses') }}</p>
        <h1>{{ t('home.title') }}</h1>
        <p class="browse-page__intro">{{ t('home.intro') }}</p>

        <p v-if="isLoading" role="status">{{ t('home.loadingGroups') }}</p>
        <p v-else-if="groupError" role="alert">{{ groupError }}</p>
        <template v-else>
          <ion-card v-if="projection.currencies.length" class="balance-card" data-testid="account-summary" :aria-label="t('home.accountBalance')">
            <ion-card-content>
              <div v-for="balance in projection.currencies" :key="balance.currency" class="balance-card__currency">
                <div class="balance-card__headline">
                  <p>{{ t('home.currencyBalance', { currency: balance.currency }) }}</p>
                  <span>{{ overallLabel(balance.netMinor) }}</span>
                  <strong :class="balance.netMinor > 0 ? 'is-owed' : balance.netMinor < 0 ? 'is-owing' : ''">{{ formatMoney({ currency: balance.currency, minorAmount: Math.abs(balance.netMinor) }) }}</strong>
                </div>
                <dl class="balance-card__details">
                  <div><dt>{{ t('home.youOwe') }}</dt><dd class="is-owing">{{ formatMoney({ currency: balance.currency, minorAmount: balance.userOwesMinor }) }}</dd></div>
                  <div><dt>{{ t('home.youAreOwed') }}</dt><dd class="is-owed">{{ formatMoney({ currency: balance.currency, minorAmount: balance.owedToUserMinor }) }}</dd></div>
                </dl>
              </div>
              <small v-if="balancesLoading" class="balance-card__updating" role="status">{{ t('home.updatingBalances') }}</small>
            </ion-card-content>
          </ion-card>
          <ion-card v-else-if="balancesLoading" class="balance-card balance-card--loading" data-testid="account-summary" :aria-label="t('home.loadingAccountBalance')">
            <ion-card-content><ion-skeleton-text animated style="width: 34%" /><ion-skeleton-text animated style="width: 72%; height: 28px" /><ion-skeleton-text animated style="width: 100%; height: 54px" /></ion-card-content>
          </ion-card>
          <ion-card v-else class="balance-card balance-card--settled" data-testid="account-summary" :aria-label="t('home.accountBalance')">
            <ion-card-content><p>{{ t('home.overallBalance') }}</p><h2>{{ t('home.allSettled') }}</h2><span>{{ t('home.addGroupFriend') }}</span></ion-card-content>
          </ion-card>
          <p v-if="balanceNoticeCopy" class="balance-notice" role="status">{{ balanceNoticeCopy }}</p>

          <section class="friends-card" aria-labelledby="friends-title">
            <div class="section-heading">
              <div><h2 id="friends-title">{{ t('home.friendsTitle') }}</h2><p>{{ friendSummary() }}</p></div>
              <router-link data-testid="friends-link" to="/tabs/home/friends">{{ t('home.viewAll') }} <ion-icon :icon="chevronForward" aria-hidden="true" /></router-link>
            </div>
            <ion-list v-if="homeFriends.length" class="context-list" lines="none">
              <ion-item v-for="friend in homeFriends.slice(0, 3)" :key="friend.id" :router-link="friendDestination(friend)" :data-testid="`friend-balance-${friend.id}`" detail>
                <ion-avatar slot="start" class="friend-avatar"><img v-if="friend.avatarUrl" :src="friend.avatarUrl" alt=""><span v-else aria-hidden="true">{{ friend.initials }}</span></ion-avatar>
                <ion-label><strong>{{ friend.displayName }}</strong><ion-note>{{ friendStatus(friend) }}</ion-note></ion-label>
                <div slot="end" class="position-stack">
                  <MoneyAmount v-for="position in friend.positions" :key="position.currency" :money="absolute(position)" :direction="direction(position)" :label="directionLabel(position)" />
                </div>
              </ion-item>
            </ion-list>
            <div v-else-if="balancesLoading" class="friends-skeleton" aria-hidden="true"><ion-skeleton-text animated /><ion-skeleton-text animated /></div>
          </section>

          <section aria-labelledby="recent-groups-title">
            <h2 id="recent-groups-title">{{ t('home.recentGroups') }}</h2>
            <ion-list class="context-list group-list" lines="none">
              <ion-item
                v-for="group in recentGroups"
                :key="group.id"
                :router-link="`/tabs/groups/${encodeURIComponent(group.id)}`"
                :data-testid="group.id === 'lake-house-weekend' ? 'lake-house-link' : undefined"
                detail
              >
                <ion-avatar slot="start" class="group-avatar"><img v-if="group.coverImageUrl" :src="group.coverImageUrl" alt=""><ion-icon v-else :icon="peopleOutline" aria-hidden="true" /></ion-avatar>
                <ion-label><strong>{{ group.name }}</strong><ion-note>{{ memberCount(group.memberIds.length) }}</ion-note></ion-label>
                <div slot="end" class="position-stack" :data-testid="`group-balance-${group.id}`">
                  <template v-if="balanceByGroup.get(group.id)">
                    <MoneyAmount v-for="position in balanceByGroup.get(group.id)!.positions" :key="position.currency" :money="absolute(position)" :direction="direction(position)" :label="groupDirectionLabel(position)" />
                  </template>
                  <small v-else>{{ balancesLoading ? t('home.calculating') : t('home.balanceUnavailable') }}</small>
                </div>
              </ion-item>
            </ion-list>
          </section>
        </template>
      </main>
    </ion-content>
  </ion-page>
</template>

<style scoped>
.browse-page{box-sizing:border-box;width:min(100%,620px);margin:auto;padding:20px 18px 112px}.browse-page__eyebrow{margin:0 0 5px;color:var(--su-accent);font-size:.82rem;font-weight:650}.browse-page h1{margin:0;font-size:2rem;letter-spacing:-.035em}.browse-page__intro{max-width:31rem;margin:8px 0 20px;color:var(--ion-color-medium);line-height:1.45}.browse-page h2{margin:0;font-size:1rem}.home-search-button{min-width:44px;min-height:44px}.balance-card{margin:0 0 24px;border:1px solid color-mix(in srgb,var(--su-accent) 26%,transparent);border-radius:22px;background:linear-gradient(145deg,color-mix(in srgb,var(--su-lilac) 92%,var(--su-surface)),var(--su-surface));box-shadow:0 16px 38px rgb(29 22 70 / 13%);color:var(--su-text)}.balance-card ion-card-content{padding:18px}.balance-card__currency+.balance-card__currency{margin-top:16px;padding-top:16px;border-top:1px solid color-mix(in srgb,var(--su-divider) 34%,transparent)}.balance-card__headline{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:4px 12px}.balance-card__headline p{grid-column:1/-1;margin:0;color:var(--ion-color-primary);font-size:.68rem;font-weight:800;letter-spacing:.13em;text-transform:uppercase}.balance-card__headline span{color:var(--ion-color-medium);font-size:.88rem}.balance-card__headline strong{max-width:100%;font-size:clamp(1.45rem,8vw,2.15rem);font-variant-numeric:tabular-nums;letter-spacing:-.045em;overflow-wrap:anywhere;text-align:end}.balance-card__details{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:16px 0 0}.balance-card__details>div{min-width:0;padding:10px 12px;border-radius:14px;background:color-mix(in srgb,var(--su-surface) 76%,transparent)}.balance-card__details dt{color:var(--ion-color-medium);font-size:.72rem}.balance-card__details dd{margin:3px 0 0;font-size:.95rem;font-weight:750;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.is-owed{color:var(--su-owed)!important}.is-owing{color:var(--su-owing)!important}.balance-card__updating{display:block;margin-top:10px;color:var(--ion-color-medium)}.balance-card--loading ion-skeleton-text{margin:9px 0;border-radius:8px}.balance-card--settled p,.balance-card--settled h2,.balance-card--settled span{margin:0}.balance-card--settled p{color:var(--ion-color-primary);font-size:.72rem;font-weight:800;text-transform:uppercase}.balance-card--settled h2{margin-top:5px;font-size:1.25rem}.balance-card--settled span{display:block;margin-top:4px;color:var(--ion-color-medium);font-size:.82rem;line-height:1.4}.balance-notice{margin:-14px 2px 20px;color:var(--ion-color-medium);font-size:.78rem}.friends-card{margin:0 0 26px;padding:15px 8px 6px;border-radius:20px;background:var(--su-lilac);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--su-divider) 18%,transparent)}.section-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:0 8px 8px}.section-heading p{margin:4px 0 0;color:var(--ion-color-medium);font-size:.76rem}.section-heading>a{display:flex;min-height:44px;align-items:center;gap:2px;color:var(--ion-color-primary);font-size:.8rem;font-weight:700;text-decoration:none}.context-list{padding:0;background:transparent}.context-list ion-item{--background:transparent;--border-color:color-mix(in srgb,var(--su-divider) 34%,transparent);--inner-padding-end:8px;--min-height:68px;--padding-start:8px;color:var(--su-text)}.group-list{margin-top:8px}.group-list ion-item{--min-height:78px;--padding-start:0;--inner-padding-end:2px}.friend-avatar,.group-avatar{display:grid;width:46px;height:46px;place-items:center;overflow:hidden;background:linear-gradient(145deg,var(--su-indigo),var(--ion-color-primary));color:#fff;font-size:.8rem;font-weight:800}.friend-avatar img,.group-avatar img{width:100%;height:100%;object-fit:cover}.group-avatar{width:54px;height:54px;border-radius:15px;background:var(--su-lilac);color:var(--ion-color-primary);font-size:1.3rem}.context-list ion-label{display:grid;min-width:0;gap:3px}.context-list ion-label strong,.context-list ion-label ion-note{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.context-list ion-label ion-note{color:var(--ion-color-medium);font-size:.74rem}.position-stack{display:grid;min-width:72px;gap:4px;justify-items:end}.position-stack :deep(.money-amount__value){font-size:.84rem;font-weight:750}.position-stack :deep(.money-amount__direction){font-size:.64rem}.position-stack>small{color:var(--ion-color-medium);font-size:.68rem;text-align:end}.friends-skeleton{display:grid;gap:8px;padding:6px 10px 12px}.friends-skeleton ion-skeleton-text{height:48px;margin:0;border-radius:13px}
@media(max-width:360px){.browse-page{padding-inline:14px}.balance-card ion-card-content{padding:15px}.balance-card__details{gap:7px}.balance-card__details>div{padding:9px}.position-stack{min-width:64px}.context-list ion-item{--inner-padding-end:4px}}
@media(prefers-reduced-motion:no-preference){.balance-card{animation:balance-card-in 240ms cubic-bezier(.2,.8,.2,1) both}@keyframes balance-card-in{from{opacity:0;transform:translateY(6px) scale(.99)}}}
@media(prefers-reduced-motion:reduce){.balance-card{animation:none}}
</style>
