<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, watch, type ComponentPublicInstance } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { IonBackButton, IonButton, IonButtons, IonCheckbox, IonContent, IonHeader, IonIcon, IonItem, IonLabel, IonList, IonModal, IonNote, IonPage, IonSegment, IonSegmentButton, IonTitle, IonToggle, IonToolbar } from '@ionic/vue'
import { trashOutline } from 'ionicons/icons'
import { createClientOperationId } from '../../data/clientOperationId'
import { getAppSession } from '../../data'
import { isStrictId } from '../../data/identifiers'
import type { DefaultSplit } from '../../domain/groupSettings'
import type { GroupPremiumSnapshot } from '../premium/premiumData'
import { loadGroupPremiumSnapshot } from '../premium/premiumData'
import MemberAvatar from '../../components/MemberAvatar.vue'
import type { Member } from '../../data/repositories'

type DefaultKind = DefaultSplit['type']
const route = useRoute(); const router = useRouter(); const snapshot = ref<GroupPremiumSnapshot>(); const error = ref(''); const status = ref(''); const loading = ref(false); const saving = ref(false); const simplifying = ref(false); const kind = ref<DefaultKind>('equal'); const selectedIds = ref<string[]>([]); const ratios = ref<Record<string, string>>({}); let request = 0
const presentingElement = shallowRef<HTMLElement>(); const removalTarget = ref<Member>(); const removing = ref(false); const removalError = ref('')
const deleteOpen = ref(false); const deleting = ref(false); const lifecycleError = ref('')
const groupId = computed(() => typeof route.params.groupId === 'string' && isStrictId(route.params.groupId) ? route.params.groupId : '')
const backPath = computed(() => groupId.value ? `/tabs/groups/${encodeURIComponent(groupId.value)}` : '/tabs/groups')
const canManage = computed(() => snapshot.value?.currentUser.canManage === true)
const simplifyDebtsEnabled = computed(() => snapshot.value?.settings.simplifyDebtsEnabled !== false)
const eligibleMembers = computed(() => snapshot.value?.members.filter(({ accountStatus }) => accountStatus !== 'deleted') ?? [])
watch(groupId, (id) => { void load(id) }, { immediate: true })

