<script setup lang="ts">
import { computed, nextTick, onMounted, ref, shallowRef, type ComponentPublicInstance } from 'vue'
import { storeToRefs } from 'pinia'
import { useRouter } from 'vue-router'
import { IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonInput, IonItem, IonLabel, IonList, IonModal, IonNote, IonPage, IonSearchbar, IonTitle, IonToolbar } from '@ionic/vue'
import { add, checkmarkCircle, chevronDown, chevronForward } from 'ionicons/icons'
import { useI18n } from '../../app/i18n'
import { useGroupStore } from './groupStore'
import { getAppSession } from '../../data/session'
import { callSplitUnwiseFunction } from '../../data/firebaseCallables'
import { createClientOperationId } from '../../data/clientOperationId'
import { currencyPickerOrder, loadCurrencyPreferences } from '../account/currencyPreferences'
import { getActiveRuntimeConfiguration } from '../../data/firebase'
import { createSparkGroup } from '../../data/firebaseSparkMutations'
import { groupContexts } from '../../domain/expenseContexts'
import type { CurrencyCode } from '../../domain/money'
import { GROUP_COVER_CHOICES, groupCoverChoice, type GroupCoverId } from './groupCovers'

const store = useGroupStore()
const { t } = useI18n()
const { groups, error, isLoading } = storeToRefs(store)
const groupError = computed(() => {
  if (!error.value) return undefined
  if (error.value.kind === 'remote') return error.value.message
  return t(error.value.code === 'money-overflow' ? 'groups.error.moneyOverflow' : 'groups.error.load')
})
const visibleGroups = computed(() => groupContexts(groups.value))
const session = getAppSession()
const router = useRouter()
const showingCreate = ref(false)
const groupName = ref('')
const currency = ref<CurrencyCode>('USD')
const defaultCurrency = ref<CurrencyCode>('USD')
const currencyOrder = ref<readonly CurrencyCode[]>(['USD'])
const preferredCurrencies = ref<readonly CurrencyCode[]>(['USD'])
const currencyQuery = ref('')
const choosingCurrency = ref(false)
const coverId = ref<GroupCoverId>('trip')
const createError = ref('')
const creating = ref(false)
const dismissingCommittedCreate = ref(false)
const presentingElement = shallowRef<HTMLElement>()
const createTrigger = shallowRef<HTMLElement>()
const createModal = shallowRef<ComponentPublicInstance>()
const selectedCover = computed(() => groupCoverChoice(coverId.value))
const hasCreateDraft = computed(() => Boolean(groupName.value.trim()) || coverId.value !== 'trip' || currency.value !== defaultCurrency.value)
const visibleCurrencies = computed(() => {
  const query = currencyQuery.value.trim().toUpperCase()
  return query
    ? currencyOrder.value.filter((code) => code.includes(query)).slice(0, 40)
    : preferredCurrencies.value
})

onMounted(async () => {
  const preferences = loadCurrencyPreferences(await session.principal)
  defaultCurrency.value = preferences.defaultCurrency
  currency.value = preferences.defaultCurrency
  preferredCurrencies.value = [...preferences.preferredCurrencies]
  currencyOrder.value = currencyPickerOrder(preferences)
  await store.loadOverview()
})

function setPresentingElement(value: Element | ComponentPublicInstance | null): void {
  const element = value && '$el' in value ? value.$el : value
  presentingElement.value = element instanceof HTMLElement ? element : undefined
}
function openCreate(event: Event): void {
  createTrigger.value = event.currentTarget as HTMLElement
  dismissingCommittedCreate.value = false
  resetCreateDraft()
  showingCreate.value = true
}
async function requestCreateDismissal(): Promise<void> {
  if (await canDismissCreate()) showingCreate.value = false
}
async function canDismissCreate(): Promise<boolean> {
  if (dismissingCommittedCreate.value) return true
  if (creating.value) return false
  if (!hasCreateDraft.value) return true
  return window.confirm(t('groups.discardDraft'))
}
async function finishCreateDismissal(): Promise<void> {
  showingCreate.value = false
  resetCreateDraft()
  await nextTick()
  createTrigger.value?.focus()
}
function resetCreateDraft(): void {
  groupName.value = ''
  currency.value = defaultCurrency.value
  currencyQuery.value = ''
  choosingCurrency.value = false
  coverId.value = 'trip'
  createError.value = ''
}
function selectCover(id: GroupCoverId): void { coverId.value = id }
function selectCurrency(code: CurrencyCode): void {
  currency.value = code
  choosingCurrency.value = false
  currencyQuery.value = ''
}
async function dismissCreateBeforeNavigation(): Promise<void> {
  dismissingCommittedCreate.value = true
  const element: unknown = createModal.value?.$el
  const dismissed = element instanceof HTMLElement && 'onDidDismiss' in element && typeof element.onDidDismiss === 'function'
    ? element.onDidDismiss()
    : undefined
  showingCreate.value = false
  await nextTick()
  try {
    if (dismissed) await dismissed
  } finally {
    dismissingCommittedCreate.value = false
  }
}

