#!/usr/bin/env node

import { chromium } from 'playwright-core'

import { assertExpectedHostedCommit, collectHashedStartupAssets } from './hostedBundleContract.mjs'

const hostedOrigin = 'https://split-unwise-aditya.web.app'
const suffix = process.env.LIVE_PROOF_SUFFIX
const password = process.env.LIVE_PROOF_PASSWORD
const thirdUid = process.env.LIVE_PROOF_THIRD_UID
const expectedCommit = assertExpectedHostedCommit(process.env.EXPECTED_HOSTED_COMMIT)

if (!suffix || !/^[a-z0-9-]{10,80}$/.test(suffix)) throw new Error('Hosted browser proof requires a valid LIVE_PROOF_SUFFIX.')
if (!password || process.env.LIVE_PREVERIFIED_ACCOUNTS !== '1') throw new Error('Hosted browser proof requires preverified disposable accounts from runHostedProof.')
if (!thirdUid || !/^[A-Za-z0-9_-]{1,128}$/.test(thirdUid)) throw new Error('Hosted browser proof requires the exact disposable third-account UID.')

const ownerEmail = `live-owner-${suffix}@example.com`
const friendEmail = `live-friend-${suffix}@example.com`
const thirdEmail = `live-third-${suffix}@example.com`
const unverifiedEmail = `live-unverified-${suffix}@example.com`
const groupId = `grp-live-${suffix}`
const groupPath = `/tabs/groups/${groupId}`
const deepUrl = new URL(groupPath, hostedOrigin).href
const noStore = { cache: 'no-store', headers: { 'cache-control': 'no-cache' } }

await verifyDeployedBundle()
await verifyAuthenticatedMobileJourney()

process.stdout.write(`Hosted browser proof passed for deployed commit ${expectedCommit}; authenticated mobile group, Add Expense and reimbursement saves with reversed debt direction, reimbursement detail, applied currency conversion card modal, completed and cancelled touch swipe-back navigation across eager and lazy pages, recurrence, member-removal, delete, and restore card modals, shared group recovery, invitation acceptance, removed-member access revocation, and unverified-email recovery all completed.\n`)

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
    const restoredOfflineReadyDismiss = page.locator('.app-status').getByRole('button', { name: 'OK', exact: true })
    if (await restoredOfflineReadyDismiss.isVisible()) await restoredOfflineReadyDismiss.click()
    await verifyReimbursementWorkflow(page)
    await verifySwipeBackGesture(context, page)
    await verifyCurrencyConversion(page)
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
    await verifyMemberRemoval(browser)
    await verifyGroupLifecycle(browser)
    await verifyInvitationVerificationGate(browser, unverifiedInvitationUrl)
  } finally {
    await browser.close()
  }
}

