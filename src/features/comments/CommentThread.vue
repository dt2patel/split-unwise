<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { getAppSession } from '../../data'
import type { ExpenseComment, Member } from '../../data/repositories'
import type { ReceiptAsset } from '../../data/receipts'
import { compareFirestoreStrings } from '../../data/timeline'
import { useSheetKeyboardAvoidance } from '../expenses/components/useSheetKeyboardAvoidance'

const props = defineProps<{ readonly groupId: string; readonly expenseId: string; readonly closed: boolean }>()
const session = getAppSession()
const comments = ref<readonly ExpenseComment[]>([])
const body = ref('')
const attachmentRefs = ref<readonly string[]>([])
const error = ref('')
const status = ref('')
const isLoading = ref(true)
const currentUser = ref<Member>()
const operationId = ref<string>()
const attachmentAssets = ref(new Map<string, ReceiptAsset | null>())
const queueRevision = ref(0)
const composer = ref<HTMLElement>()
const errorSummary = ref<HTMLElement>()
let unsubscribe: (() => void) | undefined

useSheetKeyboardAvoidance(composer, {
  async resolveScrollHost(element) {
    const content = element.closest('ion-content') as (HTMLElement & { getScrollElement?: () => Promise<HTMLElement> }) | null
    return await content?.getScrollElement?.() ?? element
  },
})

const visibleComments = computed(() => {
  queueRevision.value
  const byId = new Map<string, CommentDisplay>(comments.value.map((comment) => [comment.commentId, clone(comment)]))
  for (const operation of session.queue.snapshot()) {
    const envelope = operation.envelope
    if ((envelope.kind !== 'comment.add' && envelope.kind !== 'comment.delete') || envelope.groupId !== props.groupId || envelope.expenseId !== props.expenseId) continue
    if ((operation.status === 'fresh' || operation.status === 'stale') && operation.result.status === 'saved' && 'comment' in operation.result) {
      byId.set(operation.result.comment.commentId, clone(operation.result.comment))
    } else if (envelope.kind === 'comment.add' && (operation.status === 'pending' || operation.status === 'failed' || operation.status === 'conflicted')) {
      byId.set(`pending:${envelope.operationId}`, {
        commentId: `pending:${envelope.operationId}`,
        groupId: envelope.groupId,
        expenseId: envelope.expenseId,
        operationId: envelope.operationId,
        author: currentUser.value ? { id: currentUser.value.id, displayName: currentUser.value.displayName } : { id: 'current-user', displayName: 'You' },
        body: envelope.body,
        attachmentRefs: [...envelope.attachmentRefs],
        syncState: operation.status,
      })
    } else if (envelope.kind === 'comment.delete' && (operation.status === 'pending' || operation.status === 'failed' || operation.status === 'conflicted')) {
      const current = byId.get(envelope.commentId)
      if (current) byId.set(envelope.commentId, { ...current, syncState: operation.status })
    }
  }
  return [...byId.values()].sort((left, right) => compareFirestoreStrings(left.createdAt ?? '9999', right.createdAt ?? '9999') || compareFirestoreStrings(left.commentId, right.commentId))
})

onMounted(async () => {
  unsubscribe = session.queue.subscribe(() => { queueRevision.value += 1; void reload() })
  await reload()
})
onBeforeUnmount(() => unsubscribe?.())

async function reload(): Promise<void> {
  try {
    await session.ready
    const [loadedComments, user] = await Promise.all([
      session.repository.comments.listForExpense(props.groupId, props.expenseId),
      session.repository.app.getCurrentUser(),
    ])
    comments.value = loadedComments
    currentUser.value = user
    restoreDurableDraft()
    await hydrateAttachmentMetadata([...loadedComments.flatMap(({ attachmentRefs: references }) => references), ...attachmentRefs.value])
  } catch (reason) {
    error.value = message(reason, 'Comments could not be loaded.')
  } finally {
    isLoading.value = false
  }
}

async function submit(): Promise<void> {
  if (operationId.value) return
  const trimmed = body.value.trim()
  if (!trimmed) {
    error.value = 'Enter a comment before posting.'
    await nextTick()
    errorSummary.value?.focus()
    return
  }
  error.value = ''
  status.value = 'Saving comment…'
  const nextOperationId = createOperationId('comment-add')
  operationId.value = nextOperationId
  try {
    for (const reference of attachmentRefs.value) {
      if (reference.startsWith('local-receipt:') && !(await session.receipts.claim(reference as `local-receipt:${string}`, nextOperationId))) {
        throw new Error('A comment attachment is no longer available. Reattach it before posting.')
      }
    }
    const handle = session.queue.submit({
      kind: 'comment.add', operationId: nextOperationId, groupId: props.groupId, expenseId: props.expenseId,
      body: trimmed, attachmentRefs: [...attachmentRefs.value],
    })
    await handle.result()
    await reload()
    body.value = ''
    attachmentRefs.value = []
    operationId.value = undefined
    status.value = 'Comment saved.'
  } catch (reason) {
    const operation = session.queue.get(nextOperationId)
    error.value = operation?.status === 'conflicted' ? 'Comment conflicted. Your draft is preserved.' : `Comment failed: ${message(reason, 'Try again or discard the draft.')}`
    status.value = ''
    if (!operation) operationId.value = undefined
  }
}

