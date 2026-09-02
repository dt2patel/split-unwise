<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
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
import MoneyAmount, { formatMoney as formatMoneyValue } from '../../components/MoneyAmount.vue'
import CommentThread from '../comments/CommentThread.vue'
import { getAppSession } from '../../data'
import type { ExpenseRevision, ExpenseRow, Member } from '../../data/repositories'
import type { ReceiptAsset } from '../../data/receipts'
import type { CommandOperation } from '../../data/commandQueue'
import { isStrictId, parseStrictScalarId } from '../../data/identifiers'

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
const attachmentAssets = ref(new Map<string, ReceiptAsset | null>())
const deleteTrigger = ref<HTMLElement>()
let loadRequest = 0
const unsubscribe = session.queue.subscribe((operation) => { void reconcileDeleteOperation(operation) })
onBeforeUnmount(unsubscribe)

const origin = computed<DetailOrigin>(() => {
  const name = typeof route.name === 'string' ? route.name : ''
  const candidate = name.split('-')[0]
  return candidate === 'account' || candidate === 'activity' || candidate === 'groups' || candidate === 'home' ? candidate : 'home'
})
const groupId = computed(() => parseStrictScalarId(route.query.groupId))
const expenseId = computed(() => typeof route.params.expenseId === 'string' ? route.params.expenseId : '')
const returnPath = computed(() => origin.value === 'groups' && validatedGroupId.value ? `/tabs/groups/${encodeURIComponent(validatedGroupId.value)}` : `/tabs/${origin.value}`)
const editPath = computed(() => groupId.value && expense.value
  ? `/tabs/${origin.value}/expenses/${encodeURIComponent(expense.value.id)}/edit?groupId=${encodeURIComponent(groupId.value)}`
  : '')