async function load(id: string): Promise<void> {
  const current = ++request; loading.value = true; error.value = ''; status.value = ''; snapshot.value = undefined
  try { const loaded = await loadGroupPremiumSnapshot(id); if (current !== request) return; snapshot.value = loaded; initialize(loaded) } catch (reason) { if (current === request) error.value = message(reason) } finally { if (current === request) loading.value = false }
}
function initialize(loaded: GroupPremiumSnapshot): void {
  const configured = loaded.settings.defaultSplit
  const activeMembers = loaded.members.filter(({ accountStatus }) => accountStatus !== 'deleted')
  kind.value = configured?.type ?? 'equal'; selectedIds.value = [...(configured?.participantIds.filter((id) => activeMembers.some((member) => member.id === id)) ?? activeMembers.map(({ id }) => id))]
  ratios.value = Object.fromEntries(loaded.members.map(({ id }) => [id, configured?.type === 'percentage' ? String(configured.percentages[id] ?? 0) : configured?.type === 'shares' ? String(configured.shares[id] ?? 1) : '1']))
}
function setPresentingElement(value: Element | ComponentPublicInstance | null): void {
  const element = value && '$el' in value ? value.$el : value
  presentingElement.value = element instanceof HTMLElement ? element : undefined
}
function openMemberRemoval(member: Member): void {
  if (!canManage.value || member.isCurrentUser || member.role === 'owner' || member.accountStatus === 'deleted') return
  removalError.value = ''; removalTarget.value = member
}
function closeMemberRemoval(): void {
  if (removing.value) return
  removalTarget.value = undefined; removalError.value = ''
}
async function removeMember(): Promise<void> {
  const target = removalTarget.value; const group = snapshot.value?.group
  if (!target || !group || removing.value) return
  removing.value = true; removalError.value = ''; error.value = ''; status.value = ''
  try {
    const result = await getAppSession().queue.submit({
      kind: 'group.member-remove', operationId: createClientOperationId('group-member-remove'), groupId: group.id, targetMemberId: target.id,
    }).result()
    if (result.status !== 'saved') throw new Error(result.reason)
    const displayName = target.displayName
    await load(group.id)
    removalTarget.value = undefined
    status.value = `${displayName} was removed from the group.`
    await nextTick()
  } catch (reason) { removalError.value = message(reason) } finally { removing.value = false }
}
async function canDismissRemoval(): Promise<boolean> { return !removing.value }
function openGroupDeletion(): void {
  if (!canManage.value || !snapshot.value) return
  lifecycleError.value = ''; deleteOpen.value = true
}
function closeGroupDeletion(): void {
  if (deleting.value) return
  deleteOpen.value = false; lifecycleError.value = ''
}
async function deleteGroup(): Promise<void> {
  const group = snapshot.value?.group
  if (!group || !canManage.value || deleting.value) return
  deleting.value = true; lifecycleError.value = ''
  try {
    const result = await getAppSession().queue.submit({
      kind: 'group.delete', operationId: createClientOperationId('group-delete'), groupId: group.id,
    }).result()
    if (result.status !== 'saved') throw new Error(result.reason)
    deleteOpen.value = false
    await router.replace('/tabs/groups')
  } catch (reason) { lifecycleError.value = message(reason) } finally { deleting.value = false }
}
async function canDismissLifecycle(): Promise<boolean> { return !deleting.value }
function selectKind(next: DefaultKind): void {
  if (kind.value === next) return
  kind.value = next
  seedRatios(next)
}
function changeKind(event: CustomEvent<{ value?: string | number }>): void {
  if (event.detail.value === 'equal' || event.detail.value === 'percentage' || event.detail.value === 'shares') selectKind(event.detail.value)
}
function toggle(id: string, checked: boolean): void {
  selectedIds.value = checked ? [...new Set([...selectedIds.value, id])] : selectedIds.value.filter((value) => value !== id)
  if (kind.value === 'percentage') seedRatios('percentage')
  else if (kind.value === 'shares' && checked && !ratios.value[id]) ratios.value = { ...ratios.value, [id]: '1' }
}
function seedRatios(next: DefaultKind): void {
  if (next === 'equal') return
  const included = eligibleMembers.value.map(({ id }) => id).filter((id) => selectedIds.value.includes(id))
  if (next === 'shares') { ratios.value = Object.fromEntries(included.map((id) => [id, '1'])); return }
  if (!included.length) { ratios.value = {}; return }
  const base = Math.floor(100 / included.length); const remainder = 100 - base * included.length
  ratios.value = Object.fromEntries(included.map((id, index) => [id, String(base + (index < remainder ? 1 : 0))]))
}
function buildDefault(): DefaultSplit {
  const participantIds = eligibleMembers.value.map(({ id }) => id).filter((id) => selectedIds.value.includes(id))
  if (kind.value === 'equal') return { type: 'equal', participantIds }
  const values = Object.fromEntries(participantIds.map((id) => [id, Number(ratios.value[id])]))
  return kind.value === 'percentage' ? { type: 'percentage', participantIds, percentages: values } : { type: 'shares', participantIds, shares: values }
}
async function saveDefault(): Promise<void> { await submit(buildDefault(), 'Default split saved.') }
async function clearDefault(): Promise<void> { await submit(null, 'Default split cleared.') }
async function updateSimplification(event: CustomEvent<{ checked: boolean }>): Promise<void> {
  const enabled = event.detail.checked
  if (!snapshot.value || simplifying.value || enabled === simplifyDebtsEnabled.value) return
  simplifying.value = true; error.value = ''; status.value = ''
  try {
    const result = await getAppSession().queue.submit({
      kind: 'group.simplify-debts', operationId: createClientOperationId('group-simplify'), groupId: snapshot.value.group.id,
      expectedRevision: snapshot.value.settings.revision, simplifyDebtsEnabled: enabled,
    }).result()
    if (result.status !== 'saved') throw new Error(result.reason)
    await load(snapshot.value.group.id)
    status.value = enabled ? 'Simplified balances saved.' : 'Direct balances saved.'
    await nextTick()
  } catch (reason) {
    const failure = message(reason)
    if (isConflict(reason, failure)) {
      const id = snapshot.value?.group.id ?? groupId.value
      await load(id)
      error.value = `${failure} Review the latest settings and try again.`
    } else error.value = failure
  } finally { simplifying.value = false }
}
async function submit(defaultSplit: DefaultSplit | null, confirmation: string): Promise<void> {
  if (!snapshot.value || !canManage.value || saving.value) return
  saving.value = true; error.value = ''; status.value = ''
  try {
    const result = await getAppSession().queue.submit({ kind: 'group.default-split', operationId: createClientOperationId('group-default'), groupId: snapshot.value.group.id, expectedRevision: snapshot.value.settings.revision, defaultSplit }).result()
    if (result.status !== 'saved') throw new Error(result.reason)
    await load(snapshot.value.group.id); status.value = confirmation; await nextTick()
  } catch (reason) {
    const failure = message(reason)
    if (isConflict(reason, failure)) {
      const id = snapshot.value?.group.id ?? groupId.value
      await load(id)
      error.value = `${failure} Review the latest settings and save again.`
    } else error.value = failure
  } finally { saving.value = false }
}
function message(reason: unknown): string { if (reason && typeof reason === 'object' && 'message' in reason) return String(reason.message); return String(reason) }
function isConflict(reason: unknown, failure: string): boolean {
  return /changed remotely/i.test(failure) || Boolean(reason && typeof reason === 'object' && 'code' in reason && reason.code === 'conflict')
}
</script>