async function createGroup(): Promise<void> {
  const name = groupName.value.trim()
  if (!name) { createError.value = t('groups.error.enterName'); return }
  creating.value = true; createError.value = ''
  try {
    const runtime = getActiveRuntimeConfiguration()
    if (runtime.kind !== 'firebase') throw new Error(t('groups.error.firebaseNotReady'))
    const operationId = createClientOperationId('group')
    const value = runtime.functionsRegion
      ? await callSplitUnwiseFunction('createGroup', { schemaVersion: 1, operationId, kind: 'group', name, currency: currency.value, coverImageUrl: selectedCover.value.imageUrl }, { replayProtected: true })
      : await createSparkGroup(runtime.firebase, { operationId, name, currency: currency.value, coverImageUrl: selectedCover.value.imageUrl })
    if (!isRecord(value) || typeof value.groupId !== 'string') throw new Error(t('groups.error.invalidResponse'))
    await dismissCreateBeforeNavigation()
    await store.loadOverview()
    await router.push(`/tabs/groups/${encodeURIComponent(value.groupId)}`)
  } catch (reason) { createError.value = reason instanceof Error ? reason.message : t('groups.error.createFailed') } finally { creating.value = false }
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function peopleCount(count: number): string { return t(count === 1 ? 'groups.person.one' : 'groups.person.other', { count }) }
function coverLabel(id: GroupCoverId): string {
  if (id === 'trip') return t('groups.cover.trip.label')
  if (id === 'home') return t('groups.cover.home.label')
  if (id === 'couple') return t('groups.cover.couple.label')
  return t('groups.cover.other.label')
}
function coverDescription(id: GroupCoverId): string {
  if (id === 'trip') return t('groups.cover.trip.description')
  if (id === 'home') return t('groups.cover.home.description')
  if (id === 'couple') return t('groups.cover.couple.description')
  return t('groups.cover.other.description')
}
</script>

<template>
  <ion-page :ref="setPresentingElement">
    <ion-header translucent>
      <ion-toolbar>
        <ion-title>{{ t('groups.title') }}</ion-title>
        <ion-buttons v-if="session.repository.mode === 'firebase'" slot="end"><ion-button :aria-label="t('groups.createAction')" @click="openCreate"><ion-icon :icon="add" /></ion-button></ion-buttons>
      </ion-toolbar>
    </ion-header>
    <ion-content :fullscreen="true">
      <main class="groups-page">
        <h1>{{ t('groups.title') }}</h1>
        <p>{{ t('groups.intro') }}</p>

        <p v-if="isLoading" role="status">{{ t('groups.loading') }}</p>
        <p v-else-if="groupError" role="alert">{{ groupError }}</p>
        <div v-else class="groups-page__list">
          <router-link
            v-for="group in visibleGroups"
            :key="group.id"
            class="group-row"
            data-testid="lake-house-link"
            :to="`/tabs/groups/${group.id}`"
          >
            <img v-if="group.coverImageUrl" :src="group.coverImageUrl" alt="" aria-hidden="true">
            <span class="group-row__copy">
              <strong>{{ group.name }}</strong>
              <small>{{ peopleCount(group.memberIds.length) }} · {{ group.currency }}</small>
            </span>
            <ion-icon :icon="chevronForward" aria-hidden="true" />
          </router-link>
        </div>
      </main>
    </ion-content>

    <ion-modal
      ref="createModal"
      :is-open="showingCreate"
      :presenting-element="presentingElement"
      :can-dismiss="canDismissCreate"
      @did-dismiss="finishCreateDismissal"
    >
      <ion-header translucent>
        <ion-toolbar>
          <ion-buttons slot="start"><ion-button :disabled="creating" @click="requestCreateDismissal">{{ t('groups.cancel') }}</ion-button></ion-buttons>
          <ion-title>{{ t('groups.newGroup') }}</ion-title>
          <ion-buttons slot="end"><ion-button strong :disabled="creating" data-testid="create-group-submit" @click="createGroup">{{ creating ? t('groups.creating') : t('groups.create') }}</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content :fullscreen="true">
        <main class="create-group-card">
          <header class="create-group-card__intro">
            <p>{{ t('groups.startSharing') }}</p>
            <h1>{{ t('groups.createTitle') }}</h1>
            <span>{{ t('groups.createIntro') }}</span>
          </header>

          <section class="cover-section" aria-labelledby="group-kind-heading">
            <div class="create-section-heading"><h2 id="group-kind-heading">{{ t('groups.kindTitle') }}</h2><ion-note>{{ t('groups.coverNote') }}</ion-note></div>
            <div class="cover-grid" role="group" :aria-label="t('groups.coverAria')">
              <button
                v-for="choice in GROUP_COVER_CHOICES"
                :key="choice.id"
                type="button"
                class="cover-choice"
                :class="{ 'cover-choice--selected': coverId === choice.id }"
                :aria-pressed="coverId === choice.id"
                :data-cover-choice="choice.id"
                @click="selectCover(choice.id)"
              >
                <span class="cover-choice__image"><img :src="choice.imageUrl" alt=""><ion-icon v-if="coverId === choice.id" :icon="checkmarkCircle" aria-hidden="true" /></span>
                <strong>{{ coverLabel(choice.id) }}</strong>
                <small>{{ coverDescription(choice.id) }}</small>
              </button>
            </div>
          </section>

          <section aria-labelledby="group-details-heading">
            <div class="create-section-heading"><h2 id="group-details-heading">{{ t('groups.details') }}</h2><ion-note>{{ t('groups.required') }}</ion-note></div>
            <ion-list inset lines="full" class="create-fields">
              <ion-item>
                <ion-input v-model="groupName" :label="t('groups.name')" label-placement="stacked" autocomplete="off" :maxlength="120" :placeholder="t('groups.namePlaceholder')" />
              </ion-item>
              <ion-item button :detail="false" data-testid="currency-trigger" @click="choosingCurrency = !choosingCurrency">
                <ion-label><span>{{ t('groups.currency') }}</span><strong>{{ currency }}</strong></ion-label>
                <ion-icon slot="end" :icon="chevronDown" aria-hidden="true" />
              </ion-item>
            </ion-list>

            <section v-if="choosingCurrency" class="currency-picker" :aria-label="t('groups.chooseCurrency')">
              <ion-searchbar v-model="currencyQuery" inputmode="search" :placeholder="t('groups.searchCurrencies')" :debounce="0" />
              <p>{{ currencyQuery.trim() ? t('groups.matchingCurrencies') : t('groups.preferredCurrencies') }}</p>
              <ion-list data-testid="currency-options" lines="full">
                <ion-item v-for="code in visibleCurrencies" :key="code" button :detail="false" :data-currency-choice="code" @click="selectCurrency(code)">
                  <ion-label>{{ code }}</ion-label>
                  <ion-icon v-if="currency === code" slot="end" :icon="checkmarkCircle" aria-hidden="true" />
                </ion-item>
              </ion-list>
              <ion-note v-if="currencyQuery.trim() && !visibleCurrencies.length">{{ t('groups.noCurrencyMatch') }}</ion-note>
            </section>
          </section>

          <p v-if="createError" role="alert" class="create-error">{{ createError }}</p>
          <p class="create-footnote">{{ t('groups.footnote') }}</p>
        </main>
      </ion-content>
    </ion-modal>
  </ion-page>
</template>

<style scoped>
.groups-page { padding: 20px 18px 110px; }
.groups-page h1 { margin: 0; font-size: 2rem; letter-spacing: -0.035em; }
.groups-page > p { margin: 8px 0 24px; color: var(--ion-color-medium); line-height: 1.45; }
.groups-page__list { border-top: 1px solid var(--su-divider); }
.group-row { display: grid; grid-template-columns: 64px minmax(0, 1fr) 18px; align-items: center; gap: 12px; min-height: 88px; border-bottom: 1px solid var(--su-divider); color: inherit; text-decoration: none; }
.group-row img { width: 64px; height: 64px; border-radius: 18px; object-fit: cover; object-position: 50% 88%; }
.group-row__copy { display: grid; gap: 4px; }
.group-row__copy strong { font-size: 1rem; }
.group-row__copy small { color: var(--ion-color-medium); }
.group-row > ion-icon { color: var(--su-accent); font-size: 1.05rem; }
.create-group-card{box-sizing:border-box;width:min(100%,620px);margin:auto;padding:22px 16px calc(38px + env(safe-area-inset-bottom));background:color-mix(in srgb,var(--su-lilac) 24%,var(--su-surface));min-height:100%}.create-group-card__intro{padding:4px 4px 24px}.create-group-card__intro p{margin:0 0 7px;color:var(--ion-color-primary);font-size:.68rem;font-weight:800;letter-spacing:.13em}.create-group-card__intro h1{margin:0;font-size:2rem;letter-spacing:-.045em}.create-group-card__intro span{display:block;max-width:32rem;margin-top:8px;color:var(--ion-color-medium);font-size:.86rem;line-height:1.45}.create-section-heading{display:flex;align-items:end;justify-content:space-between;gap:12px;margin:0 4px 10px}.create-section-heading h2{margin:0;font-size:.94rem}.create-section-heading ion-note{font-size:.7rem}.cover-section{margin-bottom:26px}.cover-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.cover-choice{display:grid;min-width:0;gap:3px;padding:0 0 11px;overflow:hidden;border:1px solid color-mix(in srgb,var(--su-divider) 28%,transparent);border-radius:17px;background:var(--su-surface);color:var(--su-text);font:inherit;text-align:left;box-shadow:0 8px 22px rgb(34 26 76 / 7%);transition:transform var(--su-motion-fast) ease,border-color var(--su-motion-fast) ease,box-shadow var(--su-motion-fast) ease}.cover-choice:active{transform:scale(.98)}.cover-choice--selected{border-color:var(--ion-color-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--ion-color-primary) 20%,transparent),0 10px 24px rgb(34 26 76 / 11%)}.cover-choice__image{position:relative;display:block;width:100%;aspect-ratio:2.17/1;overflow:hidden;background:var(--su-lilac)}.cover-choice__image img{width:100%;height:100%;object-fit:cover}.cover-choice__image ion-icon{position:absolute;right:8px;bottom:7px;padding:2px;border-radius:50%;background:var(--su-surface);color:var(--ion-color-primary);font-size:1.3rem}.cover-choice strong,.cover-choice small{padding:0 11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.cover-choice strong{margin-top:5px;font-size:.86rem}.cover-choice small{color:var(--ion-color-medium);font-size:.66rem}.create-fields{overflow:hidden;margin:0;border-radius:16px;background:var(--su-surface);box-shadow:0 0 0 1px color-mix(in srgb,var(--su-divider) 20%,transparent)}.create-fields ion-item{--background:transparent;--min-height:64px;--padding-start:14px;--inner-padding-end:12px;color:var(--su-text)}.create-fields ion-input{--padding-top:7px;--padding-bottom:9px;font-size:16px}.create-fields ion-label{display:grid;gap:3px}.create-fields ion-label span{color:var(--ion-color-medium);font-size:.69rem}.create-fields ion-label strong{font-size:.98rem}.create-fields ion-icon{color:var(--ion-color-primary)}.currency-picker{margin-top:12px;padding:8px 8px 10px;border-radius:18px;background:var(--su-surface);box-shadow:0 12px 30px rgb(34 26 76 / 9%);animation:currency-picker-in 180ms cubic-bezier(.2,.8,.2,1) both}.currency-picker ion-searchbar{--background:color-mix(in srgb,var(--su-lilac) 64%,var(--su-surface));--border-radius:12px;--box-shadow:none;padding:4px}.currency-picker>p{margin:5px 10px 3px;color:var(--ion-color-medium);font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em}.currency-picker ion-list{max-height:270px;overflow:auto;background:transparent}.currency-picker ion-item{--background:transparent;--min-height:48px;color:var(--su-text)}.currency-picker ion-icon{color:var(--ion-color-primary)}.currency-picker>ion-note{display:block;padding:14px 10px}.create-error{margin:14px 2px 0;padding:11px 12px;border-radius:12px;background:color-mix(in srgb,var(--ion-color-danger) 10%,var(--su-surface));color:var(--ion-color-danger);font-size:.8rem}.create-footnote{margin:16px 4px 0;color:var(--ion-color-medium);font-size:.72rem;line-height:1.45}@keyframes currency-picker-in{from{opacity:0;transform:translateY(-6px)}}@media(max-width:350px){.cover-grid{grid-template-columns:1fr}.cover-choice__image{aspect-ratio:2.7/1}}@media(prefers-reduced-motion:reduce){.cover-choice,.currency-picker{transition:none;animation:none}.cover-choice:active{transform:none}}
@media(max-width:350px){.cover-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.cover-choice__image{aspect-ratio:2.17/1}}
</style>
