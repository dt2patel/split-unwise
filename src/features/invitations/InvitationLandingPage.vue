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
import { useI18n } from '../../app/i18n'
import { displayMessageText, type ApplicationMessage } from '../../app/displayMessages'

type InvalidReason = 'missing' | 'account-not-ready' | 'consumed' | 'accept-failed' | 'different-email' | 'invalid'
type LandingState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'preview' }
  | { readonly kind: 'sign-in' }
  | { readonly kind: 'verification'; readonly email?: string }
  | { readonly kind: 'ready'; readonly groupId: string; readonly groupName: string }
  | { readonly kind: 'accepted'; readonly groupId: string; readonly reason: 'already-member'; readonly groupName: string }
  | { readonly kind: 'accepted'; readonly groupId: string; readonly reason: 'joined' }
  | { readonly kind: 'invalid'; readonly reason: InvalidReason }

const route = useRoute()
const router = useRouter()
const invitationId = computed(() => String(route.params.invitationId ?? pathnameInvitationId()))
const authService = getAuthService()
const { t } = useI18n()
const state = ref<LandingState>({ kind: 'loading' })
const accepting = ref(false)
const verifying = ref(false)
const actionStatus = ref<ApplicationMessage>()
const actionStatusCopy = computed(() => displayMessageText(actionStatus.value, t))
const groupId = computed(() => state.value.kind === 'ready' || state.value.kind === 'accepted' ? state.value.groupId : '')
const message = computed(() => {
  const current = state.value
  if (current.kind === 'preview') return t('inviteLanding.demoPreview')
  if (current.kind === 'sign-in') return t('inviteLanding.signInPrompt')
  if (current.kind === 'verification') return t('inviteLanding.verifyToAccept', { email: current.email ?? t('inviteLanding.accountEmail') })
  if (current.kind === 'ready') return t('inviteLanding.invited', { group: current.groupName })
  if (current.kind === 'accepted') return current.reason === 'already-member'
    ? t('inviteLanding.alreadyMember', { group: current.groupName })
    : t('inviteLanding.joined')
  if (current.kind === 'invalid') {
    const key = {
      missing: 'inviteLanding.missing',
      'account-not-ready': 'inviteLanding.accountNotReady',
      consumed: 'inviteLanding.consumed',
      'accept-failed': 'inviteLanding.acceptFailed',
      'different-email': 'inviteLanding.differentEmail',
      invalid: 'inviteLanding.invalid',
    } as const
    return t(key[current.reason])
  }
  return ''
})

onMounted(async () => {
  if (typeof location !== 'undefined' && location.hash) captureInvitationFragment(invitationId.value, location, history)
  await inspectInvitation()
})

async function inspectInvitation(): Promise<void> {
  state.value = { kind: 'loading' }; actionStatus.value = undefined
  try {
    const secret = peekTransientInvitationSecret(invitationId.value)
    if (!secret) { state.value = { kind: 'invalid', reason: 'missing' }; return }
    const auth = authService.getState()
    if (auth.status !== 'signed-in') { state.value = { kind: 'sign-in' }; return }
    const session = peekActiveAppSession()
    if (!session) { state.value = { kind: 'invalid', reason: 'account-not-ready' }; return }
    if (session.repository.mode === 'firebase') {
      const runtime = getActiveRuntimeConfiguration()
      if (runtime.kind !== 'firebase') throw new Error('Firebase is not ready for invitations.')
      const serviceInvitationId = runtime.functionsRegion ? invitationId.value : await hashInvitationSecret(secret)
      const preview = runtime.functionsRegion
        ? decodePreview(await callSplitUnwiseFunction('invitationInspect', { schemaVersion: 1, invitationId: serviceInvitationId, token: secret }))
        : await inspectSparkInvitation(runtime.firebase, serviceInvitationId, secret)
      state.value = preview.alreadyMember
        ? { kind: 'accepted', groupId: preview.groupId, reason: 'already-member', groupName: preview.groupName }
        : { kind: 'ready', groupId: preview.groupId, groupName: preview.groupName }
      return
    }
    state.value = { kind: 'preview' }
  } catch (reason) { handleInspectionFailure(reason) }
}

