<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, type ComponentPublicInstance } from 'vue'
import { IonAlert, IonButton, IonButtons, IonCheckbox, IonContent, IonHeader, IonIcon, IonInput, IonModal, IonPage, IonSpinner, IonTitle, IonToolbar } from '@ionic/vue'
import { archiveOutline, cardOutline, chevronForward, cloudOfflineOutline, colorPaletteOutline, documentAttachOutline, logOutOutline, notificationsOutline, personCircleOutline, trashOutline } from 'ionicons/icons'
import { getAppSession, type UnresolvedWorkSummary } from '../../data/session'
import { createBrowserPrincipalLocalDataPort } from '../../data/localData'
import { createClientOperationId } from '../../data/clientOperationId'
import { peekAuthService } from '../auth/authService'
import type { Member, NotificationPreferences } from '../../data/repositories'
import type { AccountDeletionProgress, AccountDeletionProgressStage } from '../../data/firebaseAccountDeletion'

const session = getAppSession()
const auth = peekAuthService()
const member = ref<Member>()
const displayName = ref('')
const notificationPreferences = ref<NotificationPreferences>({ emailEnabled: true, pushEnabled: true })
const status = ref('')
const error = ref('')
const signOutDecision = ref(false)
const clearDecision = ref(false)
const deletionOpen = ref(false)
const deletingAccount = ref(false)
const deletionAcknowledged = ref(false)
const deletionPassword = ref('')
const deletionError = ref('')
const deletionProgress = ref<AccountDeletionProgress>()
const unresolved = ref<UnresolvedWorkSummary>({ pending: 0, failed: 0, conflicted: 0, total: 0 })
const trigger = ref<HTMLElement>()
const presentingElement = shallowRef<HTMLElement>()
let unsubscribeQueue: () => void = () => undefined

const authState = computed(() => auth?.getState())
const privateIdentity = computed(() => authState.value?.status === 'signed-in' ? authState.value.identity : undefined)
const initials = computed(() => member.value?.initials ?? displayName.value.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase())
const modeCopy = computed(() => session.repository.mode === 'demo' ? 'Demo mode · data stays on this device' : 'Firebase account · cloud data enabled')
const deletionProvider = computed<'password' | 'google' | 'unsupported'>(() => {
  const providers = privateIdentity.value?.providerIds ?? []
  if (providers.includes('password')) return 'password'
  if (providers.includes('google.com')) return 'google'
  return 'unsupported'
})
const deletionAvailable = computed(() => session.repository.mode === 'firebase' && Boolean(privateIdentity.value) && deletionProvider.value !== 'unsupported')
const canConfirmDeletion = computed(() => deletionAvailable.value && deletionAcknowledged.value && !deletingAccount.value
  && (deletionProvider.value !== 'password' || deletionPassword.value.length > 0))
const deletionProgressCopy = computed(() => progressCopy(deletionProgress.value?.stage))

onMounted(async () => {
  try {
    await session.ready
    const [profile, preferences] = await Promise.all([session.repository.app.getCurrentUser(), session.repository.notifications.getPreferences()])
    member.value = profile
    displayName.value = profile.displayName
    notificationPreferences.value = preferences
    refreshQueue()
    unsubscribeQueue = session.queue.subscribe(refreshQueue)
  } catch (reason) { error.value = message(reason) }
})
onBeforeUnmount(() => unsubscribeQueue())

function refreshQueue(): void {
  const rows = session.queue.snapshot()
  const pending = rows.filter(({ status }) => status === 'pending').length
  const failed = rows.filter(({ status }) => status === 'failed').length
  const conflicted = rows.filter(({ status }) => status === 'conflicted').length
  unresolved.value = { pending, failed, conflicted, total: pending + failed + conflicted }
}

async function saveProfile(): Promise<void> {
  error.value = ''; status.value = ''
  try {
    const name = displayName.value.trim()
    if (!name) throw new Error('Enter your name')
    await session.queue.submit({ kind: 'profile.update', operationId: createClientOperationId('profile'), displayName: name, initials: initials.value }).result()
    status.value = 'Profile saved.'
  } catch (reason) { error.value = message(reason) }
}

async function saveNotifications(): Promise<void> {
  error.value = ''; status.value = ''
  try {
    await session.queue.submit({ kind: 'notification.preferences', operationId: createClientOperationId('notification-preferences'), preferences: { ...notificationPreferences.value } }).result()
    status.value = 'Notification preferences saved.'
  } catch (reason) { error.value = message(reason) }
}

