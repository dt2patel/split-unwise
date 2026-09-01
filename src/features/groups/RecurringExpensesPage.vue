<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import {
  IonAlert,
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonPage,
  IonSkeletonText,
  IonTitle,
  IonToolbar,
  onIonViewWillEnter,
} from '@ionic/vue'
import { calendarOutline, createOutline, repeatOutline, stopCircleOutline } from 'ionicons/icons'
import { formatMoney } from '../../components/MoneyAmount.vue'
import { createClientOperationId } from '../../data/clientOperationId'
import { getAppSession } from '../../data'
import { isStrictId } from '../../data/identifiers'
import type { ExpenseRow, Group, MaterializeDueResult, Member, RecurringExpense } from '../../data/repositories'

const route = useRoute()
const session = getAppSession()
const group = ref<Group>()
const currentUser = ref<Member>()
const templates = ref<readonly RecurringExpense[]>([])
const groupExpenses = ref<readonly ExpenseRow[]>([])
const isLoading = ref(true)
const isCatchingUp = ref(false)
const loadError = ref('')
const catchUpError = ref('')
const catchUpNotice = ref('')
const catchUpCap = ref('')
const cancellationTarget = ref<RecurringExpense>()
const cancellingTemplateId = ref('')
const operationNotice = ref('')
const operationError = ref('')
let loadRequest = 0
let entryRevision = 0
let entryFlight: { readonly groupId: string; readonly promise: Promise<void> } | undefined
let catchUpFlight: { readonly groupId: string; readonly promise: Promise<void> } | undefined
let skipInitialIonicEntry = true

const groupId = computed(() => String(route.params.groupId ?? ''))
const backPath = computed(() => isStrictId(groupId.value) ? `/tabs/groups/${encodeURIComponent(groupId.value)}` : '/tabs/groups')
const addExpensePath = computed(() => isStrictId(groupId.value) ? `/tabs/groups/expenses/new?groupId=${encodeURIComponent(groupId.value)}` : '/tabs/groups/expenses/new')
const sortedTemplates = computed(() => [...templates.value].sort((left, right) => {
  if (left.status !== right.status) return left.status === 'active' ? -1 : 1
  return left.nextDate.localeCompare(right.nextDate) || left.description.localeCompare(right.description) || left.id.localeCompare(right.id)
}))
const cancellationButtons = computed(() => [
  { text: 'Keep active', role: 'cancel' },
  { text: 'Stop future expenses', role: 'destructive', handler: () => cancelRecurrence() },
])

watch(groupId, (id) => { void enterPage(id) }, { immediate: true })
onIonViewWillEnter(() => {
  if (skipInitialIonicEntry) {
    skipInitialIonicEntry = false
    return
  }
  void enterPage(groupId.value)
})

function enterPage(id = groupId.value): Promise<void> {
  entryRevision += 1
  resetOperationState()
  if (entryFlight?.groupId === id) return entryFlight.promise
  let pending!: Promise<void>
  pending = loadPage(id).finally(() => {
    if (entryFlight?.promise === pending) entryFlight = undefined
  })
  entryFlight = { groupId: id, promise: pending }
  return pending
}

async function loadPage(id: string): Promise<void> {
  const request = ++loadRequest
  isLoading.value = true
  loadError.value = ''
  catchUpError.value = ''
  catchUpNotice.value = ''
  catchUpCap.value = ''
  if (!isStrictId(id)) {
    loadError.value = 'Open recurring expenses from a valid group link.'
    isLoading.value = false
    return
  }
  try {
    await session.ready
    if (request !== loadRequest) return
    const [loadedGroup, identity] = await Promise.all([
      session.repository.groups.getById(id),
      session.repository.app.getCurrentUser(),
    ])
    if (request !== loadRequest) return
    if (!loadedGroup || loadedGroup.id !== id) throw new Error('This group is not available.')
    const [members, loadedTemplates, loadedExpenses] = await Promise.all([
      session.repository.groups.listMembers(id),
      session.repository.groups.listRecurring(id),
      session.repository.expenses.listForGroup(id),
    ])
    if (request !== loadRequest) return
    const membership = members.find(({ id: memberId }) => memberId === identity.id)
    if (!membership) throw new Error('You are not an active member of this group.')
    group.value = loadedGroup
    currentUser.value = { ...membership, isCurrentUser: true }
    templates.value = verifiedTemplates(id, loadedTemplates)
    groupExpenses.value = verifiedExpenses(id, loadedExpenses)
    isLoading.value = false
    await nextTick()
    await catchUp(id, request)
  } catch (reason) {
    if (request !== loadRequest) return
    group.value = undefined
    currentUser.value = undefined
    templates.value = []
    groupExpenses.value = []
    loadError.value = messageFor(reason, 'Recurring expenses could not be loaded.')
  } finally {
    if (request === loadRequest) isLoading.value = false
  }
}

