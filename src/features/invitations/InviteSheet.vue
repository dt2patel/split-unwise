<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonPage, IonTitle, IonToolbar } from '@ionic/vue'
import { checkmarkCircleOutline, copyOutline, lockClosedOutline, shareOutline } from 'ionicons/icons'
import { getAppSession } from '../../data/session'
import { isStrictId } from '../../data/identifiers'
import { prepareDemoInvitation, type PreparedInvitation } from './invitations'
import { sharePreparedInvitation } from './shareInvitation'
import { callSplitUnwiseFunction } from '../../data/firebaseCallables'
import { createClientOperationId } from '../../data/clientOperationId'
import { getActiveRuntimeConfiguration } from '../../data/firebase'
import { createSparkInvitation, revokeSparkInvitation } from '../../data/firebaseSparkMutations'
import { useI18n } from '../../app/i18n'
import { ApplicationError, displayMessageFor, displayMessageText, type ApplicationMessage, type DisplayMessage } from '../../app/displayMessages'

const route = useRoute()
const session = getAppSession()
const { locale, t } = useI18n()
const groupId = computed(() => String(route.params.groupId ?? ''))
const email = ref('')
const groupName = ref('')
const canManage = ref(false)
const invitation = ref<PreparedInvitation>()
const status = ref<ApplicationMessage>()
const error = ref<DisplayMessage>()
const busy = ref(false)
const revoked = ref(false)
const statusCopy = computed(() => displayMessageText(status.value, t))
const errorCopy = computed(() => displayMessageText(error.value, t))
const expiryCopy = computed(() => invitation.value
  ? new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(invitation.value.expiresAt))
  : '')

onMounted(async () => {
  try {
    if (!isStrictId(groupId.value)) throw new ApplicationError('groups.error.unavailable')
    const [group, members, current] = await Promise.all([session.repository.groups.getById(groupId.value), session.repository.groups.listMembers(groupId.value), session.repository.app.getCurrentUser()])
    if (!group) throw new ApplicationError('groups.error.unavailable')
    groupName.value = group.name
    canManage.value = members.find(({ id }) => id === current.id)?.canManage === true
  } catch (reason) { error.value = displayMessageFor(reason, 'groups.error.load') }
})