const memberNames = computed(() => new Map(members.value.map((member) => [member.id, member.displayName])))
const canMutate = computed(() => {
  if (!expense.value || expense.value.deletedAt || !currentUser.value) return false
  const membership = members.value.find(({ id }) => id === currentUser.value?.id)
  return membership !== undefined
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
  deleteState.value = 'idle'
  deleteOperationId.value = undefined
  const requestedGroup = groupId.value
  const requestedExpense = expenseId.value
  if (!requestedGroup || !isStrictId(requestedExpense)) {
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
    await hydrateAttachmentMetadata([...loadedExpense.attachmentRefs, ...history.flatMap((revision) => revision.expense.attachmentRefs)])
    await reconcileStoredDelete()
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
  if (!expense.value || !groupId.value || !canMutate.value || deleteState.value !== 'idle') return false
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

async function reloadDeleteConflict(): Promise<void> {
  const operation = currentDeleteOperation()
  if (!operation || operation.status !== 'conflicted' || operation.envelope.kind !== 'expense.delete') return
  try {
    const remote = await session.repository.expenses.getById(operation.envelope.groupId, operation.envelope.expenseId)
    if (remote && (remote.groupId !== operation.envelope.groupId || remote.id !== operation.envelope.expenseId)) throw new Error('Remote expense did not match this deletion.')
    await session.queue.acknowledge(operation.envelope.operationId)
    if (remote) expense.value = remote
    revisions.value = await session.repository.expenses.listRevisions(operation.envelope.groupId, operation.envelope.expenseId)
    deleteOperationId.value = undefined
    deleteState.value = remote?.deletedAt ? 'saved' : 'idle'
  } catch (reason) {
    error.value = message(reason, 'The current expense could not be reloaded.')
  }
}

async function deleteLatestExpense(): Promise<void> {
  const operation = currentDeleteOperation()
  if (!operation || operation.status !== 'conflicted' || operation.envelope.kind !== 'expense.delete') return
  try {
    const remote = await session.repository.expenses.getById(operation.envelope.groupId, operation.envelope.expenseId)
    if (!remote || remote.groupId !== operation.envelope.groupId || remote.id !== operation.envelope.expenseId) throw new Error('The latest expense is not available.')
    await session.queue.acknowledge(operation.envelope.operationId)
    expense.value = remote
    if (remote.deletedAt) {
      deleteOperationId.value = undefined
      deleteState.value = 'saved'
      return
    }
    const nextOperationId = `${operation.envelope.operationId}.latest.r${remote.revision}`
    deleteOperationId.value = nextOperationId
    deleteState.value = 'pending'
    await session.queue.submit({ kind: 'expense.delete', operationId: nextOperationId, groupId: remote.groupId, expenseId: remote.id, expectedRevision: remote.revision }).result()
    await load()
    deleteState.value = 'saved'
  } catch (reason) {
    const current = deleteOperationId.value ? session.queue.get(deleteOperationId.value) : undefined
    deleteState.value = current?.status === 'conflicted' ? 'conflicted' : 'failed'
    error.value = message(reason, 'The latest expense could not be deleted.')
  }
}

function currentDeleteOperation() {
  const requestedGroup = groupId.value
  const requestedExpense = expenseId.value
  return [...session.queue.snapshot()].reverse().find((operation) => {
    const envelope = operation.envelope
    return envelope.kind === 'expense.delete' && envelope.groupId === requestedGroup && envelope.expenseId === requestedExpense
      && (operation.status === 'pending' || operation.status === 'failed' || operation.status === 'conflicted')
  })
}

async function reconcileStoredDelete(): Promise<void> {
  const operation = [...session.queue.snapshot()].reverse().find(isExactDeleteOperation)
  if (operation) await reconcileDeleteOperation(operation)
}

async function reconcileDeleteOperation(operation: CommandOperation): Promise<void> {
  if (!isExactDeleteOperation(operation)) return
  deleteOperationId.value = operation.envelope.operationId
  if (operation.status === 'pending' || operation.status === 'failed' || operation.status === 'conflicted') {
    deleteState.value = operation.status
    return
  }
  if (operation.result.status !== 'saved' || operation.result.kind !== 'expense.delete') return
  const tombstone = operation.result.tombstone
  if (expense.value?.groupId === tombstone.groupId && expense.value.id === tombstone.id) {
    expense.value = { ...expense.value, revision: tombstone.revision, updatedAt: tombstone.deletedAt, deletedAt: tombstone.deletedAt, syncState: operation.status }
  }
  deleteState.value = 'saved'
  try {
    const [retained, history] = await Promise.all([
      session.repository.expenses.getById(tombstone.groupId, tombstone.id),
      session.repository.expenses.listRevisions(tombstone.groupId, tombstone.id),
    ])
    if (retained?.groupId === tombstone.groupId && retained.id === tombstone.id && retained.deletedAt) expense.value = retained
    if (history.every((revision) => revision.groupId === tombstone.groupId && revision.expenseId === tombstone.id)) revisions.value = history
  } catch { /* the saved tombstone result already closes mutation and comment surfaces truthfully */ }
}

function isExactDeleteOperation(operation: CommandOperation): boolean {
  const envelope = operation.envelope
  return envelope.kind === 'expense.delete' && envelope.groupId === groupId.value && envelope.expenseId === expenseId.value
}

async function hydrateAttachmentMetadata(references: readonly string[]): Promise<void> {
  const next = new Map(attachmentAssets.value)
  await Promise.all(references.map(async (reference) => {
    if (next.has(reference)) return
    next.set(reference, reference.startsWith('local-receipt:') ? await session.receipts.get(reference as `local-receipt:${string}`) ?? null : null)
  }))
  attachmentAssets.value = next
}

function attachmentLabel(reference: string): string {
  return attachmentAssets.value.get(reference)?.fileName ?? (reference.startsWith('local-receipt:') ? 'Attachment unavailable' : 'Receipt attachment')
}
function attachmentDurability(reference: string): string {
  const asset = attachmentAssets.value.get(reference)
  if (!asset) return 'Preview unavailable on this device.'
  if (asset.durability.status === 'uploaded') return 'Uploaded and durable.'
  return asset.durability.reason
}
function openAttachment(reference: string): void {
  const asset = attachmentAssets.value.get(reference)
  if (!asset || typeof URL.createObjectURL !== 'function') return
  const url = URL.createObjectURL(asset.blob)
  window.open(url, '_blank', 'noopener,noreferrer')
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

function payerName(memberId: string): string { return memberNames.value.get(memberId) ?? 'Unknown member' }
function formatDate(date: string): string { return new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00.000Z`)) }
function formatTimestamp(timestamp: string): string { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp)) }
function revisionLabel(revision: ExpenseRevision): string {
  if (revision.action === 'created') return `${revision.actor.displayName} created this expense`
  if (revision.action === 'updated') return `${revision.actor.displayName} updated this expense`
  return `${revision.actor.displayName} deleted this expense`
}
function revisionDiff(revision: ExpenseRevision, index: number): string {
  if (revision.action === 'created') return 'Initial expense snapshot.'
  if (revision.action === 'deleted') return 'Marked deleted; prior values are retained below.'
  const previous = revisions.value[index - 1]?.expense
  if (!previous) return 'Updated expense snapshot.'
  const changed: string[] = []
  if (previous.description !== revision.expense.description) changed.push('description')
  if (JSON.stringify(previous.total) !== JSON.stringify(revision.expense.total)) changed.push('total')
  if (previous.date !== revision.expense.date) changed.push('date')
  if (previous.category !== revision.expense.category) changed.push('category')
  if ((previous.notes ?? '') !== (revision.expense.notes ?? '')) changed.push('notes')
  if (Boolean(previous.reimbursement) !== Boolean(revision.expense.reimbursement)) changed.push('type')
  if (JSON.stringify(previous.payments) !== JSON.stringify(revision.expense.payments)) changed.push('payers')
  if (JSON.stringify(previous.allocations) !== JSON.stringify(revision.expense.allocations) || JSON.stringify(previous.splitMethod) !== JSON.stringify(revision.expense.splitMethod)) changed.push('split')
  if (JSON.stringify(previous.attachmentRefs) !== JSON.stringify(revision.expense.attachmentRefs)) changed.push('attachments')
  if (JSON.stringify(previous.recurrence) !== JSON.stringify(revision.expense.recurrence)) changed.push('recurrence')
  return changed.length ? `Changed ${changed.join(', ')}.` : 'Metadata-only update.'
}
function formatMoney(row: ExpenseRow): string { return formatMoneyValue(row.total) }
function allocationLabel(row: ExpenseRow, participantId: string, minorAmount: number): string {
  return `${payerName(participantId)} ${formatMoneyValue({ currency: row.total.currency, minorAmount })}`
}
function splitLabel(row: ExpenseRow): string { return row.reimbursement ? 'reimbursement' : `${row.splitMethod.type} split` }
function recurrenceLabel(row: ExpenseRow): string {
  if (!row.recurrence) return 'Not recurring'
  return `${row.recurrence.frequency[0].toUpperCase()}${row.recurrence.frequency.slice(1)} · ${row.recurrence.timeZone}`
}
function isDeleteRetryable(): boolean {
  const operation = deleteOperationId.value ? session.queue.get(deleteOperationId.value) : undefined
  return operation?.status === 'failed' && operation.error.retryable
}
function createOperationId(prefix: string): string { return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Date.now().toString(36)}` }
function message(reason: unknown, fallback: string): string { return reason instanceof Error && reason.message.trim() ? reason.message : fallback }
</script>

<template>
  <ion-page class="expense-detail">
    <ion-header translucent>
      <ion-toolbar>
        <ion-buttons slot="start"><ion-back-button :default-href="returnPath" text="Back" /></ion-buttons>
        <ion-title>{{ expense?.reimbursement ? 'Reimbursement' : 'Expense' }}</ion-title>
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
            <money-amount data-testid="expense-total" :money="expense.total" :label="expense.reimbursement ? 'Reimbursement total' : 'Expense total'" :show-direction="false" />
            <p v-if="expense.deletedAt" data-testid="deleted-state">This expense was deleted. Its audit history and prior comments are retained.</p>
          </header>

          <div class="expense-detail__columns">
            <div class="expense-detail__primary">
              <section aria-labelledby="details-title">
                <h2 id="details-title">Details</h2>
                <dl>
                  <div><dt>Date</dt><dd><time :datetime="expense.date">{{ formatDate(expense.date) }}</time></dd></div>
                  <div><dt>Type</dt><dd>{{ expense.reimbursement ? 'Reimbursement' : 'Expense' }}</dd></div>
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
                <h2 id="payers-title">{{ expense.reimbursement ? 'Refund received by' : 'Paid by' }}</h2>
                <ul aria-labelledby="payers-title">
                  <li v-for="payment in expense.payments" :key="payment.participantId">
                    <span>{{ payerName(payment.participantId) }}</span><money-amount :money="payment.money" :show-direction="false" />
                  </li>
                </ul>
              </section>

              <section aria-labelledby="allocations-title">
                <h2 id="allocations-title">{{ expense.reimbursement ? 'Reimbursement owed to' : 'Allocated to' }}</h2>
                <ul aria-labelledby="allocations-title">
                  <li v-for="allocation in expense.allocations" :key="allocation.participantId">
                    <span>{{ payerName(allocation.participantId) }}</span><money-amount :money="allocation.money" :show-direction="false" />
                  </li>
                </ul>
              </section>

              <section aria-labelledby="attachments-title">
                <h2 id="attachments-title">Attachments</h2>
                <p v-if="expense.attachmentRefs.length === 0">No attachments</p>
                <ul v-else aria-labelledby="attachments-title">
                  <li v-for="attachment in expense.attachmentRefs" :key="attachment" class="expense-detail__attachment">
                    <span><strong>{{ attachmentLabel(attachment) }}</strong><small>{{ attachmentDurability(attachment) }}</small></span>
                    <button v-if="attachmentAssets.get(attachment)" type="button" data-action="open-expense-attachment" @click="openAttachment(attachment)">Open preview</button>
                  </li>
                </ul>
              </section>
            </div>

            <aside class="expense-detail__audit" aria-labelledby="audit-title">
              <h2 id="audit-title">Audit history</h2>
              <ol aria-labelledby="audit-title">
                <li v-for="(revision, index) in revisions" :key="revision.id">
                  <strong>{{ revisionLabel(revision) }}</strong>
                  <span>Revision {{ revision.revision }}</span>
                  <time :datetime="revision.createdAt">{{ formatTimestamp(revision.createdAt) }}</time>
                  <p data-testid="revision-diff">{{ revisionDiff(revision, index) }}</p>
                  <details data-testid="revision-snapshot">
                    <summary>View revision snapshot</summary>
                    <dl>
                      <div><dt>Description</dt><dd>{{ revision.expense.description }}</dd></div>
                      <div><dt>Total</dt><dd>{{ formatMoney(revision.expense) }}</dd></div>
                      <div><dt>Date</dt><dd>{{ formatDate(revision.expense.date) }}</dd></div>
                      <div><dt>Category</dt><dd>{{ revision.expense.category }}</dd></div>
                      <div><dt>Notes</dt><dd>{{ revision.expense.notes || 'No notes' }}</dd></div>
                      <div><dt>{{ revision.expense.reimbursement ? 'Refund received by' : 'Paid by' }}</dt><dd>{{ revision.expense.payments.map((payment) => allocationLabel(revision.expense, payment.participantId, payment.money.minorAmount)).join(', ') }}</dd></div>
                      <div><dt>{{ revision.expense.reimbursement ? 'Reimbursement owed to' : 'Allocated to' }}</dt><dd>{{ revision.expense.allocations.map((allocation) => allocationLabel(revision.expense, allocation.participantId, allocation.money.minorAmount)).join(', ') }}</dd></div>
                      <div><dt>Split</dt><dd>{{ splitLabel(revision.expense) }}</dd></div>
                      <div><dt>Recurrence</dt><dd>{{ recurrenceLabel(revision.expense) }}</dd></div>
                      <div><dt>Attachments</dt><dd>{{ revision.expense.attachmentRefs.length ? revision.expense.attachmentRefs.map(attachmentLabel).join(', ') : 'No attachments' }}</dd></div>
                    </dl>
                  </details>
                </li>
              </ol>
            </aside>
          </div>

          <section v-if="canMutate && deleteState === 'idle'" class="expense-detail__danger" aria-labelledby="delete-title">
            <h2 id="delete-title">Delete expense</h2>
            <button ref="deleteTrigger" type="button" data-action="delete-expense" @click="requestDelete">Delete expense</button>
          </section>
          <p v-if="deleteState !== 'idle'" data-testid="delete-state" role="status">
            {{ deleteState === 'pending' ? 'Saving deletion…' : deleteState === 'failed' ? 'Deletion failed.' : deleteState === 'conflicted' ? 'Deletion conflict: the remote revision and your delete intent are retained.' : 'Deleted.' }}
          </p>
          <div v-if="deleteState === 'failed'" class="expense-detail__delete-actions">
            <button v-if="isDeleteRetryable()" type="button" data-action="retry-expense-delete" @click="retryDelete">Retry</button>
            <button type="button" data-action="discard-expense-delete" @click="discardDelete">Discard</button>
          </div>
          <div v-if="deleteState === 'conflicted'" class="expense-detail__delete-actions">
            <button type="button" data-action="reload-expense-delete-conflict" @click="reloadDeleteConflict">Reload current expense</button>
            <button type="button" data-action="delete-latest-expense" @click="deleteLatestExpense">Delete latest version</button>
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
.expense-detail__audit p { margin: 3px 0; }
.expense-detail__audit details { margin-top: 3px; }
.expense-detail__audit summary { min-height: 44px; cursor: pointer; color: var(--ion-color-primary); }
.expense-detail__audit span,
.expense-detail__audit time { color: var(--ion-color-medium); font-size: 0.82rem; }
.expense-detail__attachment { align-items: center; }
.expense-detail__attachment > span { display: grid; gap: 2px; }
.expense-detail__attachment small { color: var(--ion-color-medium); }
.expense-detail__danger { margin-top: 18px; }
.expense-detail button,
.expense-detail__error a { display: inline-grid; min-width: 44px; min-height: 44px; place-items: center; padding: 0 14px; border: 0; border-radius: 12px; background: var(--ion-color-primary); color: var(--ion-color-primary-contrast); font: inherit; font-weight: 650; text-decoration: none; }
.expense-detail__danger button { background: var(--su-owing); color: var(--su-surface); }
.expense-detail__delete-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.expense-detail :deep(.comment-thread) { margin-top: 18px; }
@media (min-width: 760px) { .expense-detail__columns { grid-template-columns: minmax(0, 1.5fr) minmax(260px, 0.8fr); align-items: start; } .expense-detail__audit { position: sticky; top: 18px; } }
@media (prefers-reduced-motion: reduce) { .expense-detail * { transition-duration: 0ms; animation-duration: 0ms; } }
</style>