async function verifyReimbursementWorkflow(page) {
  const group = page.locator('[data-testid="group-detail"]:not(.ion-page-hidden)')
  await group.getByRole('link', { name: 'Add expense', exact: true }).click()
  await page.waitForURL(new RegExp(`/tabs/groups/expenses/new\\?groupId=${escapeRegExp(groupId)}$`))

  const description = `Hosted reimbursement ${suffix}`
  await page.locator('#expense-description').fill(description)
  await page.locator('#expense-amount').fill('10.00')
  await page.locator('#expense-category').selectOption({ label: 'Other' })
  await page.locator('#split-sheet-trigger').click()

  const cardModal = page.locator('ion-modal.show-modal')
  await cardModal.waitFor({ state: 'visible' })
  await cardModal.getByRole('heading', { name: 'Split expense', exact: true }).waitFor({ state: 'visible' })
  if (!(await cardModal.evaluate((modal) => modal.classList.contains('modal-card')))) throw new Error('Hosted reimbursement editor did not use the Ionic iOS card modal.')
  await cardModal.locator('[data-method="reimbursement"]').click()
  await cardModal.getByLabel('Live Renamed Owner reimbursement', { exact: true }).fill('0.00')
  await cardModal.getByLabel('Live Proof Friend reimbursement', { exact: true }).fill('10.00')
  await cardModal.locator('[data-action="apply-split"]').click()
  await cardModal.waitFor({ state: 'hidden' })
  await page.getByText('Refund received by Live Renamed Owner', { exact: true }).waitFor({ state: 'visible' })
  await page.getByText('distributed as a reimbursement', { exact: true }).waitFor({ state: 'visible' })
  await dismissAppStatus(page)
  await page.locator('[data-action="save-expense"]').click()

  await page.waitForURL(deepUrl, { timeout: 120_000 })
  await page.reload({ waitUntil: 'domcontentloaded' })
  const restoredGroup = page.locator('[data-testid="group-detail"]:not(.ion-page-hidden)')
  await restoredGroup.getByRole('heading', { name: 'Live Account Proof', exact: true }).waitFor({ state: 'visible' })
  const reimbursementRow = restoredGroup.locator('.expense-row[data-sync-state="fresh"]', { hasText: description })
  await reimbursementRow.getByText(description, { exact: true }).waitFor({ state: 'visible' })
  await reimbursementRow.getByText('Refund received by Live Renamed Owner', { exact: true }).waitFor({ state: 'visible' })
  if (!(await reimbursementRow.textContent())?.includes('Reimbursed to 2 of you')) throw new Error('Hosted reimbursement row did not retain its allocation summary.')
  const reimbursementBalance = reimbursementRow.locator('.expense-row__amount--balance.money-amount--owing')
  await reimbursementBalance.getByText('you borrowed', { exact: true }).waitFor({ state: 'visible' })
  await reimbursementBalance.getByText('$10.00', { exact: true }).waitFor({ state: 'visible' })

  await reimbursementRow.locator('a.expense-row__body').click()
  await page.waitForURL(new RegExp(`/tabs/groups/expenses/[^/?]+\\?groupId=${escapeRegExp(groupId)}$`))
  const detail = page.locator('.expense-detail:not(.ion-page-hidden)')
  await detail.getByRole('heading', { name: description, exact: true }).waitFor({ state: 'visible' })
  const details = detail.locator('section[aria-labelledby="details-title"]')
  await details.getByText('Type', { exact: true }).waitFor({ state: 'visible' })
  await details.getByText('Reimbursement', { exact: true }).waitFor({ state: 'visible' })
  await detail.getByRole('heading', { name: 'Refund received by', exact: true }).waitFor({ state: 'visible' })
  await detail.getByRole('heading', { name: 'Reimbursement owed to', exact: true }).waitFor({ state: 'visible' })
  const accessibleTotal = (await detail.getByTestId('expense-total').locator('.money-amount__context').textContent())?.trim()
  if (accessibleTotal !== 'Reimbursement total $10.00') throw new Error(`Hosted reimbursement detail exposed an unexpected total label: ${accessibleTotal ?? 'missing'}.`)
  const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth)
  if (overflow > 1) throw new Error(`Hosted reimbursement detail overflowed the 390px mobile viewport by ${overflow}px.`)

  await page.goto(deepUrl, { waitUntil: 'domcontentloaded' })
  await page.locator('[data-testid="group-detail"]:not(.ion-page-hidden)').getByRole('heading', { name: 'Live Account Proof', exact: true }).waitFor({ state: 'visible' })
}

