export type AppMode = 'demo' | 'firebase'

/** Complete local-data owner. UID alone is not unique across modes or projects. */
export interface AppPrincipal {
  readonly mode: AppMode
  readonly projectId: string
  readonly uid: string
}

export interface AppPrincipalSource {
  /** Delivers the hydrated initial principal, then every later identity change. */
  listen(listener: (principal: AppPrincipal | undefined) => void | Promise<void>): Promise<() => void>
}

const PRINCIPAL_KEY_PREFIX = 'split-unwise-principal:v1'

/** Canonical, collision-safe namespace shared by all principal-owned local stores. */
export function appPrincipalKey(principal: AppPrincipal): string {
  const projectId = principalPart(principal.projectId, 'project ID')
  const uid = principalPart(principal.uid, 'user ID')
  if (principal.mode !== 'demo' && principal.mode !== 'firebase') throw new Error('Repository mode is invalid')
  return `${PRINCIPAL_KEY_PREFIX}:${principal.mode}:${encodeURIComponent(projectId)}:${encodeURIComponent(uid)}`
}

export function sameAppPrincipal(left: AppPrincipal | undefined, right: AppPrincipal | undefined): boolean {
  if (!left || !right) return left === right
  return appPrincipalKey(left) === appPrincipalKey(right)
}

function principalPart(value: string, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\u0000-\u001F\u007F]/.test(value)) {
    throw new Error(`App principal ${label} is required`)
  }
  return value
}
