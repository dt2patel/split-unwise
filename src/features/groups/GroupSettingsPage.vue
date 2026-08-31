<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonPage, IonTitle, IonToolbar } from '@ionic/vue'
import { createClientOperationId } from '../../data/clientOperationId'
import { getAppSession } from '../../data'
import type { DefaultSplit } from '../../domain/groupSettings'
import type { GroupPremiumSnapshot } from '../premium/premiumData'
import { loadGroupPremiumSnapshot } from '../premium/premiumData'

type DefaultKind = DefaultSplit['type']
const route = useRoute(); const snapshot = ref<GroupPremiumSnapshot>(); const error = ref(''); const status = ref(''); const loading = ref(false); const saving = ref(false); const kind = ref<DefaultKind>('equal'); const selectedIds = ref<string[]>([]); const ratios = ref<Record<string, string>>({}); let request = 0
const groupId = computed(() => typeof route.params.groupId === 'string' ? route.params.groupId : '')
const canManage = computed(() => snapshot.value?.currentUser.canManage === true)
watch(groupId, (id) => { void load(id) }, { immediate: true })

async function load(id: string): Promise<void> {
  const current = ++request; loading.value = true; error.value = ''; status.value = ''; snapshot.value = undefined
  try { const loaded = await loadGroupPremiumSnapshot(id); if (current !== request) return; snapshot.value = loaded; initialize(loaded) } catch (reason) { if (current === request) error.value = message(reason) } finally { if (current === request) loading.value = false }
}
function initialize(loaded: GroupPremiumSnapshot): void {
  const configured = loaded.settings.defaultSplit
  kind.value = configured?.type ?? 'equal'; selectedIds.value = [...(configured?.participantIds ?? loaded.members.map(({ id }) => id))]
  ratios.value = Object.fromEntries(loaded.members.map(({ id }) => [id, configured?.type === 'percentage' ? String(configured.percentages[id] ?? 0) : configured?.type === 'shares' ? String(configured.shares[id] ?? 1) : '1']))
}
function selectKind(next: DefaultKind): void {
  if (kind.value === next) return
  kind.value = next
  seedRatios(next)
}
function toggle(id: string, checked: boolean): void {
  selectedIds.value = checked ? [...new Set([...selectedIds.value, id])] : selectedIds.value.filter((value) => value !== id)
  if (kind.value === 'percentage') seedRatios('percentage')
  else if (kind.value === 'shares' && checked && !ratios.value[id]) ratios.value = { ...ratios.value, [id]: '1' }
}
function seedRatios(next: DefaultKind): void {
  if (next === 'equal') return
  const included = snapshot.value?.members.map(({ id }) => id).filter((id) => selectedIds.value.includes(id)) ?? []
  if (next === 'shares') { ratios.value = Object.fromEntries(included.map((id) => [id, '1'])); return }
  if (!included.length) { ratios.value = {}; return }
  const base = Math.floor(100 / included.length); const remainder = 100 - base * included.length
  ratios.value = Object.fromEntries(included.map((id, index) => [id, String(base + (index < remainder ? 1 : 0))]))
}
function buildDefault(): DefaultSplit {
  const participantIds = snapshot.value?.members.map(({ id }) => id).filter((id) => selectedIds.value.includes(id)) ?? []
  if (kind.value === 'equal') return { type: 'equal', participantIds }
  const values = Object.fromEntries(participantIds.map((id) => [id, Number(ratios.value[id])]))
  return kind.value === 'percentage' ? { type: 'percentage', participantIds, percentages: values } : { type: 'shares', participantIds, shares: values }
}
async function saveDefault(): Promise<void> { await submit(buildDefault(), 'Default split saved.') }
async function clearDefault(): Promise<void> { await submit(null, 'Default split cleared.') }
async function submit(defaultSplit: DefaultSplit | null, confirmation: string): Promise<void> {
  if (!snapshot.value || !canManage.value || saving.value) return
  saving.value = true; error.value = ''; status.value = ''
  try {
    const result = await getAppSession().queue.submit({ kind: 'group.default-split', operationId: createClientOperationId('group-default'), groupId: snapshot.value.group.id, expectedRevision: snapshot.value.settings.revision, defaultSplit }).result()
    if (result.status !== 'saved') throw new Error(result.reason)
    await load(snapshot.value.group.id); status.value = confirmation; await nextTick()
  } catch (reason) { error.value = message(reason) } finally { saving.value = false }
}
function message(reason: unknown): string { if (reason && typeof reason === 'object' && 'message' in reason) return String(reason.message); return String(reason) }
</script>

