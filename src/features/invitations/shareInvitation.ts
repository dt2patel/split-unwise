export type ShareInvitationResult =
  | { readonly status: 'shared' | 'copied' | 'cancelled' }
  | { readonly status: 'manual'; readonly url: string }

export interface ShareInvitationCopy {
  readonly title: string
  readonly text: string
}

export async function sharePreparedInvitation(url: string, copy: ShareInvitationCopy, options: {
  readonly share?: (data: ShareData) => Promise<void>
  readonly clipboard?: { writeText(value: string): Promise<void> }
} = {}): Promise<ShareInvitationResult> {
  const safe = preparedUrl(url)
  const share = options.share ?? globalThis.navigator?.share?.bind(globalThis.navigator)
  if (share) {
    try {
      await share({ title: copy.title, text: copy.text, url: safe })
      return { status: 'shared' }
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === 'AbortError') return { status: 'cancelled' }
    }
  }
  const clipboard = options.clipboard ?? globalThis.navigator?.clipboard
  if (clipboard) {
    try { await clipboard.writeText(safe); return { status: 'copied' } } catch { /* offer selectable manual copy */ }
  }
  return { status: 'manual', url: safe }
}

function preparedUrl(value: string): string {
  const url = new URL(value)
  if (url.protocol !== 'https:' || !/^\/invite\/[A-Za-z0-9._~-]+$/.test(url.pathname) || !/^#token=[A-Za-z0-9_-]{43}$/.test(url.hash)) throw new Error('Only a prepared invitation link can be shared')
  return url.href
}
