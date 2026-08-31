import { computed, onScopeDispose, ref } from 'vue'
import { defineStore } from 'pinia'
import { getAppSession } from '../../data/session'
import type { CommandHandle, CommandOperation } from '../../data/commandQueue'
import type {
  Group,
  GroupBalanceSnapshot,
  Member,
  SettlementRecord,
  SettlementRecordCommand,
  SettlementVoidCommand,
} from '../../data/repositories'

export interface PendingSettlementProjection {
  readonly operationId: string
  readonly kind: 'record' | 'void'
  readonly status: CommandOperation['status']
  readonly groupId: string
  readonly settlementId?: string
  readonly senderId?: string
  readonly recipientId?: string
  readonly currency?: string
  readonly amountMinor?: number
  readonly submittedAt: string
  readonly error?: string
  readonly retryable: boolean
}

export const useSettlementStore = defineStore('settlements', () => {
  const session = getAppSession()
  const { repository, queue } = session
  const group = ref<Group>()
  const members = ref<readonly Member[]>([])
  const currentUser = ref<Member>()
  const balanceSnapshot = ref<GroupBalanceSnapshot>()
  const settlements = ref<readonly SettlementRecord[]>([])
  const isLoading = ref(false)
  const error = ref<string>()
  const notice = ref('')
  const queueRevision = ref(0)
  let loadGeneration = 0
  const unsubscribe = queue.subscribe(() => { queueRevision.value += 1 })
  onScopeDispose(unsubscribe)

  const memberNames = computed(() => new Map(members.value.map((member) => [member.id, member.displayName])))
  const canRecord = computed(() => Boolean(group.value && currentUser.value && balanceSnapshot.value
    && balanceSnapshot.value.groupId === group.value.id
    && members.value.some(({ id }) => id === currentUser.value?.id)))
  const pendingSettlements = computed<readonly PendingSettlementProjection[]>(() => {
    queueRevision.value
    const activeGroupId = group.value?.id
    if (!activeGroupId) return []
    return queue.snapshot()
      .filter((operation) => (operation.envelope.kind === 'settlement.record' || operation.envelope.kind === 'settlement.void') && operation.envelope.groupId === activeGroupId)
      .map(projectOperation)
      .sort((left, right) => left.submittedAt < right.submittedAt ? -1 : left.submittedAt > right.submittedAt ? 1 : left.operationId.localeCompare(right.operationId))
  })

  async function loadGroup(groupId: string): Promise<void> {
    const generation = ++loadGeneration
    clearState()
    isLoading.value = true
    try {
      await (session as typeof session & { readonly ready?: Promise<void> }).ready
      if (generation !== loadGeneration) return
      const [loadedGroup, loadedMembers, user, snapshot, loadedSettlements] = await Promise.all([
        repository.groups.getById(groupId),
        repository.groups.listMembers(groupId),
        repository.app.getCurrentUser(),
        repository.groups.getBalanceSnapshot(groupId),
        repository.settlements.listForGroup(groupId),
      ])
      if (generation !== loadGeneration) return
      if (!loadedGroup || loadedGroup.id !== groupId) throw new Error('This group is not available.')
      if (snapshot.groupId !== groupId) throw new Error('The balance snapshot did not match this group.')
      if (!loadedMembers.some(({ id }) => id === user.id)) throw new Error('You are not an active member of this group.')
      if (loadedSettlements.some((settlement) => settlement.groupId !== groupId)) throw new Error('A settlement did not match this group.')
      group.value = loadedGroup
      members.value = loadedMembers
      currentUser.value = user
      balanceSnapshot.value = snapshot
      settlements.value = loadedSettlements
      queueRevision.value += 1
    } catch (reason) {
      if (generation !== loadGeneration) return
      clearState()
      error.value = messageFor(reason)
    } finally {
      if (generation === loadGeneration) isLoading.value = false
    }
  }

  async function recordPayment(command: SettlementRecordCommand): Promise<boolean> {
    if (!canRecord.value || !group.value || !balanceSnapshot.value || command.groupId !== group.value.id
      || command.expectedBalanceRevision !== balanceSnapshot.value.balanceRevision) {
      error.value = 'Reload current balances before recording this payment.'
      return false
    }
    return executeAndRefresh(queue.submit(command), command.groupId)
  }

  async function voidSettlement(command: SettlementVoidCommand): Promise<boolean> {
    const target = settlements.value.find(({ settlementId }) => settlementId === command.settlementId)
    if (!group.value || !balanceSnapshot.value || !target || target.void || command.groupId !== group.value.id
      || command.expectedRevision !== target.revision || command.expectedBalanceRevision !== balanceSnapshot.value.balanceRevision) {
      error.value = 'Reload the settlement and current balances before voiding this record.'
      return false
    }
    if (!canVoid(target)) {
      error.value = 'Only the settlement creator or an active group manager may void it.'
      return false
    }
    return executeAndRefresh(queue.submit(command), command.groupId)
  }

  function canVoid(settlement: SettlementRecord): boolean {
    const user = currentUser.value
    if (!user || settlement.void) return false
    return settlement.createdBy.id === user.id || members.value.find(({ id }) => id === user.id)?.canManage === true
  }

  async function retryOperation(operationId: string): Promise<boolean> {
    const operation = queue.get(operationId)
    if (!operation || operation.status !== 'failed' || !operation.error.retryable
      || (operation.envelope.kind !== 'settlement.record' && operation.envelope.kind !== 'settlement.void')) return false
    return executeAndRefresh(queue.retry(operationId), operation.envelope.groupId)
  }

  async function discardOperation(operationId: string): Promise<boolean> {
    const operation = queue.get(operationId)
    if (!operation || operation.status !== 'failed'
      || (operation.envelope.kind !== 'settlement.record' && operation.envelope.kind !== 'settlement.void')) return false
    try {
      const discarded = await queue.discard(operationId)
      if (discarded) queueRevision.value += 1
      return discarded
    } catch (reason) {
      error.value = messageFor(reason)
      return false
    }
  }

  async function dismissOperation(operationId: string): Promise<boolean> {
    const operation = queue.get(operationId)
    if (!operation || operation.status !== 'conflicted'
      || (operation.envelope.kind !== 'settlement.record' && operation.envelope.kind !== 'settlement.void')) return false
    try {
      const dismissed = await queue.acknowledge(operationId)
      if (dismissed) queueRevision.value += 1
      return dismissed
    } catch (reason) {
      error.value = messageFor(reason)
      return false
    }
  }

  async function executeAndRefresh(handle: CommandHandle, groupId: string): Promise<boolean> {
    error.value = undefined
    notice.value = ''
    queueRevision.value += 1
    try {
      const result = await handle.result()
      if ((result.kind !== 'settlement.record' && result.kind !== 'settlement.void') || result.status !== 'saved') throw new Error('Settlement write did not return a saved result.')
      const generation = loadGeneration
      const [snapshot, loadedSettlements] = await Promise.all([
        repository.groups.getBalanceSnapshot(groupId),
        repository.settlements.listForGroup(groupId),
      ])
      if (generation !== loadGeneration || group.value?.id !== groupId) return false
      if (snapshot.groupId !== groupId || snapshot.balanceRevision < result.balanceSnapshot.balanceRevision
        || !loadedSettlements.some((settlement) => settlement.settlementId === result.settlement.settlementId && settlement.revision >= result.settlement.revision)) {
        throw new Error('Saved settlement is not yet available in authoritative reads.')
      }
      balanceSnapshot.value = snapshot
      settlements.value = loadedSettlements
      await queue.acknowledge(handle.operationId)
      queueRevision.value += 1
      notice.value = result.kind === 'settlement.record' ? 'Payment recorded.' : 'Settlement record voided.'
      return true
    } catch (reason) {
      queueRevision.value += 1
      error.value = messageFor(reason)
      return false
    }
  }

  function clear(): void {
    loadGeneration += 1
    clearState()
    isLoading.value = false
  }

  function clearState(): void {
    group.value = undefined
    members.value = []
    currentUser.value = undefined
    balanceSnapshot.value = undefined
    settlements.value = []
    error.value = undefined
    notice.value = ''
  }

  return {
    group,
    members,
    currentUser,
    balanceSnapshot,
    settlements,
    memberNames,
    pendingSettlements,
    canRecord,
    isLoading,
    error,
    notice,
    loadGroup,
    recordPayment,
    voidSettlement,
    retryOperation,
    discardOperation,
    dismissOperation,
    canVoid,
    clear,
  }
})

function projectOperation(operation: CommandOperation): PendingSettlementProjection {
  const envelope = operation.envelope
  if (envelope.kind !== 'settlement.record' && envelope.kind !== 'settlement.void') throw new Error('Expected a settlement operation')
  return envelope.kind === 'settlement.record'
    ? {
        operationId: envelope.operationId,
        kind: 'record',
        status: operation.status,
        groupId: envelope.groupId,
        senderId: envelope.basis.senderId,
        recipientId: envelope.basis.recipientId,
        currency: envelope.money.currency,
        amountMinor: envelope.money.minorAmount,
        submittedAt: operation.submittedAt,
        ...('error' in operation ? { error: operation.error.message, retryable: operation.error.retryable } : { retryable: false }),
      }
    : {
        operationId: envelope.operationId,
        kind: 'void',
        status: operation.status,
        groupId: envelope.groupId,
        settlementId: envelope.settlementId,
        submittedAt: operation.submittedAt,
        ...('error' in operation ? { error: operation.error.message, retryable: operation.error.retryable } : { retryable: false }),
      }
}

function messageFor(reason: unknown): string {
  if (reason instanceof Error && reason.message.trim()) return reason.message
  return 'Settlement data could not be loaded.'
}
