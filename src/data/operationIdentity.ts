import type { CommandEnvelope } from './repositories'

export interface OperationIdentity {
  readonly userId: string
  readonly operationId: string
  readonly kind: CommandEnvelope['kind']
  readonly groupId: string | null
  readonly requestFingerprint: string
  readonly resourceId: string
}

export class OperationReplayConflictError extends Error {
  constructor() { super('Operation ID was already used with a different request context'); this.name = 'OperationReplayConflictError' }
}

export async function createOperationIdentity(userId: string, command: CommandEnvelope): Promise<OperationIdentity> {
  assertOperationId(command.operationId)
  if (!userId.trim()) throw new Error('Authenticated user ID is required')
  const request = Object.fromEntries(Object.entries(command).filter(([key]) => key !== 'operationId'))
  return {
    userId,
    operationId: command.operationId,
    kind: command.kind,
    groupId: 'groupId' in command ? command.groupId : null,
    requestFingerprint: await sha256(stableJson(request)),
    resourceId: `operation-${(await sha256(`${userId}\u0000${command.operationId}`)).slice(0, 48)}`,
  }
}

export async function assertReplayIdentity(stored: OperationIdentity, requested: OperationIdentity): Promise<void> {
  if (stored.userId !== requested.userId || stored.operationId !== requested.operationId || stored.kind !== requested.kind || stored.groupId !== requested.groupId || stored.requestFingerprint !== requested.requestFingerprint || stored.resourceId !== requested.resourceId) {
    throw new OperationReplayConflictError()
  }
}

/** Synchronous canonical fingerprint for queue-local envelope comparisons. */
export function canonicalEnvelopeFingerprint(command: CommandEnvelope): string { return stableJson(command) }

export function assertOperationId(operationId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(operationId)) throw new Error('operationId must be 1-128 URL-safe characters')
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
  }
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Operation payload must contain finite numbers')
  return JSON.stringify(value)
}
