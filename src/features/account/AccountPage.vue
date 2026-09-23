<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, type ComponentPublicInstance } from 'vue'
import { IonAlert, IonButton, IonButtons, IonCheckbox, IonContent, IonHeader, IonIcon, IonInput, IonItem, IonLabel, IonList, IonModal, IonPage, IonSpinner, IonTitle, IonToggle, IonToolbar } from '@ionic/vue'
import { archiveOutline, cardOutline, cloudOfflineOutline, colorPaletteOutline, documentAttachOutline, languageOutline, logOutOutline, notificationsOutline, personCircleOutline, speedometerOutline, trashOutline } from 'ionicons/icons'
import { restoreInteractiveFocus } from '../../app/focus'
import { useI18n } from '../../app/i18n'
import { describeLaunch, readLaunchHistory } from '../../app/perfMarks'
import { getAppSession, type UnresolvedWorkSummary } from '../../data/session'
import { createBrowserPrincipalLocalDataPort } from '../../data/localData'
import { createClientOperationId } from '../../data/clientOperationId'
import { peekAuthService } from '../auth/authService'
import type { Member, NotificationPreferences } from '../../data/repositories'
import type { AccountDeletionProgress, AccountDeletionProgressStage } from '../../data/firebaseAccountDeletion'
import { ApplicationError, displayMessageFor, displayMessageText, type ApplicationMessage, type DisplayMessage } from '../../app/displayMessages'

const session = getAppSession()
const auth = peekAuthService()
const { t } = useI18n()
const member = ref<Member>()
const displayName = ref('')
const paypalHandle = ref('')
const venmoHandle = ref('')
const profileReady = ref(false)
const notificationPreferences = ref<NotificationPreferences>({ emailEnabled: true, pushEnabled: true })
const status = ref<ApplicationMessage>()
const error = ref<DisplayMessage>()
const signOutDecision = ref(false)
const clearDecision = ref(false)
const deletionOpen = ref(false)
const deletingAccount = ref(false)
const deletionAcknowledged = ref(false)
const deletionPassword = ref('')
const deletionError = ref<DisplayMessage>()
const deletionProgress = ref<AccountDeletionProgress>()
const launches = readLaunchHistory().slice(0, 5)
const unresolved = ref<UnresolvedWorkSummary>({ pending: 0, failed: 0, conflicted: 0, total: 0 })
const trigger = ref<HTMLElement>()
const presentingElement = shallowRef<HTMLElement>()
let unsubscribeQueue: () => void = () => undefined

const authState = computed(() => auth?.getState())
const privateIdentity = computed(() => authState.value?.status === 'signed-in' ? authState.value.identity : undefined)
const initials = computed(() => member.value?.initials ?? displayName.value.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase())
const modeCopy = computed(() => session.repository.mode === 'demo' ? t('account.mode.demo') : t('account.mode.firebase'))
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
const statusCopy = computed(() => translateMessage(status.value))
const errorCopy = computed(() => translateMessage(error.value))
const deletionErrorCopy = computed(() => translateMessage(deletionError.value))

