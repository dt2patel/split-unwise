<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { IonButton, IonContent, IonIcon, IonPage, IonSpinner } from '@ionic/vue'
import { mailUnreadOutline, peopleOutline, refreshOutline, shieldCheckmarkOutline } from 'ionicons/icons'
import { captureInvitationFragment, consumeTransientInvitationSecret, hashInvitationSecret, peekTransientInvitationSecret } from './invitations'
import { peekActiveAppSession } from '../../data/session'
import { getAuthService } from '../auth/authService'
import { callSplitUnwiseFunction } from '../../data/firebaseCallables'
import { storeReturnPath } from '../auth/returnPath'
import { getActiveRuntimeConfiguration } from '../../data/firebase'
import { acceptSparkInvitation, inspectSparkInvitation } from '../../data/firebaseSparkMutations'

const route = useRoute()
const router = useRouter()
const invitationId = computed(() => String(route.params.invitationId ?? pathnameInvitationId()))
const authService = getAuthService()
const state = ref<'loading' | 'preview' | 'sign-in' | 'verification' | 'ready' | 'accepted' | 'invalid'>('loading')
const message = ref('')
const groupId = ref('')
const accepting = ref(false)
const verifying = ref(false)
const verificationEmail = ref('')
const actionStatus = ref('')

onMounted(async () => {
  if (typeof location !== 'undefined' && location.hash) captureInvitationFragment(invitationId.value, location, history)
  await inspectInvitation()
})

async function inspectInvitation(): Promise<void> {
  state.value = 'loading'; actionStatus.value = ''
  try {
    const secret = peekTransientInvitationSecret(invitationId.value)
    if (!secret) { state.value = 'invalid'; message.value = 'This invitation link is missing or has already been opened.'; return }
    const auth = authService.getState()
    if (auth.status !== 'signed-in') { state.value = 'sign-in'; message.value = 'Sign in to inspect and accept this private invitation.'; return }
    const session = peekActiveAppSession()
    if (!session) { state.value = 'invalid'; message.value = 'Your signed-in account is not ready.'; return }
    if (session.repository.mode === 'firebase') {
      const runtime = getActiveRuntimeConfiguration()
      if (runtime.kind !== 'firebase') throw new Error('Firebase is not ready for invitations.')
      const serviceInvitationId = runtime.functionsRegion ? invitationId.value : await hashInvitationSecret(secret)
      const preview = runtime.functionsRegion
        ? decodePreview(await callSplitUnwiseFunction('invitationInspect', { schemaVersion: 1, invitationId: serviceInvitationId, token: secret }))
        : await inspectSparkInvitation(runtime.firebase, serviceInvitationId, secret)
      groupId.value = preview.groupId
      state.value = preview.alreadyMember ? 'accepted' : 'ready'
      message.value = preview.alreadyMember ? `You already belong to ${preview.groupName}.` : `You’re invited to join ${preview.groupName}.`
      return
    }
    state.value = 'preview'; message.value = 'Demo invitation preview. Acceptance stays on this device and is not a production membership change.'
  } catch (reason) { handleInspectionFailure(reason) }
}

