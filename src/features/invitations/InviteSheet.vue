<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonPage, IonTitle, IonToolbar } from '@ionic/vue'
import { checkmarkCircleOutline, copyOutline, lockClosedOutline, shareOutline } from 'ionicons/icons'
import { getAppSession } from '../../data/session'
import { isStrictId } from '../../data/identifiers'
import { prepareDemoInvitation, productionInvitationCapability, type PreparedInvitation } from './invitations'
import { sharePreparedInvitation } from './shareInvitation'

const route = useRoute()
const session = getAppSession()
const groupId = computed(() => String(route.params.groupId ?? ''))
const email = ref('')
const groupName = ref('Group')
const canManage = ref(false)
const invitation = ref<PreparedInvitation>()
const status = ref('')
const error = ref('')
const busy = ref(false)

onMounted(async () => {
  try {
    if (!isStrictId(groupId.value)) throw new Error('This group is not available.')
    const [group, members, current] = await Promise.all([session.repository.groups.getById(groupId.value), session.repository.groups.listMembers(groupId.value), session.repository.app.getCurrentUser()])
    if (!group) throw new Error('This group is not available.')
    groupName.value = group.name
    canManage.value = members.find(({ id }) => id === current.id)?.canManage === true
  } catch (reason) { error.value = message(reason) }
})

async function create(): Promise<void> {
  busy.value = true; error.value = ''; status.value = ''; invitation.value = undefined
  try {
    if (!canManage.value) throw new Error('Only a group manager can create an invitation.')
    if (session.repository.mode === 'firebase') throw new Error(productionInvitationCapability().reason)
    const configuredOrigin = String(import.meta.env.VITE_CANONICAL_ORIGIN ?? 'https://split-unwise.web.app')
    invitation.value = await prepareDemoInvitation({ groupId: groupId.value, canonicalOrigin: configuredOrigin, ...(email.value.trim() ? { targetEmail: email.value } : {}) })
    status.value = 'Local preview ready. It is not a cross-device production invitation.'
  } catch (reason) { error.value = message(reason) } finally { busy.value = false }
}
async function share(): Promise<void> {
  if (!invitation.value) return
  const result = await sharePreparedInvitation(invitation.value.link)
  status.value = result.status === 'shared' ? 'Share sheet completed.' : result.status === 'copied' ? 'Invitation copied.' : result.status === 'cancelled' ? 'Sharing cancelled.' : 'Select and copy the invitation below.'
}
function message(reason: unknown): string { return reason instanceof Error ? reason.message : 'The invitation could not be prepared.' }
</script>

<template>
  <ion-page>
    <ion-header translucent><ion-toolbar><ion-buttons slot="start"><ion-back-button :default-href="`/tabs/groups/${groupId}`" text="Group" /></ion-buttons><ion-title>Invite people</ion-title></ion-toolbar></ion-header>
    <ion-content :fullscreen="true">
      <main class="invite-page">
        <div class="invite-icon"><ion-icon :icon="shareOutline" aria-hidden="true" /></div>
        <h1>Invite to {{ groupName }}</h1>
        <p>Create a private, seven-day link. Split Unwise never sends it automatically.</p>

        <section class="invite-card">
          <label for="invite-email"><span>Target email <small>Optional</small></span><input id="invite-email" v-model="email" type="email" inputmode="email" autocomplete="email" placeholder="friend@example.com"></label>
          <ion-button expand="block" shape="round" :disabled="busy || !canManage" @click="create">{{ busy ? 'Preparing…' : 'Prepare invitation' }}</ion-button>
          <p v-if="!canManage" class="capability"><ion-icon :icon="lockClosedOutline" /> Only a group manager can invite members.</p>
          <p v-else-if="session.repository.mode === 'firebase'" class="capability"><ion-icon :icon="lockClosedOutline" /> Secure production creation will activate with the server callable.</p>
          <p v-else class="capability"><ion-icon :icon="checkmarkCircleOutline" /> Demo mode creates a local preview only.</p>
        </section>

        <section v-if="invitation" class="prepared-card" aria-labelledby="prepared-heading">
          <h2 id="prepared-heading">Invitation ready</h2>
          <p>Expires {{ new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(invitation.expiresAt)) }}</p>
          <textarea readonly :value="invitation.link" aria-label="Prepared invitation URL" @focus="($event.target as HTMLTextAreaElement).select()" />
          <ion-button expand="block" shape="round" @click="share"><ion-icon slot="start" :icon="copyOutline" /> Share invitation</ion-button>
        </section>
        <p v-if="error" class="invite-error" role="alert">{{ error }}</p>
        <p v-if="status" class="invite-status" role="status" aria-live="polite">{{ status }}</p>
      </main>
    </ion-content>
  </ion-page>
</template>

<style scoped>
.invite-page{box-sizing:border-box;width:min(100%,480px);margin:auto;padding:24px 18px 42px;text-align:center}.invite-icon{display:grid;width:66px;height:66px;place-items:center;margin:4px auto 18px;border-radius:22px;background:var(--su-lilac);color:var(--ion-color-primary);font-size:1.8rem}.invite-page h1{margin:0;font-size:2rem;letter-spacing:-.045em}.invite-page>p{color:var(--ion-color-medium);line-height:1.45}.invite-card,.prepared-card{display:grid;gap:14px;margin-top:24px;padding:18px;border-radius:20px;background:var(--su-surface);box-shadow:0 0 0 1px color-mix(in srgb,var(--su-divider) 22%,transparent),0 14px 36px rgb(37 29 87 / 8%);text-align:start}.invite-card label{display:grid;gap:7px;font-size:.8rem;font-weight:650}.invite-card label small{color:var(--ion-color-medium);font-weight:500}.invite-card input,.prepared-card textarea{box-sizing:border-box;width:100%;min-height:50px;padding:0 13px;border:1px solid color-mix(in srgb,var(--su-divider) 35%,transparent);border-radius:12px;background:var(--su-surface);color:inherit;font:inherit;font-size:16px}.prepared-card textarea{min-height:92px;padding:11px;resize:none;font-size:.78rem}.invite-card ion-button,.prepared-card ion-button{min-height:48px;margin:0;text-transform:none}.capability{display:flex;align-items:flex-start;gap:7px;margin:0;color:var(--ion-color-medium);font-size:.75rem;line-height:1.4}.capability ion-icon{flex:0 0 auto;margin-top:2px;color:var(--ion-color-primary)}.prepared-card h2,.prepared-card p{margin:0}.prepared-card p{color:var(--ion-color-medium);font-size:.8rem}.invite-error,.invite-status{margin-top:16px!important;padding:11px;border-radius:12px;font-size:.8rem}.invite-error{background:color-mix(in srgb,var(--ion-color-danger) 9%,var(--su-surface));color:var(--ion-color-danger)!important}.invite-status{background:var(--su-lilac);color:var(--ion-color-primary)!important}
</style>
