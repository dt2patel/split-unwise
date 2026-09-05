// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  assertExpectedHostedCommit,
  collectHashedStartupAssets,
} from '../hostedBundleContract.mjs'

describe('hosted bundle proof contract', () => {
  it('requires one exact full Git commit for the deployed build assertion', () => {
    expect(assertExpectedHostedCommit('4090861e7f6b5f98c3ff321628e7197958d74bd4')).toBe('4090861e7f6b5f98c3ff321628e7197958d74bd4')
    expect(() => assertExpectedHostedCommit('4090861')).toThrow(/40-character/i)
    expect(() => assertExpectedHostedCommit('not-a-commit')).toThrow(/40-character/i)
    expect(() => assertExpectedHostedCommit(undefined)).toThrow(/EXPECTED_HOSTED_COMMIT/)
  })

  it('extracts every referenced hashed JavaScript and stylesheet startup asset', () => {
    const html = `
      <script type="module" crossorigin src="/assets/index-AbCdEf12.js"></script>
      <link rel="modulepreload" href="/assets/vendor-A1_b-234.js">
      <link rel="stylesheet" href="/assets/index-98zy_XWV.css">
      <script src="/startup.js"></script>
      <link rel="manifest" href="/manifest.webmanifest">
    `

    expect(collectHashedStartupAssets(html, 'https://split-unwise-aditya.web.app')).toEqual([
      'https://split-unwise-aditya.web.app/assets/index-AbCdEf12.js',
      'https://split-unwise-aditya.web.app/assets/vendor-A1_b-234.js',
      'https://split-unwise-aditya.web.app/assets/index-98zy_XWV.css',
    ])
  })

  it('rejects a shell without both a hashed module entry and a hashed stylesheet', () => {
    expect(() => collectHashedStartupAssets('<script src="/startup.js"></script>', 'https://split-unwise-aditya.web.app')).toThrow(/hashed module entry/i)
    expect(() => collectHashedStartupAssets('<script type="module" src="/assets/index-AbCdEf12.js"></script>', 'https://split-unwise-aditya.web.app')).toThrow(/hashed stylesheet/i)
  })

  it('rejects non-origin, non-hashed, and malformed startup asset references', () => {
    expect(() => collectHashedStartupAssets(`
      <script type="module" src="https://cdn.example.com/assets/index-AbCdEf12.js"></script>
      <link rel="stylesheet" href="/assets/index-98zy_XWV.css">
    `, 'https://split-unwise-aditya.web.app')).toThrow(/same hosted origin/i)
    expect(() => collectHashedStartupAssets(`
      <script type="module" src="/assets/index.js"></script>
      <link rel="stylesheet" href="/assets/index-98zy_XWV.css">
    `, 'https://split-unwise-aditya.web.app')).toThrow(/content hashed/i)
  })

  it('keeps exact-bundle and authenticated browser checks in the disposable hosted gate', () => {
    const runner = readFileSync(resolve(process.cwd(), 'scripts/runHostedProof.mjs'), 'utf8')
    const browser = readFileSync(resolve(process.cwd(), 'scripts/runHostedBrowserProof.mjs'), 'utf8')

    expect(runner).toContain('EXPECTED_HOSTED_COMMIT: expectedHostedCommit')
    expect(runner).toContain("['scripts/runHostedBrowserProof.mjs']")
    expect(browser).toContain("from 'playwright-core'")
    expect(browser).toContain("fetch(new URL('/build-info.json', hostedOrigin), noStore)")
    expect(browser).toContain('collectHashedStartupAssets(rootHtml, hostedOrigin)')
    expect(browser).toContain('signIn(page, ownerEmail)')
    expect(browser).toContain("getByRole('link', { name: 'Add expense', exact: true })")
    expect(browser).toContain("page.locator('#expense-category').selectOption({ label: 'Food' })")
    expect(browser).toContain("page.locator('.app-status').getByRole('button', { name: 'OK', exact: true })")
    expect(browser).toContain("page.locator('[data-action=\"save-expense\"]')")
    expect(browser).toContain('browserExpenseDescription')
    expect(browser).toContain('page.reload')
    expect(browser).toContain('.expense-row[data-sync-state="fresh"]')
    expect(browser).toContain('verifyReimbursementWorkflow')
    expect(browser).toContain('[data-method="reimbursement"]')
    expect(browser).toContain('Refund received by Live Renamed Owner')
    expect(browser).toContain('reimbursementRow.textContent()')
    expect(browser).toContain("locator('.expense-row__amount--balance.money-amount--owing')")
    expect(browser).toContain("getByText('you borrowed', { exact: true })")
    expect(browser).toContain("page.locator('.expense-detail:not(.ion-page-hidden)')")
    expect(browser).toContain("locator('section[aria-labelledby=\"details-title\"]')")
    expect(browser).toContain("details.getByText('Reimbursement', { exact: true })")
    expect(browser).toContain("getByRole('heading', { name: 'Refund received by', exact: true })")
    expect(browser).toContain("getByRole('heading', { name: 'Reimbursement owed to', exact: true })")
    expect(browser).toContain('verifySwipeBackGesture')
    expect(browser).toContain('verifyCancelledSwipeBackGesture')
    expect(browser).toContain('verifyCurrencyConversion')
    expect(browser).toContain("getByTestId('account-summary').filter({ hasText: 'You are owed' })")
    expect(browser).toContain('data-testid="confirm-conversion"')
    expect(browser).toContain('Hosted currency-conversion screen overflowed the 390px mobile viewport')
    expect(browser).toContain('visibleSiblingIonicPages')
    expect(browser).toContain("Input.dispatchTouchEvent")
    expect(browser).toContain("getByRole('link', { name: 'Recurring', exact: true })")
    expect(runner).toContain('live-unverified-')
    expect(runner).toContain("process.env.RUN_IOS_GESTURE_PROOF === '1'")
    expect(runner).toContain("VITE_NATIVE_UI_TEST_DEMO: 'true'")
    expect(runner).toContain("'-test-timeouts-enabled', 'YES'")
    expect(runner).toContain("'-maximum-test-execution-time-allowance', '240'")
    expect(runner).toContain("'test-without-building'")
    expect(browser).toContain('verifyInvitationAcceptance')
    expect(browser).toContain('invitation-verification-required')
  })

  it('ties the hosted profile save to the exact Firebase principal and authoritative Firestore operation', () => {
    const runner = readFileSync(resolve(process.cwd(), 'scripts/runHostedProof.mjs'), 'utf8')
    const browser = readFileSync(resolve(process.cwd(), 'scripts/runHostedBrowserProof.mjs'), 'utf8')
    const expectInOrder = (source: string, actions: readonly string[], label: string) => {
      let cursor = 0
      for (const action of actions) {
        const index = source.indexOf(action, cursor)
        expect(index, `${label} must include ${action} after the preceding action`).toBeGreaterThanOrEqual(cursor)
        cursor = index + action.length
      }
    }

    expectInOrder(browser, [
      'const ownerUid = process.env.LIVE_PROOF_OWNER_UID',
      'const profileOperationId = await verifyPaymentHandleProfile(page)',
      "console.log('LIVE_PROOF_PROFILE', JSON.stringify({ operationId: profileOperationId }))",
      'const expectedPrincipalKey = `split-unwise-principal:v1:firebase:split-unwise-aditya:${encodeURIComponent(ownerUid)}`',
      'operations[0].principalKey !== expectedPrincipalKey',
      'return operations[0].operationId',
    ], 'hosted browser profile proof')
    expectInOrder(runner, [
      'LIVE_PROOF_OWNER_UID: ownerFixtureUid',
      "browserProofResult = await run(process.execPath, ['scripts/runHostedBrowserProof.mjs']",
      'const profileOperationId = profileOperationFromBrowserProof(browserProofResult.stdout)',
      "getDocuments(projectId, [`users/${ownerFixtureUid}`])",
      "savedHandles?.paypal?.stringValue !== 'hosted.owner.paypal'",
      "savedHandles?.venmo?.stringValue !== 'hosted-owner-venmo'",
      'savedProfile?.fields?.lastOperationId?.stringValue !== profileOperationId',
    ], 'hosted Firestore profile proof')
  })

  it('measures each visible Ionic scroll host and the hydrated 320px deletion card for overflow', () => {
    const browser = readFileSync(resolve(process.cwd(), 'scripts/runHostedBrowserProof.mjs'), 'utf8')

    expect(browser).toContain('getScrollElement()')
    expect(browser).toContain('intentionalHorizontalScrollHosts')
    expect(browser).toContain('scrollWidth: scrollElement.scrollWidth')
    expect(browser).toContain('waitForAccountHydration(page)')
    expect(browser).toContain("'German Account deletion card at 320px'")
    expect(browser).toContain("getByTestId('account-deletion-modal')")
    expect(browser).toContain("getAnimations({ subtree: true })")
    expect(browser).toContain("setTimeout(() => reject(new Error('Hosted account deletion modal animations did not settle.')), 5_000)")
  })

  it('proves a cold offline reload and then requires unseen server data after reconnecting', () => {
    const browser = readFileSync(resolve(process.cwd(), 'scripts/runHostedBrowserProof.mjs'), 'utf8')
    const functionBody = (name: string) => {
      const start = browser.indexOf(`async function ${name}(`)
      const end = browser.indexOf('\nasync function ', start + 1)
      expect(start, `missing hosted proof helper ${name}`).toBeGreaterThanOrEqual(0)
      return browser.slice(start, end === -1 ? undefined : end)
    }
    const coldReload = functionBody('verifyColdOfflineGroupReload')
    const remoteWrite = functionBody('createReconnectExpenseFromFriend')

    let cursor = 0
    for (const expected of [
      'navigator.serviceWorker.getRegistration()',
      '{ timeout: 30_000 }',
      'await page.addInitScript',
      "sessionStorage.setItem(offlineSignalKey, '1')",
      'browserErrors.beginExpectedOfflineWindow()',
      'await context.setOffline(true)',
      "await page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 })",
      "fetch('/__/firebase/init.json', { cache: 'no-store' })",
      "getByText('Offline', { exact: true })",
      'await createReconnectExpenseFromFriend(browser)',
      'await context.setOffline(false)',
      'sessionStorage.removeItem(offlineSignalKey)',
      'browserErrors.endExpectedOfflineWindow()',
      "await page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 })",
      "if (!(await page.evaluate(() => navigator.onLine)))",
      'reconnectExpenseDescription',
    ]) {
      const index = coldReload.indexOf(expected, cursor)
      expect(index, `cold offline proof must include ${expected} after the preceding action`).toBeGreaterThanOrEqual(cursor)
      cursor = index + expected.length
    }
    for (const expected of [
      'await signIn(page, friendEmail)',
      "getByRole('link', { name: 'Add expense', exact: true })",
      "page.locator('#expense-amount').fill('1.23')",
      "'.expense-row[data-sync-state=\"fresh\"]'",
    ]) expect(remoteWrite).toContain(expected)
  })

  it('keeps the hosted Spanish Friends and invitation journeys exact-SHA verified', () => {
    const browser = readFileSync(resolve(process.cwd(), 'scripts/runHostedBrowserProof.mjs'), 'utf8')
    const functionBody = (name: string) => {
      const start = browser.indexOf(`async function ${name}(`)
      const end = browser.indexOf('\nasync function ', start + 1)
      expect(start, `missing hosted proof helper ${name}`).toBeGreaterThanOrEqual(0)
      return browser.slice(start, end === -1 ? undefined : end)
    }
    const expectInOrder = (source: string, actions: readonly string[], label: string) => {
      let cursor = 0
      for (const action of actions) {
        const index = source.indexOf(action, cursor)
        expect(index, `${label} must include ${action} after the preceding localized action`).toBeGreaterThanOrEqual(cursor)
        cursor = index + action.length
      }
    }
    const authenticatedJourney = functionBody('verifyAuthenticatedMobileJourney')
    const languagePreference = functionBody('verifyLanguagePreference')
    const spanishFriends = functionBody('verifySpanishFriendsLocalization')
    const invitationPreparation = functionBody('prepareInvitation')
    const invitationAcceptance = functionBody('verifyInvitationAcceptance')

    expectInOrder(languagePreference, [
      "name: 'Idioma de la app', exact: true",
      'await verifySpanishFriendsLocalization(page)',
      "new URL('/tabs/groups', hostedOrigin)",
    ], 'Spanish language preference')
    expectInOrder(spanishFriends, [
      "new URL('/tabs/home/friends', hostedOrigin)",
      'await page.setViewportSize({ width: 390, height: 844 })',
      "name: 'Amigos', exact: true",
      'Consulta lo que debes a cada persona entre los gastos directos y todos los grupos compartidos.',
      "page.locator('.friend-entry').filter({ hasText: 'Live Proof Friend' }).first()",
      "await friendEntry.waitFor({ state: 'visible', timeout: 120_000 })",
      "getByText('En 2 contextos compartidos', { exact: true }).waitFor({ state: 'visible', timeout: 120_000 })",
      "getByRole('button', { name: /Live Proof Friend/ })",
      'await friendRow.click()',
      "friendEntry.locator('.friend-breakdown')",
      "await breakdown.waitFor({ state: 'visible' })",
      "const friendsToolbar = page.locator('ion-header:visible ion-toolbar')",
      "const addFriendButton = friendsToolbar.getByRole('button', { name: 'Añadir amigo', exact: true })",
      'await addFriendButton.click()',
      "page.locator('.friend-form')",
      "await friendForm.waitFor({ state: 'visible' })",
      "await assertNoHorizontalOverflow(page, 'Spanish Friends at 390px')",
      'await page.setViewportSize({ width: 320, height: 844 })',
      "await assertNoHorizontalOverflow(page, 'Spanish Friends at 320px')",
      'await page.setViewportSize({ width: 390, height: 844 })',
      'await addFriendButton.click()',
      "await friendForm.waitFor({ state: 'hidden' })",
      'await friendRow.click()',
      "await breakdown.waitFor({ state: 'hidden' })",
    ], 'Spanish Friends proof')
    expect(spanishFriends).not.toContain("const addFriendButton = page.getByRole('button', { name: 'Añadir amigo', exact: true })")
    expectInOrder(invitationPreparation, [
      `await page.locator('[data-locale="es"] ion-radio').click()`,
      "document.documentElement.lang === 'es'",
      "name: 'Invitar a Live Account Proof', exact: true",
      "name: 'Preparar invitación', exact: true",
      'aria-label="URL de invitación preparada"',
      "await assertNoHorizontalOverflow(page, 'Spanish invitation preparation at 390px')",
      "name: 'Idioma de la app', exact: true",
      `await page.locator('[data-locale="en"] ion-radio').click()`,
      "name: 'App language', exact: true",
      "getAttribute('lang') !== 'en'",
    ], 'Spanish invitation preparation')
    expectInOrder(invitationAcceptance, [
      'await signIn(page, thirdEmail)',
      'const persistedInvitationToken = await page.evaluate',
      'sessionStorage.getItem(`split-unwise:invitation-secret:v1:${invitationId}`)',
      'if (persistedInvitationToken !== invitationToken)',
      "localStorage.setItem('split-unwise.locale', 'es')",
      "await page.reload({ waitUntil: 'domcontentloaded' })",
      'const restoredInvitationToken = await page.evaluate',
      'sessionStorage.getItem(`split-unwise:invitation-secret:v1:${invitationId}`)',
      'if (restoredInvitationToken !== invitationToken)',
      "'Te invitaron a unirte a Live Account Proof.'",
      "name: 'Unirse al grupo', exact: true",
    ], 'localized invitation acceptance')
    expect(invitationAcceptance.match(/sessionStorage\.getItem\(`split-unwise:invitation-secret:v1:\$\{invitationId\}`\)/g)).toHaveLength(2)
    expectInOrder(authenticatedJourney, [
      'await verifyLanguagePreference(page)',
      'const verifiedInvitationUrl = await prepareInvitation(page, thirdEmail)',
      'const unverifiedInvitationUrl = await prepareInvitation(page, unverifiedEmail)',
      'await context.close()',
      'await verifyInvitationAcceptance(browser, verifiedInvitationUrl)',
      'await verifyInvitationVerificationGate(browser, unverifiedInvitationUrl)',
    ], 'authenticated hosted journey')
  })

  it('requires the structural invitation contract to assert both awaited locale clicks', () => {
    const contract = readFileSync(resolve(process.cwd(), 'scripts/__tests__/hostedBundleContract.spec.ts'), 'utf8')
    const awaitedLocaleClick = (locale: 'es' | 'en') => [
      'await page.locator(',
      `'[data-locale="${locale}"] ion-radio'`,
      ').click()',
    ].join('')

    expect(contract).toContain(awaitedLocaleClick('es'))
    expect(contract).toContain(awaitedLocaleClick('en'))
  })

  it('requires the straight-apostrophe verification action locator in the unverified recovery helper', () => {
    const browser = readFileSync(resolve(process.cwd(), 'scripts/runHostedBrowserProof.mjs'), 'utf8')
    const start = browser.indexOf('async function verifyInvitationVerificationGate(')
    const end = browser.indexOf('\nasync function ', start + 1)
    expect(start, 'missing hosted proof helper verifyInvitationVerificationGate').toBeGreaterThanOrEqual(0)
    const recoveryHelper = browser.slice(start, end === -1 ? undefined : end)
    const straightApostropheLocator = `getByRole('button', { name: "I've verified my email", exact: true })`
    const curlyApostropheLocator = "getByRole('button', { name: 'I’ve verified my email', exact: true })"

    expect(recoveryHelper).toContain(straightApostropheLocator)
    expect(recoveryHelper).not.toContain(curlyApostropheLocator)
  })
})