function resetOperationState(): void {
  cancellationTarget.value = undefined
  cancellingTemplateId.value = ''
  operationNotice.value = ''
  operationError.value = ''
}

function catchUp(id: string, request = loadRequest): Promise<void> {
  if (catchUpFlight?.groupId === id) return catchUpFlight.promise
  const before = recurringState(templates.value, groupExpenses.value)
  isCatchingUp.value = true
  catchUpError.value = ''
  catchUpNotice.value = ''
  catchUpCap.value = ''
  let pending!: Promise<void>
  pending = (async () => {
    let result: MaterializeDueResult
    try {
      result = await session.repository.groups.materializeDue(id, localToday(), 24)
    } catch (reason) {
      await reconcileRejectedCatchUp(id, request, before, reason)
      return
    }
    try {
      const [refreshedTemplates, refreshedExpenses] = await Promise.all([
        session.repository.groups.listRecurring(id),
        session.repository.expenses.listForGroup(id),
      ])
      if (request !== loadRequest || groupId.value !== id) return
      templates.value = verifiedTemplates(id, refreshedTemplates)
      groupExpenses.value = verifiedExpenses(id, refreshedExpenses)
      if (result.moreRemain) {
        catchUpCap.value = `${result.occurrences.length} due expenses were added. More recurring expenses are still due. Continue catch-up to add the rest.`
      } else if (result.occurrences.length > 0) {
        const noun = result.occurrences.length === 1 ? 'expense was' : 'expenses were'
        catchUpNotice.value = `${result.occurrences.length} due ${noun} added.`
      }
    } catch (reason) {
      if (request === loadRequest && groupId.value === id) catchUpError.value = messageFor(reason, 'Due expenses could not be checked.')
    }
  })().finally(() => {
    if (catchUpFlight?.promise === pending) {
      catchUpFlight = undefined
      isCatchingUp.value = false
    }
  })
  catchUpFlight = { groupId: id, promise: pending }
  return pending
}

async function reconcileRejectedCatchUp(id: string, request: number, before: RecurringState, reason: unknown): Promise<void> {
  if (request !== loadRequest || groupId.value !== id) return
  try {
    const [loadedTemplates, loadedExpenses] = await Promise.all([
      session.repository.groups.listRecurring(id),
      session.repository.expenses.listForGroup(id),
    ])
    if (request !== loadRequest || groupId.value !== id) return
    const refreshedTemplates = verifiedTemplates(id, loadedTemplates)
    const refreshedExpenses = verifiedExpenses(id, loadedExpenses)
    const after = recurringState(refreshedTemplates, refreshedExpenses)
    templates.value = refreshedTemplates
    groupExpenses.value = refreshedExpenses
    const addedCount = [...after.occurrenceIds].filter((expenseId) => !before.occurrenceIds.has(expenseId)).length
    if (addedCount > 0) {
      const noun = addedCount === 1 ? 'expense was' : 'expenses were'
      catchUpNotice.value = `${addedCount} due ${noun} added before catch-up stopped. The confirmed list is shown.`
    } else if (after.fingerprint !== before.fingerprint) {
      catchUpNotice.value = 'Recurring expenses changed before catch-up stopped. The latest confirmed state is shown.'
    }
    catchUpError.value = messageFor(reason, 'Due expenses could not be fully checked.')
  } catch {
    if (request === loadRequest && groupId.value === id) {
      catchUpError.value = `${messageFor(reason, 'Due expenses could not be fully checked.')} The latest confirmed list could not be refreshed.`
    }
  }
}

function requestCancellation(template: RecurringExpense): void {
  if (!canCancel(template) || cancellingTemplateId.value) return
  operationError.value = ''
  cancellationTarget.value = template
}

