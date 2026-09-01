import { describe, expect, it } from 'vitest'
import { describeUpdateBlockers, reduceUpdatePrompt, shouldRegisterServiceWorker } from '../releasePolicy'

describe('PWA update safety', () => {
  it('registers only for production web, never development or native Capacitor', () => {
    expect(shouldRegisterServiceWorker({ production: true, native: false })).toBe(true)
    expect(shouldRegisterServiceWorker({ production: false, native: false })).toBe(false)
    expect(shouldRegisterServiceWorker({ production: true, native: true })).toBe(false)
  })

  it.each(['pending', 'failed', 'conflicted'] as const)('blocks activation for a %s command', (status) => {
    expect(describeUpdateBlockers([{ status }], 0)).toMatchObject({ blocked: true, commands: 1 })
  })

  it('blocks local receipt drafts but allows persisted terminal-safe state', () => {
    expect(describeUpdateBlockers([{ status: 'fresh' }, { status: 'stale' }], 1)).toMatchObject({ blocked: true, receipts: 1 })
    expect(describeUpdateBlockers([{ status: 'fresh' }, { status: 'stale' }], 0)).toEqual({ blocked: false, commands: 0, receipts: 0, message: '' })
  })

  it('keeps the waiting worker when Later dismisses the prompt', () => {
    const waiting = reduceUpdatePrompt({ waiting: false, dismissed: false }, 'need-refresh')
    expect(waiting).toEqual({ waiting: true, dismissed: false })
    expect(reduceUpdatePrompt(waiting, 'later')).toEqual({ waiting: true, dismissed: true })
    expect(reduceUpdatePrompt(waiting, 'activated')).toEqual({ waiting: false, dismissed: false })
  })
})
