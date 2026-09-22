// Per-device memo that an account's profile document was already confirmed, so launches don't block on re-reading it.
const PROFILE_READY_PREFIX = 'split-unwise:profile-ready:v1:'

export function profileReadyKey(projectId: string, uid: string): string { return `${PROFILE_READY_PREFIX}${projectId}:${uid}` }

export function readProfileReady(key: string): boolean {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem(key) === '1' } catch { return false }
}

export function writeProfileReady(key: string): void {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(key, '1') } catch { /* blocked storage only costs the next launch one read */ }
}

/** Makes the next launch re-run profile bootstrap, e.g. after the app found the profile document missing. */
export function forgetFirebaseProfileReady(): void {
  try {
    if (typeof localStorage === 'undefined') return
    for (const key of Object.keys(localStorage)) if (key.startsWith(PROFILE_READY_PREFIX)) localStorage.removeItem(key)
  } catch { /* nothing cached */ }
}
