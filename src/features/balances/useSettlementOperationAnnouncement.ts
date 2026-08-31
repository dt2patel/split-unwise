import { ref, watch, type Ref } from 'vue'
import type { PendingSettlementProjection } from './settlementStore'

export function useSettlementOperationAnnouncement(operations: Readonly<Ref<readonly PendingSettlementProjection[]>>): Readonly<Ref<string>> {
  const announcement = ref('')
  const states = new Map<string, PendingSettlementProjection['status']>()

  watch(operations, (current) => {
    let changed: PendingSettlementProjection | undefined
    for (const operation of current) {
      const previous = states.get(operation.operationId)
      if (previous !== undefined && previous !== operation.status) changed = operation
    }
    states.clear()
    current.forEach((operation) => states.set(operation.operationId, operation.status))
    if (!changed) return
    const subject = changed.kind === 'void' ? 'Void' : 'Payment'
    const detail = changed.error ?? (changed.kind === 'void' ? 'Saving this void request.' : 'Saving this ledger update.')
    announcement.value = `${subject} update: ${statusLabel(changed.status)}. ${detail}`
  }, { immediate: true, flush: 'sync' })

  return announcement
}

function statusLabel(status: PendingSettlementProjection['status']): string {
  if (status === 'failed') return 'Failed'
  if (status === 'conflicted') return 'Conflict'
  if (status === 'fresh') return 'Saved'
  return 'Pending'
}
