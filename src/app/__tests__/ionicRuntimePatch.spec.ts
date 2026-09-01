import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Ionic Vue navigation runtime', () => {
  it('defers pre-mount transitions and refuses incomplete swipe view pairs', () => {
    const workspace = readFileSync(resolve(process.cwd(), 'pnpm-workspace.yaml'), 'utf8')
    const patch = readFileSync(resolve(process.cwd(), 'patches/@ionic__vue@9.0.1.patch'), 'utf8')

    expect(workspace).toContain("'@ionic/vue@9.0.1': patches/@ionic__vue@9.0.1.patch")
    expect(patch).toContain('if (!enteringViewItem.mount || enteringViewItem.ionPageElement === undefined)')
    expect(patch).toContain('if (enteringViewItem.registerCallback === undefined)')
    expect(patch).toContain('return !!enteringViewItem?.ionPageElement && !!leavingViewItem?.ionPageElement')
    expect(patch).toContain('if (!enteringViewItem?.ionPageElement || !leavingViewItem?.ionPageElement)')
    expect(patch).toContain('let swipeTransitionStarted = false')
    expect(patch).toContain('if (enteringEl === undefined || leavingEl === undefined)')
    expect(patch).toContain('if (enteringViewItem?.ionPageElement)')
  })
})
