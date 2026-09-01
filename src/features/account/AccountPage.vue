<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { IonAlert, IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonPage, IonTitle, IonToolbar } from '@ionic/vue'
import { archiveOutline, cardOutline, chevronForward, cloudOfflineOutline, colorPaletteOutline, logOutOutline, notificationsOutline, personCircleOutline, trashOutline } from 'ionicons/icons'
import { getAppSession, type UnresolvedWorkSummary } from '../../data/session'
import { createBrowserPrincipalLocalDataPort } from '../../data/localData'
import { createClientOperationId } from '../../data/clientOperationId'
import { peekAuthService } from '../auth/authService'
import type { Member, NotificationPreferences } from '../../data/repositories'

const session = getAppSession()
const auth = peekAuthService()
const member = ref<Member>()
const displayName = ref('')
const notificationPreferences = ref<NotificationPreferences>({ emailEnabled: true, pushEnabled: true })
const status = ref('')
const error = ref('')
const signOutDecision = ref(false)
const clearDecision = ref(false)
const unresolved = ref<UnresolvedWorkSummary>({ pending: 0, failed: 0, conflicted: 0, total: 0 })
const trigger = ref<HTMLElement>()
let unsubscribeQueue: () => void = () => undefined

const authState = computed(() => auth?.getState())
const privateIdentity = computed(() => authState.value?.status === 'signed-in' ? authState.value.identity : undefined)
const initials = computed(() => member.value?.initials ?? displayName.value.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase())
const modeCopy = computed(() => session.repository.mode === 'demo' ? 'Demo mode · data stays on this device' : 'Firebase account · cloud data enabled')

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
async function restoreFocus(): Promise<void> { await nextTick(); trigger.value?.focus() }
function message(reason: unknown): string { return reason instanceof Error ? reason.message : 'The account action could not be completed.' }
</script>

<template>
  <ion-page>
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
          <router-link class="nav-row" to="/tabs/account/export"><span class="row-icon"><ion-icon :icon="archiveOutline" /></span><span><strong>Export your data</strong><small>CSV or JSON, separated by currency</small></span><ion-icon :icon="chevronForward" /></router-link>
          <div class="info-row"><span class="row-icon"><ion-icon :icon="cloudOfflineOutline" /></span><span><strong>Offline changes</strong><small>{{ unresolved.total ? `${unresolved.pending} pending · ${unresolved.failed} failed · ${unresolved.conflicted} conflicted` : 'Everything on this device is settled' }}</small></span></div>
          <button class="danger-row" type="button" @click="beginClear"><span class="row-icon"><ion-icon :icon="trashOutline" /></span><span><strong>Clear local data</strong><small>Only this signed-in account on this device</small></span></button>
        </section>

        <p class="section-label">Account</p>
        <section class="settings-group">
          <button class="danger-row" type="button" :disabled="session.repository.mode === 'demo'" @click="beginSignOut"><span class="row-icon"><ion-icon :icon="logOutOutline" /></span><span><strong>Sign out</strong><small>{{ session.repository.mode === 'demo' ? 'Unavailable for the fixed demo identity' : 'Review offline drafts first' }}</small></span></button>
          <div class="info-row"><span class="row-icon"><ion-icon :icon="personCircleOutline" /></span><span><strong>Delete account</strong><small>Server cleanup and recent sign-in are required; not available yet.</small></span></div>
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
  </ion-page>
</template>

<style scoped>
.account-page{padding:16px 16px calc(116px + env(safe-area-inset-bottom));background:color-mix(in srgb,var(--su-lilac) 28%,var(--su-surface))}.profile-card{display:grid;grid-template-columns:64px 1fr;align-items:center;gap:14px;margin:2px 0 25px;padding:8px 4px}.profile-avatar{display:grid;width:62px;height:62px;place-items:center;border-radius:50%;background:linear-gradient(145deg,var(--ion-color-primary),var(--su-indigo));color:#fff;font-size:1.2rem;font-weight:750;box-shadow:0 8px 24px rgb(69 42 183 / 22%)}.profile-card>span:last-child{display:grid;gap:4px;min-width:0}.profile-card strong{font-size:1.22rem}.profile-card small{display:flex;flex-wrap:wrap;gap:6px;color:var(--ion-color-medium);font-size:.78rem;overflow-wrap:anywhere}.profile-card em{padding:2px 6px;border-radius:8px;background:var(--su-lilac);color:var(--ion-color-primary);font-size:.72rem;font-style:normal;font-weight:700}.section-label{margin:22px 12px 8px;color:var(--ion-color-medium);font-size:.72rem;text-transform:uppercase;letter-spacing:.06em}.settings-group{overflow:hidden;border-radius:14px;background:var(--su-surface);box-shadow:0 0 0 1px color-mix(in srgb,var(--su-divider) 18%,transparent)}.nav-row,.toggle-row,.info-row,.danger-row,.input-row{box-sizing:border-box;display:grid;width:100%;min-height:58px;grid-template-columns:34px minmax(0,1fr) auto;align-items:center;gap:9px;padding:7px 13px;border:0;border-bottom:1px solid color-mix(in srgb,var(--su-divider) 24%,transparent);background:transparent;color:inherit;font:inherit;text-align:start;text-decoration:none}.settings-group>:last-child{border-bottom:0}.nav-row>span:nth-child(2),.toggle-row>span:nth-child(2),.info-row>span:nth-child(2),.danger-row>span:nth-child(2){display:grid;gap:2px;min-width:0}.nav-row small,.toggle-row small,.info-row small,.danger-row small{color:var(--ion-color-medium);font-size:.74rem;line-height:1.3;overflow-wrap:anywhere}.row-icon{display:grid;width:28px;height:28px;place-items:center;border-radius:8px;background:var(--su-lilac);color:var(--ion-color-primary)}.toggle-row input{width:42px;height:24px;accent-color:var(--ion-color-primary)}.input-row{grid-template-columns:90px 1fr}.input-row input{min-width:0;min-height:44px;border:0;background:transparent;color:inherit;font:inherit;font-size:16px;text-align:end}.text-action{width:100%;min-height:48px;border:0;border-bottom:1px solid color-mix(in srgb,var(--su-divider) 24%,transparent);background:transparent;color:var(--ion-color-primary);font:inherit;font-weight:650}.danger-row{color:var(--ion-color-danger)}.danger-row small{color:var(--ion-color-medium)}.danger-row:disabled{opacity:.55}.account-error,.account-status{padding:11px 13px;border-radius:12px;font-size:.82rem}.account-error{background:color-mix(in srgb,var(--ion-color-danger) 10%,var(--su-surface));color:var(--ion-color-danger)}.account-status{background:var(--su-lilac);color:var(--ion-color-primary)}
</style>
