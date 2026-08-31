<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { IonButton, IonContent, IonIcon, IonPage, IonSpinner } from '@ionic/vue'
import { peopleOutline, shieldCheckmarkOutline } from 'ionicons/icons'
import { captureInvitationFragment, consumeTransientInvitationSecret, productionInvitationCapability } from './invitations'
import { peekActiveAppSession } from '../../data/session'
import { getAuthService } from '../auth/authService'

const route = useRoute()
const invitationId = computed(() => String(route.params.invitationId ?? pathnameInvitationId()))
const state = ref<'loading' | 'preview' | 'sign-in' | 'server-required' | 'invalid'>('loading')
const message = ref('')

onMounted(() => {
  try {
    if (typeof location !== 'undefined' && location.hash) captureInvitationFragment(invitationId.value, location, history)
    const secret = consumeTransientInvitationSecret(invitationId.value)
    if (!secret) { state.value = 'invalid'; message.value = 'This invitation link is missing or has already been opened.'; return }
    const auth = getAuthService().getState()
    if (auth.status !== 'signed-in') { state.value = 'sign-in'; message.value = 'Sign in to inspect and accept this private invitation.'; return }
    const session = peekActiveAppSession()
    if (!session || session.repository.mode === 'firebase') { state.value = 'server-required'; message.value = productionInvitationCapability().reason; return }
    state.value = 'preview'; message.value = 'Demo invitation preview. Acceptance stays on this device and is not a production membership change.'
  } catch { state.value = 'invalid'; message.value = 'This invitation link is invalid.' }
})

function pathnameInvitationId(): string { return typeof location === 'undefined' ? '' : /^\/invite\/([^/]+)$/.exec(location.pathname)?.[1] ?? '' }
</script>

<template>
  <ion-page>
    <ion-content :fullscreen="true">
      <main class="landing">
        <div class="landing-icon"><ion-icon :icon="peopleOutline" /></div>
        <p class="kicker">SPLIT UNWISE INVITATION</p>
        <h1>Join a shared group</h1>
        <div v-if="state === 'loading'" role="status"><ion-spinner /><p>Checking invitation…</p></div>
        <template v-else>
          <p>{{ message }}</p>
          <p class="privacy"><ion-icon :icon="shieldCheckmarkOutline" /> The private token was removed from this browser’s address.</p>
          <ion-button v-if="state === 'sign-in'" router-link="/auth" expand="block" shape="round">Sign in to continue</ion-button>
          <ion-button v-else-if="state === 'preview'" router-link="/tabs/groups" expand="block" shape="round">Open demo groups</ion-button>
          <ion-button v-else router-link="/tabs/home" expand="block" fill="outline" shape="round">Go home</ion-button>
        </template>
      </main>
    </ion-content>
  </ion-page>
</template>

<style scoped>
.landing{box-sizing:border-box;display:grid;min-height:100%;align-content:center;gap:12px;width:min(100%,430px);margin:auto;padding:28px 22px;text-align:center}.landing-icon{display:grid;width:76px;height:76px;place-items:center;margin:0 auto 10px;border-radius:26px;background:linear-gradient(145deg,var(--ion-color-primary),var(--su-indigo));color:#fff;font-size:2rem;box-shadow:0 18px 36px rgb(66 44 181 / 24%)}.kicker{margin:0;color:var(--ion-color-primary)!important;font-size:.7rem!important;font-weight:800;letter-spacing:.12em}.landing h1{margin:0;font-size:2.2rem;letter-spacing:-.05em}.landing p{margin:0;color:var(--ion-color-medium);font-size:.9rem;line-height:1.5}.privacy{display:flex;align-items:center;justify-content:center;gap:6px;margin:12px 0!important;font-size:.74rem!important}.privacy ion-icon{color:var(--ion-color-primary);font-size:1rem}.landing ion-button{min-height:48px;margin-top:6px;text-transform:none}
</style>
