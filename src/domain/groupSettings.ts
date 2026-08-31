import type { Member } from '../data/repositories'
import type { EqualSplit, PercentageSplit, SharesSplit, SplitMethod } from './model'
import { computeAllocations } from './splits'

export type DefaultSplit = EqualSplit | PercentageSplit | SharesSplit

export interface GroupSettings {
  readonly schemaVersion: 1
  readonly groupId: string
  readonly revision: number
  readonly defaultSplit?: DefaultSplit
}

export interface GroupSettingsUpdate {
  readonly expectedRevision: number
  readonly defaultSplit?: SplitMethod
}

export function updateGroupSettings(current: GroupSettings, update: GroupSettingsUpdate, members: readonly Member[], actorId: string): GroupSettings {
  const actor = members.find(({ id }) => id === actorId)
  if (!actor || actor.canManage !== true) throw new Error('Only an active group manager can change shared defaults')
  if (!Number.isSafeInteger(update.expectedRevision) || update.expectedRevision !== current.revision) throw new Error('Group settings changed remotely')
  if (!Number.isSafeInteger(current.revision) || current.revision < 1 || current.revision >= Number.MAX_SAFE_INTEGER) throw new Error('Group settings revision cannot advance')
  const next = update.defaultSplit === undefined ? undefined : validateDefaultSplit(update.defaultSplit, members)
  return { schemaVersion: 1, groupId: current.groupId, revision: current.revision + 1, ...(next ? { defaultSplit: next } : {}) }
}

export function validateDefaultSplit(value: SplitMethod, members: readonly Member[]): DefaultSplit {
  const decoded = decodeDefaultSplit(value)
  const participantIds = [...decoded.participantIds]
  const activeIds = new Set(members.map(({ id }) => id))
  if (participantIds.some((id) => !activeIds.has(id))) throw new Error('Default split participants must be active group members')
  return decoded
}

export function decodeDefaultSplit(value: unknown): DefaultSplit {
  if (!isRecord(value) || (value.type !== 'equal' && value.type !== 'percentage' && value.type !== 'shares')) throw new Error('Shared defaults support equal, percentage, or shares only')
  if (!Array.isArray(value.participantIds) || value.participantIds.length === 0 || value.participantIds.some((id) => typeof id !== 'string' || !id.trim()) || new Set(value.participantIds).size !== value.participantIds.length) throw new Error('Default split participants must be unique non-empty IDs')
  const participantIds = [...value.participantIds] as string[]
  let decoded: DefaultSplit
  if (value.type === 'equal') {
    assertExactFields(value, ['type', 'participantIds'])
    decoded = { type: 'equal', participantIds }
  } else {
    const key = value.type === 'percentage' ? 'percentages' : 'shares'
    assertExactFields(value, ['type', 'participantIds', key])
    const ratios = value[key]
    if (!isNumberRecord(ratios) || !sameKeys(participantIds, Object.keys(ratios))) throw new Error('Default split ratio keys must exactly match its participants')
    decoded = value.type === 'percentage'
      ? { type: 'percentage', participantIds, percentages: { ...ratios } }
      : { type: 'shares', participantIds, shares: { ...ratios } }
  }
  // Reuse ledger arithmetic validation for finite ratios, positive totals, and exact 100% semantics.
  computeAllocations({ currency: 'USD', minorAmount: 10_000 }, decoded)
  return decoded
}

export function clearInvalidDefaultSplit(settings: GroupSettings, activeMembers: readonly Member[]): GroupSettings {
  if (!settings.defaultSplit) return settings
  const activeIds = new Set(activeMembers.map(({ id }) => id))
  if (settings.defaultSplit.participantIds.every((id) => activeIds.has(id))) return settings
  if (settings.revision >= Number.MAX_SAFE_INTEGER) throw new Error('Group settings revision cannot advance')
  return { schemaVersion: 1, groupId: settings.groupId, revision: settings.revision + 1 }
}

/** Existing itemized or user-selected intent always wins; defaults only seed a new unconfigured draft. */
export function seedDefaultSplit(settings: GroupSettings, current?: SplitMethod): SplitMethod | undefined {
  return current ?? (settings.defaultSplit ? cloneDefault(settings.defaultSplit) : undefined)
}

function cloneDefault(value: DefaultSplit): DefaultSplit {
  if (value.type === 'equal') return { type: 'equal', participantIds: [...value.participantIds] }
  if (value.type === 'percentage') return { type: 'percentage', participantIds: [...value.participantIds], percentages: { ...value.percentages } }
  return { type: 'shares', participantIds: [...value.participantIds], shares: { ...value.shares } }
}
function sameKeys(expected: readonly string[], actual: readonly string[]): boolean {
  const sortedExpected = [...expected].sort()
  const sortedActual = [...actual].sort()
  return sortedExpected.length === sortedActual.length && sortedExpected.every((value, index) => value === sortedActual[index])
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function isNumberRecord(value: unknown): value is Readonly<Record<string, number>> { return isRecord(value) && Object.values(value).every((item) => typeof item === 'number' && Number.isFinite(item)) }
function assertExactFields(value: Readonly<Record<string, unknown>>, expected: readonly string[]): void {
  if (!sameKeys(expected, Object.keys(value))) throw new Error('Default split fields are invalid')
}