function beginSignOut(event: Event): void {
  trigger.value = event.currentTarget as HTMLElement
  unresolved.value = session.quiesce()
  if (unresolved.value.total === 0) { void finishSignOut('keep'); return }
  signOutDecision.value = true
}

async function finishSignOut(choice: 'cancel' | 'keep' | 'discard'): Promise<void> {
  signOutDecision.value = false
  if (choice === 'cancel') { session.resumeWork(); await restoreFocus(); return }
  try {
    if (choice === 'discard') unresolved.value = await session.discardTerminalWork()
    if (!auth) throw new Error('Authentication is not initialized')
    await auth.signOut()
  } catch (reason) {
    session.resumeWork()
    error.value = message(reason)
    await restoreFocus()
  }
}

function beginClear(event: Event): void { trigger.value = event.currentTarget as HTMLElement; clearDecision.value = true }
async function clearLocalData(): Promise<void> {
  clearDecision.value = false
  error.value = ''; status.value = ''
  const summary = session.quiesce()
  if (summary.pending > 0) { session.resumeWork(); error.value = 'Wait for in-flight changes before clearing local data.'; await restoreFocus(); return }
  try {
    const principal = await session.principal
    await session.clearLocalData()
    await createBrowserPrincipalLocalDataPort().clear(principal)
    session.resumeWork()
    status.value = 'Local data for this account was cleared. Cloud data was not deleted.'
  } catch (reason) { session.resumeWork(); error.value = message(reason) }
  await restoreFocus()
}
function setPresentingElement(value: Element | ComponentPublicInstance | null): void {
  const element = value && '$el' in value ? value.$el : value
  presentingElement.value = element instanceof HTMLElement ? element : undefined
}
function beginAccountDeletion(event: Event): void {
  if (!deletionAvailable.value) return
  trigger.value = event.currentTarget as HTMLElement
  deletionAcknowledged.value = false
  deletionPassword.value = ''
  deletionError.value = ''
  deletionProgress.value = undefined
  deletionOpen.value = true
}
function closeAccountDeletion(): void {
  if (deletingAccount.value) return
  deletionOpen.value = false
  deletionAcknowledged.value = false
  deletionPassword.value = ''
  deletionError.value = ''
  deletionProgress.value = undefined
  void restoreFocus()
}
async function canDismissAccountDeletion(): Promise<boolean> { return !deletingAccount.value }
async function deleteAccount(): Promise<void> {
  if (!auth || !canConfirmDeletion.value) return
  deletionError.value = ''
  status.value = ''
  const summary = session.quiesce()
  unresolved.value = summary
  if (summary.pending > 0) {
    session.resumeWork()
    deletionError.value = 'Wait for in-flight changes before deleting your account.'
    return
  }
  const principal = await session.principal
  deletingAccount.value = true
  try {
    await auth.deleteAccount({
      ...(deletionProvider.value === 'password' ? { password: deletionPassword.value } : {}),
      onProgress(next) { deletionProgress.value = next },
      async beforeAuthDelete() {
        await session.clearLocalData()
        await createBrowserPrincipalLocalDataPort().clear(principal)
      },
    })
  } catch (reason) {
    deletionPassword.value = ''
    deletionError.value = message(reason)
    if (!deletionProgress.value) session.resumeWork()
  } finally {
    deletingAccount.value = false
  }
}
async function restoreFocus(): Promise<void> { await nextTick(); trigger.value?.focus() }
function message(reason: unknown): string { return reason instanceof Error ? reason.message : 'The account action could not be completed.' }
function progressCopy(stage: AccountDeletionProgressStage | undefined): string {
  if (stage === 'starting') return 'Preparing your account…'
  if (stage === 'shared-data') return 'Removing your identity from shared history…'
  if (stage === 'group-continuity') return 'Keeping shared groups usable…'
  if (stage === 'private-data') return 'Removing private account data…'
  if (stage === 'prepared') return 'Finishing account deletion…'
  return 'Reauthenticating your account…'
}
</script>

