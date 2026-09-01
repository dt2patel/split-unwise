#!/usr/bin/env node

import { chromium } from 'playwright-core'

import { assertExpectedHostedCommit, collectHashedStartupAssets } from './hostedBundleContract.mjs'

const hostedOrigin = 'https://split-unwise-aditya.web.app'
const suffix = process.env.LIVE_PROOF_SUFFIX
const password = process.env.LIVE_PROOF_PASSWORD
const expectedCommit = assertExpectedHostedCommit(process.env.EXPECTED_HOSTED_COMMIT)

if (!suffix || !/^[a-z0-9-]{10,80}$/.test(suffix)) throw new Error('Hosted browser proof requires a valid LIVE_PROOF_SUFFIX.')
if (!password || process.env.LIVE_PREVERIFIED_ACCOUNTS !== '1') throw new Error('Hosted browser proof requires preverified disposable accounts from runHostedProof.')

const ownerEmail = `live-owner-${suffix}@example.com`
const thirdEmail = `live-third-${suffix}@example.com`
const unverifiedEmail = `live-unverified-${suffix}@example.com`
const groupId = `grp-live-${suffix}`
const groupPath = `/tabs/groups/${groupId}`
const deepUrl = new URL(groupPath, hostedOrigin).href
const noStore = { cache: 'no-store', headers: { 'cache-control': 'no-cache' } }

await verifyDeployedBundle()
await verifyAuthenticatedMobileJourney()

process.stdout.write(`Hosted browser proof passed for deployed commit ${expectedCommit}; authenticated mobile group, Add Expense save, repeated touch swipe-back navigation, recurrence card modal, invitation acceptance, and unverified-email recovery all completed.\n`)

async function verifyDeployedBundle() {
  const [buildResponse, rootResponse, deepResponse] = await Promise.all([
    fetch(new URL('/build-info.json', hostedOrigin), noStore),
    fetch(new URL('/', hostedOrigin), noStore),
    fetch(deepUrl, noStore),
  ])
  requireResponse(buildResponse, 'build metadata')
  requireResponse(rootResponse, 'root shell')
  requireResponse(deepResponse, 'deep-route shell')

  const build = await buildResponse.json()
  if (build?.app !== 'Split Unwise' || build?.commit !== expectedCommit) {
    throw new Error(`Hosted build metadata does not match expected deployed commit ${expectedCommit}.`)
  }

  const [rootHtml, deepHtml] = await Promise.all([rootResponse.text(), deepResponse.text()])
  for (const [label, html] of [['root', rootHtml], ['deep route', deepHtml]]) {
    if (!html.includes('id="app"')) throw new Error(`Hosted ${label} did not return the application shell.`)
  }
  const rootAssets = collectHashedStartupAssets(rootHtml, hostedOrigin)
  const deepAssets = collectHashedStartupAssets(deepHtml, hostedOrigin)
  if (JSON.stringify(deepAssets) !== JSON.stringify(rootAssets)) throw new Error('Hosted deep route referenced a different startup bundle than the root shell.')

  await Promise.all(rootAssets.map(async (assetUrl) => {
    const response = await fetch(assetUrl, noStore)
    requireResponse(response, new URL(assetUrl).pathname)
    const expectedType = assetUrl.endsWith('.css') ? 'text/css' : 'javascript'
    if (!response.headers.get('content-type')?.includes(expectedType)) throw new Error(`Hosted startup asset returned the wrong content type: ${new URL(assetUrl).pathname}`)
    if ((await response.arrayBuffer()).byteLength === 0) throw new Error(`Hosted startup asset was empty: ${new URL(assetUrl).pathname}`)
  }))
}