<template>
  <ion-page><ion-header translucent><ion-toolbar><ion-buttons slot="start"><ion-back-button :default-href="`/tabs/groups/${encodeURIComponent(groupId)}`" text="Group" /></ion-buttons><ion-title>Group settings</ion-title></ion-toolbar></ion-header>
    <ion-content :fullscreen="true"><main class="settings-main"><p class="eyebrow">{{ snapshot?.group.name ?? 'Group' }}</p><h1>Group settings</h1><p class="intro">Choose how new expenses start. Existing expenses, payers, recurrence, and receipt itemization never change.</p>
      <p v-if="loading" role="status">Loading group settings…</p><p v-else-if="error && !snapshot" role="alert" class="error">{{ error }}</p>
      <template v-else-if="snapshot"><section class="settings-card" aria-labelledby="default-heading"><header><div><h2 id="default-heading">Default split</h2><p>Settings revision {{ snapshot.settings.revision }}</p></div><span class="unlocked">Included</span></header>
          <p v-if="!canManage" class="permission-note">Only an active group manager can change this shared default.</p>
          <fieldset :disabled="!canManage || saving"><legend>Method</legend><div class="method-grid"><label v-for="option in (['equal', 'percentage', 'shares'] as const)" :key="option"><input :checked="kind === option" type="radio" name="default-kind" :value="option" @change="selectKind(option)"><span>{{ option === 'equal' ? 'Equally' : option === 'percentage' ? 'By percentage' : 'By shares' }}</span></label></div></fieldset>
          <fieldset :disabled="!canManage || saving"><legend>People included</legend><div class="member-list"><label v-for="member in snapshot.members" :key="member.id"><input type="checkbox" :checked="selectedIds.includes(member.id)" @change="toggle(member.id, ($event.target as HTMLInputElement).checked)"><span>{{ member.displayName }}</span><input v-if="kind !== 'equal'" v-model="ratios[member.id]" class="ratio-input" inputmode="decimal" :aria-label="`${member.displayName} ${kind === 'percentage' ? 'percentage' : 'shares'}`" :disabled="!selectedIds.includes(member.id)"><small v-if="kind === 'percentage'">%</small></label></div></fieldset>
          <p v-if="error" role="alert" class="error">{{ error }}</p><p class="status" role="status" aria-live="polite">{{ status }}</p>
          <div class="actions"><ion-button expand="block" :disabled="!canManage || saving" @click="saveDefault">{{ saving ? 'Saving…' : 'Save default' }}</ion-button><button type="button" :disabled="!canManage || saving || !snapshot.settings.defaultSplit" @click="clearDefault">Clear default</button></div>
        </section>
        <section class="truth-card"><h2>How defaults work</h2><ul><li>They seed only future expense drafts.</li><li>Receipt itemization always wins.</li><li>Membership changes clear an invalid default instead of redistributing it.</li></ul></section>
      </template>
    </main></ion-content></ion-page>
</template>

<style scoped>
.settings-main { width: min(100%, 640px); margin: 0 auto; padding: 22px 18px calc(42px + env(safe-area-inset-bottom)); }.eyebrow { margin: 0 0 4px; color: var(--su-accent); font-size: .78rem; font-weight: 700; text-transform: uppercase; }.settings-main h1 { margin: 0; font-size: clamp(2rem, 9vw, 2.55rem); letter-spacing: -.045em; }.intro { margin: 8px 0 20px; color: var(--ion-color-medium); line-height: 1.45; }.settings-card, .truth-card { margin-top: 14px; padding: 16px; border: 1px solid color-mix(in srgb, var(--su-divider) 35%, transparent); border-radius: 18px; }.settings-card > header { display: flex; align-items: start; justify-content: space-between; gap: 12px; }.settings-card h2, .truth-card h2 { margin: 0; font-size: 1.05rem; }.settings-card header p { margin: 3px 0 0; color: var(--ion-color-medium); font-size: .78rem; }.unlocked { padding: 5px 9px; border-radius: 12px; background: var(--su-lilac); color: var(--su-category-fg); font-size: .72rem; font-weight: 700; }.settings-card fieldset { margin: 18px 0 0; border: 0; padding: 0; }.settings-card legend { margin-bottom: 8px; font-size: .82rem; font-weight: 700; }.method-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 7px; }.method-grid label { min-height: 44px; }.method-grid input { position: absolute; opacity: 0; }.method-grid span { display: grid; min-height: 44px; place-items: center; border: 1px solid var(--su-divider); border-radius: 12px; padding: 0 6px; font-size: .78rem; text-align: center; }.method-grid input:checked + span { border-color: var(--su-accent); background: var(--su-lilac); color: var(--su-category-fg); font-weight: 700; }.member-list { display: grid; }.member-list label { display: grid; grid-template-columns: 28px minmax(0, 1fr) 72px 16px; min-height: 50px; align-items: center; border-top: 1px solid color-mix(in srgb, var(--su-divider) 28%, transparent); }.member-list input[type="checkbox"] { width: 22px; height: 22px; accent-color: var(--su-accent); }.ratio-input { min-height: 40px; min-width: 0; border: 1px solid var(--su-divider); border-radius: 10px; padding: 0 8px; background: var(--su-surface); color: inherit; font: inherit; text-align: right; }.actions { display: grid; gap: 8px; margin-top: 8px; }.actions ion-button, .actions button { min-height: 44px; margin: 0; }.actions button { border: 0; background: transparent; color: var(--su-owing); font: inherit; }.permission-note, .truth-card, .status { color: var(--ion-color-medium); font-size: .88rem; line-height: 1.45; }.truth-card ul { margin: 10px 0 0; padding-left: 20px; }.error { color: var(--su-owing); }
@media (max-width: 360px) { .method-grid { grid-template-columns: 1fr; } }
</style>
