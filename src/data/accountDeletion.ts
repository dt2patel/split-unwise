export const DELETED_ACCOUNT_NAME = 'Deleted user'
export const DELETED_ACCOUNT_INITIALS = 'DU'
export const DELETED_COMMENT_BODY = 'Comment removed with deleted account'

export type AccountDeletionPhase = 'deleting' | 'prepared'
export type SharedDocumentKind = 'activity' | 'comment' | 'expense' | 'group' | 'recurring' | 'revision' | 'settings' | 'settlement'

export interface AccountDeletionTombstone extends Readonly<Record<string, unknown>> {
  readonly displayName: typeof DELETED_ACCOUNT_NAME
  readonly initials: typeof DELETED_ACCOUNT_INITIALS
  readonly avatarUrl: null
  readonly createdAt: unknown
  readonly updatedAt: unknown
  readonly deletionRequestedAt: unknown
  readonly deletionStatus: AccountDeletionPhase
  readonly deletionId: string
  readonly deletionGroupIds: readonly string[]
}

export interface AccountDeletionTombstoneInput {
  readonly uid: string
  readonly deletionId: string
  readonly groupIds: readonly string[]
  readonly phase: AccountDeletionPhase
  readonly committedAt: unknown
}

export interface DeletionGroupContinuity {
  readonly group: Readonly<Record<string, unknown>>
  readonly deletedMember: Readonly<Record<string, unknown>>
  readonly promotedMember?: Readonly<Record<string, unknown>> & { readonly id: string }
}

export function buildAccountDeletionTombstone(
  current: Readonly<Record<string, unknown>>,
  input: AccountDeletionTombstoneInput,
): AccountDeletionTombstone {
  assertStrictId(input.uid, 'account UID')
  assertDeletionId(input.deletionId)
  if (input.phase !== 'deleting' && input.phase !== 'prepared') throw new Error('Account deletion phase is invalid.')
  if (current.createdAt === undefined) throw new Error('Account profile creation time is missing.')
  const groupIds = normalizedGroupIds(input.groupIds)
  const existingDeletionId = current.deletionId
  if (existingDeletionId !== undefined && existingDeletionId !== input.deletionId) throw new Error('Account deletion identity does not match the pending request.')
  if (Array.isArray(current.deletionGroupIds) && !sameStrings(current.deletionGroupIds, groupIds)) throw new Error('Account deletion group scope does not match the pending request.')
  const deletionRequestedAt = current.deletionRequestedAt ?? input.committedAt
  return {
    displayName: DELETED_ACCOUNT_NAME,
    initials: DELETED_ACCOUNT_INITIALS,
    avatarUrl: null,
    createdAt: current.createdAt,
    updatedAt: input.committedAt,
    deletionRequestedAt,
    deletionStatus: input.phase,
    deletionId: input.deletionId,
    deletionGroupIds: groupIds,
  }
}

export function anonymizeSharedDocument(
  kind: SharedDocumentKind,
  current: Readonly<Record<string, unknown>>,
  uid: string,
): Readonly<Record<string, unknown>> | undefined {
  assertStrictId(uid, 'account UID')
  if (kind === 'comment') return anonymizeComment(current, uid)
  if (kind === 'expense') {
    let next = current
    next = replaceActorField(next, 'createdBy', uid)
    next = replaceActorField(next, 'updatedBy', uid)
    next = replaceNestedActorFields(next, 'current', uid, ['createdBy', 'updatedBy'])
    return next === current ? undefined : next
  }
  if (kind === 'revision') {
    let next = replaceActorField(current, 'actor', uid)
    next = replaceNestedActorFields(next, 'expense', uid, ['createdBy', 'updatedBy'])
    return next === current ? undefined : next
  }
  if (kind === 'settlement') {
    let next = replaceActorField(current, 'createdBy', uid)
    next = replaceNestedActorFields(next, 'void', uid, ['actor'])
    return next === current ? undefined : next
  }
  const actorFields = kind === 'group'
    ? ['deletedBy']
    : kind === 'activity'
      ? ['actor']
      : kind === 'recurring'
        ? ['createdBy', 'updatedBy']
        : kind === 'settings'
          ? ['updatedBy']
          : []
  let next = current
  for (const field of actorFields) next = replaceActorField(next, field, uid)
  return next === current ? undefined : next
}