function dismissCancellation(): void {
  cancellationTarget.value = undefined
}

async function cancelRecurrence(): Promise<void> {
  const template = cancellationTarget.value
  cancellationTarget.value = undefined
  if (!template || !canCancel(template) || !isStrictId(groupId.value)) return
  const submittedGroupId = groupId.value
  const submittedTemplateId = template.id
  const submittedEntry = entryRevision
  cancellingTemplateId.value = submittedTemplateId
  operationError.value = ''
  operationNotice.value = `Stopping future expenses for ${template.description}…`
  try {
    const result = await session.queue.submit({
      kind: 'recurrence.cancel',
      operationId: createClientOperationId('recurrence-cancel'),
      groupId: submittedGroupId,
      templateId: submittedTemplateId,
      expectedRevision: template.revision,
    }).result()
    if (result.kind !== 'recurrence.cancel' || result.status !== 'saved') throw new Error('The recurring expense could not be stopped.')
    if (!isCurrentEntry(submittedGroupId, submittedEntry)) return
    templates.value = templates.value.map((item) => item.id === result.template.id ? result.template : item)
    operationNotice.value = 'Future expenses stopped. Past expenses remain in this group.'
    try {
      await refreshSeries(submittedGroupId, submittedEntry)
    } catch {
      if (isCurrentEntry(submittedGroupId, submittedEntry)) {
        operationError.value = 'Future expenses were stopped, but the latest recurring list could not be refreshed. Reload this screen to confirm the latest group state.'
      }
    }
  } catch (reason) {
    if (isCurrentEntry(submittedGroupId, submittedEntry)) {
      operationNotice.value = ''
      operationError.value = messageFor(reason, 'The recurring expense could not be stopped.')
    }
  } finally {
    if (isCurrentEntry(submittedGroupId, submittedEntry) && cancellingTemplateId.value === submittedTemplateId) cancellingTemplateId.value = ''
  }
}

async function refreshSeries(id: string, entry: number): Promise<void> {
  if (!isCurrentEntry(id, entry)) return
  const [refreshedTemplates, refreshedExpenses] = await Promise.all([
    session.repository.groups.listRecurring(id),
    session.repository.expenses.listForGroup(id),
  ])
  if (!isCurrentEntry(id, entry)) return
  templates.value = verifiedTemplates(id, refreshedTemplates)
  groupExpenses.value = verifiedExpenses(id, refreshedExpenses)
}

function isCurrentEntry(id: string, entry: number): boolean {
  return groupId.value === id && entryRevision === entry
}

function canCancel(template: RecurringExpense): boolean {
  return template.status === 'active'
    && Boolean(currentUser.value)
    && (template.createdBy.id === currentUser.value?.id || currentUser.value?.canManage === true)
}

function canEditFuture(template: RecurringExpense): boolean {
  const frontier = confirmedFrontierExpense(template)
  return template.status === 'active'
    && Boolean(currentUser.value)
    && Boolean(frontier)
    && (currentUser.value?.canManage === true || template.createdBy.id === currentUser.value?.id)
}

function confirmedFrontierExpense(template: RecurringExpense): ExpenseRow | undefined {
  const linked = groupExpenses.value.filter((expense) => expense.recurringTemplateId === template.id && !expense.deletedAt && isStrictId(expense.id))
  if (template.lastOccurrenceId) return linked.find((expense) => expense.id === template.lastOccurrenceId)
  return linked.length === 1 ? linked[0] : undefined
}

function frontierExpenseId(template: RecurringExpense): string | undefined {
  if (template.lastOccurrenceId && isStrictId(template.lastOccurrenceId)) return template.lastOccurrenceId
  return [...groupExpenses.value]
    .filter((expense) => expense.recurringTemplateId === template.id && !expense.deletedAt && isStrictId(expense.id))
    .sort((left, right) => right.date.localeCompare(left.date) || right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id))[0]?.id
}

function expensePath(template: RecurringExpense): string | undefined {
  const expenseId = frontierExpenseId(template)
  if (!expenseId || !isStrictId(groupId.value)) return undefined
  return `/tabs/groups/expenses/${encodeURIComponent(expenseId)}?groupId=${encodeURIComponent(groupId.value)}`
}

