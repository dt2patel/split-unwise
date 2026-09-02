#!/usr/bin/env node

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
const deletionEmail = `live-delete-${suffix}@example.com`
const groupId = `grp-live-${suffix}`
const friendshipGroupId = `grp-live-friendship-${suffix}`
const groupPath = `/tabs/groups/${groupId}`
const deepUrl = new URL(groupPath, hostedOrigin).href
const friendshipDeepUrl = new URL(`/tabs/groups/${friendshipGroupId}`, hostedOrigin).href
const noStore = { cache: 'no-store', headers: { 'cache-control': 'no-cache' } }

await verifyDeployedBundle()
await verifyAuthenticatedMobileJourney()

process.stdout.write(`Hosted browser proof passed for deployed commit ${expectedCommit}; account-wide Home totals and cross-group friend breakdowns, persisted eight-locale language selection, opt-in payment-handle persistence and real PayPal/Venmo handoffs, native group-creation card modal with built-in covers, authenticated mobile group, on-device receipt scanning and itemization in Add Expense, atomic cross-group expense move, reimbursement saves with reversed debt direction, deleted-expense restoration with preserved history, reimbursement detail, applied currency conversion card modal, completed and cancelled touch swipe-back navigation across eager and lazy pages, recurrence, member-removal, delete, and restore card modals, shared group recovery, invitation acceptance, removed-member access revocation, unverified-email recovery, and permanent account deletion all completed.\n`)

async function verifyDeployedBundle() {
  const [buildResponse, rootResponse, deepResponse] = await Promise.all([
    fetch(new URL('/build-info.json', hostedOrigin), noStore),
    fetch(new URL('/', hostedOrigin), noStore),
    fetch(deepUrl, noStore),
  ])
  requireResponse(buildResponse, 'build metadata')
  requireResponse(rootResponse, 'root shell')
  requireResponse(deepResponse, 'deep-route shell')

  const contentSecurityPolicy = rootResponse.headers.get('content-security-policy') ?? ''
  if (!contentSecurityPolicy.includes("script-src 'self' 'wasm-unsafe-eval'")) throw new Error('Hosted CSP does not allow the self-hosted WebAssembly receipt scanner.')
  if (/(?:^|\s)'unsafe-eval'(?:;|\s|$)/.test(contentSecurityPolicy)) throw new Error('Hosted CSP grants unrestricted script evaluation instead of the narrow WebAssembly permission.')

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

  for (const [pathname, expectedType] of [
    ['/ocr/worker.min.js', 'javascript'],
    ['/ocr/lang/eng.traineddata.gz', 'application/gzip'],
    ['/ocr/core/tesseract-core-simd-lstm.wasm', 'application/wasm'],
  ]) {
    const response = await fetch(new URL(pathname, hostedOrigin), noStore)
    requireResponse(response, pathname)
    if (!response.headers.get('content-type')?.includes(expectedType)) throw new Error(`Hosted OCR asset returned the wrong content type: ${pathname}`)
    if ((await response.arrayBuffer()).byteLength === 0) throw new Error(`Hosted OCR asset was empty: ${pathname}`)
  }
}