async function verifyCurrencyConversion(page) {
  const group = page.locator('[data-testid="group-detail"]:not(.ion-page-hidden)')
  await group.getByRole('button', { name: 'More', exact: true }).click()
  await group.getByRole('link', { name: 'Convert', exact: true }).click()
  await page.waitForURL(`${deepUrl}/convert`)
  await page.getByRole('heading', { name: 'Convert currencies', exact: true }).waitFor({ state: 'visible' })
  const conversion = page.locator('[data-testid="conversion-USD"]')
  await conversion.waitFor({ state: 'visible', timeout: 30_000 })
  await conversion.getByText('Reference in EUR', { exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
  const apply = page.locator('[data-testid="apply-conversion"]')
  await apply.waitFor({ state: 'visible' })
  if (await apply.isDisabled()) throw new Error('Hosted currency conversion did not load an applicable verified rate.')
  await apply.click()
  const cardModal = page.locator('ion-modal.show-modal')
  await cardModal.waitFor({ state: 'visible' })
  await cardModal.getByRole('heading', { name: 'Convert existing activity to EUR?', exact: true }).waitFor({ state: 'visible' })
  if (!(await cardModal.evaluate((modal) => modal.classList.contains('modal-card')))) throw new Error('Hosted currency conversion did not use the Ionic iOS card modal.')
  const confirm = cardModal.locator('[data-testid="confirm-conversion"]')
  await confirm.click()
  const applyFailure = cardModal.locator('[role="alert"]')
  try {
    const outcome = await Promise.race([
      cardModal.waitFor({ state: 'hidden', timeout: 120_000 }).then(() => 'closed'),
      applyFailure.waitFor({ state: 'visible', timeout: 120_000 }).then(() => 'failed'),
    ])
    if (outcome === 'failed') throw new Error(`Hosted currency conversion failed in the mobile UI: ${(await applyFailure.textContent())?.trim() || 'unknown error'}`)
  } catch (cause) {
    const diagnostic = await page.evaluate(() => ({
      operations: Object.entries(localStorage).flatMap(([key, value]) => {
        if (!key.startsWith('split-unwise:command-queue:')) return []
        try {
          const parsed = JSON.parse(value)
          if (!Array.isArray(parsed?.operations)) return []
          return parsed.operations
            .filter((operation) => operation?.envelope?.kind === 'group.currency-conversion')
            .map((operation) => ({
              kind: operation.envelope.kind,
              operationId: operation.envelope.operationId,
              status: operation.status,
              ...(operation.error ? { error: operation.error } : {}),
            }))
        } catch { return [] }
      }),
    }))
    throw new Error(`Hosted currency conversion did not close cleanly: ${JSON.stringify({
      ...diagnostic,
      buttonText: (await confirm.textContent())?.trim(),
      buttonDisabled: await confirm.isDisabled(),
    })}`, { cause })
  }
  await page.getByText('Existing group activity now uses EUR. New expenses keep the currency entered until you convert again.', { exact: true }).waitFor({ state: 'visible' })
  await page.getByLabel('Active conversion').getByText('EUR', { exact: true }).waitFor({ state: 'visible' })
  const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth)
  if (overflow > 1) throw new Error(`Hosted currency-conversion screen overflowed the 390px mobile viewport by ${overflow}px.`)
  await page.goto(deepUrl, { waitUntil: 'domcontentloaded' })
  await page.locator('[data-testid="group-detail"]:not(.ion-page-hidden)').getByRole('heading', { name: 'Live Account Proof', exact: true }).waitFor({ state: 'visible' })
}

async function verifySwipeBackGesture(context, page) {
  const cdp = await context.newCDPSession(page)
  try {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await dismissAppStatus(page)
      const group = page.locator('[data-testid="group-detail"]:not(.ion-page-hidden)')
      await group.getByRole('link', { name: 'Invite', exact: true }).click()
      await page.waitForURL(`${deepUrl}/invite`)
      const inviteHeading = page.getByRole('heading', { name: 'Invite to Live Account Proof', exact: true })
      await inviteHeading.waitFor({ state: 'visible' })
      await verifyCancelledSwipeBackGesture(cdp, page, inviteHeading, `${deepUrl}/invite`, `invite attempt ${attempt}`)
      await dispatchSwipeBack(cdp, page, Array.from({ length: 12 }, (_, index) => 2 + ((index + 1) * 31)), 16)

      await page.waitForURL(deepUrl, { timeout: 10_000 })
      const restoredGroup = page.locator('[data-testid="group-detail"]:not(.ion-page-hidden)')
      await restoredGroup.getByRole('heading', { name: 'Live Account Proof', exact: true }).waitFor({ state: 'visible' })
      await restoredGroup.locator('[data-testid="expense-journal"]').waitFor({ state: 'visible' })
      await requireSingleVisibleIonicPage(page, restoredGroup, `completed invite attempt ${attempt}`)
    }

    await dismissAppStatus(page)
    const group = page.locator('[data-testid="group-detail"]:not(.ion-page-hidden)')
    await group.getByRole('link', { name: 'Group settings', exact: true }).click()
    await page.waitForURL(`${deepUrl}/settings`)
    const settingsHeading = page.getByRole('heading', { name: 'Group settings', exact: true })
    await settingsHeading.waitFor({ state: 'visible' })
    await verifyCancelledSwipeBackGesture(cdp, page, settingsHeading, `${deepUrl}/settings`, 'lazy group settings')
    await dispatchSwipeBack(cdp, page, Array.from({ length: 12 }, (_, index) => 2 + ((index + 1) * 31)), 16)
    await page.waitForURL(deepUrl, { timeout: 10_000 })
    const restoredGroup = page.locator('[data-testid="group-detail"]:not(.ion-page-hidden)')
    await restoredGroup.getByRole('heading', { name: 'Live Account Proof', exact: true }).waitFor({ state: 'visible' })
    await requireSingleVisibleIonicPage(page, restoredGroup, 'completed lazy group settings swipe')
  } finally {
    await cdp.detach()
  }
}