function editExpensePath(template: RecurringExpense): string | undefined {
  const expenseId = confirmedFrontierExpense(template)?.id
  if (!expenseId || !isStrictId(groupId.value)) return undefined
  return `/tabs/groups/expenses/${encodeURIComponent(expenseId)}/edit?groupId=${encodeURIComponent(groupId.value)}`
}

function frequencyLabel(template: RecurringExpense): string {
  const labels: Record<RecurringExpense['recurrence']['frequency'], string> = {
    weekly: 'Weekly',
    fortnightly: 'Every 2 weeks',
    monthly: 'Monthly',
    yearly: 'Yearly',
  }
  return labels[template.recurrence.frequency]
}

function dateLabel(date: string): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00.000Z`))
}

function localToday(value = new Date()): string {
  return `${String(value.getFullYear()).padStart(4, '0')}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
}

function verifiedTemplates(id: string, values: readonly RecurringExpense[]): readonly RecurringExpense[] {
  if (values.some((template) => template.groupId !== id)) throw new Error('Recurring expenses did not match the requested group.')
  return values
}

function verifiedExpenses(id: string, values: readonly ExpenseRow[]): readonly ExpenseRow[] {
  if (values.some((expense) => expense.groupId !== id)) throw new Error('Recurring source expenses did not match the requested group.')
  return values
}

interface RecurringState { readonly occurrenceIds: ReadonlySet<string>; readonly fingerprint: string }

function recurringState(currentTemplates: readonly RecurringExpense[], currentExpenses: readonly ExpenseRow[]): RecurringState {
  const recurringExpenses = currentExpenses.filter((expense): expense is ExpenseRow & { readonly recurringTemplateId: string } => Boolean(expense.recurringTemplateId))
  const occurrenceIds = recurringExpenses
    .filter((expense) => expense.id.startsWith(`occ_${expense.recurringTemplateId}_`))
    .map(({ id }) => id)
  const fingerprint = [
    ...currentTemplates.map((template) => `template:${template.id}:${template.status}:${template.revision}:${template.nextDate}:${template.lastOccurrenceId ?? ''}`),
    ...recurringExpenses.map((expense) => `expense:${expense.id}:${expense.revision}:${expense.updatedAt}:${expense.deletedAt ?? ''}`),
  ].sort().join('|')
  return { occurrenceIds: new Set(occurrenceIds), fingerprint }
}

function messageFor(reason: unknown, fallback: string): string {
  return reason instanceof Error && reason.message.trim() ? reason.message : fallback
}
</script>