<template>
  <ion-page :ref="setPresentingElement">
    <ion-header translucent>
      <ion-toolbar>
        <ion-buttons slot="start"><ion-back-button :default-href="backPath" text="Group" /></ion-buttons>
        <ion-title>Group settings</ion-title>
      </ion-toolbar>
    </ion-header>
    <ion-content :fullscreen="true">
      <main class="settings-main">
        <p class="eyebrow">{{ snapshot?.group.name ?? 'Group' }}</p>
        <h1>Group settings</h1>
        <p class="intro">Choose how new expenses start. Existing expenses, payers, recurrence, and receipt itemization never change.</p>
        <p v-if="loading" role="status" class="load-status">Loading group settings…</p>
        <p v-else-if="error && !snapshot" role="alert" class="error error--standalone">{{ error }}</p>

        <template v-else-if="snapshot">
          <section class="settings-section simplify-section" aria-labelledby="simplify-heading">
            <header class="section-heading">
              <div><h2 id="simplify-heading">Simplify debts</h2><p>Settings revision {{ snapshot.settings.revision }}</p></div>
              <span class="access-pill">Everyone</span>
            </header>
            <ion-list inset lines="none" class="settings-list simplify-list">
              <ion-item class="settings-row simplify-row">
                <ion-label class="settings-row__copy"><strong>Use fewer payments</strong><p>Rearranges who pays whom without changing anyone’s total balance. Both views stay available.</p></ion-label>
                <ion-toggle slot="end" data-testid="simplify-debts-toggle" aria-label="Simplify debts" :model-value="simplifyDebtsEnabled" :disabled="simplifying" @ion-change="updateSimplification" />
              </ion-item>
            </ion-list>
          </section>

          <section class="settings-section" aria-labelledby="members-heading">
            <header class="section-heading">
              <div><h2 id="members-heading">Manage members</h2><p>{{ eligibleMembers.length }} active {{ eligibleMembers.length === 1 ? 'person' : 'people' }}</p></div>
              <span class="access-pill">{{ canManage ? 'Manager' : 'View only' }}</span>
            </header>
            <ion-note v-if="!canManage" class="permission-note">Only an active group manager can remove people.</ion-note>
            <ion-list inset lines="full" class="settings-list manage-member-list">
              <ion-item v-for="member in snapshot.members" :key="`manage-${member.id}`" class="settings-row manage-member-row" :data-member-id="member.id">
                <member-avatar slot="start" :member="member" size="compact" />
                <ion-label class="manage-member-copy">
                  <strong>{{ member.displayName }}</strong>
                  <p>{{ member.accountStatus === 'deleted' ? 'Deleted account · history only' : member.isCurrentUser ? 'You' : member.role === 'owner' ? 'Owner' : member.canManage ? 'Manager' : 'Member' }}</p>
                </ion-label>
                <ion-button
                  v-if="canManage && !member.isCurrentUser && member.role !== 'owner' && member.accountStatus !== 'deleted'"
                  slot="end" fill="clear" color="danger" size="small"
                  :aria-label="`Remove ${member.displayName} from group`"
                  @click="openMemberRemoval(member)"
                >Remove</ion-button>
              </ion-item>
            </ion-list>
          </section>

          <section class="settings-section" aria-labelledby="default-heading">
            <header class="section-heading">
              <div><h2 id="default-heading">Default split</h2><p>Settings revision {{ snapshot.settings.revision }}</p></div>
              <span class="access-pill">Included</span>
            </header>
            <ion-note v-if="!canManage" class="permission-note">Only an active group manager can change this shared default.</ion-note>

            <fieldset class="method-fieldset" :disabled="!canManage || saving">
              <legend>Method</legend>
              <ion-segment data-testid="group-default-methods" aria-label="Default split method" :value="kind" :disabled="!canManage || saving" @ion-change="changeKind">
                <ion-segment-button v-for="option in (['equal', 'percentage', 'shares'] as const)" :key="option" :value="option" @click="selectKind(option)">
                  <ion-label>{{ option === 'equal' ? 'Equally' : option === 'percentage' ? 'Percentage' : 'Shares' }}</ion-label>
                </ion-segment-button>
              </ion-segment>
            </fieldset>

            <fieldset class="people-fieldset" :disabled="!canManage || saving">
              <legend>People included</legend>
              <ion-list data-testid="group-settings-list" inset lines="full" class="settings-list member-list">
                <ion-item v-for="member in eligibleMembers" :key="member.id" data-testid="group-member-row" class="settings-row member-row" :disabled="!canManage || saving">
                  <ion-checkbox slot="start" :checked="selectedIds.includes(member.id)" :disabled="!canManage || saving" :aria-label="`Include ${member.displayName}`" @ion-change="toggle(member.id, $event.detail.checked)" />
                  <ion-label>{{ member.displayName }}</ion-label>
                  <label v-if="kind !== 'equal'" slot="end" class="ratio-control">
                    <span class="su-visually-hidden">{{ member.displayName }} {{ kind === 'percentage' ? 'percentage' : 'shares' }}</span>
                    <input v-model="ratios[member.id]" class="ratio-input" inputmode="decimal" :aria-label="`${member.displayName} ${kind === 'percentage' ? 'percentage' : 'shares'}`" :disabled="!canManage || saving || !selectedIds.includes(member.id)">
                    <small v-if="kind === 'percentage'">%</small>
                  </label>
                </ion-item>
              </ion-list>
            </fieldset>

            <p v-if="error" role="alert" class="error">{{ error }}</p>
            <p class="status" role="status" aria-live="polite">{{ status }}</p>
            <div class="actions">
              <ion-button expand="block" shape="round" :disabled="!canManage || saving" @click="saveDefault">{{ saving ? 'Saving…' : 'Save default' }}</ion-button>
              <ion-button data-testid="clear-default-button" expand="block" fill="clear" color="danger" :disabled="!canManage || saving || !snapshot.settings.defaultSplit" @click="clearDefault">Clear default</ion-button>
            </div>
          </section>

          <section class="truth-card" aria-labelledby="defaults-help-heading">
            <h2 id="defaults-help-heading">How defaults work</h2>
            <ul><li>They seed only future expense drafts.</li><li>Receipt itemization always wins.</li><li>Membership changes clear an invalid default instead of redistributing it.</li></ul>
          </section>

          <section class="settings-section lifecycle-section" aria-labelledby="lifecycle-heading">
            <header class="section-heading">
              <div><h2 id="lifecycle-heading">Group lifecycle</h2><p>Shared with every active member</p></div>
              <span class="access-pill access-pill--danger">Manager</span>
            </header>
            <ion-list inset lines="none" class="settings-list">
              <ion-item class="settings-row lifecycle-row">
                <ion-label class="settings-row__copy"><strong>Delete this group</strong><p>Hide it for everyone. You can restore the complete group later from Activity.</p></ion-label>
                <ion-button data-testid="delete-group-button" slot="end" fill="clear" color="danger" :disabled="!canManage" aria-label="Delete group" @click="openGroupDeletion">Delete</ion-button>
              </ion-item>
            </ion-list>
            <ion-note v-if="!canManage" class="permission-note">Only an active group manager can delete this shared group.</ion-note>
          </section>
        </template>
      </main>
    </ion-content>

    <ion-modal :is-open="Boolean(removalTarget)" :presenting-element="presentingElement" :can-dismiss="canDismissRemoval" @did-dismiss="closeMemberRemoval">
      <ion-header translucent>
        <ion-toolbar>
          <ion-buttons slot="start"><ion-button :disabled="removing" @click="closeMemberRemoval">Cancel</ion-button></ion-buttons>
          <ion-title>Remove member</ion-title>
        </ion-toolbar>
      </ion-header>
      <ion-content>
        <main v-if="removalTarget" class="removal-card-content">
          <member-avatar :member="removalTarget" />
          <h2>Remove {{ removalTarget.displayName }}?</h2>
          <p>They will lose access to this group. Shared history stays intact.</p>
          <div class="removal-check">
            <strong>Before removal</strong>
            <p>They cannot be linked to expenses, recurring expenses, payments, or an unsettled balance. If anything is still linked, Split Unwise will tell you what to clean up.</p>
          </div>
          <p v-if="removalError" role="alert" class="error removal-error">{{ removalError }}</p>
          <ion-button data-testid="confirm-member-removal" expand="block" shape="round" color="danger" :disabled="removing" @click="removeMember">
            {{ removing ? 'Checking group…' : `Remove ${removalTarget.displayName}` }}
          </ion-button>
        </main>
      </ion-content>
    </ion-modal>

    <ion-modal :is-open="deleteOpen" :presenting-element="presentingElement" :can-dismiss="canDismissLifecycle" @did-dismiss="closeGroupDeletion">
      <ion-header translucent>
        <ion-toolbar>
          <ion-buttons slot="start"><ion-button :disabled="deleting" @click="closeGroupDeletion">Cancel</ion-button></ion-buttons>
          <ion-title>Delete group</ion-title>
        </ion-toolbar>
      </ion-header>
      <ion-content>
        <main v-if="snapshot" class="lifecycle-card-content" data-testid="group-lifecycle-modal">
          <span class="lifecycle-mark" aria-hidden="true"><ion-icon :icon="trashOutline" /></span>
          <h2>Delete {{ snapshot.group.name }}?</h2>
          <p>This hides the group for everyone. All expenses and payments stay intact and can be restored from Activity.</p>
          <div class="removal-check">
            <strong>Reversible for the whole group</strong>
            <p>Restoring brings back the same members, expenses, recurring expenses, comments, and payments.</p>
          </div>
          <p v-if="lifecycleError" role="alert" class="error removal-error">{{ lifecycleError }}</p>
          <ion-button data-testid="confirm-group-delete" expand="block" shape="round" color="danger" :disabled="deleting" @click="deleteGroup">
            {{ deleting ? 'Deleting group…' : 'Delete group for everyone' }}
          </ion-button>
        </main>
      </ion-content>
    </ion-modal>
  </ion-page>