onMounted(async () => {
  try {
    await session.ready
    const [profile, preferences] = await Promise.all([session.repository.app.getCurrentUser(), session.repository.notifications.getPreferences()])
    member.value = profile
    displayName.value = profile.displayName
    paypalHandle.value = profile.paymentHandles?.paypal ?? ''
    venmoHandle.value = profile.paymentHandles?.venmo ?? ''
    profileReady.value = true
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
  if (!profileReady.value) return
  error.value = undefined; status.value = undefined
  try {
    const name = displayName.value.trim()
    if (!name) throw new ApplicationError('account.error.enterName')
    const paypal = normalizePaymentHandle(paypalHandle.value, 'PayPal')
    const venmo = normalizePaymentHandle(venmoHandle.value, 'Venmo')
    const paymentHandles = { ...(paypal ? { paypal } : {}), ...(venmo ? { venmo } : {}) }
    await session.queue.submit({
      kind: 'profile.update', operationId: createClientOperationId('profile'), displayName: name,
      initials: initials.value, paymentHandles,
    }).result()
    paypalHandle.value = paypal ?? ''
    venmoHandle.value = venmo ?? ''
    if (member.value) member.value = { ...member.value, displayName: name, initials: initials.value, paymentHandles }
    status.value = { kind: 'application', key: 'account.status.profileSaved' }
  } catch (reason) { error.value = message(reason) }
}

function normalizePaymentHandle(value: string, label: string): string | undefined {
  const token = value.trim().replace(/^@/, '')
  if (!token) return undefined
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(token)) throw new ApplicationError('account.error.handle', { label })
  return token
}

async function saveNotifications(): Promise<void> {
  error.value = undefined; status.value = undefined
  try {
    await session.queue.submit({ kind: 'notification.preferences', operationId: createClientOperationId('notification-preferences'), preferences: { ...notificationPreferences.value } }).result()
    status.value = { kind: 'application', key: 'account.status.notificationsSaved' }
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
    if (!auth) throw new ApplicationError('account.error.authNotInitialized')
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
  error.value = undefined; status.value = undefined
  const summary = session.quiesce()
  if (summary.pending > 0) { session.resumeWork(); error.value = { kind: 'application', key: 'account.error.waitClear' }; await restoreFocus(); return }
  try {
    const principal = await session.principal
    await session.clearLocalData()
    await createBrowserPrincipalLocalDataPort().clear(principal)
    session.resumeWork()
    status.value = { kind: 'application', key: 'account.status.cleared' }
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
  deletionError.value = undefined
  deletionProgress.value = undefined
  deletionOpen.value = true
}
function closeAccountDeletion(): void {
  if (deletingAccount.value) return
  deletionOpen.value = false
  deletionAcknowledged.value = false
  deletionPassword.value = ''
  deletionError.value = undefined
  deletionProgress.value = undefined
  void restoreFocus()
}
async function canDismissAccountDeletion(): Promise<boolean> { return !deletingAccount.value }
async function deleteAccount(): Promise<void> {
  if (!auth || !canConfirmDeletion.value) return
  deletionError.value = undefined
  status.value = undefined
  const summary = session.quiesce()
  unresolved.value = summary
  if (summary.pending > 0) {
    session.resumeWork()
    deletionError.value = { kind: 'application', key: 'account.error.waitDelete' }
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
// The triggers are Ionic items whose focusable button lives in their shadow root.
async function restoreFocus(): Promise<void> { await nextTick(); restoreInteractiveFocus(trigger.value) }
function message(reason: unknown): DisplayMessage { return displayMessageFor(reason, 'account.error.actionFailed') }
function translateMessage(message: DisplayMessage | undefined): string | undefined { return displayMessageText(message, t) }
function progressCopy(stage: AccountDeletionProgressStage | undefined): string {
  if (stage === 'starting') return t('account.progress.starting')
  if (stage === 'shared-data') return t('account.progress.shared')
  if (stage === 'group-continuity') return t('account.progress.group')
  if (stage === 'private-data') return t('account.progress.private')
  if (stage === 'prepared') return t('account.progress.prepared')
  return t('account.progress.reauth')
}
</script>

<template>
  <ion-page :ref="setPresentingElement">
    <ion-header translucent><ion-toolbar><ion-title>{{ t('nav.account') }}</ion-title><ion-buttons slot="end"><ion-button router-link="/tabs/account/export">{{ t('account.export') }}</ion-button></ion-buttons></ion-toolbar></ion-header>
    <ion-content :fullscreen="true">
      <main class="account-page">
        <h1 class="su-visually-hidden">{{ t('nav.account') }}</h1>
        <header class="profile-card">
          <span class="profile-avatar" aria-hidden="true">{{ initials }}</span>
          <span><strong>{{ member?.displayName ?? t('account.yourAccount') }}</strong><small v-if="privateIdentity?.email">{{ privateIdentity.email }}<em v-if="privateIdentity.emailVerified">{{ t('account.verified') }}</em></small><small>{{ modeCopy }}</small></span>
        </header>

        <p v-if="errorCopy" class="account-error" role="alert" tabindex="-1">{{ errorCopy }}</p>
        <p v-if="statusCopy" class="account-status" role="status" aria-live="polite">{{ statusCopy }}</p>

        <p class="section-label">{{ t('account.profile') }}</p>
        <ion-list inset lines="full" class="settings-group" :aria-busy="!profileReady">
          <ion-item class="settings-item input-item">
            <ion-input id="account-name" v-model="displayName" :label="t('auth.name')" label-placement="fixed" autocomplete="name" autocapitalize="words" :disabled="!profileReady" />
          </ion-item>
          <ion-item class="settings-item input-item">
            <ion-input id="paypal-handle" v-model="paypalHandle" data-testid="paypal-handle" label="PayPal" label-placement="fixed" autocomplete="off" inputmode="text" :maxlength="65" :placeholder="t('account.optionalHandle')" :disabled="!profileReady" />
          </ion-item>
          <ion-item class="settings-item input-item">
            <ion-input id="venmo-handle" v-model="venmoHandle" data-testid="venmo-handle" label="Venmo" label-placement="fixed" autocomplete="off" inputmode="text" :maxlength="65" :placeholder="t('account.optionalHandle')" :disabled="!profileReady" />
          </ion-item>
          <ion-item class="settings-item help-item"><ion-label class="profile-help">{{ t('account.paymentHelp') }}</ion-label></ion-item>
          <ion-item class="settings-item action-item">
            <ion-button class="settings-action" expand="full" fill="clear" data-action="save-profile" :disabled="!profileReady" @click="saveProfile">{{ profileReady ? t('account.saveProfile') : t('account.loadingProfile') }}</ion-button>
          </ion-item>
        </ion-list>

        <p class="section-label">{{ t('account.preferences') }}</p>
        <ion-list inset lines="full" class="settings-group">
          <ion-item class="settings-item">
            <ion-toggle v-model="notificationPreferences.emailEnabled" class="settings-toggle" justify="space-between">
              <span class="toggle-copy"><span class="row-icon" aria-hidden="true"><ion-icon :icon="notificationsOutline" /></span><span class="row-copy"><strong>{{ t('account.emailNotifications') }}</strong><small>{{ t('account.emailDetail') }}</small></span></span>
            </ion-toggle>
          </ion-item>
          <ion-item class="settings-item">
            <ion-toggle v-model="notificationPreferences.pushEnabled" class="settings-toggle" justify="space-between">
              <span class="toggle-copy"><span class="row-icon" aria-hidden="true"><ion-icon :icon="notificationsOutline" /></span><span class="row-copy"><strong>{{ t('account.pushNotifications') }}</strong><small>{{ t('account.pushDetail') }}</small></span></span>
            </ion-toggle>
          </ion-item>
          <ion-item class="settings-item action-item">
            <ion-button class="settings-action" expand="full" fill="clear" data-action="save-notifications" @click="saveNotifications">{{ t('account.saveNotifications') }}</ion-button>
          </ion-item>
          <ion-item class="settings-item" router-link="/tabs/account/appearance" detail>
            <span slot="start" class="row-icon" aria-hidden="true"><ion-icon :icon="colorPaletteOutline" /></span>
            <ion-label class="row-copy"><strong>{{ t('account.appearance') }}</strong><small>{{ t('account.appearanceDetail') }}</small></ion-label>
          </ion-item>
          <ion-item class="settings-item" router-link="/tabs/account/language" detail>
            <span slot="start" class="row-icon" aria-hidden="true"><ion-icon :icon="languageOutline" /></span>
            <ion-label class="row-copy"><strong>{{ t('language.title') }}</strong><small>{{ t('language.accountDetail') }}</small></ion-label>
          </ion-item>
          <ion-item class="settings-item" router-link="/tabs/account/currencies" detail>
            <span slot="start" class="row-icon" aria-hidden="true"><ion-icon :icon="cardOutline" /></span>
            <ion-label class="row-copy"><strong>{{ t('account.currencies') }}</strong><small>{{ t('account.currenciesDetail') }}</small></ion-label>
          </ion-item>
        </ion-list>

        <p class="section-label">{{ t('account.data') }}</p>
        <ion-list inset lines="full" class="settings-group">
          <ion-item class="settings-item" router-link="/tabs/account/transactions/import" detail>
            <span slot="start" class="row-icon" aria-hidden="true"><ion-icon :icon="documentAttachOutline" /></span>
            <ion-label class="row-copy"><strong>{{ t('account.importTransactions') }}</strong><small>{{ t('account.importDetail') }}</small></ion-label>
          </ion-item>
          <ion-item class="settings-item" router-link="/tabs/account/export" detail>
            <span slot="start" class="row-icon" aria-hidden="true"><ion-icon :icon="archiveOutline" /></span>
            <ion-label class="row-copy"><strong>{{ t('account.exportData') }}</strong><small>{{ t('account.exportDetail') }}</small></ion-label>
          </ion-item>
          <ion-item class="settings-item">
            <span slot="start" class="row-icon" aria-hidden="true"><ion-icon :icon="cloudOfflineOutline" /></span>
            <ion-label class="row-copy"><strong>{{ t('account.offlineChanges') }}</strong><small>{{ unresolved.total ? t('account.offlineSummary', unresolved) : t('account.deviceSettled') }}</small></ion-label>
          </ion-item>
          <ion-item class="settings-item launch-timing" data-testid="launch-timing">
            <span slot="start" class="row-icon" aria-hidden="true"><ion-icon :icon="speedometerOutline" /></span>
            <ion-label class="row-copy"><strong>{{ t('account.launchTiming') }}</strong><small v-if="launches.length === 0">{{ t('account.launchTimingEmpty') }}</small><small v-for="launch in launches" :key="launch.startedAt">{{ launch.path }}{{ launch.standalone ? ' (app)' : '' }}: {{ describeLaunch(launch) }}</small></ion-label>
          </ion-item>
          <ion-item class="settings-item danger-item" button :detail="false" @click="beginClear">
            <span slot="start" class="row-icon" aria-hidden="true"><ion-icon :icon="trashOutline" /></span>
            <ion-label class="row-copy"><strong>{{ t('account.clearLocal') }}</strong><small>{{ t('account.clearLocalDetail') }}</small></ion-label>
          </ion-item>
        </ion-list>

        <p class="section-label">{{ t('nav.account') }}</p>
        <ion-list inset lines="full" class="settings-group">
          <ion-item class="settings-item danger-item" button :detail="false" :disabled="session.repository.mode === 'demo'" @click="beginSignOut">
            <span slot="start" class="row-icon" aria-hidden="true"><ion-icon :icon="logOutOutline" /></span>
            <ion-label class="row-copy"><strong>{{ t('account.signOut') }}</strong><small>{{ session.repository.mode === 'demo' ? t('account.demoUnavailable') : t('account.reviewDrafts') }}</small></ion-label>
          </ion-item>
          <ion-item data-testid="open-account-delete" class="settings-item danger-item" button detail :disabled="!deletionAvailable" @click="beginAccountDeletion">
            <span slot="start" class="row-icon" aria-hidden="true"><ion-icon :icon="personCircleOutline" /></span>
            <ion-label class="row-copy"><strong>{{ t('account.delete') }}</strong><small>{{ session.repository.mode === 'demo' ? t('account.demoUnavailable') : deletionProvider === 'unsupported' ? t('account.unsupportedProvider') : t('account.deleteDetail') }}</small></ion-label>
          </ion-item>
        </ion-list>
      </main>
    </ion-content>

    <ion-alert :is-open="signOutDecision" :header="t('account.signOutHeader')" :message="t('account.signOutMessage', unresolved)" :buttons="[
      { text: t('activity.cancel'), role: 'cancel', handler: () => finishSignOut('cancel') },
      { text: t('account.keepDrafts'), handler: () => finishSignOut('keep') },
      { text: t('account.discardTerminal'), role: 'destructive', handler: () => finishSignOut('discard') },
    ]" @did-dismiss="signOutDecision = false" />
    <ion-alert :is-open="clearDecision" :header="t('account.clearHeader')" :message="t('account.clearMessage')" :buttons="[
      { text: t('activity.cancel'), role: 'cancel', handler: () => { clearDecision = false; restoreFocus() } },
      { text: t('account.clearAction'), role: 'destructive', handler: clearLocalData },
    ]" @did-dismiss="clearDecision = false" />

    <ion-modal :is-open="deletionOpen" :presenting-element="presentingElement" :can-dismiss="canDismissAccountDeletion" @did-dismiss="closeAccountDeletion">
      <ion-header translucent>
        <ion-toolbar>
          <ion-buttons slot="start"><ion-button :disabled="deletingAccount" @click="closeAccountDeletion">{{ t('activity.cancel') }}</ion-button></ion-buttons>
          <ion-title>{{ t('account.delete') }}</ion-title>
        </ion-toolbar>
      </ion-header>
      <ion-content>
        <main class="account-deletion-card" data-testid="account-deletion-modal">
          <span class="deletion-mark" aria-hidden="true"><ion-icon :icon="trashOutline" /></span>
          <h2>{{ t('account.deleteQuestion') }}</h2>
          <p>{{ t('account.deletePermanent') }}</p>
          <section class="deletion-summary" :aria-label="t('account.deleteAria')">
            <strong>{{ t('account.sharedBalances') }}</strong>
            <p>{{ t('account.deleteHistory') }}</p>
          </section>
          <ion-input
            v-if="deletionProvider === 'password'"
            v-model="deletionPassword"
            data-testid="account-delete-password"
            type="password"
            :label="t('account.currentPassword')"
            label-placement="stacked"
            fill="outline"
            autocomplete="current-password"
            :disabled="deletingAccount"
          />
          <p v-else-if="deletionProvider === 'google'" class="google-reauth">{{ t('account.googleConfirm') }}</p>
          <ion-checkbox v-model="deletionAcknowledged" data-testid="account-delete-ack" label-placement="end" alignment="start" :disabled="deletingAccount">
            {{ t('account.deleteAcknowledge') }}
          </ion-checkbox>
          <p v-if="deletionErrorCopy" class="deletion-error" role="alert">{{ deletionErrorCopy }}</p>
          <p v-if="deletingAccount" class="deletion-progress" role="status" aria-live="polite"><ion-spinner name="crescent" />{{ deletionProgressCopy }}</p>
          <ion-button data-testid="confirm-account-delete" expand="block" shape="round" color="danger" :disabled="!canConfirmDeletion" @click="deleteAccount">
            {{ deletingAccount ? t('account.deleting') : deletionProvider === 'google' ? t('account.continueGoogle') : t('account.permanentDelete') }}
          </ion-button>
        </main>
      </ion-content>
    </ion-modal>
  </ion-page>
</template>

<style scoped>
.account-page{padding:16px 16px calc(116px + env(safe-area-inset-bottom));background:color-mix(in srgb,var(--su-lilac) 28%,var(--su-surface))}.profile-card{display:grid;grid-template-columns:64px 1fr;align-items:center;gap:14px;margin:2px 0 25px;padding:8px 4px}.profile-avatar{display:grid;width:62px;height:62px;place-items:center;border-radius:50%;background:linear-gradient(145deg,var(--ion-color-primary),var(--su-indigo));color:#fff;font-size:1.2rem;font-weight:750;box-shadow:0 8px 24px rgb(69 42 183 / 22%)}.profile-card>span:last-child{display:grid;gap:4px;min-width:0}.profile-card strong{font-size:1.22rem}.profile-card small{display:flex;flex-wrap:wrap;gap:6px;color:var(--ion-color-medium);font-size:.78rem;overflow-wrap:anywhere}.profile-card em{padding:2px 6px;border-radius:8px;background:var(--su-lilac);color:var(--ion-color-primary);font-size:.72rem;font-style:normal;font-weight:700}.section-label{margin:22px 12px 8px;color:var(--ion-color-medium);font-size:.72rem;text-transform:uppercase;letter-spacing:.06em}.settings-group{overflow:hidden;margin:0;padding:0;border-radius:14px;background:var(--su-surface);box-shadow:0 0 0 1px color-mix(in srgb,var(--su-divider) 18%,transparent)}.settings-item{--background:transparent;--border-color:color-mix(in srgb,var(--su-divider) 24%,transparent);--min-height:58px;--padding-start:13px;--inner-padding-end:13px;color:var(--su-text)}.settings-item.item-disabled{opacity:.55}.row-icon{display:grid;flex:0 0 auto;width:28px;height:28px;place-items:center;margin:0 15px 0 0;border-radius:8px;background:var(--su-lilac);color:var(--ion-color-primary)}.row-copy{display:grid;gap:2px;min-width:0;white-space:normal}.row-copy small{color:var(--ion-color-medium);font-size:.74rem;line-height:1.3;overflow-wrap:anywhere}.settings-toggle::part(label){min-width:0;overflow:visible;text-overflow:clip;white-space:normal}.toggle-copy{display:flex;align-items:center;min-width:0;padding-block:7px}.input-item ion-input{font-size:16px}.input-item :deep(input){text-align:end}.input-item ion-input.input-disabled{opacity:.55}.help-item{--min-height:0}.profile-help{margin:11px 0;color:var(--ion-color-medium);font-size:.74rem;line-height:1.4;white-space:normal}.action-item{--min-height:48px;--padding-start:0;--inner-padding-end:0}.settings-action{flex:1;width:100%;min-height:48px;margin:0;--border-radius:0;font-weight:650;text-transform:none}.danger-item{color:var(--ion-color-danger)}.account-error,.account-status{padding:11px 13px;border-radius:12px;font-size:.82rem}.account-error{background:color-mix(in srgb,var(--ion-color-danger) 10%,var(--su-surface));color:var(--ion-color-danger)}.account-status{background:var(--su-lilac);color:var(--ion-color-primary)}
.account-deletion-card{box-sizing:border-box;display:grid;width:min(100%,560px);min-width:0;margin:0 auto;padding:28px 20px calc(36px + env(safe-area-inset-bottom));gap:16px;overflow-wrap:anywhere}.account-deletion-card>*{min-width:0}.account-deletion-card h2{margin:2px 0 -8px;font-size:1.7rem;letter-spacing:-.035em}.account-deletion-card>p{margin:0;color:var(--ion-color-medium);font-size:.92rem;line-height:1.45}.deletion-mark{display:grid;width:54px;height:54px;place-items:center;border-radius:18px;background:color-mix(in srgb,var(--ion-color-danger) 12%,var(--su-surface));color:var(--ion-color-danger);font-size:1.55rem}.deletion-summary{padding:14px 15px;border:1px solid color-mix(in srgb,var(--su-divider) 72%,transparent);border-radius:14px;background:var(--su-surface)}.deletion-summary strong{font-size:.92rem}.deletion-summary p{margin:5px 0 0;color:var(--ion-color-medium);font-size:.8rem;line-height:1.45}.account-deletion-card ion-input{--border-radius:12px;--padding-start:14px;--padding-end:14px}.account-deletion-card ion-checkbox{box-sizing:border-box;width:100%;min-width:0;font-size:.86rem;line-height:1.35}.account-deletion-card ion-checkbox::part(label){min-width:0;overflow:visible;text-overflow:clip;white-space:normal;overflow-wrap:anywhere}.google-reauth{padding:12px 14px;border-radius:12px;background:var(--su-lilac);color:var(--ion-color-primary)!important;font-weight:650}.deletion-error,.deletion-progress{padding:11px 13px;border-radius:12px;font-size:.82rem!important}.deletion-error{background:color-mix(in srgb,var(--ion-color-danger) 10%,var(--su-surface));color:var(--ion-color-danger)!important}.deletion-progress{display:flex;align-items:center;gap:9px;background:var(--su-lilac);color:var(--ion-color-primary)!important}.deletion-progress ion-spinner{width:18px;height:18px}
</style>