export function buildDeletedMemberDocument(
  current: Readonly<Record<string, unknown>>,
  uid: string,
  deletionId: string,
  committedAt: unknown,
): Readonly<Record<string, unknown>> {
  assertStrictId(uid, 'account UID')
  assertDeletionId(deletionId)
  if (current.status !== 'active') throw new Error('Only an active member can be deleted from an account.')
  const { id: _id, ...member } = current
  return {
    ...member,
    status: 'removed',
    role: 'member',
    canManage: false,
    displayName: DELETED_ACCOUNT_NAME,
    initials: DELETED_ACCOUNT_INITIALS,
    avatarUrl: null,
    accountStatus: 'deleted',
    accountDeletionId: deletionId,
    accountDeletedAt: committedAt,
  }
}

export function buildDeletionGroupContinuity(
  group: Readonly<Record<string, unknown>>,
  members: readonly (Readonly<Record<string, unknown>> & { readonly id: string })[],
  uid: string,
  deletionId: string,
  committedAt: unknown,
): DeletionGroupContinuity {
  assertStrictId(uid, 'account UID')
  assertDeletionId(deletionId)
  if (!Array.isArray(group.memberIds) || group.memberIds.some((id) => typeof id !== 'string')) throw new Error('Account deletion group membership is invalid.')
  const memberIds = group.memberIds as string[]
  if (!memberIds.includes(uid)) throw new Error('Deleting account is not a group member.')
  const deletingMember = members.find((member) => member.id === uid)
  if (!deletingMember) throw new Error('Deleting account membership is missing.')
  const byId = new Map(members.map((member) => [member.id, member]))
  const remaining = memberIds.flatMap((id) => {
    const member = byId.get(id)
    return id !== uid && member?.status === 'active' && member.accountStatus !== 'deleted' ? [member] : []
  })
  const otherManagerExists = remaining.some((member) => member.canManage === true)
  const needsPromotion = deletingMember.role === 'owner' || (deletingMember.canManage === true && !otherManagerExists)
  const promotionTarget = needsPromotion ? remaining[0] : undefined
  const deletedMember = buildDeletedMemberDocument(deletingMember, uid, deletionId, committedAt)
  const anonymizedGroup = anonymizeSharedDocument('group', group, uid) ?? group
  const baseGroup: Record<string, unknown> = {
    ...anonymizedGroup,
    memberIds: memberIds.filter((memberId) => memberId !== uid),
    updatedAt: committedAt,
    lastAccountDeletionId: deletionId,
    lastDeletedAccountUid: uid,
  }
  let promotedMember: (Readonly<Record<string, unknown>> & { readonly id: string }) | undefined
  if (promotionTarget) {
    baseGroup.createdByUid = promotionTarget.id
    promotedMember = {
      ...promotionTarget,
      role: 'owner',
      canManage: true,
      accountDeletionPromotionId: deletionId,
      accountDeletionPromotedAt: committedAt,
    }
  } else if (remaining.length === 0) {
    baseGroup.status = 'deleted'
    baseGroup.deletedAt = committedAt
    baseGroup.deletedBy = deletedActor(uid)
  }
  return { group: baseGroup, deletedMember, ...(promotedMember ? { promotedMember } : {}) }
}

export function buildDeletionRecurringTemplate(
  current: Readonly<Record<string, unknown>>,
  uid: string,
  deletionId: string,
  committedAt: unknown,
): Readonly<Record<string, unknown>> | undefined {
  assertStrictId(uid, 'account UID')
  assertDeletionId(deletionId)
  const actorAnonymized = anonymizeSharedDocument('recurring', current, uid)
  if (current.status !== 'active' || !Array.isArray(current.involvedMemberIds) || !current.involvedMemberIds.includes(uid)) return actorAnonymized
  if (!Number.isSafeInteger(current.revision) || Number(current.revision) < 1 || Number(current.revision) >= Number.MAX_SAFE_INTEGER) {
    throw new Error('Recurring template revision is invalid.')
  }
  const recurrence = actorAnonymized ?? current
  return {
    ...recurrence,
    status: 'cancelled',
    revision: Number(current.revision) + 1,
    updatedAt: committedAt,
    updatedBy: deletedActor(uid),
    accountDeletionId: deletionId,
    accountDeletedUid: uid,
  }
}