async function verifyAuthenticatedMobileJourney() {
  const launchOptions = process.env.LIVE_PROOF_BROWSER_EXECUTABLE
    ? { executablePath: process.env.LIVE_PROOF_BROWSER_EXECUTABLE, headless: true }
    : { channel: process.env.LIVE_PROOF_BROWSER_CHANNEL ?? 'chrome', headless: true }
  const browser = await chromium.launch(launchOptions)
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, locale: 'en-US' })
    const page = await context.newPage()
    const assertOwnerPageClean = monitorBrowserErrors(page, 'owner journey')

    const navigation = await page.goto(hostedOrigin, { waitUntil: 'domcontentloaded' })
    if (!navigation?.ok()) throw new Error(`Hosted browser root navigation failed with ${navigation?.status() ?? 'no response'}.`)
    await page.locator('#auth-email').waitFor({ state: 'visible' })
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/tabs\/home(?:[?#].*)?$/)
    await page.getByRole('heading', { name: 'Home', exact: true }).waitFor({ state: 'visible' })

    const groupLink = page.getByRole('link', { name: /Live Account Proof/ }).first()
    await groupLink.waitFor({ state: 'visible' })
    await groupLink.click()
    await page.waitForURL(deepUrl)
    const activeGroup = page.locator('[data-testid="group-detail"]:not(.ion-page-hidden)')
    await activeGroup.getByRole('heading', { name: 'Live Account Proof', exact: true }).waitFor({ state: 'visible' })
    await activeGroup.locator('[data-testid="expense-journal"]').waitFor({ state: 'visible' })

    await activeGroup.getByRole('link', { name: 'Add expense', exact: true }).click()
    await page.waitForURL(new RegExp(`/tabs/groups/expenses/new\\?groupId=${escapeRegExp(groupId)}$`))
    await page.locator('#expense-description').waitFor({ state: 'visible' })
    const recurrenceTrigger = page.locator('#recurrence-sheet-trigger')
    await recurrenceTrigger.waitFor({ state: 'visible' })
    await recurrenceTrigger.click()
    const cardModal = page.locator('ion-modal.show-modal')
    await cardModal.waitFor({ state: 'visible' })
    await cardModal.getByRole('heading', { name: 'Repeat', exact: true }).waitFor({ state: 'visible' })
    await cardModal.getByRole('radiogroup', { name: 'Repeat frequency' }).waitFor({ state: 'visible' })
    if (!(await cardModal.evaluate((modal) => modal.classList.contains('modal-card')))) throw new Error('Hosted recurrence editor did not use the Ionic iOS card modal.')
    await cardModal.getByRole('button', { name: 'Cancel', exact: true }).click()
    await cardModal.waitFor({ state: 'hidden' })
    const browserExpenseDescription = `Hosted browser transport ${suffix}`
    await page.locator('#expense-description').fill(browserExpenseDescription)
    await page.locator('#expense-amount').fill('13.37')
    await page.locator('#expense-category').selectOption({ label: 'Food' })
    const offlineReadyDismiss = page.locator('.app-status').getByRole('button', { name: 'OK', exact: true })
    if (await offlineReadyDismiss.isVisible()) await offlineReadyDismiss.click()
    await page.locator('[data-action="save-expense"]').click()

    await page.waitForURL(deepUrl, { timeout: 120_000 })
    await page.reload({ waitUntil: 'domcontentloaded' })
    const restoredGroup = page.locator('[data-testid="group-detail"]:not(.ion-page-hidden)')
    await restoredGroup.getByRole('heading', { name: 'Live Account Proof', exact: true }).waitFor({ state: 'visible' })
    const persistedExpense = restoredGroup.locator('.expense-row[data-sync-state="fresh"]', { hasText: browserExpenseDescription })
    await persistedExpense.getByText(browserExpenseDescription, { exact: true }).waitFor({ state: 'visible' })
    await verifySwipeBackGesture(context, page)
    await restoredGroup.getByRole('button', { name: 'More', exact: true }).click()
    await restoredGroup.getByRole('link', { name: 'Recurring', exact: true }).click()
    await page.waitForURL(`${deepUrl}/recurring`)
    const recurringPage = page.locator('[data-testid="recurring-expenses-page"]:not(.ion-page-hidden)')
    await recurringPage.getByRole('heading', { name: 'Recurring expenses', exact: true }).waitFor({ state: 'visible' })
    const recurringCard = recurringPage.locator('.recurring-card').filter({ hasText: 'Hosted utilities future plan' })
    await recurringCard.waitFor({ state: 'visible' })
    if (!(await recurringCard.textContent())?.includes('Stopped')) throw new Error('Hosted recurring-series screen did not retain the cancelled series state.')

    const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth)
    if (overflow > 1) throw new Error(`Hosted recurring-series screen overflowed the 390px mobile viewport by ${overflow}px.`)
    const verifiedInvitationUrl = await prepareInvitation(page, thirdEmail)
    const unverifiedInvitationUrl = await prepareInvitation(page, unverifiedEmail)
    assertOwnerPageClean()
    await context.close()

    await verifyInvitationAcceptance(browser, verifiedInvitationUrl)
    await verifyInvitationVerificationGate(browser, unverifiedInvitationUrl)
  } finally {
    await browser.close()
  }
}

