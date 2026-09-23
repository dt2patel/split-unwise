import { readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Ionic Vue navigation runtime', () => {
  it('defers pre-mount transitions and refuses incomplete swipe view pairs', () => {
    const workspace = readFileSync(resolve(process.cwd(), 'pnpm-workspace.yaml'), 'utf8')
    const patch = readFileSync(resolve(process.cwd(), 'patches/@ionic__vue@9.0.4.patch'), 'utf8')

    expect(workspace).toContain("'@ionic/vue@9.0.4': patches/@ionic__vue@9.0.4.patch")
    expect(patch).toContain('if (!enteringViewItem.mount || enteringViewItem.ionPageElement === undefined)')
    expect(patch).toContain('if (enteringViewItem.registerCallback === undefined)')
    expect(patch).toContain('return !!enteringViewItem?.ionPageElement && !!leavingViewItem?.ionPageElement')
    expect(patch).toContain('if (!enteringViewItem?.ionPageElement || !leavingViewItem?.ionPageElement)')
    expect(patch).toContain('let swipeTransitionStarted = false')
    expect(patch).toContain('if (enteringEl === undefined || leavingEl === undefined)')
    expect(patch).toContain('if (enteringViewItem?.ionPageElement)')
  })

  it('marks an interactive swipe as started before awaiting its animation', () => {
    const patch = readFileSync(resolve(process.cwd(), 'patches/@ionic__vue@9.0.4.patch'), 'utf8')
    const transitionStart = patch.indexOf('+            swipeTransitionStarted = true;')
    const transitionWait = patch.indexOf('+            await transition(enteringEl, leavingEl, "back"')

    expect(transitionStart).toBeGreaterThan(-1)
    expect(transitionWait).toBeGreaterThan(-1)
    expect(transitionStart).toBeLessThan(transitionWait)
  })
})

describe('Ionic card modal swipe-to-close patch', () => {
  it('finishes a dismiss at the release velocity with a decelerating curve', () => {
    const workspace = readFileSync(resolve(process.cwd(), 'pnpm-workspace.yaml'), 'utf8')
    expect(workspace).toContain("'@ionic/core@9.0.4': patches/@ionic__core@9.0.4.patch")
    // pnpm links @ionic/core beside the @ionic/vue that the app imports, not at the top level.
    const core = resolve(realpathSync(resolve(process.cwd(), 'node_modules/@ionic/vue')), '../core')
    const installed = readFileSync(resolve(core, 'components/p-BxCcX93a.js'), 'utf8')
    expect(installed).toContain('i.easing("cubic-bezier(0.25, 0.46, 0.45, 0.94)")')
    expect(installed).toContain('r=a>.05?Math.min(450,Math.max(200,(1-t0)*sl*d/a)):380')
    expect(installed).not.toContain('i.easing("cubic-bezier(0.32, 0.72, 0, 1)")')
  })
})
