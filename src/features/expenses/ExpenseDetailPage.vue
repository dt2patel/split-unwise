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
  IonPage,
  IonTitle,
  IonToolbar,
} from '@ionic/vue'
import MoneyAmount from '../../components/MoneyAmount.vue'
import CommentThread from '../comments/CommentThread.vue'
import { getAppSession } from '../../data'
import type { ExpenseRevision, ExpenseRow, Member } from '../../data/repositories'

type DetailOrigin = 'account' | 'activity' | 'groups' | 'home'
type DeleteState = 'conflicted' | 'failed' | 'idle' | 'pending' | 'saved'

const route = useRoute()
const session = getAppSession()
const expense = ref<ExpenseRow>()
const revisions = ref<readonly ExpenseRevision[]>([])
const members = ref<readonly Member[]>([])
const currentUser = ref<Member>()
const validatedGroupId = ref<string>()
const error = ref('')
const isLoading = ref(true)
const showDeleteConfirmation = ref(false)
const deleteState = ref<DeleteState>('idle')
const deleteOperationId = ref<string>()
const deleteTrigger = ref<HTMLElement>()
let loadRequest = 0

const origin = computed<DetailOrigin>(() => {
  const name = typeof route.name === 'string' ? route.name : ''
  const candidate = name.split('-')[0]
  return candidate === 'account' || candidate === 'activity' || candidate === 'groups' || candidate === 'home' ? candidate : 'home'
})
const groupId = computed(() => validScalarId(route.query.groupId))
const expenseId = computed(() => typeof route.params.expenseId === 'string' ? route.params.expenseId : '')
const returnPath = computed(() => origin.value === 'groups' && validatedGroupId.value ? `/tabs/groups/${encodeURIComponent(validatedGroupId.value)}` : `/tabs/${origin.value}`)
const editPath = computed(() => groupId.value && expense.value
  ? `/tabs/${origin.value}/expenses/${encodeURIComponent(expense.value.id)}/edit?groupId=${encodeURIComponent(groupId.value)}`
  : '')
const memberNames = computed(() => new Map(members.value.map((member) => [member.id, member.displayName])))
const canMutate = computed(() => {
  if (!expense.value || expense.value.deletedAt || !currentUser.value) return false
  const membership = members.value.find(({ id }) => id === currentUser.value?.id)
  return expense.value.createdBy?.id === currentUser.value.id || membership?.canManage === true
})
const alertButtons = computed(() => [
  { text: 'Cancel', role: 'cancel' },
  { text: 'Delete', role: 'destructive', handler: () => deleteExpense() },
])

watch(() => route.fullPath, () => { void load() }, { immediate: true })

async function load(): Promise<void> {
  const request = ++loadRequest
  isLoading.value = true
  error.value = ''
  expense.value = undefined
  revisions.value = []
  members.value = []
  currentUser.value = undefined
  validatedGroupId.value = undefined
  const requestedGroup = groupId.value
  const requestedExpense = expenseId.value
  if (!requestedGroup || !validId(requestedExpense)) {
    error.value = 'Open this expense from a valid group link. No group was guessed or searched.'
    isLoading.value = false
    return
  }
  try {
    await session.ready
    if (request !== loadRequest) return
    const [group, user] = await Promise.all([
      session.repository.groups.getById(requestedGroup),
      session.repository.app.getCurrentUser(),
    ])
    if (request !== loadRequest) return
    if (!group || group.id !== requestedGroup) throw new Error('This expense is not available in a group you can access.')
    const loadedMembers = await session.repository.groups.listMembers(requestedGroup)
    if (request !== loadRequest) return
    if (!loadedMembers.some(({ id }) => id === user.id)) throw new Error('This expense is not available in a group you can access.')
    validatedGroupId.value = requestedGroup
    const [loadedExpense, history] = await Promise.all([
      session.repository.expenses.getById(requestedGroup, requestedExpense),
      session.repository.expenses.listRevisions(requestedGroup, requestedExpense),
    ])
    if (request !== loadRequest) return
    if (!loadedExpense || loadedExpense.groupId !== requestedGroup || loadedExpense.id !== requestedExpense) throw new Error('This expense is not available in the requested group.')
    if (history.some((revision) => revision.groupId !== requestedGroup || revision.expenseId !== requestedExpense)) throw new Error('Expense audit history did not match the requested group.')
    currentUser.value = user
    members.value = loadedMembers
    expense.value = loadedExpense
    revisions.value = history
  } catch (reason) {
    if (request !== loadRequest) return
    error.value = message(reason, 'This expense is not available.')
  } finally {
    if (request === loadRequest) isLoading.value = false
  }
}