async function verifySwipeBackGesture(context, page) {
  const cdp = await context.newCDPSession(page)
  try {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const group = page.locator('[data-testid="group-detail"]:not(.ion-page-hidden)')
      await group.getByRole('link', { name: 'Invite', exact: true }).click()
      await page.waitForURL(`${deepUrl}/invite`)
      await page.getByRole('heading', { name: 'Invite to Live Account Proof', exact: true }).waitFor({ state: 'visible' })

      const y = 422
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: 2, y, radiusX: 1, radiusY: 1, force: 1 }],
      })
      for (let step = 1; step <= 12; step += 1) {
        await cdp.send('Input.dispatchTouchEvent', {
          type: 'touchMove',
          touchPoints: [{ x: 2 + (step * 31), y, radiusX: 1, radiusY: 1, force: 1 }],
        })
        await page.waitForTimeout(16)
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })

      await page.waitForURL(deepUrl, { timeout: 10_000 })
      const restoredGroup = page.locator('[data-testid="group-detail"]:not(.ion-page-hidden)')
      await restoredGroup.getByRole('heading', { name: 'Live Account Proof', exact: true }).waitFor({ state: 'visible' })
      await restoredGroup.locator('[data-testid="expense-journal"]').waitFor({ state: 'visible' })
      try {
        await page.waitForFunction(() => {
          const groupPage = document.querySelector('[data-testid="group-detail"]:not(.ion-page-hidden)')
          if (!groupPage) return false
          return Array.from(groupPage.parentElement?.children ?? [])
            .filter((candidate) => candidate.classList.contains('ion-page') && !candidate.classList.contains('ion-page-hidden')).length === 1
        }, undefined, { polling: 50, timeout: 2_000 })
      } catch {
        throw new Error(`Hosted swipe-back attempt ${attempt} did not leave exactly one visible Ionic page.`)
      }
    }
  } finally {
    await cdp.detach()
  }
}