async function accept(): Promise<void> {
  const secret = peekTransientInvitationSecret(invitationId.value)
  if (!secret) { state.value = { kind: 'invalid', reason: 'consumed' }; return }
  accepting.value = true
  try {
    const runtime = getActiveRuntimeConfiguration()
    if (runtime.kind !== 'firebase') throw new Error('Firebase is not ready for invitations.')
    const serviceInvitationId = runtime.functionsRegion ? invitationId.value : await hashInvitationSecret(secret)
    const result = runtime.functionsRegion
      ? decodeAccept(await callSplitUnwiseFunction('invitationAccept', { schemaVersion: 1, invitationId: serviceInvitationId, token: secret }, { replayProtected: true }))
      : await acceptSparkInvitation(runtime.firebase, serviceInvitationId, secret)
    consumeTransientInvitationSecret(invitationId.value)
    state.value = { kind: 'accepted', groupId: result.groupId, reason: 'joined' }
    await router.replace(`/tabs/groups/${encodeURIComponent(result.groupId)}`)
  } catch { state.value = { kind: 'invalid', reason: 'accept-failed' } } finally { accepting.value = false }
}
async function signIn(): Promise<void> { storeReturnPath(`/invite/${encodeURIComponent(invitationId.value)}`); await router.push('/auth') }
async function sendVerification(): Promise<void> {
  if (verifying.value) return
  verifying.value = true; actionStatus.value = undefined
  try {
    await authService.sendVerification()
    actionStatus.value = { kind: 'application', key: 'inviteLanding.verificationSent' }
  } catch { actionStatus.value = { kind: 'application', key: 'inviteLanding.verificationSendFailed' } } finally { verifying.value = false }
}
async function recheckVerification(): Promise<void> {
  if (verifying.value) return
  verifying.value = true; actionStatus.value = undefined
  try {
    const identity = await authService.refreshIdentity()
    if (identity?.email && state.value.kind === 'verification') state.value = { kind: 'verification', email: identity.email }
    if (!identity?.emailVerified) { actionStatus.value = { kind: 'application', key: 'inviteLanding.notVerified' }; return }
    await inspectInvitation()
  } catch { actionStatus.value = { kind: 'application', key: 'inviteLanding.verificationCheckFailed' } } finally { verifying.value = false }
}
function handleInspectionFailure(reason: unknown): void {
  const auth = authService.getState()
  const failure = classifyInspectionFailure(reason, auth.status === 'signed-in' && !auth.identity.emailVerified)
  if (failure === 'verification-required' && auth.status === 'signed-in') {
    state.value = { kind: 'verification', ...(auth.identity.email ? { email: auth.identity.email } : {}) }
    return
  }
  state.value = { kind: 'invalid', reason: failure === 'different-email' ? 'different-email' : 'invalid' }
}
function decodePreview(value: unknown): { groupId: string; groupName: string; alreadyMember: boolean } { if (!isRecord(value) || typeof value.groupId !== 'string' || typeof value.groupName !== 'string' || typeof value.alreadyMember !== 'boolean') throw new Error('Invalid invitation preview'); return { groupId: value.groupId, groupName: value.groupName, alreadyMember: value.alreadyMember } }
function decodeAccept(value: unknown): { groupId: string } { if (!isRecord(value) || typeof value.groupId !== 'string') throw new Error('Invalid invitation acceptance'); return { groupId: value.groupId } }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function pathnameInvitationId(): string { return typeof location === 'undefined' ? '' : /^\/invite\/([^/]+)$/.exec(location.pathname)?.[1] ?? '' }
function classifyInspectionFailure(reason: unknown, needsVerification: boolean): 'verification-required' | 'different-email' | 'invalid' {
  const isVerifiedEmailFailure = reason instanceof Error && /verified email/i.test(reason.message)
  if (!isVerifiedEmailFailure) return 'invalid'
  return needsVerification ? 'verification-required' : 'different-email'
}
</script>