function requestDelete(event: Event): void {
  deleteTrigger.value = event.currentTarget as HTMLElement
  showDeleteConfirmation.value = true
}

function onDeleteDismiss(event: CustomEvent<{ role?: string }>): void {
  showDeleteConfirmation.value = false
  if (event.detail.role === 'cancel' || event.detail.role === 'backdrop') void restoreDeleteFocus()
}

async function restoreDeleteFocus(): Promise<void> {
  await nextTick()
  deleteTrigger.value?.focus()
}

async function deleteExpense(): Promise<boolean> {
  if (!expense.value || !groupId.value || !canMutate.value || deleteState.value === 'pending') return false
  const target = expense.value
  const operationId = deleteOperationId.value ?? createOperationId('expense-delete')
  deleteOperationId.value = operationId
  deleteState.value = 'pending'
  showDeleteConfirmation.value = false
  try {
    await session.queue.submit({
      kind: 'expense.delete', operationId, groupId: groupId.value, expenseId: target.id, expectedRevision: target.revision,
    }).result()
    const retained = await session.repository.expenses.getById(groupId.value, target.id)
    if (retained && retained.groupId === groupId.value && retained.id === target.id) expense.value = retained
    revisions.value = await session.repository.expenses.listRevisions(groupId.value, target.id)
    deleteState.value = 'saved'
    return true
  } catch {
    const operation = session.queue.get(operationId)
    deleteState.value = operation?.status === 'conflicted' ? 'conflicted' : 'failed'
    return false
  }
}

async function retryDelete(): Promise<void> {
  const operationId = deleteOperationId.value
  if (!operationId) return
  deleteState.value = 'pending'
  try {
    await session.queue.retry(operationId).result()
    await load()
    deleteState.value = 'saved'
  } catch {
    deleteState.value = session.queue.get(operationId)?.status === 'conflicted' ? 'conflicted' : 'failed'
  }
}

async function discardDelete(): Promise<void> {
  const operationId = deleteOperationId.value
  if (!operationId) return
  try {
    if (await session.queue.discard(operationId)) {
      deleteOperationId.value = undefined
      deleteState.value = 'idle'
    }
  } catch { /* the visible failure state remains retryable/discardable */ }
}

function payerName(memberId: string): string { return memberNames.value.get(memberId) ?? 'Unknown member' }
function formatDate(date: string): string { return new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00.000Z`)) }
function formatTimestamp(timestamp: string): string { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp)) }
function revisionLabel(revision: ExpenseRevision): string {
  if (revision.action === 'created') return `${revision.actor.displayName} created this expense`
  if (revision.action === 'updated') return `${revision.actor.displayName} updated this expense`
  return `${revision.actor.displayName} deleted this expense`
}
function recurrenceLabel(row: ExpenseRow): string {
  if (!row.recurrence) return 'Not recurring'
  return `${row.recurrence.frequency[0].toUpperCase()}${row.recurrence.frequency.slice(1)} · ${row.recurrence.timeZone}`
}
function isDeleteRetryable(): boolean {
  const operation = deleteOperationId.value ? session.queue.get(deleteOperationId.value) : undefined
  return operation?.status === 'failed' && operation.error.retryable
}
function validScalarId(value: unknown): string | undefined { return typeof value === 'string' && validId(value) ? value : undefined }
function validId(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) }
function createOperationId(prefix: string): string { return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Date.now().toString(36)}` }
function message(reason: unknown, fallback: string): string { return reason instanceof Error && reason.message.trim() ? reason.message : fallback }
</script>