<template>
  <ion-page :ref="setPresentingElement">
    <ion-header translucent><ion-toolbar><ion-title>Account</ion-title><ion-buttons slot="end"><ion-button router-link="/tabs/account/export">Export</ion-button></ion-buttons></ion-toolbar></ion-header>
    <ion-content :fullscreen="true">
      <main class="account-page">
        <h1 class="su-visually-hidden">Account</h1>
        <header class="profile-card">
          <span class="profile-avatar" aria-hidden="true">{{ initials }}</span>
          <span><strong>{{ member?.displayName ?? 'Your account' }}</strong><small v-if="privateIdentity?.email">{{ privateIdentity.email }}<em v-if="privateIdentity.emailVerified">Verified</em></small><small>{{ modeCopy }}</small></span>
        </header>

        <p v-if="error" class="account-error" role="alert" tabindex="-1">{{ error }}</p>
        <p v-if="status" class="account-status" role="status" aria-live="polite">{{ status }}</p>

        <p class="section-label">Profile</p>
        <section class="settings-group">
          <label class="input-row" for="account-name"><span>Name</span><input id="account-name" v-model="displayName" autocomplete="name"></label>
          <button class="text-action" type="button" @click="saveProfile">Save profile</button>
        </section>

        <p class="section-label">Preferences</p>
        <section class="settings-group">
          <label class="toggle-row"><span class="row-icon"><ion-icon :icon="notificationsOutline" /></span><span><strong>Email notifications</strong><small>Important shared expense updates</small></span><input v-model="notificationPreferences.emailEnabled" type="checkbox" aria-label="Email notifications"></label>
          <label class="toggle-row"><span class="row-icon"><ion-icon :icon="notificationsOutline" /></span><span><strong>Push notifications</strong><small>Alerts on supported devices</small></span><input v-model="notificationPreferences.pushEnabled" type="checkbox" aria-label="Push notifications"></label>
          <button class="text-action" type="button" @click="saveNotifications">Save notifications</button>
          <router-link class="nav-row" to="/tabs/account/appearance"><span class="row-icon"><ion-icon :icon="colorPaletteOutline" /></span><span><strong>Appearance</strong><small>Automatic, light, or dark</small></span><ion-icon :icon="chevronForward" /></router-link>
          <router-link class="nav-row" to="/tabs/account/currencies"><span class="row-icon"><ion-icon :icon="cardOutline" /></span><span><strong>Currencies</strong><small>Default and preferred order</small></span><ion-icon :icon="chevronForward" /></router-link>
        </section>

        <p class="section-label">Data</p>
        <section class="settings-group">
          <router-link class="nav-row" to="/tabs/account/transactions/import"><span class="row-icon"><ion-icon :icon="documentAttachOutline" /></span><span><strong>Import transactions</strong><small>Review a bank statement CSV on this device</small></span><ion-icon :icon="chevronForward" /></router-link>
          <router-link class="nav-row" to="/tabs/account/export"><span class="row-icon"><ion-icon :icon="archiveOutline" /></span><span><strong>Export your data</strong><small>CSV or JSON, separated by currency</small></span><ion-icon :icon="chevronForward" /></router-link>
          <div class="info-row"><span class="row-icon"><ion-icon :icon="cloudOfflineOutline" /></span><span><strong>Offline changes</strong><small>{{ unresolved.total ? `${unresolved.pending} pending · ${unresolved.failed} failed · ${unresolved.conflicted} conflicted` : 'Everything on this device is settled' }}</small></span></div>
          <button class="danger-row" type="button" @click="beginClear"><span class="row-icon"><ion-icon :icon="trashOutline" /></span><span><strong>Clear local data</strong><small>Only this signed-in account on this device</small></span></button>
        </section>

        <p class="section-label">Account</p>
        <section class="settings-group">
          <button class="danger-row" type="button" :disabled="session.repository.mode === 'demo'" @click="beginSignOut"><span class="row-icon"><ion-icon :icon="logOutOutline" /></span><span><strong>Sign out</strong><small>{{ session.repository.mode === 'demo' ? 'Unavailable for the fixed demo identity' : 'Review offline drafts first' }}</small></span></button>
          <button data-testid="open-account-delete" class="danger-row" type="button" :disabled="!deletionAvailable" @click="beginAccountDeletion"><span class="row-icon"><ion-icon :icon="personCircleOutline" /></span><span><strong>Delete account</strong><small>{{ session.repository.mode === 'demo' ? 'Unavailable for the fixed demo identity' : deletionProvider === 'unsupported' ? 'This sign-in provider is not supported yet' : 'Permanently remove your account and private data' }}</small></span><ion-icon :icon="chevronForward" /></button>
        </section>
      </main>
    </ion-content>

    <ion-alert :is-open="signOutDecision" header="Sign out with local work?" :message="`${unresolved.pending} pending, ${unresolved.failed} failed, and ${unresolved.conflicted} conflicted changes are stored for this account. Pending work cannot be discarded while its result is unknown.`" :buttons="[
      { text: 'Cancel', role: 'cancel', handler: () => finishSignOut('cancel') },
      { text: 'Keep drafts', handler: () => finishSignOut('keep') },
      { text: 'Discard terminal drafts', role: 'destructive', handler: () => finishSignOut('discard') },
    ]" @did-dismiss="signOutDecision = false" />
    <ion-alert :is-open="clearDecision" header="Clear local data?" message="This removes only this account’s offline queue, local receipt images, and device currency preferences. It does not delete cloud data." :buttons="[
      { text: 'Cancel', role: 'cancel', handler: () => { clearDecision = false; restoreFocus() } },
      { text: 'Clear local data', role: 'destructive', handler: clearLocalData },
    ]" @did-dismiss="clearDecision = false" />

    <ion-modal :is-open="deletionOpen" :presenting-element="presentingElement" :can-dismiss="canDismissAccountDeletion" @did-dismiss="closeAccountDeletion">
      <ion-header translucent>
        <ion-toolbar>
          <ion-buttons slot="start"><ion-button :disabled="deletingAccount" @click="closeAccountDeletion">Cancel</ion-button></ion-buttons>
          <ion-title>Delete account</ion-title>
        </ion-toolbar>
      </ion-header>
      <ion-content>
        <main class="account-deletion-card" data-testid="account-deletion-modal">
          <span class="deletion-mark" aria-hidden="true"><ion-icon :icon="trashOutline" /></span>
          <h2>Delete your account?</h2>
          <p>This is permanent. Your private account data and sign-in will be removed.</p>
          <section class="deletion-summary" aria-label="What happens when this account is deleted">
            <strong>Shared balances stay accurate</strong>
            <p>Expenses and payments remain for the people you shared them with. Your name becomes “Deleted user,” and you cannot be added to new expenses.</p>
          </section>
          <ion-input
            v-if="deletionProvider === 'password'"
            v-model="deletionPassword"
            data-testid="account-delete-password"
            type="password"
            label="Current password"
            label-placement="stacked"
            fill="outline"
            autocomplete="current-password"
            :disabled="deletingAccount"
          />
          <p v-else-if="deletionProvider === 'google'" class="google-reauth">Continue with Google to confirm it’s you.</p>
          <ion-checkbox v-model="deletionAcknowledged" data-testid="account-delete-ack" label-placement="end" alignment="start" :disabled="deletingAccount">
            I understand this account cannot be recovered.
          </ion-checkbox>
          <p v-if="deletionError" class="deletion-error" role="alert">{{ deletionError }}</p>
          <p v-if="deletingAccount" class="deletion-progress" role="status" aria-live="polite"><ion-spinner name="crescent" />{{ deletionProgressCopy }}</p>
          <ion-button data-testid="confirm-account-delete" expand="block" shape="round" color="danger" :disabled="!canConfirmDeletion" @click="deleteAccount">
            {{ deletingAccount ? 'Deleting account…' : deletionProvider === 'google' ? 'Continue with Google' : 'Permanently delete account' }}
          </ion-button>
        </main>
      </ion-content>
    </ion-modal>
  </ion-page>