async function verifyCancelledSwipeBackGesture(cdp, page, activeHeading, expectedUrl, label) {
  await dispatchSwipeBack(cdp, page, [18, 35, 55, 72, 88, 70, 50, 30], 28)
  if (page.url() !== expectedUrl) throw new Error(`Hosted cancelled ${label} swipe unexpectedly navigated to ${page.url()}.`)
  await activeHeading.waitFor({ state: 'visible' })
  const activePage = activeHeading.locator('xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " ion-page ")][1]')
  await requireSingleVisibleIonicPage(page, activePage, `cancelled ${label} swipe`)
}

async function dispatchSwipeBack(cdp, page, xPositions, delayMs) {
  const y = 422
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: 2, y, radiusX: 1, radiusY: 1, force: 1 }],
  })
  for (const x of xPositions) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x, y, radiusX: 1, radiusY: 1, force: 1 }],
    })
    await page.waitForTimeout(delayMs)
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

async function requireSingleVisibleIonicPage(page, activePage, label) {
  try {
    await activePage.waitFor({ state: 'visible' })
    await page.waitForFunction((pageElement) => {
      if (!(pageElement instanceof HTMLElement)) return false
      return Array.from(pageElement.parentElement?.children ?? [])
        .filter((candidate) => candidate.classList.contains('ion-page') && !candidate.classList.contains('ion-page-hidden')).length === 1
    }, await activePage.elementHandle(), { polling: 50, timeout: 2_000 })
  } catch {
    const visibleCount = await activePage.evaluate(visibleSiblingIonicPages).catch(() => 0)
    throw new Error(`Hosted ${label} left ${visibleCount} visible sibling Ionic pages.`)
  }
}

function visibleSiblingIonicPages(pageElement) {
  return Array.from(pageElement.parentElement?.children ?? [])
    .filter((candidate) => candidate.classList.contains('ion-page') && !candidate.classList.contains('ion-page-hidden')).length
}

