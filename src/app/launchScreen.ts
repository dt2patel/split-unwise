import { waitForLaunchMark, type LaunchMark } from './perfMarks'

/** A page that already shows real content: from here on, the launch screen only hides it. */
const CONTENT_MARKS: readonly LaunchMark[] = ['home-cached', 'home-content', 'group-cached', 'group-header', 'group-content']
const PAGE_WAIT_MS = 1500
const CONTENT_WAIT_MS = 600
const FADE_FALLBACK_MS = 450

let dismissing = false

/**
 * Fades the home-screen launch screen (index.html, public/launch.js) into the app once the first page has painted,
 * holding briefly for its content so the reveal lands on a filled screen instead of skeletons. Safe to call more than once.
 */
export async function dismissLaunchScreen(documentRef: Document = document): Promise<void> {
  const splash = documentRef.getElementById('su-launch')
  if (!splash || dismissing) return
  dismissing = true
  await firstVisiblePage(documentRef, PAGE_WAIT_MS)
  await waitForLaunchMark(CONTENT_MARKS, CONTENT_WAIT_MS)
  const finish = () => {
    splash.remove()
    documentRef.documentElement.classList.remove('su-launching')
  }
  if (!documentRef.documentElement.classList.contains('su-launching')) return finish()
  splash.addEventListener('transitionend', finish, { once: true })
  // The fade can't be relied on to report its end (hidden tab, reduced motion), so finish regardless.
  setTimeout(finish, FADE_FALLBACK_MS)
  splash.classList.add('su-launch--leaving')
}

/** Ionic reveals the first page one frame after mounting it; waiting for that keeps the fade from showing an empty shell. */
function firstVisiblePage(documentRef: Document, timeoutMs: number): Promise<void> {
  const started = Date.now()
  return new Promise((resolve) => {
    const check = () => {
      const visible = documentRef.querySelector('.ion-page:not(.ion-page-invisible):not(.ion-page-hidden)')
      if (visible || Date.now() - started >= timeoutMs) return resolve()
      requestAnimationFrame(check)
    }
    check()
  })
}

export function resetLaunchScreenForTesting(): void { dismissing = false }