export function buildDeletionSettings(
  current: Readonly<Record<string, unknown>>,
  uid: string,
  deletionId: string,
  committedAt: unknown,
): Readonly<Record<string, unknown>> | undefined {
  assertStrictId(uid, 'account UID')
  assertDeletionId(deletionId)
  const participantIds = isRecord(current.defaultSplit) && Array.isArray(current.defaultSplit.participantIds)
    ? current.defaultSplit.participantIds
    : undefined
  const clearsDefault = participantIds?.includes(uid) === true
  const anonymized = anonymizeSharedDocument('settings', current, uid)
  if (!clearsDefault && !anonymized) return undefined
  const base = anonymized ?? current
  const { defaultSplit: _defaultSplit, ...withoutDefault } = base
  if (!clearsDefault) return base
  if (!Number.isSafeInteger(current.revision) || Number(current.revision) < 1 || Number(current.revision) >= Number.MAX_SAFE_INTEGER) {
    throw new Error('Group settings revision is invalid.')
  }
  return {
    ...withoutDefault,
    revision: Number(current.revision) + 1,
    updatedAt: committedAt,
    updatedBy: deletedActor(uid),
    accountDeletionId: deletionId,
    accountDeletedUid: uid,
  }
}

function anonymizeComment(current: Readonly<Record<string, unknown>>, uid: string): Readonly<Record<string, unknown>> | undefined {
  if (!actorBelongsTo(current.author, uid)) return undefined
  let changed = false
  const author = anonymizedActor(current.author, uid)
  if (author !== current.author) changed = true
  const body = current.body === DELETED_COMMENT_BODY ? current.body : DELETED_COMMENT_BODY
  if (body !== current.body) changed = true
  const attachmentRefs = Array.isArray(current.attachmentRefs) && current.attachmentRefs.length === 0 ? current.attachmentRefs : []
  if (attachmentRefs !== current.attachmentRefs) changed = true
  return changed ? { ...current, author, body, attachmentRefs } : undefined
}

function replaceNestedActorFields(
  current: Readonly<Record<string, unknown>>,
  nestedField: string,
  uid: string,
  actorFields: readonly string[],
): Readonly<Record<string, unknown>> {
  const nested = current[nestedField]
  if (!isRecord(nested)) return current
  let nextNested: Readonly<Record<string, unknown>> = nested
  for (const actorField of actorFields) nextNested = replaceActorField(nextNested, actorField, uid)
  return nextNested === nested ? current : { ...current, [nestedField]: nextNested }
}

function replaceActorField(current: Readonly<Record<string, unknown>>, field: string, uid: string): Readonly<Record<string, unknown>> {
  const actor = current[field]
  const replacement = anonymizedActor(actor, uid)
  return replacement === actor ? current : { ...current, [field]: replacement }
}

function anonymizedActor(value: unknown, uid: string): unknown {
  if (!actorBelongsTo(value, uid) || value.displayName === DELETED_ACCOUNT_NAME) return value
  return { ...value, displayName: DELETED_ACCOUNT_NAME }
}

function actorBelongsTo(value: unknown, uid: string): value is Readonly<Record<string, unknown>> & { readonly id: string; readonly displayName: string } {
  return isRecord(value) && value.id === uid && typeof value.displayName === 'string'
}

function deletedActor(uid: string): Readonly<{ id: string; displayName: typeof DELETED_ACCOUNT_NAME }> {
  return { id: uid, displayName: DELETED_ACCOUNT_NAME }
}

function normalizedGroupIds(values: readonly string[]): readonly string[] {
  const groupIds = [...new Set(values)]
  groupIds.forEach((groupId) => assertStrictId(groupId, 'account deletion group ID'))
  if (groupIds.length > 100) throw new Error('Account deletion supports at most 100 groups.')
  return groupIds.sort((left, right) => left.localeCompare(right))
}

function assertDeletionId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) throw new Error('Account deletion ID is invalid.')
}

function assertStrictId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error(`${label} is invalid.`)
}

function sameStrings(left: readonly unknown[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