<template>
  <ion-page data-testid="recurring-expenses-page" class="recurring-page">
    <ion-header class="recurring-header" translucent>
      <ion-toolbar>
        <ion-buttons slot="start">
          <ion-back-button :default-href="backPath" text="Back" />
        </ion-buttons>
        <ion-title>Recurring</ion-title>
      </ion-toolbar>
    </ion-header>

    <ion-content :fullscreen="true">
      <main class="recurring-main">
        <header class="recurring-intro">
          <span class="recurring-intro__icon" aria-hidden="true"><ion-icon :icon="repeatOutline" /></span>
          <div>
            <p>{{ group?.name ?? 'Group' }}</p>
            <h1>Recurring expenses</h1>
            <span>Due expenses are added when the series creator or a group manager opens this group or this screen.</span>
          </div>
        </header>

        <section v-if="isLoading" class="recurring-skeleton" data-testid="recurring-loading" role="status" aria-label="Loading recurring expenses">
          <span class="su-visually-hidden">Loading recurring expenses…</span>
          <article v-for="index in 3" :key="index" class="recurring-skeleton__card" aria-hidden="true">
            <ion-skeleton-text animated class="recurring-skeleton__title" />
            <ion-skeleton-text animated class="recurring-skeleton__amount" />
            <ion-skeleton-text animated class="recurring-skeleton__line" />
          </article>
        </section>

        <section v-else-if="loadError" class="recurring-state recurring-state--error" data-testid="recurring-load-error" role="alert">
          <span class="recurring-state__icon" aria-hidden="true"><ion-icon :icon="stopCircleOutline" /></span>
          <h2>Recurring expenses could not be loaded</h2>
          <p>{{ loadError }}</p>
          <ion-button data-action="retry-recurring-load" fill="outline" @click="enterPage(groupId)">Retry</ion-button>
        </section>

        <template v-else-if="group">
          <p v-if="isCatchingUp" class="catch-up-message" role="status">Checking for due expenses…</p>
          <p v-if="catchUpNotice" class="catch-up-message catch-up-message--success" data-testid="catch-up-status" role="status" aria-live="polite">{{ catchUpNotice }}</p>
          <aside v-if="catchUpCap" class="catch-up-message catch-up-message--cap" data-testid="catch-up-cap" role="alert">
            <span>{{ catchUpCap }}</span>
            <ion-button fill="clear" data-action="continue-catch-up" :disabled="isCatchingUp" @click="catchUp(groupId)">Continue</ion-button>
          </aside>
          <aside v-if="catchUpError" class="catch-up-message catch-up-message--error" role="alert">
            <span>{{ catchUpError }}</span>
            <ion-button fill="clear" data-action="retry-catch-up" :disabled="isCatchingUp" @click="catchUp(groupId)">Retry catch-up</ion-button>
          </aside>
          <p v-if="operationNotice" class="operation-message" data-testid="recurrence-operation" role="status" aria-live="polite">{{ operationNotice }}</p>
          <p v-if="operationError" class="operation-message operation-message--error" data-testid="recurrence-operation-error" role="alert" aria-live="assertive">{{ operationError }}</p>

          <section v-if="sortedTemplates.length === 0" class="recurring-state recurring-state--empty" data-testid="recurring-empty">
            <span class="recurring-state__icon" aria-hidden="true"><ion-icon :icon="calendarOutline" /></span>
            <h2>No recurring expenses yet</h2>
            <p>Create an expense and choose a schedule to see it here.</p>
            <ion-button data-action="add-recurring-expense" :router-link="addExpensePath">Add expense</ion-button>
          </section>

          <transition-group v-else name="recurring-list" tag="section" class="recurring-list" aria-label="Recurring expense series">
            <article
              v-for="template in sortedTemplates"
              :key="template.id"
              class="recurring-card"
              :class="`recurring-card--${template.status}`"
              :data-template-id="template.id"
            >
              <div class="recurring-card__top">
                <span class="recurring-card__repeat" aria-hidden="true"><ion-icon :icon="repeatOutline" /></span>
                <div class="recurring-card__summary">
                  <div class="recurring-card__title-row">
                    <h2>{{ template.description }}</h2>
                    <span class="recurring-card__status" :class="`recurring-card__status--${template.status}`">{{ template.status === 'active' ? 'Active' : 'Stopped' }}</span>
                  </div>
                  <strong class="recurring-card__amount">{{ formatMoney(template.total) }}</strong>
                  <p>Created by {{ template.createdBy.displayName }}</p>
                </div>
              </div>

              <dl class="recurring-card__schedule">
                <div>
                  <dt>Schedule</dt>
                  <dd>{{ frequencyLabel(template) }}</dd>
                </div>
                <div v-if="template.status === 'active'">
                  <dt>Next</dt>
                  <dd><time data-testid="recurring-next-date" :datetime="template.nextDate">{{ dateLabel(template.nextDate) }}</time></dd>
                </div>
              </dl>

              <p v-if="template.status === 'cancelled'" class="recurring-card__stopped-copy">Future expenses are stopped. Past expenses remain in the group.</p>

              <div class="recurring-card__actions">
                <ion-button
                  v-if="expensePath(template)"
                  fill="outline"
                  data-action="view-recurring-expense"
                  :router-link="expensePath(template)"
                >View latest expense</ion-button>
                <ion-button
                  v-if="canEditFuture(template) && editExpensePath(template)"
                  fill="outline"
                  data-action="edit-recurring-expense"
                  :router-link="editExpensePath(template)"
                ><ion-icon :icon="createOutline" aria-hidden="true" />Edit future</ion-button>
                <ion-button
                  v-if="canCancel(template)"
                  fill="clear"
                  color="danger"
                  data-action="cancel-recurrence"
                  :disabled="cancellingTemplateId === template.id"
                  @click="requestCancellation(template)"
                >{{ cancellingTemplateId === template.id ? 'Stopping…' : 'Stop series' }}</ion-button>
              </div>
              <p v-if="template.status === 'active' && !canCancel(template)" class="recurring-card__permission" data-testid="recurrence-permission">
                Only the series creator or a group manager can stop future expenses.
              </p>
            </article>
          </transition-group>
        </template>
      </main>
    </ion-content>

    <ion-alert
      :is-open="Boolean(cancellationTarget)"
      :header="cancellationTarget ? `Stop ${cancellationTarget.description}?` : 'Stop recurring expense?'"
      message="Future expenses will stop. Past expenses will remain in the group and continue to count in balances."
      :buttons="cancellationButtons"
      @did-dismiss="dismissCancellation"
    />
  </ion-page>