async function dismissAppStatus(page) {
  for (const name of ['OK', 'Later']) {
    const button = page.locator('.app-status').getByRole('button', { name, exact: true })
    if (await button.isVisible()) await button.click()
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

async function verifyMemberRemoval(browser) {
  const ownerContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, locale: 'en-US' })
  try {
    const page = await ownerContext.newPage()
    const assertPageClean = monitorBrowserErrors(page, 'member removal owner journey')
    const navigation = await page.goto(hostedOrigin, { waitUntil: 'domcontentloaded' })
    if (!navigation?.ok()) throw new Error(`Hosted member-removal owner navigation failed with ${navigation?.status() ?? 'no response'}.`)
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/tabs\/home(?:[?#].*)?$/)
    await page.goto(`${deepUrl}/settings`, { waitUntil: 'domcontentloaded' })
    await page.getByRole('heading', { name: 'Group settings', exact: true }).waitFor({ state: 'visible' })
    await page.getByText('3 active people', { exact: true }).waitFor({ state: 'visible' })
    const targetRow = page.locator(`.manage-member-row[data-member-id="${thirdUid}"]`)
    await targetRow.waitFor({ state: 'visible' })
    const targetName = (await targetRow.locator('strong').textContent())?.trim()
    if (!targetName) throw new Error('Hosted member-removal target did not expose a display name.')
    const removalAction = targetRow.locator('ion-button')
    await removalAction.waitFor({ state: 'visible' })
    await removalAction.click()

    const cardModal = page.locator('ion-modal.show-modal')
    await cardModal.waitFor({ state: 'visible' })
    await cardModal.getByText('Remove member', { exact: true }).waitFor({ state: 'visible' })
    await cardModal.getByRole('heading', { name: `Remove ${targetName}?`, exact: true }).waitFor({ state: 'visible' })
    if (!(await cardModal.evaluate((modal) => modal.classList.contains('modal-card')))) throw new Error('Hosted member removal did not use the Ionic iOS card modal.')
    await cardModal.getByRole('button', { name: `Remove ${targetName}`, exact: true }).click()
    await cardModal.waitFor({ state: 'hidden' })
    await page.getByText(`${targetName} was removed from the group.`, { exact: true }).waitFor({ state: 'visible' })
    await page.getByText('2 active people', { exact: true }).waitFor({ state: 'visible' })
    if (await targetRow.count()) {
      throw new Error('Hosted member list still exposed the removed account.')
    }
    assertPageClean()
  } finally {
    await ownerContext.close()
  }

  const removedContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, locale: 'en-US' })
  try {
    const page = await removedContext.newPage()
    const assertPageClean = monitorBrowserErrors(page, 'removed member journey')
    const navigation = await page.goto(hostedOrigin, { waitUntil: 'domcontentloaded' })
    if (!navigation?.ok()) throw new Error(`Hosted removed-member navigation failed with ${navigation?.status() ?? 'no response'}.`)
    await signIn(page, thirdEmail)
    await page.waitForURL(/\/tabs\/home(?:[?#].*)?$/)
    await page.getByRole('heading', { name: 'Home', exact: true }).waitFor({ state: 'visible' })
    if (await page.getByRole('link', { name: /Live Account Proof/ }).count()) throw new Error('Removed account still listed the group on Home.')
    await page.goto(deepUrl, { waitUntil: 'domcontentloaded' })
    const unavailable = page.locator('[data-testid="group-detail"]:not(.ion-page-hidden) [role="alert"]')
    await unavailable.waitFor({ state: 'visible' })
    if (!/not available/i.test((await unavailable.textContent()) ?? '')) throw new Error('Removed account deep link did not show an unavailable-group state.')
    assertPageClean()
  } finally {
    await removedContext.close()
  }
}

async function verifyGroupLifecycle(browser) {
  const ownerContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, locale: 'en-US' })
  const friendContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, locale: 'en-US' })
  try {
    const ownerPage = await ownerContext.newPage()
    const friendPage = await friendContext.newPage()
    const assertOwnerPageClean = monitorBrowserErrors(ownerPage, 'group lifecycle owner journey')
    const assertFriendPageClean = monitorBrowserErrors(friendPage, 'group lifecycle friend journey')

    const ownerNavigation = await ownerPage.goto(hostedOrigin, { waitUntil: 'domcontentloaded' })
    if (!ownerNavigation?.ok()) throw new Error(`Hosted lifecycle owner navigation failed with ${ownerNavigation?.status() ?? 'no response'}.`)
    await signIn(ownerPage, ownerEmail)
    await ownerPage.waitForURL(/\/tabs\/home(?:[?#].*)?$/)
    await ownerPage.goto(`${deepUrl}/settings`, { waitUntil: 'domcontentloaded' })
    await ownerPage.getByRole('heading', { name: 'Group settings', exact: true }).waitFor({ state: 'visible' })
    const deleteButton = ownerPage.getByTestId('delete-group-button')
    await deleteButton.scrollIntoViewIfNeeded()
    await deleteButton.click()
    let cardModal = ownerPage.locator('ion-modal.show-modal')
    await cardModal.waitFor({ state: 'visible' })
    await cardModal.getByRole('heading', { name: 'Delete Live Account Proof?', exact: true }).waitFor({ state: 'visible' })
    if (!(await cardModal.evaluate((modal) => modal.classList.contains('modal-card')))) throw new Error('Hosted group deletion did not use the Ionic iOS card modal.')
    await cardModal.getByRole('button', { name: 'Cancel', exact: true }).click()
    await cardModal.waitFor({ state: 'hidden' })

    await deleteButton.click()
    cardModal = ownerPage.locator('ion-modal.show-modal')
    await cardModal.waitFor({ state: 'visible' })
    await cardModal.getByRole('button', { name: 'Delete group for everyone', exact: true }).click()
    await ownerPage.waitForURL(/\/tabs\/groups(?:[?#].*)?$/, { timeout: 120_000 })
    await ownerPage.getByRole('heading', { name: 'Groups', exact: true }).waitFor({ state: 'visible' })
    if (await ownerPage.getByRole('link', { name: /Live Account Proof/ }).count()) throw new Error('Deleted group still appeared for its owner.')

    const friendNavigation = await friendPage.goto(hostedOrigin, { waitUntil: 'domcontentloaded' })
    if (!friendNavigation?.ok()) throw new Error(`Hosted lifecycle friend navigation failed with ${friendNavigation?.status() ?? 'no response'}.`)
    await signIn(friendPage, friendEmail)
    await friendPage.waitForURL(/\/tabs\/home(?:[?#].*)?$/)
    await friendPage.getByRole('heading', { name: 'Home', exact: true }).waitFor({ state: 'visible' })
    if (await friendPage.getByRole('link', { name: /Live Account Proof/ }).count()) throw new Error('Deleted group still appeared for another member.')
    await friendPage.goto(deepUrl, { waitUntil: 'domcontentloaded' })
    const unavailable = friendPage.locator('[data-testid="group-detail"]:not(.ion-page-hidden) [role="alert"]')
    await unavailable.waitFor({ state: 'visible' })
    if (!/not available/i.test((await unavailable.textContent()) ?? '')) throw new Error('Deleted group deep link did not show an unavailable state.')

    await ownerPage.goto(`${hostedOrigin}/tabs/activity`, { waitUntil: 'domcontentloaded' })
    await ownerPage.getByRole('heading', { name: 'Activity', exact: true }).waitFor({ state: 'visible' })
    const deletedRow = ownerPage.locator('[data-activity-id]', { hasText: 'deleted Live Account Proof' }).first()
    await deletedRow.waitFor({ state: 'visible' })
    await deletedRow.locator('[data-action="restore-group"]').click()
    cardModal = ownerPage.locator('ion-modal.show-modal')
    await cardModal.waitFor({ state: 'visible' })
    await cardModal.getByRole('heading', { name: 'Restore Live Account Proof?', exact: true }).waitFor({ state: 'visible' })
    if (!(await cardModal.evaluate((modal) => modal.classList.contains('modal-card')))) throw new Error('Hosted group restore did not use the Ionic iOS card modal.')
    await cardModal.getByRole('button', { name: 'Restore group', exact: true }).click()
    await cardModal.waitFor({ state: 'hidden' })
    await ownerPage.getByText('Live Account Proof was restored for everyone.', { exact: true }).waitFor({ state: 'visible' })
    await ownerPage.getByText('Live Renamed Owner restored Live Account Proof', { exact: true }).waitFor({ state: 'visible' })

    await ownerPage.goto(deepUrl, { waitUntil: 'domcontentloaded' })
    const restoredOwnerGroup = ownerPage.locator('[data-testid="group-detail"]:not(.ion-page-hidden)')
    await restoredOwnerGroup.getByRole('heading', { name: 'Live Account Proof', exact: true }).waitFor({ state: 'visible' })
    await restoredOwnerGroup.locator('[data-testid="expense-journal"]').waitFor({ state: 'visible' })
    await friendPage.reload({ waitUntil: 'domcontentloaded' })
    const restoredFriendGroup = friendPage.locator('[data-testid="group-detail"]:not(.ion-page-hidden)')
    await restoredFriendGroup.getByRole('heading', { name: 'Live Account Proof', exact: true }).waitFor({ state: 'visible' })
    await restoredFriendGroup.locator('[data-testid="expense-journal"]').waitFor({ state: 'visible' })

    assertOwnerPageClean()
    assertFriendPageClean()
  } finally {
    await Promise.all([ownerContext.close(), friendContext.close()])
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