<template>
  <ion-page>
    <ion-content :fullscreen="true">
      <main class="landing">
        <div class="landing-icon"><ion-icon :icon="peopleOutline" /></div>
        <p class="kicker">{{ t('inviteLanding.kicker') }}</p>
        <h1>{{ t('inviteLanding.title') }}</h1>
        <div v-if="state.kind === 'loading'" role="status"><ion-spinner /><p>{{ t('inviteLanding.checking') }}</p></div>
        <template v-else>
          <section v-if="state.kind === 'verification'" data-testid="invitation-verification-required" class="verification-card">
            <ion-icon :icon="mailUnreadOutline" aria-hidden="true" />
            <strong>{{ t('inviteLanding.verificationRequired') }}</strong>
            <p>{{ message }}</p>
            <ion-button data-testid="send-invitation-verification" expand="block" shape="round" :disabled="verifying" @click="sendVerification">{{ t('inviteLanding.resendVerification') }}</ion-button>
            <ion-button data-testid="recheck-invitation-verification" expand="block" fill="outline" shape="round" :disabled="verifying" @click="recheckVerification"><ion-icon slot="start" :icon="refreshOutline" aria-hidden="true" /> {{ verifying ? t('inviteLanding.checkingShort') : t('inviteLanding.verifiedAction') }}</ion-button>
            <p v-if="actionStatusCopy" role="status" aria-live="polite" class="verification-status">{{ actionStatusCopy }}</p>
          </section>
          <p v-else>{{ message }}</p>
          <p class="privacy"><ion-icon :icon="shieldCheckmarkOutline" /> {{ t('inviteLanding.privacy') }}</p>
          <ion-button v-if="state.kind === 'sign-in'" expand="block" shape="round" @click="signIn">{{ t('inviteLanding.signIn') }}</ion-button>
          <ion-button v-else-if="state.kind === 'ready'" expand="block" shape="round" :disabled="accepting" @click="accept">{{ accepting ? t('inviteLanding.joining') : t('inviteLanding.join') }}</ion-button>
          <ion-button v-else-if="state.kind === 'accepted' && groupId" :router-link="`/tabs/groups/${groupId}`" expand="block" shape="round">{{ t('inviteLanding.openGroup') }}</ion-button>
          <ion-button v-else-if="state.kind === 'preview'" router-link="/tabs/groups" expand="block" shape="round">{{ t('inviteLanding.openDemo') }}</ion-button>
          <ion-button v-else router-link="/tabs/home" expand="block" fill="outline" shape="round">{{ t('inviteLanding.goHome') }}</ion-button>
        </template>
      </main>
    </ion-content>
  </ion-page>
</template>

<style scoped>
.landing{box-sizing:border-box;display:grid;min-height:100%;align-content:center;gap:12px;width:min(100%,430px);margin:auto;padding:28px 22px;text-align:center}.landing-icon{display:grid;width:76px;height:76px;place-items:center;margin:0 auto 10px;border-radius:26px;background:linear-gradient(145deg,var(--ion-color-primary),var(--su-indigo));color:#fff;font-size:2rem;box-shadow:0 18px 36px rgb(66 44 181 / 24%)}.kicker{margin:0;color:var(--ion-color-primary)!important;font-size:.7rem!important;font-weight:800;letter-spacing:.12em}.landing h1{margin:0;font-size:2.2rem;letter-spacing:-.05em}.landing p{margin:0;color:var(--ion-color-medium);font-size:.9rem;line-height:1.5}.privacy{display:flex;align-items:center;justify-content:center;gap:6px;margin:12px 0!important;font-size:.74rem!important}.privacy ion-icon{color:var(--ion-color-primary);font-size:1rem}.landing ion-button{min-height:48px;margin-top:6px;text-transform:none}
.verification-card{display:grid;gap:10px;padding:17px;border:1px solid color-mix(in srgb,var(--ion-color-primary) 18%,var(--su-divider));border-radius:18px;background:color-mix(in srgb,var(--su-lilac) 34%,var(--su-surface));text-align:start}.verification-card>ion-icon{color:var(--ion-color-primary);font-size:1.5rem}.verification-card strong{font-size:1rem}.verification-card ion-button{margin:0}.verification-status{padding:9px 10px;border-radius:10px;background:var(--su-surface);color:var(--ion-color-primary)!important;font-size:.78rem!important}
</style>