async function create(): Promise<void> {
  busy.value = true; error.value = undefined; status.value = undefined; invitation.value = undefined
  try {
    if (!canManage.value) throw new ApplicationError('invite.error.managerOnly')
    const configuredOrigin = String(import.meta.env.VITE_CANONICAL_ORIGIN ?? 'https://split-unwise-aditya.web.app')
    if (session.repository.mode === 'firebase') {
      const runtime = getActiveRuntimeConfiguration()
      if (runtime.kind !== 'firebase') throw new ApplicationError('invite.error.firebaseNotReady')
      if (runtime.functionsRegion) {
        const result = await callSplitUnwiseFunction('invitationCreate', { schemaVersion: 1, operationId: createClientOperationId('invite'), groupId: groupId.value, origin: configuredOrigin, ...(email.value.trim() ? { targetEmail: email.value } : {}) }, { replayProtected: true })
        invitation.value = decodePreparedInvitation(result)
      } else {
        invitation.value = await createSparkInvitation(runtime.firebase, { groupId: groupId.value, canonicalOrigin: configuredOrigin, ...(email.value.trim() ? { targetEmail: email.value } : {}) })
      }
      status.value = { kind: 'application', key: 'invite.status.privateReady' }
    } else {
      invitation.value = await prepareDemoInvitation({ groupId: groupId.value, canonicalOrigin: configuredOrigin, ...(email.value.trim() ? { targetEmail: email.value } : {}) })
      status.value = { kind: 'application', key: 'invite.status.demoReady' }
    }
    revoked.value = false
  } catch (reason) { error.value = displayMessageFor(reason, 'invite.error.prepareFailed') } finally { busy.value = false }
}
async function share(): Promise<void> {
  if (!invitation.value) return
  const result = await sharePreparedInvitation(invitation.value.link)
  const key = {
    shared: 'invite.status.shared',
    copied: 'invite.status.copied',
    cancelled: 'invite.status.cancelled',
    manual: 'invite.status.manual',
  } as const
  status.value = { kind: 'application', key: key[result.status] }
}
async function revoke(): Promise<void> {
  if (!invitation.value || (invitation.value.capability !== 'firebase-server' && invitation.value.capability !== 'firebase-client')) return
  busy.value = true; error.value = undefined
  try {
    const runtime = getActiveRuntimeConfiguration()
    if (runtime.kind !== 'firebase') throw new ApplicationError('invite.error.firebaseNotReady')
    if (invitation.value.capability === 'firebase-server') await callSplitUnwiseFunction('invitationRevoke', { schemaVersion: 1, operationId: createClientOperationId('invite-revoke'), invitationId: invitation.value.invitationId }, { replayProtected: true })
    else await revokeSparkInvitation(runtime.firebase, invitation.value.invitationId)
    revoked.value = true; status.value = { kind: 'application', key: 'invite.status.revoked' }
  } catch (reason) { error.value = displayMessageFor(reason, 'invite.error.revokeFailed') } finally { busy.value = false }
}
function decodePreparedInvitation(value: unknown): PreparedInvitation {
  if (!isRecord(value) || typeof value.invitationId !== 'string' || typeof value.groupId !== 'string' || typeof value.link !== 'string' || typeof value.expiresAt !== 'string') throw new ApplicationError('invite.error.invalidResponse')
  return { invitationId: value.invitationId, groupId: value.groupId, link: value.link, expiresAt: value.expiresAt, capability: 'firebase-server', ...(typeof value.targetEmail === 'string' ? { targetEmail: value.targetEmail } : {}) }
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
</script>

<template>
  <ion-page>
    <ion-header translucent><ion-toolbar><ion-buttons slot="start"><ion-back-button :default-href="`/tabs/groups/${groupId}`" :text="t('invite.backGroup')" /></ion-buttons><ion-title>{{ t('invite.title') }}</ion-title></ion-toolbar></ion-header>
    <ion-content :fullscreen="true">
      <main class="invite-page">
        <div class="invite-icon"><ion-icon :icon="shareOutline" aria-hidden="true" /></div>
        <h1 v-if="groupName">{{ t('invite.heading', { group: groupName }) }}</h1>
        <p>{{ t('invite.intro') }}</p>

        <section class="invite-card">
          <label for="invite-email"><span>{{ t('invite.targetEmail') }} <small>{{ t('invite.optional') }}</small></span><input id="invite-email" v-model="email" type="email" inputmode="email" autocomplete="email" :placeholder="t('invite.emailPlaceholder')"></label>
          <ion-button expand="block" shape="round" :disabled="busy || !canManage" @click="create">{{ busy ? t('invite.preparing') : t('invite.prepare') }}</ion-button>
          <p v-if="!canManage" class="capability"><ion-icon :icon="lockClosedOutline" /> {{ t('invite.managerOnly') }}</p>
          <p v-else-if="session.repository.mode === 'firebase'" class="capability"><ion-icon :icon="lockClosedOutline" /> {{ t('invite.privateCapability') }}</p>
          <p v-else class="capability"><ion-icon :icon="checkmarkCircleOutline" /> {{ t('invite.demoCapability') }}</p>
        </section>

        <section v-if="invitation" class="prepared-card" aria-labelledby="prepared-heading">
          <h2 id="prepared-heading">{{ t('invite.ready') }}</h2>
          <p>{{ t('invite.expires', { date: expiryCopy }) }}</p>
          <textarea readonly :value="invitation.link" :aria-label="t('invite.urlAria')" @focus="($event.target as HTMLTextAreaElement).select()" />
          <ion-button expand="block" shape="round" :disabled="revoked" @click="share"><ion-icon slot="start" :icon="copyOutline" /> {{ revoked ? t('invite.revoked') : t('invite.share') }}</ion-button>
          <ion-button v-if="(invitation.capability === 'firebase-server' || invitation.capability === 'firebase-client') && !revoked" expand="block" fill="clear" color="danger" :disabled="busy" @click="revoke">{{ t('invite.revoke') }}</ion-button>
        </section>
        <p v-if="errorCopy" class="invite-error" role="alert">{{ errorCopy }}</p>
        <p v-if="statusCopy" class="invite-status" role="status" aria-live="polite">{{ statusCopy }}</p>
      </main>
    </ion-content>
  </ion-page>
</template>

<style scoped>
.invite-page{box-sizing:border-box;width:min(100%,480px);margin:auto;padding:24px 18px 42px;text-align:center}.invite-icon{display:grid;width:66px;height:66px;place-items:center;margin:4px auto 18px;border-radius:22px;background:var(--su-lilac);color:var(--ion-color-primary);font-size:1.8rem}.invite-page h1{margin:0;font-size:2rem;letter-spacing:-.045em}.invite-page>p{color:var(--ion-color-medium);line-height:1.45}.invite-card,.prepared-card{display:grid;gap:14px;margin-top:24px;padding:18px;border-radius:20px;background:var(--su-surface);box-shadow:0 0 0 1px color-mix(in srgb,var(--su-divider) 22%,transparent),0 14px 36px rgb(37 29 87 / 8%);text-align:start}.invite-card label{display:grid;gap:7px;font-size:.8rem;font-weight:650}.invite-card label small{color:var(--ion-color-medium);font-weight:500}.invite-card input,.prepared-card textarea{box-sizing:border-box;width:100%;min-height:50px;padding:0 13px;border:1px solid color-mix(in srgb,var(--su-divider) 35%,transparent);border-radius:12px;background:var(--su-surface);color:inherit;font:inherit;font-size:16px}.prepared-card textarea{min-height:92px;padding:11px;resize:none;font-size:.78rem}.invite-card ion-button,.prepared-card ion-button{min-height:48px;margin:0;text-transform:none}.capability{display:flex;align-items:flex-start;gap:7px;margin:0;color:var(--ion-color-medium);font-size:.75rem;line-height:1.4}.capability ion-icon{flex:0 0 auto;margin-top:2px;color:var(--ion-color-primary)}.prepared-card h2,.prepared-card p{margin:0}.prepared-card p{color:var(--ion-color-medium);font-size:.8rem}.invite-error,.invite-status{margin-top:16px!important;padding:11px;border-radius:12px;font-size:.8rem}.invite-error{background:color-mix(in srgb,var(--ion-color-danger) 9%,var(--su-surface));color:var(--ion-color-danger)!important}.invite-status{background:var(--su-lilac);color:var(--ion-color-primary)!important}
</style>
