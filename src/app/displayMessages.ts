import type { MessageKey } from './i18n'

export interface ApplicationMessage {
  readonly kind: 'application'
  readonly key: MessageKey
  readonly values?: Readonly<Record<string, string | number>>
}

export interface RemoteDisplayMessage {
  readonly kind: 'remote'
  readonly message: string
}

export type DisplayMessage = ApplicationMessage | RemoteDisplayMessage

export class ApplicationError extends Error {
  readonly kind = 'application-error'

  constructor(readonly messageKey: MessageKey, readonly values?: Readonly<Record<string, string | number>>) {
    super(messageKey)
    this.name = 'ApplicationError'
  }
}

export class SafeRemoteDisplayError extends Error {
  readonly kind = 'safe-remote-display'

  constructor(message: string) {
    super(message)
    this.name = 'SafeRemoteDisplayError'
  }
}

export function displayMessageFor(reason: unknown, fallbackKey: MessageKey): DisplayMessage {
  if (reason instanceof ApplicationError) return { kind: 'application', key: reason.messageKey, values: reason.values }
  if (isSafeRemoteDisplayError(reason)) return { kind: 'remote', message: reason.message }
  return { kind: 'application', key: fallbackKey }
}

export function isSafeRemoteDisplayError(reason: unknown): reason is SafeRemoteDisplayError {
  return typeof reason === 'object'
    && reason !== null
    && 'kind' in reason
    && reason.kind === 'safe-remote-display'
    && 'message' in reason
    && typeof reason.message === 'string'
    && Boolean(reason.message.trim())
}

export function displayMessageText(
  message: DisplayMessage | undefined,
  translate: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string,
): string | undefined {
  if (!message) return undefined
  return message.kind === 'remote' ? message.message : translate(message.key, message.values)
}