async function verifyAuthenticatedMobileJourney() {
  const launchOptions = process.env.LIVE_PROOF_BROWSER_EXECUTABLE
    ? { executablePath: process.env.LIVE_PROOF_BROWSER_EXECUTABLE, headless: true }
    : { channel: process.env.LIVE_PROOF_BROWSER_CHANNEL ?? 'chrome', headless: true }
  const browser = await chromium.launch(launchOptions)
  const receiptFixtureDirectory = await mkdtemp(join(tmpdir(), 'split-unwise-hosted-receipt-'))
  const receiptFixturePath = join(receiptFixtureDirectory, 'receipt.png')
  try {
    await createReceiptFixture(browser, receiptFixturePath)
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, locale: 'en-US' })
    const page = await context.newPage()
    const assertOwnerPageClean = monitorBrowserErrors(page, 'owner journey')

    const navigation = await page.goto(hostedOrigin, { waitUntil: 'domcontentloaded' })
    if (!navigation?.ok()) throw new Error(`Hosted browser root navigation failed with ${navigation?.status() ?? 'no response'}.`)
    await page.locator('#auth-email').waitFor({ state: 'visible' })
    await signIn(page, ownerEmail)
    await page.waitForURL(/\/tabs\/home(?:[?#].*)?$/)
    await page.getByRole('heading', { name: 'Home', exact: true }).waitFor({ state: 'visible' })
    await verifyAccountBalanceDashboard(page)
    await verifyPaymentHandleProfile(page)
    await verifyLanguagePreference(page)
    await verifyCreateGroupCardModal(page)

    const groupLink = page.getByRole('link', { name: /Live Account Proof/ }).first()
    await groupLink.waitFor({ state: 'visible' })
    const groupCover = groupLink.locator('img')
    await groupCover.waitFor({ state: 'visible' })
    if (await groupCover.getAttribute('src') !== '/covers/group-trip.jpg'
      || !(await groupCover.evaluate((element) => element.complete && element.naturalWidth > 0))) {
      throw new Error('Hosted group list did not render the persisted built-in cover.')
    }
    await groupLink.click()
    await page.waitForURL(deepUrl)
    const activeGroup = page.locator('[data-testid="group-detail"]:not(.ion-page-hidden)')
    await activeGroup.getByRole('heading', { name: 'Live Account Proof', exact: true }).waitFor({ state: 'visible' })
    await activeGroup.locator('[data-testid="expense-journal"]').waitFor({ state: 'visible' })
    await verifyPaymentProviderHandoffs(page)

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
    await verifyOnDeviceReceiptScan(page, receiptFixturePath)
    const browserExpenseDescription = `Hosted browser transport ${suffix}`
    await page.locator('#expense-description').fill(browserExpenseDescription)
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
    await verifyExpenseMove(page, persistedExpense, browserExpenseDescription)
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
    await verifyAccountDeletion(browser)
  } finally {
    await browser.close()
    await rm(receiptFixtureDirectory, { recursive: true, force: true })
  }
}

async function verifyPaymentHandleProfile(page) {
  await page.goto(new URL('/tabs/account', hostedOrigin).href, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Account', exact: true }).waitFor({ state: 'visible' })
  const paypal = page.getByTestId('paypal-handle')
  const venmo = page.getByTestId('venmo-handle')
  await paypal.waitFor({ state: 'visible' })
  await page.waitForFunction(() => {
    const name = document.querySelector('#account-name')
    const save = document.querySelector('[data-action="save-profile"]')
    return name instanceof HTMLInputElement && name.value.length > 0
      && save instanceof HTMLButtonElement && !save.disabled
  }, undefined, { timeout: 120_000 })
  await paypal.fill('@hosted.owner.paypal')
  await venmo.fill('@hosted-owner-venmo')
  await page.locator('[data-action="save-profile"]').click()
  await page.getByText('Profile saved.', { exact: true }).waitFor({ state: 'visible', timeout: 120_000 })

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Account', exact: true }).waitFor({ state: 'visible' })
  await page.getByTestId('paypal-handle').waitFor({ state: 'visible' })
  await page.waitForFunction(() => {
    const paypal = document.querySelector('[data-testid="paypal-handle"]')
    const venmo = document.querySelector('[data-testid="venmo-handle"]')
    return paypal instanceof HTMLInputElement && paypal.value === 'hosted.owner.paypal'
      && venmo instanceof HTMLInputElement && venmo.value === 'hosted-owner-venmo'
  }, undefined, { timeout: 120_000 })
  const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth)
  if (overflow > 1) throw new Error(`Hosted Account payment handles overflowed the 390px mobile viewport by ${overflow}px.`)

  await page.goto(new URL('/tabs/home', hostedOrigin).href, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Home', exact: true }).waitFor({ state: 'visible' })
}

async function verifyLanguagePreference(page) {
  const languageUrl = new URL('/tabs/account/language', hostedOrigin).href
  await page.goto(languageUrl, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'App language', exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
  if (await page.locator('[data-locale]').count() !== 9) throw new Error('Hosted language settings did not expose system plus eight supported locales.')

  for (const locale of ['de', 'nl', 'fr', 'it', 'pt-BR', 'pt-PT', 'es']) {
    await page.locator(`[data-locale="${locale}"] ion-radio`).click()
    await page.waitForFunction((expected) => document.documentElement.lang === expected, locale)
    const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth)
    if (overflow > 1) throw new Error(`Hosted ${locale} language settings overflowed the 390px mobile viewport by ${overflow}px.`)
  }
  await page.getByRole('heading', { name: 'Idioma de la app', exact: true }).waitFor({ state: 'visible' })
  if (await page.locator('html').getAttribute('lang') !== 'es') throw new Error('Hosted Spanish preference did not update the document language.')
  await page.goto(new URL('/tabs/home', hostedOrigin).href, { waitUntil: 'domcontentloaded' })
  await page.locator('ion-tab-button[tab="home"]').getByText('Inicio', { exact: true }).waitFor({ state: 'visible' })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator('ion-tab-button[tab="account"]').getByText('Cuenta', { exact: true }).waitFor({ state: 'visible' })

  await page.goto(languageUrl, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Idioma de la app', exact: true }).waitFor({ state: 'visible' })
  await page.locator('[data-locale="en"] ion-radio').click()
  await page.getByRole('heading', { name: 'App language', exact: true }).waitFor({ state: 'visible' })
  if (await page.locator('html').getAttribute('lang') !== 'en') throw new Error('Hosted language settings did not restore English for the remaining proof.')
  await page.goto(new URL('/tabs/home', hostedOrigin).href, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Home', exact: true }).waitFor({ state: 'visible' })
}

async function verifyPaymentProviderHandoffs(page) {
  await page.goto(new URL(`/tabs/groups/${groupId}/settle-up`, hostedOrigin).href, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Settle up', exact: true }).waitFor({ state: 'visible' })
  const direction = page.getByTestId('selected-direction')
  await direction.waitFor({ state: 'visible', timeout: 120_000 })
  if ((await direction.textContent())?.trim() !== 'Live Renamed Owner pays Live Proof Friend') {
    throw new Error(`Hosted payment handoff selected an unexpected direction: ${(await direction.textContent())?.trim() ?? 'missing'}`)
  }
  const paypal = page.getByRole('link', { name: 'Open PayPal', exact: true })
  const venmo = page.getByRole('link', { name: 'Open Venmo', exact: true })
  await paypal.waitFor({ state: 'visible' })
  await venmo.waitFor({ state: 'visible' })

  const paypalUrl = new URL((await paypal.getAttribute('href')) ?? '')
  const venmoUrl = new URL((await venmo.getAttribute('href')) ?? '')
  if (paypalUrl.origin !== 'https://www.paypal.com' || !paypalUrl.pathname.startsWith('/paypalme/live.friend.paypal/')) {
    throw new Error(`Hosted PayPal handoff targeted an unexpected recipient: ${paypalUrl.href}`)
  }
  if (venmoUrl.origin !== 'https://account.venmo.com' || venmoUrl.searchParams.get('recipients') !== 'live-friend-venmo'
    || venmoUrl.searchParams.get('txn') !== 'pay') {
    throw new Error(`Hosted Venmo handoff targeted an unexpected recipient: ${venmoUrl.href}`)
  }
  for (const link of [paypal, venmo]) {
    if (await link.getAttribute('target') !== '_blank' || !(await link.getAttribute('rel'))?.includes('noopener')) {
      throw new Error('Hosted payment-provider handoff did not preserve external-link isolation.')
    }
  }
  if (await page.getByTestId('outside-payment-confirmation').isChecked()) throw new Error('Hosted payment handoff pre-confirmed an outside payment.')
  const recordPaymentDisabled = await page.locator('[data-action="record-payment"]').evaluate((element) => ({
    host: 'disabled' in element && element.disabled === true && element.hasAttribute('disabled'),
    accessibility: element.getAttribute('aria-disabled') === 'true',
    native: element.shadowRoot?.querySelector('button')?.disabled === true,
  }))
  if (!Object.values(recordPaymentDisabled).every(Boolean)) {
    throw new Error(`Hosted payment handoff enabled ledger recording without confirmation: ${JSON.stringify(recordPaymentDisabled)}`)
  }
  if (await page.locator('[data-operation-id]').count()) throw new Error('Hosted payment handoff created a ledger operation without confirmation.')
  const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth)
  if (overflow > 1) throw new Error(`Hosted payment handoff overflowed the 390px mobile viewport by ${overflow}px.`)

  await page.goto(deepUrl, { waitUntil: 'domcontentloaded' })
  const activeGroup = page.locator('[data-testid="group-detail"]:not(.ion-page-hidden)')
  await activeGroup.getByRole('heading', { name: 'Live Account Proof', exact: true }).waitFor({ state: 'visible' })
  await activeGroup.locator('[data-testid="expense-journal"]').waitFor({ state: 'visible' })
}

async function createReceiptFixture(browser, receiptFixturePath) {
  const context = await browser.newContext({ viewport: { width: 760, height: 980 }, deviceScaleFactor: 1 })
  try {
    const page = await context.newPage()
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>
      body{margin:0;background:white;color:black;font-family:Arial,sans-serif}
      .receipt{box-sizing:border-box;width:760px;min-height:980px;padding:70px 60px}
      .brand{font-size:50px;font-weight:800;text-align:center;margin-bottom:70px}
      .row{display:flex;justify-content:space-between;font-size:38px;line-height:1.8;border-bottom:1px solid #ddd}
      .total{margin-top:40px;border-top:5px solid black;border-bottom:0;font-weight:800}
    </style><div class="receipt"><div class="brand">LAKE HOUSE MARKET</div>
      <div class="row"><span>Groceries</span><span>42.00</span></div>
      <div class="row"><span>Ice</span><span>8.00</span></div>
      <div class="row"><span>Snacks</span><span>15.00</span></div>
      <div class="row"><span>Tax</span><span>5.00</span></div>
      <div class="row total"><span>TOTAL</span><span>70.00</span></div>
    </div>`)
    await page.screenshot({ path: receiptFixturePath, fullPage: true })
  } finally {
    await context.close()
  }
}

async function verifyOnDeviceReceiptScan(page, receiptFixturePath) {
  const input = page.locator('#expense-receipt-input')
  if (await input.getAttribute('capture') !== 'environment') throw new Error('Hosted receipt input did not prefer the rear mobile camera.')
  await input.setInputFiles(receiptFixturePath)

  const modal = page.locator('ion-modal.show-modal')
  await modal.waitFor({ state: 'visible' })
  await modal.getByRole('heading', { name: 'Receipt review', exact: true }).waitFor({ state: 'visible' })
  if (!(await modal.evaluate((element) => element.classList.contains('modal-card')))) throw new Error('Hosted receipt review did not use the Ionic iOS card modal.')
  const progress = modal.getByTestId('receipt-scan-progress')
  await progress.getByText('Scanning on this device', { exact: true }).waitFor({ state: 'visible' })
  const confirm = modal.getByRole('button', { name: 'Confirm', exact: true })
  if (!(await confirm.isDisabled())) throw new Error('Hosted receipt review allowed confirmation before recognition completed.')

  await modal.getByText('Scanned on this device. Review each item and assignment before confirming.', { exact: true }).waitFor({ state: 'visible', timeout: 120_000 })
  const descriptions = await modal.locator('[data-item-description]').evaluateAll((elements) => elements.map((element) => element.value))
  const amounts = await modal.locator('[data-item-amount]').evaluateAll((elements) => elements.map((element) => element.value))
  if (JSON.stringify(descriptions) !== JSON.stringify(['Groceries', 'Ice', 'Snacks', 'Tax'])
    || JSON.stringify(amounts) !== JSON.stringify(['42.00', '8.00', '15.00', '5.00'])) {
    throw new Error(`Hosted receipt scanner returned unexpected editable rows: ${JSON.stringify({ descriptions, amounts })}`)
  }
  if (await page.locator('#expense-amount').inputValue() !== '70.00') throw new Error('Hosted receipt scanner did not seed the recognized total.')
  if (await confirm.isDisabled()) throw new Error('Hosted receipt review did not enable confirmation after recognition.')
  await confirm.click()
  await modal.waitFor({ state: 'hidden' })
  await page.getByRole('button', { name: 'split by receipt items', exact: true }).waitFor({ state: 'visible' })
}

async function verifyCreateGroupCardModal(page) {
  await page.goto(new URL('/tabs/groups', hostedOrigin).href, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Groups', exact: true }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: 'Create group', exact: true }).click()
  const modal = page.locator('ion-modal.show-modal')
  await modal.waitFor({ state: 'visible' })
  await modal.getByRole('heading', { name: 'Create a group', exact: true }).waitFor({ state: 'visible' })
  if (!(await modal.evaluate((element) => element.classList.contains('modal-card')))) throw new Error('Hosted group creator did not use the Ionic iOS card modal.')

  const coverGroup = modal.getByRole('group', { name: 'Group cover' })
  const expected = [
    ['Trip Travel and weekends', '/covers/group-trip.jpg'],
    ['Home Rent and household bills', '/covers/group-home.jpg'],
    ['Couple Everyday shared costs', '/covers/group-couple.jpg'],
    ['Other Friends, events, and more', '/covers/group-other.jpg'],
  ]
  for (const [name, source] of expected) {
    const choice = coverGroup.getByRole('button', { name, exact: true })
    await choice.waitFor({ state: 'visible' })
    const image = choice.locator('img')
    await image.waitFor({ state: 'visible' })
    const rendered = await image.evaluate(async (element) => {
      try { await element.decode() } catch { return false }
      return element.complete && element.naturalWidth > 0
    })
    if (await image.getAttribute('src') !== source || !rendered) {
      throw new Error(`Hosted group creator did not render ${source}.`)
    }
  }
  const trip = coverGroup.getByRole('button', { name: expected[0][0], exact: true })
  const home = coverGroup.getByRole('button', { name: expected[1][0], exact: true })
  if (await trip.getAttribute('aria-pressed') !== 'true') throw new Error('Hosted group creator did not select the Trip cover by default.')
  await home.click()
  if (await home.getAttribute('aria-pressed') !== 'true') throw new Error('Hosted group creator did not retain the selected cover.')

  const overflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth)
  if (overflow > 1) throw new Error(`Hosted group creator overflowed the 390px mobile viewport by ${overflow}px.`)
  await modal.getByLabel('Group name').fill(`Hosted card group ${suffix}`)
  await modal.getByRole('button', { name: 'Create', exact: true }).click()
  await page.waitForURL(new RegExp(`${escapeRegExp(hostedOrigin)}/tabs/groups/(grp-group-[A-Za-z0-9-]+)$`), { timeout: 120_000 })
  const createdGroupId = new URL(page.url()).pathname.split('/').at(-1)
  if (!createdGroupId || !/^grp-group-[A-Za-z0-9-]+$/.test(createdGroupId)) throw new Error('Hosted group creator returned an invalid group route.')
  console.log('LIVE_PROOF_RESOURCE', JSON.stringify({ browserGroupId: createdGroupId }))
  await modal.waitFor({ state: 'hidden' })
  const savedCover = page.getByTestId('group-cover')
  await savedCover.waitFor({ state: 'visible' })
  if (await savedCover.getAttribute('src') !== '/covers/group-home.jpg'
    || !(await savedCover.evaluate((element) => element.complete && element.naturalWidth > 0))) {
    throw new Error('Hosted group creator did not persist the selected cover through the real UI save.')
  }
  await page.goto(new URL('/tabs/groups', hostedOrigin).href, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Groups', exact: true }).waitFor({ state: 'visible' })
  return createdGroupId
}

async function verifyAccountBalanceDashboard(page) {
  const summary = page.getByTestId('account-summary').filter({ hasText: 'You are owed' })
  await summary.waitFor({ state: 'visible', timeout: 120_000 })
  const summaryText = (await summary.textContent()) ?? ''
  for (const label of ['Overall,', 'You owe', 'You are owed']) {
    if (!summaryText.includes(label)) throw new Error(`Hosted account balance summary did not include ${label}.`)
  }
  const homeOverflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth)
  if (homeOverflow > 1) throw new Error(`Hosted Home balance dashboard overflowed the 390px mobile viewport by ${homeOverflow}px.`)
  const homeFriend = page.locator('[data-testid^="friend-balance-"]').filter({ hasText: 'Live Proof Friend' }).first()
  await homeFriend.getByText('2 shared contexts', { exact: true }).waitFor({ state: 'visible', timeout: 120_000 })

  await page.getByTestId('friends-link').click()
  await page.waitForURL(new RegExp(`${escapeRegExp(hostedOrigin)}/tabs/home/friends(?:[?#].*)?$`))
  await page.getByRole('heading', { name: 'Friends', exact: true }).waitFor({ state: 'visible' })
  const friendEntry = page.locator('.friend-entry').filter({ hasText: 'Live Proof Friend' }).first()
  await friendEntry.waitFor({ state: 'visible', timeout: 120_000 })
  await friendEntry.getByRole('button', { name: /Live Proof Friend/ }).click()
  const breakdown = friendEntry.locator('.friend-breakdown')
  await breakdown.waitFor({ state: 'visible' })
  const breakdownText = (await breakdown.textContent()) ?? ''
  if (!breakdownText.includes('Live Account Proof') || !breakdownText.includes('Live Proof Friend')) {
    throw new Error(`Hosted friend balance did not include both shared-group and direct-expense breakdowns: ${breakdownText.trim()}`)
  }
  if (await breakdown.locator('.friend-breakdown__link').count() < 2) throw new Error('Hosted friend balance did not expose both account contexts.')
  const friendsOverflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth)
  if (friendsOverflow > 1) throw new Error(`Hosted Friends balance breakdown overflowed the 390px mobile viewport by ${friendsOverflow}px.`)

  await page.goto(new URL('/tabs/home', hostedOrigin).href, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Home', exact: true }).waitFor({ state: 'visible' })
}

async function verifyExpenseMove(page, sourceRow, description) {
  await sourceRow.locator('a.expense-row__body').click()
  await page.waitForURL(new RegExp(`/tabs/groups/expenses/[^/?]+\\?groupId=${escapeRegExp(groupId)}$`))
  const detail = page.locator('.expense-detail:not(.ion-page-hidden)')
  await detail.getByRole('heading', { name: description, exact: true }).waitFor({ state: 'visible' })
  await detail.locator('[data-action="edit-expense"]').click()
  await page.waitForURL(new RegExp(`/tabs/groups/expenses/[^/?]+/edit\\?groupId=${escapeRegExp(groupId)}$`))
  await page.getByRole('heading', { name: 'Edit expense', exact: true }).waitFor({ state: 'visible' })
  await page.locator('#context-sheet-trigger').click()

  const cardModal = page.locator('ion-modal.show-modal')
  await cardModal.waitFor({ state: 'visible' })
  await cardModal.getByRole('heading', { name: 'Group or friend', exact: true }).waitFor({ state: 'visible' })
  if (!(await cardModal.evaluate((modal) => modal.classList.contains('modal-card')))) throw new Error('Hosted expense context picker did not use the Ionic iOS card modal.')
  await cardModal.locator(`[data-context-id="${friendshipGroupId}"]`).check()
  await cardModal.locator('[data-action="apply-context"]').click()
  await cardModal.waitFor({ state: 'hidden' })
  await page.getByTestId('expense-context').getByText('Live Proof Friend', { exact: true }).waitFor({ state: 'visible' })
  await dismissAppStatus(page)
  await page.locator('[data-action="save-expense"]').click()
  await page.waitForURL((url) => url.href === friendshipDeepUrl || (url.pathname.includes('/tabs/groups/expenses/') && url.searchParams.get('groupId') === friendshipGroupId), { timeout: 120_000 })

  await page.goto(friendshipDeepUrl, { waitUntil: 'domcontentloaded' })
  const targetGroup = page.locator('[data-testid="group-detail"]:not(.ion-page-hidden)')
  await targetGroup.getByRole('heading', { name: 'Live Proof Friend', exact: true }).waitFor({ state: 'visible' })
  const movedRow = targetGroup.locator('.expense-row[data-sync-state="fresh"]', { hasText: description })
  await movedRow.getByText(description, { exact: true }).waitFor({ state: 'visible', timeout: 120_000 })
  const targetOverflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth)
  if (targetOverflow > 1) throw new Error(`Hosted moved-expense target group overflowed the 390px mobile viewport by ${targetOverflow}px.`)

  await page.goto(deepUrl, { waitUntil: 'domcontentloaded' })
  const sourceGroup = page.locator('[data-testid="group-detail"]:not(.ion-page-hidden)')
  await sourceGroup.getByRole('heading', { name: 'Live Account Proof', exact: true }).waitFor({ state: 'visible' })
  await sourceGroup.locator('[data-testid="expense-journal"]').waitFor({ state: 'visible' })
  if (await sourceGroup.locator('.expense-row', { hasText: description }).count()) throw new Error('Hosted moved expense remained visible in its source group.')
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
  await verifySplitMethodDiscoverability(cardModal)
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

  await detail.locator('[data-action="delete-expense"]').click()
  const deleteAlert = page.locator('ion-alert').filter({ hasText: `Delete ${description}?` })
  await deleteAlert.waitFor({ state: 'visible' })
  await deleteAlert.getByRole('button', { name: 'Delete', exact: true }).click()
  await detail.getByTestId('deleted-state').waitFor({ state: 'visible', timeout: 120_000 })
  await detail.getByTestId('delete-state').getByText('Deleted.', { exact: true }).waitFor({ state: 'visible' })

  await page.goto(new URL('/tabs/activity', hostedOrigin).href, { waitUntil: 'domcontentloaded' })
  await page.getByRole('heading', { name: 'Activity', exact: true }).waitFor({ state: 'visible' })
  const deletedExpenseRow = page.locator('[data-activity-id]', { hasText: `deleted ${description}` }).first()
  await deletedExpenseRow.waitFor({ state: 'visible', timeout: 120_000 })
  await deletedExpenseRow.locator('[data-action="restore-expense"]').click()
  const restoreModal = page.locator('ion-modal.show-modal')
  await restoreModal.waitFor({ state: 'visible' })
  await restoreModal.getByRole('heading', { name: `Restore ${description}?`, exact: true }).waitFor({ state: 'visible' })
  if (!(await restoreModal.evaluate((modal) => modal.classList.contains('modal-card') && Boolean(modal.presentingElement)))) {
    throw new Error('Hosted expense restoration did not use an Ionic presenting-element iOS card modal.')
  }
  const restoreOverflow = await page.evaluate(() => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth)
  if (restoreOverflow > 1) throw new Error(`Hosted expense restore card overflowed the 390px mobile viewport by ${restoreOverflow}px.`)
  await restoreModal.getByRole('button', { name: 'Restore expense', exact: true }).click()
  await restoreModal.waitFor({ state: 'hidden', timeout: 120_000 })
  await page.getByText(`${description} was restored.`, { exact: true }).waitFor({ state: 'visible' })
  await page.getByText(`Live Renamed Owner restored ${description}`, { exact: true }).waitFor({ state: 'visible' })

  await page.goto(deepUrl, { waitUntil: 'domcontentloaded' })
  const groupAfterRestore = page.locator('[data-testid="group-detail"]:not(.ion-page-hidden)')
  await groupAfterRestore.getByRole('heading', { name: 'Live Account Proof', exact: true }).waitFor({ state: 'visible' })
  await groupAfterRestore.locator('.expense-row[data-sync-state="fresh"]', { hasText: description }).getByText(description, { exact: true }).waitFor({ state: 'visible', timeout: 120_000 })
}

async function verifySplitMethodDiscoverability(cardModal) {
  const methodGroup = cardModal.getByRole('radiogroup', { name: 'Split method', exact: true })
  const methods = methodGroup.getByRole('radio')
  if (await methods.count() !== 7) throw new Error('Hosted split editor did not expose all seven documented split methods.')
  const layout = await methodGroup.evaluate((element) => {
    const bounds = element.getBoundingClientRect()
    const buttons = [...element.querySelectorAll('[role="radio"]')].map((button) => {
      const buttonBounds = button.getBoundingClientRect()
      return {
        left: buttonBounds.left,
        right: buttonBounds.right,
        visible: buttonBounds.width > 0 && buttonBounds.height > 0,
      }
    })
    return {
      left: bounds.left,
      right: bounds.right,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      overflowX: getComputedStyle(element).overflowX,
      buttons,
    }
  })
  if (layout.overflowX === 'auto' || layout.scrollWidth > layout.clientWidth + 1
    || layout.buttons.some((button) => !button.visible || button.left < layout.left - 1 || button.right > layout.right + 1)) {
    throw new Error('Hosted split editor hid one or more split methods in a horizontal scrolling rail at 390px.')
  }
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

async function verifyAccountDeletion(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, locale: 'en-US' })
  try {
    const page = await context.newPage()
    const assertPageClean = monitorBrowserErrors(page, 'account deletion journey')
    const navigation = await page.goto(hostedOrigin, { waitUntil: 'domcontentloaded' })
    if (!navigation?.ok()) throw new Error(`Hosted account-deletion navigation failed with ${navigation?.status() ?? 'no response'}.`)
    await signIn(page, deletionEmail)
    await page.waitForURL(/\/tabs\/home(?:[?#].*)?$/)
    await page.goto(new URL('/tabs/account', hostedOrigin).href, { waitUntil: 'domcontentloaded' })
    await page.getByRole('heading', { name: 'Account', exact: true }).waitFor({ state: 'visible' })
    await page.getByTestId('open-account-delete').click()

    const cardModal = page.locator('ion-modal.show-modal')
    await cardModal.waitFor({ state: 'visible' })
    await cardModal.getByRole('heading', { name: 'Delete your account?', exact: true }).waitFor({ state: 'visible' })
    const hasPresentingElement = await cardModal.evaluate((modal) => Boolean(modal.presentingElement))
    if (!hasPresentingElement) throw new Error('Hosted account deletion did not use an Ionic presenting-element card modal.')
    await cardModal.getByTestId('account-delete-password').locator('input').fill(password)
    await cardModal.getByTestId('account-delete-ack').click()
    await cardModal.getByTestId('confirm-account-delete').click()

    await page.waitForURL(/\/auth(?:[?#].*)?$/, { timeout: 120_000 })
    await page.locator('#auth-email').waitFor({ state: 'visible' })
    assertPageClean()
    await page.locator('#auth-email').fill(deletionEmail)
    await page.locator('#auth-password').fill(password)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    const rejectedSignIn = page.locator('.auth-error[role="alert"]')
    await rejectedSignIn.waitFor({ state: 'visible' })
    if (!/email|password|credential|user/i.test((await rejectedSignIn.textContent()) ?? '')) {
      throw new Error('Hosted deleted-account sign-in failed without an authentication-specific recovery message.')
    }
    if (!/\/auth(?:[?#].*)?$/.test(page.url())) throw new Error('Hosted deleted account was unexpectedly able to leave the sign-in page.')
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