<template>
  <ion-page class="expense-detail">
    <ion-header translucent>
      <ion-toolbar>
        <ion-buttons slot="start"><ion-back-button :default-href="returnPath" text="Back" /></ion-buttons>
        <ion-title>Expense</ion-title>
        <ion-buttons v-if="canMutate" slot="end">
          <ion-button data-action="edit-expense" :router-link="editPath">Edit</ion-button>
        </ion-buttons>
      </ion-toolbar>
    </ion-header>
    <ion-content :fullscreen="true">
      <main class="expense-detail__main">
        <p v-if="isLoading" role="status">Loading expense…</p>
        <section v-else-if="error" class="expense-detail__error">
          <h1>Expense unavailable</h1>
          <p role="alert">{{ error }}</p>
          <a data-action="safe-return" :href="returnPath">Return safely</a>
        </section>
        <template v-else-if="expense">
          <header class="expense-detail__hero">
            <p>{{ expense.category }}</p>
            <h1>{{ expense.description }}</h1>
            <money-amount data-testid="expense-total" :money="expense.total" label="Expense total" :show-direction="false" />
            <p v-if="expense.deletedAt" data-testid="deleted-state">This expense was deleted. Its audit history and prior comments are retained.</p>
          </header>

          <div class="expense-detail__columns">
            <div class="expense-detail__primary">
              <section aria-labelledby="details-title">
                <h2 id="details-title">Details</h2>
                <dl>
                  <div><dt>Date</dt><dd><time :datetime="expense.date">{{ formatDate(expense.date) }}</time></dd></div>
                  <div><dt>Category</dt><dd>{{ expense.category }}</dd></div>
                  <div><dt>Notes</dt><dd>{{ expense.notes || 'No notes' }}</dd></div>
                  <div><dt>Recurrence</dt><dd>{{ recurrenceLabel(expense) }}</dd></div>
                  <div><dt>Revision</dt><dd>{{ expense.revision }}</dd></div>
                  <div><dt>Created</dt><dd><time :datetime="expense.createdAt">{{ formatTimestamp(expense.createdAt) }}</time></dd></div>
                  <div><dt>Updated</dt><dd><time :datetime="expense.updatedAt">{{ formatTimestamp(expense.updatedAt) }}</time></dd></div>
                </dl>
                <p>Created by {{ expense.createdBy?.displayName ?? 'Unknown author' }}.</p>
                <p>Last edited by {{ expense.updatedBy?.displayName ?? 'Unknown editor' }}.</p>
              </section>

              <section aria-labelledby="payers-title">
                <h2 id="payers-title">Paid by</h2>
                <ul aria-labelledby="payers-title">
                  <li v-for="payment in expense.payments" :key="payment.participantId">
                    <span>{{ payerName(payment.participantId) }}</span><money-amount :money="payment.money" :show-direction="false" />
                  </li>
                </ul>
              </section>

              <section aria-labelledby="allocations-title">
                <h2 id="allocations-title">Allocated to</h2>
                <ul aria-labelledby="allocations-title">
                  <li v-for="allocation in expense.allocations" :key="allocation.participantId">
                    <span>{{ payerName(allocation.participantId) }}</span><money-amount :money="allocation.money" :show-direction="false" />
                  </li>
                </ul>
              </section>

              <section aria-labelledby="attachments-title">
                <h2 id="attachments-title">Attachments</h2>
                <p v-if="expense.attachmentRefs.length === 0">No attachments</p>
                <ul v-else aria-labelledby="attachments-title"><li v-for="attachment in expense.attachmentRefs" :key="attachment">{{ attachment }}</li></ul>
              </section>
            </div>

            <aside class="expense-detail__audit" aria-labelledby="audit-title">
              <h2 id="audit-title">Audit history</h2>
              <ol aria-labelledby="audit-title">
                <li v-for="revision in revisions" :key="revision.id">
                  <strong>{{ revisionLabel(revision) }}</strong>
                  <span>Revision {{ revision.revision }}</span>
                  <time :datetime="revision.createdAt">{{ formatTimestamp(revision.createdAt) }}</time>
                </li>
              </ol>
            </aside>
          </div>

          <section v-if="canMutate" class="expense-detail__danger" aria-labelledby="delete-title">
            <h2 id="delete-title">Delete expense</h2>
            <button ref="deleteTrigger" type="button" data-action="delete-expense" :disabled="deleteState === 'pending'" @click="requestDelete">Delete expense</button>
          </section>
          <p v-if="deleteState !== 'idle'" data-testid="delete-state" role="status">
            {{ deleteState === 'pending' ? 'Saving deletion…' : deleteState === 'failed' ? 'Deletion failed.' : deleteState === 'conflicted' ? 'Deletion conflict: the remote revision and your delete intent are retained.' : 'Deleted.' }}
          </p>
          <div v-if="deleteState === 'failed'" class="expense-detail__delete-actions">
            <button v-if="isDeleteRetryable()" type="button" @click="retryDelete">Retry</button>
            <button type="button" @click="discardDelete">Discard</button>
          </div>

          <comment-thread :group-id="expense.groupId" :expense-id="expense.id" :closed="Boolean(expense.deletedAt)" />
        </template>
      </main>
    </ion-content>
    <ion-alert
      :is-open="showDeleteConfirmation"
      :header="expense ? `Delete ${expense.description}?` : 'Delete expense?'"
      message="This keeps an immutable audit record and removes the expense from current balances."
      :buttons="alertButtons"
      @did-dismiss="onDeleteDismiss"
    />
  </ion-page>