</template>

<style scoped>
.recurring-page { overflow-x: hidden; }
.recurring-page ion-content { --background: color-mix(in srgb, var(--su-lilac) 22%, var(--su-surface)); overflow-x: hidden; }
.recurring-page ion-content::part(scroll) { overflow-x: hidden; }
.recurring-header ion-toolbar { --min-height: 54px; --border-color: color-mix(in srgb, var(--su-divider) 32%, transparent); }
.recurring-header ion-title { font-size: 1rem; font-weight: 680; }
.recurring-header ion-back-button { min-height: 44px; }
.recurring-main { box-sizing: border-box; width: min(100%, 680px); min-width: 0; margin: 0 auto; padding: 14px 16px calc(30px + env(safe-area-inset-bottom)); overflow-wrap: anywhere; }
.recurring-intro { display: grid; min-width: 0; grid-template-columns: 44px minmax(0, 1fr); align-items: start; gap: 12px; padding: 8px 2px 18px; }
.recurring-intro__icon,.recurring-state__icon { display: grid; width: 42px; height: 42px; place-items: center; border-radius: 14px; background: var(--su-lilac); color: var(--ion-color-primary); font-size: 1.35rem; }
.recurring-intro div { min-width: 0; }
.recurring-intro p,.recurring-intro h1,.recurring-intro span { margin: 0; }
.recurring-intro p { color: var(--ion-color-primary); font-size: .74rem; font-weight: 720; letter-spacing: .04em; text-transform: uppercase; }
.recurring-intro h1 { margin-top: 3px; font-size: clamp(1.55rem, 7vw, 2rem); line-height: 1.08; }
.recurring-intro div > span { display: block; margin-top: 7px; color: var(--ion-color-medium); font-size: .82rem; line-height: 1.42; }
.recurring-skeleton,.recurring-list { display: grid; min-width: 0; gap: 12px; }
.recurring-skeleton__card,.recurring-card { box-sizing: border-box; min-width: 0; padding: 16px; border: 1px solid color-mix(in srgb, var(--su-divider) 34%, transparent); border-radius: 20px; background: var(--su-surface); box-shadow: 0 8px 24px rgb(38 30 91 / 7%); }
.recurring-skeleton__card { display: grid; gap: 11px; }
.recurring-skeleton ion-skeleton-text { margin: 0; border-radius: 7px; }
.recurring-skeleton__title { width: min(172px, 70%); height: 17px; }
.recurring-skeleton__amount { width: 92px; height: 22px; }
.recurring-skeleton__line { width: min(220px, 86%); height: 12px; }
.recurring-state { display: grid; min-width: 0; justify-items: center; gap: 8px; padding: 30px 20px; border: 1px solid color-mix(in srgb, var(--su-divider) 32%, transparent); border-radius: 22px; background: var(--su-surface); text-align: center; }
.recurring-state h2,.recurring-state p { margin: 0; }
.recurring-state h2 { margin-top: 4px; font-size: 1.12rem; }
.recurring-state p { color: var(--ion-color-medium); font-size: .86rem; line-height: 1.45; }
.recurring-state ion-button { min-height: 44px; margin: 8px 0 0; text-transform: none; }
.recurring-state--error { border-color: color-mix(in srgb, var(--ion-color-danger) 26%, transparent); }
.catch-up-message,.operation-message { box-sizing: border-box; width: 100%; min-width: 0; margin: 0 0 12px; padding: 11px 13px; border-radius: 14px; background: color-mix(in srgb, var(--su-lilac) 60%, var(--su-surface)); color: var(--ion-color-primary); font-size: .82rem; line-height: 1.4; }
.catch-up-message--cap,.catch-up-message--error { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 10px; background: color-mix(in srgb, var(--ion-color-warning) 13%, var(--su-surface)); color: var(--ion-color-warning-shade); }
.catch-up-message--error,.operation-message--error { background: color-mix(in srgb, var(--ion-color-danger) 10%, var(--su-surface)); color: var(--ion-color-danger); }
.catch-up-message ion-button { min-height: 44px; margin: -7px -8px -7px 0; text-transform: none; }
.recurring-card { transition: border-color 160ms ease-out, box-shadow 160ms ease-out, opacity 160ms ease-out; }
.recurring-card--cancelled { box-shadow: none; }
.recurring-card__top { display: grid; min-width: 0; grid-template-columns: 42px minmax(0, 1fr); align-items: start; gap: 11px; }
.recurring-card__repeat { display: grid; width: 40px; height: 40px; place-items: center; border-radius: 13px; background: var(--su-lilac); color: var(--ion-color-primary); font-size: 1.18rem; }
.recurring-card--cancelled .recurring-card__repeat { background: color-mix(in srgb, var(--ion-color-medium) 12%, var(--su-surface)); color: var(--ion-color-medium); }
.recurring-card__summary { display: grid; min-width: 0; gap: 4px; }
.recurring-card__title-row { display: flex; min-width: 0; flex-wrap: wrap; align-items: start; justify-content: space-between; gap: 5px 10px; }
.recurring-card h2,.recurring-card p { margin: 0; }
.recurring-card h2 { min-width: 0; flex: 1 1 150px; font-size: 1.03rem; line-height: 1.25; overflow-wrap: anywhere; }
.recurring-card__status { flex: 0 0 auto; padding: 3px 7px; border-radius: 999px; background: color-mix(in srgb, var(--ion-color-success) 13%, var(--su-surface)); color: var(--ion-color-success-shade); font-size: .68rem; font-weight: 720; }
.recurring-card__status--cancelled { background: color-mix(in srgb, var(--ion-color-medium) 12%, var(--su-surface)); color: var(--ion-color-medium); }
.recurring-card__amount { min-width: 0; overflow: hidden; color: var(--su-text); font-size: 1.32rem; font-variant-numeric: tabular-nums; line-height: 1.2; text-overflow: ellipsis; white-space: nowrap; }
.recurring-card__summary > p { color: var(--ion-color-medium); font-size: .76rem; }
.recurring-card__schedule { display: grid; min-width: 0; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 9px; margin: 15px 0 0; }
.recurring-card__schedule div { min-width: 0; padding: 10px 11px; border-radius: 13px; background: color-mix(in srgb, var(--su-lilac) 38%, var(--su-surface)); }
.recurring-card__schedule dt { color: var(--ion-color-medium); font-size: .67rem; font-weight: 680; letter-spacing: .03em; text-transform: uppercase; }
.recurring-card__schedule dd { min-width: 0; margin: 3px 0 0; font-size: .82rem; font-weight: 650; overflow-wrap: anywhere; }
.recurring-card--cancelled .recurring-card__schedule { grid-template-columns: minmax(0, 1fr); }
.recurring-card__stopped-copy,.recurring-card__permission { margin-top: 12px !important; color: var(--ion-color-medium); font-size: .78rem; line-height: 1.4; }
.recurring-card__actions { display: flex; min-width: 0; flex-wrap: wrap; gap: 7px; margin-top: 13px; }
.recurring-card__actions ion-button { min-width: 0; min-height: 44px; flex: 1 1 126px; margin: 0; --padding-start: 10px; --padding-end: 10px; font-size: .78rem; text-transform: none; }
.recurring-card__actions ion-icon { margin-inline-end: 5px; }
.recurring-list-enter-active,.recurring-list-leave-active { transition: opacity 160ms ease-out, transform 160ms ease-out; }
.recurring-list-enter-from,.recurring-list-leave-to { opacity: 0; transform: translateY(7px); }

@media (max-width: 360px) {
  .recurring-main { padding-inline: 12px; }
  .recurring-card__schedule { grid-template-columns: minmax(0, 1fr); }
}

@media (prefers-reduced-motion: reduce) {
  .recurring-card,.recurring-list-enter-active,.recurring-list-leave-active { transition: none; }
  .recurring-list-enter-from,.recurring-list-leave-to { transform: none; }
  .recurring-skeleton ion-skeleton-text { animation: none; }
}
</style>
