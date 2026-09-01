import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Ionic Vue navigation runtime', () => {
  it('keeps the pre-mount route transition guard installed', () => {
    const workspace = readFileSync(resolve(process.cwd(), 'pnpm-workspace.yaml'), 'utf8')
    const patch = readFileSync(resolve(process.cwd(), 'patches/@ionic__vue@9.0.1.patch'), 'utf8')

    expect(workspace).toContain("'@ionic/vue@9.0.1': patches/@ionic__vue@9.0.1.patch")
    expect(patch).toContain('else if (enteringViewItem.ionPageElement !== undefined)')
  })
})