async function prepareInvitation(page, targetEmail) {
  await page.goto(`${deepUrl}/invite`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Invite to Live Account Proof', exact: true }).waitFor({ state: 'visible' })
  await page.locator('#invite-email').fill(targetEmail)
  await page.getByRole('button', { name: 'Prepare invitation', exact: true }).click()
  const invitation = page.locator('[aria-label="Prepared invitation URL"]')
  await invitation.waitFor({ state: 'visible' })
  const invitationUrl = await invitation.inputValue()
  if (!invitationUrl.startsWith(`${hostedOrigin}/invite/`) || !invitationUrl.includes('#token=')) {
    throw new Error(`Hosted invitation UI prepared an invalid link for ${targetEmail}.`)
  }
  return invitationUrl
}

async function verifyInvitationAcceptance(browser, invitationUrl) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, locale: 'en-US' })
  try {
    const page = await context.newPage()
    const assertPageClean = monitorBrowserErrors(page, 'verified invitation journey')
    const navigation = await page.goto(invitationUrl, { waitUntil: 'domcontentloaded' })
    if (!navigation?.ok()) throw new Error(`Hosted verified invitation navigation failed with ${navigation?.status() ?? 'no response'}.`)
    await page.getByRole('button', { name: 'Sign in to continue', exact: true }).click()
    await page.waitForURL(/\/auth(?:[?#].*)?$/)
    await signIn(page, thirdEmail)
    await page.waitForURL(/\/invite\/join(?:[?#].*)?$/)
    await page.getByText('You’re invited to join Live Account Proof.', { exact: true }).waitFor({ state: 'visible' })
    await page.getByRole('button', { name: 'Join group', exact: true }).click()
    await page.waitForURL(deepUrl)
    const group = page.locator('[data-testid="group-detail"]:not(.ion-page-hidden)')
    await group.getByRole('heading', { name: 'Live Account Proof', exact: true }).waitFor({ state: 'visible' })
    await group.locator('[data-testid="expense-journal"]').waitFor({ state: 'visible' })
    assertPageClean()
  } finally {
    await context.close()
  }
}

async function verifyInvitationVerificationGate(browser, invitationUrl) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, locale: 'en-US' })
  try {
    const page = await context.newPage()
    const assertPageClean = monitorBrowserErrors(page, 'unverified invitation journey')
    const navigation = await page.goto(invitationUrl, { waitUntil: 'domcontentloaded' })
    if (!navigation?.ok()) throw new Error(`Hosted unverified invitation navigation failed with ${navigation?.status() ?? 'no response'}.`)
    await page.getByRole('button', { name: 'Sign in to continue', exact: true }).click()
    await page.waitForURL(/\/auth(?:[?#].*)?$/)
    await signIn(page, unverifiedEmail)
    await page.waitForURL(/\/invite\/join(?:[?#].*)?$/)
    const recovery = page.locator('[data-testid="invitation-verification-required"]')
    await recovery.getByText('Email verification required', { exact: true }).waitFor({ state: 'visible' })
    await recovery.getByRole('button', { name: 'Resend verification email', exact: true }).waitFor({ state: 'visible' })
    await recovery.getByRole('button', { name: 'I’ve verified my email', exact: true }).waitFor({ state: 'visible' })
    if (!(await recovery.textContent())?.includes(unverifiedEmail)) throw new Error('Hosted verification recovery did not identify the invited account.')
    assertPageClean()
  } finally {
    await context.close()
  }
}

async function signIn(page, email) {
  try {
    await page.locator('#auth-email').waitFor({ state: 'visible' })
  } catch (cause) {
    const diagnostic = await page.evaluate(() => ({
      pathname: location.pathname,
      authInputCount: document.querySelectorAll('#auth-email').length,
      visiblePages: Array.from(document.querySelectorAll('.ion-page:not(.ion-page-hidden)')).map((pageElement) => ({
        className: pageElement.className,
        text: (pageElement.textContent ?? '').trim().slice(0, 160),
      })),
      hiddenPages: Array.from(document.querySelectorAll('.ion-page.ion-page-hidden')).map((pageElement) => ({
        className: pageElement.className,
        text: (pageElement.textContent ?? '').trim().slice(0, 160),
      })),
    }))
    throw new Error(`Hosted sign-in form did not become visible: ${JSON.stringify(diagnostic)}`, { cause })
  }
  await page.locator('#auth-email').fill(email)
  await page.locator('#auth-password').fill(password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
}

function monitorBrowserErrors(page, label) {
  let pageErrorCount = 0
  let consoleErrorCount = 0
  page.on('pageerror', () => { pageErrorCount += 1 })
  page.on('console', (message) => { if (message.type() === 'error') consoleErrorCount += 1 })
  return () => {
    if (pageErrorCount > 0 || consoleErrorCount > 0) throw new Error(`Hosted ${label} emitted ${pageErrorCount} page errors and ${consoleErrorCount} console errors.`)
  }
}

function requireResponse(response, label) {
  if (!response.ok) throw new Error(`Hosted ${label} request failed with ${response.status}.`)
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