async function retry(): Promise<void> {
  const id = operationId.value
  if (!id) return
  error.value = ''
  status.value = 'Saving comment…'
  try {
    await session.queue.retry(id).result()
    await reload()
    body.value = ''
    attachmentRefs.value = []
    operationId.value = undefined
    status.value = 'Comment saved.'
  } catch (reason) {
    error.value = `Comment failed: ${message(reason, 'Try again or discard the draft.')}`
    status.value = ''
  }
}

async function discard(): Promise<void> {
  const id = operationId.value
  if (!id) return
  try {
    if (await session.queue.discard(id)) {
      operationId.value = undefined
      body.value = ''
      attachmentRefs.value = []
      error.value = ''
      status.value = 'Draft discarded.'
    }
  } catch (reason) {
    error.value = message(reason, 'The draft could not be discarded.')
  }
}

async function deleteComment(comment: CommentDisplay): Promise<void> {
  if (comment.deletedAt || deleteOperation(comment.commentId)) return
  const id = createOperationId('comment-delete')
  try {
    await session.queue.submit({ kind: 'comment.delete', operationId: id, groupId: props.groupId, expenseId: props.expenseId, commentId: comment.commentId }).result()
    await reload()
    status.value = 'Comment deleted.'
  } catch (reason) {
    error.value = `Comment deletion failed: ${message(reason, 'Try again.')}`
  }
}

async function retryCommentDelete(commentId: string): Promise<void> {
  const operation = deleteOperation(commentId)
  if (operation?.status !== 'failed') return
  error.value = ''
  try {
    await session.queue.retry(operation.envelope.operationId).result()
    status.value = 'Comment deleted.'
    await reload()
  } catch (reason) {
    error.value = `Comment deletion failed: ${message(reason, 'Try again.')}`
  }
}

async function discardCommentDelete(commentId: string): Promise<void> {
  const operation = deleteOperation(commentId)
  if (operation?.status !== 'failed') return
  try {
    await session.queue.discard(operation.envelope.operationId)
    error.value = ''
    status.value = 'Comment deletion discarded.'
    queueRevision.value += 1
  } catch (reason) {
    error.value = message(reason, 'Comment deletion could not be discarded.')
  }
}

async function resolveCommentDeleteConflict(commentId: string): Promise<void> {
  const operation = deleteOperation(commentId)
  if (operation?.status !== 'conflicted') return
  try {
    await session.queue.acknowledge(operation.envelope.operationId)
    await reload()
    error.value = ''
    status.value = 'Reloaded the current comment.'
  } catch (reason) {
    error.value = message(reason, 'The current comment could not be reloaded.')
  }
}

async function attach(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    const reference = await session.receipts.put(file, { fileName: file.name })
    attachmentRefs.value = [...attachmentRefs.value, reference]
    attachmentAssets.value = new Map(attachmentAssets.value).set(reference, await session.receipts.get(reference) ?? null)
    status.value = 'Attachment saved on this device.'
  } catch (reason) {
    error.value = message(reason, 'The attachment could not be saved.')
  } finally {
    input.value = ''
  }
}

async function removeAttachment(reference: string): Promise<void> {
  attachmentRefs.value = attachmentRefs.value.filter((candidate) => candidate !== reference)
  const next = new Map(attachmentAssets.value)
  next.delete(reference)
  attachmentAssets.value = next
  if (reference.startsWith('local-receipt:')) await session.receipts.delete(reference as `local-receipt:${string}`)
}

