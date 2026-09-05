// @vitest-environment node
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'

import { createBrowserErrorMonitor } from '../browserErrorMonitor.mjs'

class FakePage extends EventEmitter {}

function consoleMessage(type: string, message: string) {
  return { type: () => type, text: () => message }
}

describe('hosted browser error monitor', () => {
  it('accepts only the known network and Firestore messages inside an explicit offline window', () => {
    const page = new FakePage()
    const monitor = createBrowserErrorMonitor(page, 'owner journey')

    monitor.beginExpectedOfflineWindow()
    page.emit('console', consoleMessage('error', 'Failed to load resource: net::ERR_INTERNET_DISCONNECTED'))
    page.emit('console', consoleMessage('error', '[2026-09-05T17:11:28.686Z] @firebase/firestore: Firestore (12.18.0): Could not reach Cloud Firestore backend. Connection failed 1 times. Most recent error: FirebaseError: [code=unavailable]: The operation could not be completed This typically indicates that your device does not have a healthy Internet connection at the moment.'))

    expect(monitor.endExpectedOfflineWindow()).toEqual({ consoleErrorCount: 2 })
    expect(() => monitor.assertClean()).not.toThrow()
  })

  it('rejects the same network message after the scoped offline window closes', () => {
    const page = new FakePage()
    const monitor = createBrowserErrorMonitor(page, 'owner journey')

    monitor.beginExpectedOfflineWindow()
    monitor.endExpectedOfflineWindow()
    page.emit('console', consoleMessage('error', 'Failed to load resource: net::ERR_INTERNET_DISCONNECTED'))

    expect(() => monitor.assertClean()).toThrow(/1 unexpected console error/)
  })

  it('rejects unrelated console errors and page exceptions even while offline', () => {
    const page = new FakePage()
    const monitor = createBrowserErrorMonitor(page, 'owner journey')

    monitor.beginExpectedOfflineWindow()
    page.emit('console', consoleMessage('error', 'Application invariant failed for https://example.test/path?token=secret'))
    page.emit('pageerror', new Error('Render crashed for person@example.test'))
    monitor.endExpectedOfflineWindow()

    expect(() => monitor.assertClean()).toThrow(/1 page error and 1 unexpected console error/)
    expect(() => monitor.assertClean()).toThrow(/\[url\]/)
    expect(() => monitor.assertClean()).toThrow(/\[email\]/)
    expect(() => monitor.assertClean()).not.toThrow(/token=secret|person@example\.test/)
  })

  it('requires every offline window to be closed before the final cleanliness assertion', () => {
    const page = new FakePage()
    const monitor = createBrowserErrorMonitor(page, 'owner journey')

    monitor.beginExpectedOfflineWindow()

    expect(() => monitor.assertClean()).toThrow(/offline error window is still active/)
  })
})