async function accept(): Promise<void> {
  const secret = peekTransientInvitationSecret(invitationId.value)
  if (!secret) { state.value = 'invalid'; message.value = 'This invitation has already been consumed.'; return }
  accepting.value = true
  try {
    const runtime = getActiveRuntimeConfiguration()
    if (runtime.kind !== 'firebase') throw new Error('Firebase is not ready for invitations.')
    const serviceInvitationId = runtime.functionsRegion ? invitationId.value : await hashInvitationSecret(secret)
    const result = runtime.functionsRegion
      ? decodeAccept(await callSplitUnwiseFunction('invitationAccept', { schemaVersion: 1, invitationId: serviceInvitationId, token: secret }, { replayProtected: true }))
      : await acceptSparkInvitation(runtime.firebase, serviceInvitationId, secret)
    consumeTransientInvitationSecret(invitationId.value)
    state.value = 'accepted'; groupId.value = result.groupId; message.value = 'You joined the group.'
    await router.replace(`/tabs/groups/${encodeURIComponent(result.groupId)}`)
  } catch { state.value = 'invalid'; message.value = 'This invitation could not be accepted.' } finally { accepting.value = false }
}
async function signIn(): Promise<void> { storeReturnPath(`/invite/${encodeURIComponent(invitationId.value)}`); await router.push('/auth') }
async function sendVerification(): Promise<void> {
  if (verifying.value) return
  verifying.value = true; actionStatus.value = ''
  try {
    await authService.sendVerification()
    actionStatus.value = 'Verification email sent. Open it, then return here and check again.'
  } catch (reason) { actionStatus.value = safeFailure(reason, 'The verification email could not be sent.') } finally { verifying.value = false }
}
async function recheckVerification(): Promise<void> {
  if (verifying.value) return
  verifying.value = true; actionStatus.value = ''
  try {
    const identity = await authService.refreshIdentity()
    verificationEmail.value = identity?.email ?? verificationEmail.value
    if (!identity?.emailVerified) { actionStatus.value = 'That email is not verified yet. Open the verification email, then check again.'; return }
    await inspectInvitation()
  } catch (reason) { actionStatus.value = safeFailure(reason, 'Email verification could not be checked.') } finally { verifying.value = false }
}
function handleInspectionFailure(reason: unknown): void {
  const failure = safeFailure(reason, '')
  const auth = authService.getState()
  if (/verified email/i.test(failure) && auth.status === 'signed-in' && !auth.identity.emailVerified) {
    verificationEmail.value = auth.identity.email ?? 'your account email'
    state.value = 'verification'
    message.value = `Verify ${verificationEmail.value} to accept this invitation.`
    return
  }
  state.value = 'invalid'
  message.value = /verified email/i.test(failure)
    ? 'This invitation was sent to a different verified email. Sign in with the invited account and open the link again.'
    : 'This invitation link is invalid, expired, or no longer available.'
}
function decodePreview(value: unknown): { groupId: string; groupName: string; alreadyMember: boolean } { if (!isRecord(value) || typeof value.groupId !== 'string' || typeof value.groupName !== 'string' || typeof value.alreadyMember !== 'boolean') throw new Error('Invalid invitation preview'); return { groupId: value.groupId, groupName: value.groupName, alreadyMember: value.alreadyMember } }
function decodeAccept(value: unknown): { groupId: string } { if (!isRecord(value) || typeof value.groupId !== 'string') throw new Error('Invalid invitation acceptance'); return { groupId: value.groupId } }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function pathnameInvitationId(): string { return typeof location === 'undefined' ? '' : /^\/invite\/([^/]+)$/.exec(location.pathname)?.[1] ?? '' }
function safeFailure(reason: unknown, fallback: string): string { return reason instanceof Error && reason.message ? reason.message : fallback }
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
          <section v-if="state === 'verification'" data-testid="invitation-verification-required" class="verification-card">
            <ion-icon :icon="mailUnreadOutline" aria-hidden="true" />
            <strong>Email verification required</strong>
            <p>{{ message }}</p>
            <ion-button data-testid="send-invitation-verification" expand="block" shape="round" :disabled="verifying" @click="sendVerification">Resend verification email</ion-button>
            <ion-button data-testid="recheck-invitation-verification" expand="block" fill="outline" shape="round" :disabled="verifying" @click="recheckVerification"><ion-icon slot="start" :icon="refreshOutline" aria-hidden="true" /> {{ verifying ? 'Checking…' : 'I’ve verified my email' }}</ion-button>
            <p v-if="actionStatus" role="status" aria-live="polite" class="verification-status">{{ actionStatus }}</p>
          </section>
          <p v-else>{{ message }}</p>
          <p class="privacy"><ion-icon :icon="shieldCheckmarkOutline" /> The private token was removed from this browser’s address.</p>
          <ion-button v-if="state === 'sign-in'" expand="block" shape="round" @click="signIn">Sign in to continue</ion-button>
          <ion-button v-else-if="state === 'ready'" expand="block" shape="round" :disabled="accepting" @click="accept">{{ accepting ? 'Joining…' : 'Join group' }}</ion-button>
          <ion-button v-else-if="state === 'accepted' && groupId" :router-link="`/tabs/groups/${groupId}`" expand="block" shape="round">Open group</ion-button>
          <ion-button v-else-if="state === 'preview'" router-link="/tabs/groups" expand="block" shape="round">Open demo groups</ion-button>
          <ion-button v-else router-link="/tabs/home" expand="block" fill="outline" shape="round">Go home</ion-button>
        </template>
      </main>
    </ion-content>
  </ion-page>
</template>

<style scoped>
.landing{box-sizing:border-box;display:grid;min-height:100%;align-content:center;gap:12px;width:min(100%,430px);margin:auto;padding:28px 22px;text-align:center}.landing-icon{display:grid;width:76px;height:76px;place-items:center;margin:0 auto 10px;border-radius:26px;background:linear-gradient(145deg,var(--ion-color-primary),var(--su-indigo));color:#fff;font-size:2rem;box-shadow:0 18px 36px rgb(66 44 181 / 24%)}.kicker{margin:0;color:var(--ion-color-primary)!important;font-size:.7rem!important;font-weight:800;letter-spacing:.12em}.landing h1{margin:0;font-size:2.2rem;letter-spacing:-.05em}.landing p{margin:0;color:var(--ion-color-medium);font-size:.9rem;line-height:1.5}.privacy{display:flex;align-items:center;justify-content:center;gap:6px;margin:12px 0!important;font-size:.74rem!important}.privacy ion-icon{color:var(--ion-color-primary);font-size:1rem}.landing ion-button{min-height:48px;margin-top:6px;text-transform:none}
.verification-card{display:grid;gap:10px;padding:17px;border:1px solid color-mix(in srgb,var(--ion-color-primary) 18%,var(--su-divider));border-radius:18px;background:color-mix(in srgb,var(--su-lilac) 34%,var(--su-surface));text-align:start}.verification-card>ion-icon{color:var(--ion-color-primary);font-size:1.5rem}.verification-card strong{font-size:1rem}.verification-card ion-button{margin:0}.verification-status{padding:9px 10px;border-radius:10px;background:var(--su-surface);color:var(--ion-color-primary)!important;font-size:.78rem!important}
</style>