</template>

<style scoped>
.settings-main { width: min(100%, 640px); margin: 0 auto; padding: 20px 0 calc(42px + env(safe-area-inset-bottom)); }
.eyebrow, .settings-main > h1, .intro, .load-status, .error--standalone { margin-inline: 18px; }
.eyebrow { margin-block: 0 4px; color: var(--su-accent); font-size: .75rem; font-weight: 700; letter-spacing: .02em; text-transform: uppercase; }
.settings-main > h1 { margin-block: 0; font-size: clamp(1.9rem, 8vw, 2.45rem); letter-spacing: -.045em; }
.intro { margin-block: 7px 22px; color: var(--ion-color-medium); font-size: .92rem; line-height: 1.45; }
.settings-section { margin-top: 20px; }
.section-heading { display: flex; align-items: start; justify-content: space-between; gap: 12px; margin: 0 18px 8px; }
.section-heading h2, .truth-card h2 { margin: 0; font-size: 1rem; }
.section-heading p { margin: 3px 0 0; color: var(--ion-color-medium); font-size: .75rem; }
.access-pill { padding: 4px 8px; border-radius: 999px; background: var(--su-lilac); color: var(--su-category-fg); font-size: .68rem; font-weight: 700; }
.access-pill--danger { background: color-mix(in srgb, var(--ion-color-danger) 10%, var(--su-surface)); color: var(--ion-color-danger); }
.settings-list { overflow: hidden; margin-block: 0; border: 1px solid color-mix(in srgb, var(--su-divider) 72%, transparent); border-radius: 13px; background: var(--su-surface); box-shadow: 0 1px 3px rgb(40 31 93 / 7%); }
.settings-row { --background: var(--su-surface); --border-color: color-mix(in srgb, var(--su-divider) 76%, transparent); --inner-padding-end: 12px; --min-height: 52px; --padding-start: 12px; }
.simplify-row { --min-height: 88px; }
.settings-row__copy { min-width: 0; margin-block: 12px; white-space: normal; }
.settings-row__copy strong { font-size: .94rem; }
.settings-row__copy p { margin: 3px 0 0; color: var(--ion-color-medium); font-size: .76rem; line-height: 1.35; white-space: normal; }
.simplify-row ion-toggle { min-width: 51px; min-height: 44px; margin-inline-start: 12px; }
.method-fieldset, .people-fieldset { margin: 18px 0 0; border: 0; padding: 0; }
.method-fieldset legend, .people-fieldset legend { margin: 0 18px 8px; font-size: .78rem; font-weight: 700; }
.method-fieldset ion-segment { width: auto; margin-inline: 18px; padding: 3px; border-radius: 11px; background: color-mix(in srgb, var(--su-lilac) 42%, var(--su-surface)); }
.method-fieldset ion-segment-button { min-width: 0; min-height: 40px; --border-radius: 8px; --indicator-box-shadow: 0 1px 3px rgb(40 31 93 / 12%); --indicator-color: var(--su-surface); --padding-start: 6px; --padding-end: 6px; font-size: .75rem; text-transform: none; }
.member-row ion-checkbox { width: 22px; height: 22px; margin-inline-end: 12px; }
.member-row ion-label { min-width: 0; font-size: .92rem; }
.manage-member-row { --min-height: 62px; }
.manage-member-row :deep(.member-avatar) { margin-inline-end: 12px; }
.manage-member-copy { min-width: 0; margin-block: 9px; }
.manage-member-copy strong { display: block; overflow: hidden; font-size: .91rem; text-overflow: ellipsis; white-space: nowrap; }
.manage-member-copy p { margin: 2px 0 0; color: var(--ion-color-medium); font-size: .72rem; }
.manage-member-row ion-button { min-width: 66px; min-height: 44px; margin: 0; text-transform: none; }
.ratio-control { display: flex; min-height: 44px; align-items: center; gap: 5px; margin-inline-start: 10px; }
.ratio-input { box-sizing: border-box; width: 72px; min-height: 38px; border: 1px solid var(--su-divider); border-radius: 9px; padding: 0 8px; background: var(--su-surface); color: inherit; font: inherit; text-align: right; }
.ratio-control small { width: 12px; color: var(--ion-color-medium); }
.permission-note { display: block; margin: 0 18px 4px; color: var(--ion-color-medium); font-size: .8rem; line-height: 1.4; }
.actions { display: grid; gap: 2px; margin: 10px 18px 0; }
.actions ion-button { min-height: 44px; margin: 0; text-transform: none; }
.truth-card { margin: 22px 18px 0; padding: 14px 15px; border: 1px solid color-mix(in srgb, var(--su-divider) 48%, transparent); border-radius: 13px; color: var(--ion-color-medium); font-size: .8rem; line-height: 1.45; }
.truth-card ul { margin: 8px 0 0; padding-left: 18px; }
.status { min-height: 19px; margin: 8px 18px 0; color: var(--ion-color-medium); font-size: .8rem; line-height: 1.4; }
.error { margin: 10px 18px 0; color: var(--ion-color-danger); font-size: .82rem; }
.load-status { padding: 28px 0; color: var(--ion-color-medium); text-align: center; }
.removal-card-content { box-sizing: border-box; display: flex; width: min(100%, 520px); min-height: 100%; flex-direction: column; align-items: center; margin: 0 auto; padding: 34px 20px calc(24px + env(safe-area-inset-bottom)); text-align: center; }
.removal-card-content h2 { margin: 15px 0 7px; font-size: 1.35rem; letter-spacing: -.025em; }
.removal-card-content > p { max-width: 390px; margin: 0; color: var(--ion-color-medium); font-size: .88rem; line-height: 1.45; }
.removal-check { margin: 24px 0 18px; padding: 14px 15px; border: 1px solid color-mix(in srgb, var(--su-divider) 58%, transparent); border-radius: 14px; background: color-mix(in srgb, var(--su-lilac) 34%, var(--su-surface)); text-align: start; }
.removal-check strong { font-size: .83rem; }
.removal-check p { margin: 4px 0 0; color: var(--ion-color-medium); font-size: .78rem; line-height: 1.45; }
.removal-card-content > ion-button { width: 100%; min-height: 48px; margin-top: auto; text-transform: none; }
.removal-error { width: 100%; margin: 0 0 12px; text-align: start; }
.lifecycle-section { margin-top: 24px; padding-bottom: 4px; }
.lifecycle-row { --min-height: 76px; }
.lifecycle-row ion-button { min-width: 68px; min-height: 44px; margin: 0; text-transform: none; }
.lifecycle-card-content { box-sizing: border-box; display: flex; width: min(100%, 520px); min-height: 100%; flex-direction: column; align-items: center; margin: 0 auto; padding: 36px 20px calc(24px + env(safe-area-inset-bottom)); text-align: center; }
.lifecycle-card-content h2 { margin: 15px 0 7px; font-size: 1.35rem; letter-spacing: -.025em; }
.lifecycle-card-content > p { max-width: 390px; margin: 0; color: var(--ion-color-medium); font-size: .88rem; line-height: 1.45; }
.lifecycle-card-content > ion-button { width: 100%; min-height: 48px; margin-top: auto; text-transform: none; }
.lifecycle-mark { display: grid; width: 54px; height: 54px; place-items: center; border-radius: 50%; background: color-mix(in srgb, var(--ion-color-danger) 11%, var(--su-surface)); color: var(--ion-color-danger); font-size: 2rem; font-weight: 300; line-height: 1; }
.simplify-section { animation: settings-rise var(--su-motion-slow) cubic-bezier(.2,.75,.25,1) both; }
@keyframes settings-rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
@media (max-width: 360px) { .intro { font-size: .87rem; }.method-fieldset ion-segment-button { font-size: .68rem; }.ratio-input { width: 62px; } }
@media (prefers-reduced-motion: reduce) { .simplify-section { animation: none; } }
</style>