</template>

<style scoped>
.account-page{padding:16px 16px calc(116px + env(safe-area-inset-bottom));background:color-mix(in srgb,var(--su-lilac) 28%,var(--su-surface))}.profile-card{display:grid;grid-template-columns:64px 1fr;align-items:center;gap:14px;margin:2px 0 25px;padding:8px 4px}.profile-avatar{display:grid;width:62px;height:62px;place-items:center;border-radius:50%;background:linear-gradient(145deg,var(--ion-color-primary),var(--su-indigo));color:#fff;font-size:1.2rem;font-weight:750;box-shadow:0 8px 24px rgb(69 42 183 / 22%)}.profile-card>span:last-child{display:grid;gap:4px;min-width:0}.profile-card strong{font-size:1.22rem}.profile-card small{display:flex;flex-wrap:wrap;gap:6px;color:var(--ion-color-medium);font-size:.78rem;overflow-wrap:anywhere}.profile-card em{padding:2px 6px;border-radius:8px;background:var(--su-lilac);color:var(--ion-color-primary);font-size:.72rem;font-style:normal;font-weight:700}.section-label{margin:22px 12px 8px;color:var(--ion-color-medium);font-size:.72rem;text-transform:uppercase;letter-spacing:.06em}.settings-group{overflow:hidden;border-radius:14px;background:var(--su-surface);box-shadow:0 0 0 1px color-mix(in srgb,var(--su-divider) 18%,transparent)}.nav-row,.toggle-row,.info-row,.danger-row,.input-row{box-sizing:border-box;display:grid;width:100%;min-height:58px;grid-template-columns:34px minmax(0,1fr) auto;align-items:center;gap:9px;padding:7px 13px;border:0;border-bottom:1px solid color-mix(in srgb,var(--su-divider) 24%,transparent);background:transparent;color:inherit;font:inherit;text-align:start;text-decoration:none}.settings-group>:last-child{border-bottom:0}.nav-row>span:nth-child(2),.toggle-row>span:nth-child(2),.info-row>span:nth-child(2),.danger-row>span:nth-child(2){display:grid;gap:2px;min-width:0}.nav-row small,.toggle-row small,.info-row small,.danger-row small{color:var(--ion-color-medium);font-size:.74rem;line-height:1.3;overflow-wrap:anywhere}.row-icon{display:grid;width:28px;height:28px;place-items:center;border-radius:8px;background:var(--su-lilac);color:var(--ion-color-primary)}.toggle-row input{width:42px;height:24px;accent-color:var(--ion-color-primary)}.input-row{grid-template-columns:90px 1fr}.input-row input{min-width:0;min-height:44px;border:0;background:transparent;color:inherit;font:inherit;font-size:16px;text-align:end}.text-action{width:100%;min-height:48px;border:0;border-bottom:1px solid color-mix(in srgb,var(--su-divider) 24%,transparent);background:transparent;color:var(--ion-color-primary);font:inherit;font-weight:650}.danger-row{color:var(--ion-color-danger)}.danger-row small{color:var(--ion-color-medium)}.danger-row:disabled{opacity:.55}.account-error,.account-status{padding:11px 13px;border-radius:12px;font-size:.82rem}.account-error{background:color-mix(in srgb,var(--ion-color-danger) 10%,var(--su-surface));color:var(--ion-color-danger)}.account-status{background:var(--su-lilac);color:var(--ion-color-primary)}
.account-deletion-card{display:grid;width:min(100%,560px);margin:0 auto;padding:28px 20px calc(36px + env(safe-area-inset-bottom));gap:16px}.account-deletion-card h2{margin:2px 0 -8px;font-size:1.7rem;letter-spacing:-.035em}.account-deletion-card>p{margin:0;color:var(--ion-color-medium);font-size:.92rem;line-height:1.45}.deletion-mark{display:grid;width:54px;height:54px;place-items:center;border-radius:18px;background:color-mix(in srgb,var(--ion-color-danger) 12%,var(--su-surface));color:var(--ion-color-danger);font-size:1.55rem}.deletion-summary{padding:14px 15px;border:1px solid color-mix(in srgb,var(--su-divider) 72%,transparent);border-radius:14px;background:var(--su-surface)}.deletion-summary strong{font-size:.92rem}.deletion-summary p{margin:5px 0 0;color:var(--ion-color-medium);font-size:.8rem;line-height:1.45}.account-deletion-card ion-input{--border-radius:12px;--padding-start:14px;--padding-end:14px}.account-deletion-card ion-checkbox{font-size:.86rem;line-height:1.35}.google-reauth{padding:12px 14px;border-radius:12px;background:var(--su-lilac);color:var(--ion-color-primary)!important;font-weight:650}.deletion-error,.deletion-progress{padding:11px 13px;border-radius:12px;font-size:.82rem!important}.deletion-error{background:color-mix(in srgb,var(--ion-color-danger) 10%,var(--su-surface));color:var(--ion-color-danger)!important}.deletion-progress{display:flex;align-items:center;gap:9px;background:var(--su-lilac);color:var(--ion-color-primary)!important}.deletion-progress ion-spinner{width:18px;height:18px}
</style>