async function hydrateAttachmentMetadata(references: readonly string[]): Promise<void> {
  const next = new Map(attachmentAssets.value)
  await Promise.all([...new Set(references)].map(async (reference) => {
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

function formatTime(timestamp: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(timestamp))
}
function isFailedRetryable(id: string | undefined): boolean {
  if (!id) return false
  const operation = session.queue.get(id)
  return operation?.status === 'failed' && operation.error.retryable
}
function deleteOperation(commentId: string) {
  return [...session.queue.snapshot()].reverse().find((operation) => {
    const envelope = operation.envelope
    return envelope.kind === 'comment.delete' && envelope.groupId === props.groupId && envelope.expenseId === props.expenseId && envelope.commentId === commentId
      && (operation.status === 'pending' || operation.status === 'failed' || operation.status === 'conflicted')
  })
}
function deleteRetryable(commentId: string): boolean {
  const operation = deleteOperation(commentId)
  return operation?.status === 'failed' && operation.error.retryable
}
function restoreDurableDraft(): void {
  const matching = [...session.queue.snapshot()].reverse().find((operation) => {
    const envelope = operation.envelope
    return envelope.kind === 'comment.add' && envelope.groupId === props.groupId && envelope.expenseId === props.expenseId
      && (operation.status === 'pending' || operation.status === 'failed' || operation.status === 'conflicted')
  })
  if (matching?.envelope.kind === 'comment.add') {
    operationId.value = matching.envelope.operationId
    body.value = matching.envelope.body
    attachmentRefs.value = [...matching.envelope.attachmentRefs]
    if (matching.status === 'pending') status.value = 'Saving comment…'
    else {
      error.value = matching.status === 'failed' ? `Comment failed: ${matching.error.message}` : 'Comment conflicted. Your draft is preserved.'
      status.value = ''
    }
    return
  }
  const active = operationId.value ? session.queue.get(operationId.value) : undefined
  if (active && (active.status === 'fresh' || active.status === 'stale')) {
    operationId.value = undefined
    body.value = ''
    attachmentRefs.value = []
  }
}
function createOperationId(prefix: string): string { return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Date.now().toString(36)}` }
function message(reason: unknown, fallback: string): string { return reason instanceof Error && reason.message.trim() ? reason.message : fallback }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T }

interface CommentDisplay extends Omit<ExpenseComment, 'createdAt'> { readonly createdAt?: string }
</script>

<template>
  <section ref="composer" class="comment-thread" data-testid="comments" aria-labelledby="comments-title">
    <h2 id="comments-title">Comments</h2>
    <p v-if="isLoading" role="status">Loading comments…</p>
    <ol v-else id="comment-list" class="comment-thread__list" data-testid="comment-list" aria-labelledby="comments-title">
      <li v-for="comment in visibleComments" :key="comment.commentId" :data-comment-id="comment.commentId" :data-sync-state="comment.syncState">
        <div>
          <strong>{{ comment.author.displayName }}</strong>
          <time v-if="comment.deletedAt ?? comment.createdAt" :datetime="comment.deletedAt ?? comment.createdAt">{{ formatTime((comment.deletedAt ?? comment.createdAt)!) }}</time>
          <span v-else>{{ comment.syncState === 'pending' ? 'Pending comment' : `${comment.syncState} comment` }}</span>
        </div>
        <p v-if="comment.deletedAt" class="comment-thread__deleted">Comment deleted</p>
        <p v-else>{{ comment.body }}</p>
        <ul v-if="!comment.deletedAt && comment.attachmentRefs.length" aria-label="Comment attachments">
          <li v-for="attachment in comment.attachmentRefs" :key="attachment">
            <strong>{{ attachmentLabel(attachment) }}</strong>
            <span>{{ attachmentDurability(attachment) }}</span>
            <button v-if="attachmentAssets.get(attachment)" type="button" data-action="open-comment-attachment" @click="openAttachment(attachment)">Open preview</button>
          </li>
        </ul>
        <button
          v-if="!comment.commentId.startsWith('pending:') && !comment.deletedAt && comment.author.id === currentUser?.id && !deleteOperation(comment.commentId)"
          type="button"
          data-action="delete-comment"
          :aria-label="`Delete comment by ${comment.author.displayName}`"
          @click="deleteComment(comment)"
        >Delete</button>
        <span v-if="deleteOperation(comment.commentId)?.status === 'pending'" role="status">Deleting…</span>
        <div v-else-if="deleteOperation(comment.commentId)?.status === 'failed'" class="comment-thread__recovery">
          <button v-if="deleteRetryable(comment.commentId)" type="button" data-action="retry-comment-delete" @click="retryCommentDelete(comment.commentId)">Retry delete</button>
          <button type="button" data-action="discard-comment-delete" @click="discardCommentDelete(comment.commentId)">Discard</button>
        </div>
        <div v-else-if="deleteOperation(comment.commentId)?.status === 'conflicted'" class="comment-thread__recovery">
          <span>Delete conflict: the current comment is still available.</span>
          <button type="button" data-action="resolve-comment-delete-conflict" @click="resolveCommentDeleteConflict(comment.commentId)">Reload comment</button>
        </div>
      </li>
    </ol>

    <p ref="errorSummary" class="comment-thread__error" data-testid="comment-error" role="alert" tabindex="-1">{{ error }}</p>
    <p v-if="status" role="status">{{ status }}</p>
    <p v-if="closed" class="comment-thread__closed">Comments are closed because this expense was deleted.</p>
    <form v-else class="comment-thread__composer" aria-label="Add a comment" @submit.prevent="submit">
      <label for="comment-body">Add a comment</label>
      <textarea id="comment-body" v-model="body" rows="3" :aria-invalid="Boolean(error)" aria-describedby="comment-error" />
      <div class="comment-thread__attachments">
        <label class="comment-thread__attach">Attach file<input type="file" accept="image/*" @change="attach"></label>
        <span v-for="attachment in attachmentRefs" :key="attachment" class="comment-thread__attachment">
          <span><strong>{{ attachmentLabel(attachment) }}</strong><small>{{ attachmentDurability(attachment) }}</small></span>
          <button v-if="attachmentAssets.get(attachment)" type="button" data-action="open-comment-attachment" @click="openAttachment(attachment)">Open preview</button>
          <button type="button" data-action="remove-comment-attachment" @click="removeAttachment(attachment)">Remove</button>
        </span>
      </div>
      <div class="comment-thread__actions">
        <button type="submit" :disabled="Boolean(operationId)">{{ operationId ? 'Saving…' : 'Post comment' }}</button>
        <button v-if="isFailedRetryable(operationId)" type="button" data-action="retry-comment" @click="retry">Retry</button>
        <button v-if="operationId && session.queue.get(operationId)?.status === 'failed'" type="button" data-action="discard-comment" @click="discard">Discard</button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.comment-thread { --su-keyboard-inset: 0px; display: grid; gap: 12px; padding-bottom: calc(16px + env(safe-area-inset-bottom) + var(--su-keyboard-inset)); overflow-wrap: anywhere; }
.comment-thread h2 { margin: 0; font-size: 1.05rem; }
.comment-thread__list { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }
.comment-thread__list > li { display: grid; gap: 6px; padding: 12px; border: 1px solid color-mix(in srgb, var(--su-divider) 44%, transparent); border-radius: 14px; background: color-mix(in srgb, var(--su-surface) 94%, var(--su-lilac)); }
.comment-thread__list > li > div { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 6px 12px; }
.comment-thread__list p { margin: 0; white-space: pre-wrap; }
.comment-thread__list time { color: var(--ion-color-medium); font-size: 0.78rem; }
.comment-thread__list button,
.comment-thread__actions button,
.comment-thread__attach { min-width: 44px; min-height: 44px; }
.comment-thread__list button { justify-self: end; border: 0; background: transparent; color: var(--ion-color-primary); }
.comment-thread__deleted { color: var(--ion-color-medium); font-style: italic; }
.comment-thread__error:empty { min-height: 0; margin: 0; }
.comment-thread__error { margin: 0; color: var(--su-owing); font-weight: 650; }
.comment-thread__closed { margin: 0; color: var(--ion-color-medium); }
.comment-thread__composer { position: sticky; bottom: 0; display: grid; gap: 8px; padding: 12px 0 max(4px, env(safe-area-inset-bottom)); background: var(--su-surface); }
.comment-thread__composer textarea { min-height: 88px; padding: 11px; border: 1px solid var(--su-divider); border-radius: 12px; background: var(--su-surface); color: var(--su-text); font: inherit; resize: vertical; }
.comment-thread__attachments { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.comment-thread__attachment { display: flex; min-height: 44px; align-items: center; gap: 8px; padding: 5px 8px; border: 1px solid var(--su-divider); border-radius: 11px; }
.comment-thread__attachment > span { display: grid; }
.comment-thread__attachment small { color: var(--ion-color-medium); }
.comment-thread__attach { display: inline-grid; place-items: center; padding: 0 12px; border: 1px solid var(--su-divider); border-radius: 11px; color: var(--ion-color-primary); }
.comment-thread__attach input { position: absolute; width: 1px; height: 1px; opacity: 0; }
.comment-thread__actions { display: flex; flex-wrap: wrap; gap: 8px; }
.comment-thread__recovery { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.comment-thread__actions button { padding: 0 14px; border: 0; border-radius: 12px; background: var(--ion-color-primary); color: var(--ion-color-primary-contrast); font: inherit; font-weight: 650; }
@media (prefers-reduced-motion: reduce) { .comment-thread * { transition-duration: 0ms; } }
</style>
