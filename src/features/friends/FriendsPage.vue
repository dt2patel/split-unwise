<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonPage, IonTitle, IonToolbar } from '@ionic/vue'
import { add, chevronForward, copyOutline, peopleOutline } from 'ionicons/icons'
import { useGroupStore } from '../groups/groupStore'
import { friendshipContexts } from '../../domain/expenseContexts'
import { getAppSession } from '../../data/session'
import { createClientOperationId } from '../../data/clientOperationId'
import { getActiveRuntimeConfiguration } from '../../data/firebase'
import { createSparkFriendship } from '../../data/firebaseSparkMutations'
import { loadCurrencyPreferences, SUPPORTED_CURRENCIES } from '../account/currencyPreferences'
import { sharePreparedInvitation } from '../invitations/shareInvitation'
import type { PreparedInvitation } from '../invitations/invitations'

const store = useGroupStore()
const { groups, error, isLoading } = storeToRefs(store)
const session = getAppSession()
const friends = computed(() => friendshipContexts(groups.value))
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
})

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
    invitation.value = result.invitation
    notice.value = `Private invitation ready for ${result.invitation.targetEmail}.`
    showingCreate.value = false
    await store.loadOverview()
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
          <div><p>DIRECT EXPENSES</p><h1>Friends</h1></div>
        </div>
        <p class="friends-page__intro">Split one-on-one expenses without creating a trip or household group.</p>

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
        <p v-else-if="error" role="alert">{{ error }}</p>
        <section v-else aria-labelledby="friend-list-title">
          <div class="section-title"><h2 id="friend-list-title">Your friends</h2><span>{{ friends.length }}</span></div>
          <p v-if="friends.length === 0" class="empty-friends">No direct expenses yet. Add a friend to get started.</p>
          <router-link v-for="friend in friends" :key="friend.id" :data-friend-id="friend.id" class="friend-row" :to="`/tabs/groups/${friend.id}`">
            <span class="friend-row__avatar" aria-hidden="true">{{ friend.name.trim().slice(0, 1).toUpperCase() }}</span>
            <span class="friend-row__copy"><strong>{{ friend.name }}</strong><small>{{ friend.memberIds.length < 2 ? 'Invitation pending' : 'Direct expenses' }} · {{ friend.currency }}</small></span>
            <ion-icon :icon="chevronForward" aria-hidden="true" />
          </router-link>
        </section>
      </main>
    </ion-content>
  </ion-page>
</template>

<style scoped>
.friends-page{box-sizing:border-box;width:min(100%,560px);margin:auto;padding:20px 18px 112px}.friends-page__heading{display:flex;align-items:center;gap:13px}.friends-page__icon{display:grid;width:52px;height:52px;place-items:center;border-radius:17px;background:var(--su-lilac);color:var(--ion-color-primary);font-size:1.45rem}.friends-page__heading p{margin:0 0 3px;color:var(--ion-color-primary);font-size:.68rem;font-weight:800;letter-spacing:.13em}.friends-page h1{margin:0;font-size:2rem;letter-spacing:-.045em}.friends-page__intro{margin:12px 0 22px;color:var(--ion-color-medium);line-height:1.45}.friend-form{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) 92px;gap:12px;margin-bottom:22px;padding:16px;border:1px solid color-mix(in srgb,var(--su-divider) 35%,transparent);border-radius:20px;background:var(--su-surface);box-shadow:0 14px 34px rgb(37 29 87 / 9%);transform-origin:top center}.friend-form label{display:grid;gap:6px;color:var(--ion-color-medium);font-size:.75rem;font-weight:650}.friend-form input,.friend-form select{box-sizing:border-box;width:100%;min-height:48px;padding:0 12px;border:1px solid color-mix(in srgb,var(--su-divider) 40%,transparent);border-radius:13px;background:var(--su-surface);color:var(--su-text);font:inherit;font-size:16px}.friend-form>p,.friend-form__actions{grid-column:1/-1}.friend-form>p{margin:0;color:var(--ion-color-danger);font-size:.8rem}.friend-form__actions{display:flex;justify-content:flex-end}.friend-form ion-button,.invitation-ready ion-button{min-height:44px;margin:0;text-transform:none}.invitation-ready{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 14px;padding:14px;border-radius:18px;background:var(--su-lilac);color:var(--su-text)}.invitation-ready h2,.invitation-ready p{margin:0}.invitation-ready h2{font-size:.95rem}.invitation-ready p{margin-top:3px;color:var(--ion-color-medium);font-size:.75rem;line-height:1.35}.friends-page__notice{margin:0 0 14px;color:var(--ion-color-primary);font-size:.8rem}.section-title{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--su-divider)}.section-title h2{font-size:1rem}.section-title span{display:grid;min-width:25px;height:25px;place-items:center;border-radius:999px;background:var(--su-lilac);color:var(--ion-color-primary);font-size:.72rem;font-weight:750}.friend-row{display:grid;grid-template-columns:52px minmax(0,1fr) 20px;align-items:center;gap:12px;min-height:78px;border-bottom:1px solid var(--su-divider);color:inherit;text-decoration:none}.friend-row__avatar{display:grid;width:48px;height:48px;place-items:center;border-radius:50%;background:linear-gradient(145deg,var(--su-indigo),var(--ion-color-primary));color:#fff;font-weight:750}.friend-row__copy{display:grid;min-width:0;gap:4px}.friend-row__copy strong,.friend-row__copy small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.friend-row__copy small,.empty-friends{color:var(--ion-color-medium)}.friend-row>ion-icon{color:var(--ion-color-primary)}
@media(prefers-reduced-motion:no-preference){.friend-form{animation:friend-form-in 220ms cubic-bezier(.2,.8,.2,1) both}@keyframes friend-form-in{from{opacity:0;transform:translateY(-8px) scale(.985)}}}
@media(max-width:520px){.friend-form{grid-template-columns:1fr;padding:14px;border-radius:17px}.friend-form>p,.friend-form__actions{grid-column:1}.friend-form__actions{justify-content:stretch}.friend-form__actions ion-button{flex:1}.invitation-ready{align-items:stretch;flex-direction:column}}
@media(prefers-reduced-motion:reduce){.friend-form{animation:none}}
</style>