</template>

<style scoped>
.expense-detail__main { width: min(100%, 820px); margin: 0 auto; padding: 22px 18px calc(32px + env(safe-area-inset-bottom)); overflow-wrap: anywhere; }
.expense-detail__hero { display: grid; gap: 7px; padding: 18px; border-radius: 20px; background: linear-gradient(145deg, var(--su-lilac), color-mix(in srgb, var(--su-surface) 82%, var(--su-lilac))); }
.expense-detail__hero p,
.expense-detail__hero h1 { margin: 0; }
.expense-detail__hero h1 { font-size: clamp(1.65rem, 7vw, 2.3rem); line-height: 1.08; }
.expense-detail__hero :deep(.money-amount) { justify-self: start; font-size: 1.35rem; }
.expense-detail__columns { display: grid; gap: 18px; margin-top: 18px; }
.expense-detail__primary { display: grid; gap: 18px; }
.expense-detail section,
.expense-detail__audit { padding: 16px; border: 1px solid color-mix(in srgb, var(--su-divider) 42%, transparent); border-radius: 16px; }
.expense-detail h2 { margin: 0 0 12px; font-size: 1.05rem; }
.expense-detail dl { display: grid; gap: 10px; margin: 0; }
.expense-detail dl div,
.expense-detail__primary li { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 6px 12px; }
.expense-detail dt { color: var(--ion-color-medium); }
.expense-detail dd { margin: 0; text-align: end; }
.expense-detail ul,
.expense-detail ol { display: grid; gap: 9px; margin: 0; padding: 0; list-style: none; }
.expense-detail__audit li { display: grid; gap: 4px; padding-bottom: 10px; border-bottom: 1px solid color-mix(in srgb, var(--su-divider) 35%, transparent); }
.expense-detail__audit span,
.expense-detail__audit time { color: var(--ion-color-medium); font-size: 0.82rem; }
.expense-detail__danger { margin-top: 18px; }
.expense-detail button,
.expense-detail__error a { display: inline-grid; min-width: 44px; min-height: 44px; place-items: center; padding: 0 14px; border: 0; border-radius: 12px; background: var(--ion-color-primary); color: var(--ion-color-primary-contrast); font: inherit; font-weight: 650; text-decoration: none; }
.expense-detail__danger button { background: var(--su-owing); color: var(--su-surface); }
.expense-detail__delete-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.expense-detail :deep(.comment-thread) { margin-top: 18px; }
@media (min-width: 760px) { .expense-detail__columns { grid-template-columns: minmax(0, 1.5fr) minmax(260px, 0.8fr); align-items: start; } .expense-detail__audit { position: sticky; top: 18px; } }
@media (prefers-reduced-motion: reduce) { .expense-detail * { transition-duration: 0ms; animation-duration: 0ms; } }
</style>
