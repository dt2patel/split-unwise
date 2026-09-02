#!/usr/bin/env node

import { randomBytes } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { rmSync } from 'node:fs'

import { assertExpectedHostedCommit } from './hostedBundleContract.mjs'

const projectId = 'split-unwise-aditya'
const hostedOrigin = 'https://split-unwise-aditya.web.app'
const suffix = process.env.LIVE_PROOF_SUFFIX ?? `hosted-${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')}-${randomBytes(4).toString('hex')}`
if (!/^[a-z0-9-]{10,80}$/.test(suffix)) throw new Error('LIVE_PROOF_SUFFIX must contain only lowercase letters, digits, and hyphens.')
const password = process.env.LIVE_PROOF_PASSWORD ?? `${randomBytes(24).toString('base64url')}A1!`
const ownerEmail = `live-owner-${suffix}@example.com`
const friendEmail = `live-friend-${suffix}@example.com`
const thirdEmail = `live-third-${suffix}@example.com`
const unverifiedEmail = `live-unverified-${suffix}@example.com`
const deletionEmail = `live-delete-${suffix}@example.com`
const keepLiveProof = process.env.KEEP_LIVE_PROOF === '1'
const runIosGestureProof = process.env.RUN_IOS_GESTURE_PROOF === '1'
if (keepLiveProof && !process.env.LIVE_PROOF_PASSWORD) throw new Error('KEEP_LIVE_PROOF requires an explicit LIVE_PROOF_PASSWORD so retained fixtures remain usable.')
const expectedHostedCommit = assertExpectedHostedCommit(process.env.EXPECTED_HOSTED_COMMIT
  ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim())
const require = createRequire(import.meta.url)
const firebaseAuth = require('firebase-tools/lib/auth')
const { requireAuth } = require('firebase-tools/lib/requireAuth')
const { Client } = require('firebase-tools/lib/apiv2')
const { identityOrigin } = require('firebase-tools/lib/api')
const { findUser } = require('firebase-tools/lib/gcp/auth')
const { deleteDocuments, getDocuments, queryCollection } = require('firebase-tools/lib/gcp/firestore')
const vitestEntrypoint = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')

const expectedGroupIds = [`grp-live-${suffix}`, `grp-live-friendship-${suffix}`]
let activeChild
let terminationSignal

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    terminationSignal ??= signal
    if (!activeChild || activeChild.child.killed) return
    if (activeChild.killProcessGroup) {
      try { process.kill(-activeChild.child.pid, signal) } catch { activeChild.child.kill(signal) }
    } else activeChild.child.kill(signal)
  })
}

function throwIfTerminated() {
  if (terminationSignal) throw new Error(`Hosted proof interrupted by ${terminationSignal}; cleaning up.`)
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { killProcessGroup = false, ...spawnOptions } = options
    const child = spawn(command, args, { ...spawnOptions, detached: killProcessGroup, env: options.env ?? process.env })
    activeChild = { child, killProcessGroup }
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString()
      stdout += text
      process.stdout.write(text)
    })
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString()
      stderr += text
      process.stderr.write(text)
    })
    child.once('error', (error) => {
      if (activeChild?.child === child) activeChild = undefined
      reject(error)
    })
    child.once('exit', (code, signal) => {
      if (activeChild?.child === child) activeChild = undefined
      code === 0
        ? resolve({ stdout, stderr })
        : reject(Object.assign(new Error(`${command} exited with ${code ?? signal}`), { stdout, stderr, exitCode: code, signal }))
    })
  })
}

async function identityRequest(apiKey, path, body) {
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/${path}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const payload = await response.json()
  if (!response.ok) throw new Error(`Firebase Auth fixture request failed (${response.status}): ${payload.error?.message ?? 'unknown error'}`)
  return payload
}

async function deleteFirestorePath(path) {
  if (!/^(groups|invitations|users)\/[A-Za-z0-9_-]+$/.test(path)) throw new Error(`Refusing unsafe Firestore cleanup path: ${path}`)
  await run('pnpm', ['exec', 'firebase', 'firestore:delete', path, '--recursive', '--force', '--project', projectId], { stdio: ['ignore', 'pipe', 'pipe'] })
}

async function invitationDocumentsFor(groupIds) {
  if (groupIds.length === 0) return []
  return (await queryCollection(projectId, {
    from: [{ collectionId: 'invitations' }],
    where: {
      fieldFilter: {
        field: { fieldPath: 'groupId' },
        op: 'IN',
        value: { arrayValue: { values: groupIds.map((id) => ({ stringValue: id })) } },
      },
    },
    limit: 10,
  })).documents
}

function registerBrowserProofResources(output) {
  let registered = 0
  for (const line of String(output ?? '').split(/\r?\n/)) {
    const prefix = 'LIVE_PROOF_RESOURCE '
    if (!line.startsWith(prefix)) continue
    try {
      const resource = JSON.parse(line.slice(prefix.length))
      if (typeof resource.browserGroupId === 'string' && /^grp-group-[A-Za-z0-9-]+$/.test(resource.browserGroupId)
        && !expectedGroupIds.includes(resource.browserGroupId)) {
        expectedGroupIds.push(resource.browserGroupId)
        registered += 1
      }
    } catch { /* malformed child output is ignored here and fails the exact-count gate below */ }
  }
  return registered
}

async function assertAuthUserDeleted(email) {
  try {
    await findUser(projectId, email)
    throw new Error(`Hosted account deletion left the disposable Auth user active for ${email}.`)
  } catch (error) {
    if (/No users found/i.test(String(error))) return
    throw error
  }
}

async function assertFixturesAvailable() {
  for (const email of [ownerEmail, friendEmail, thirdEmail, unverifiedEmail, deletionEmail]) {
    try {
      await findUser(projectId, email)
      throw new Error(`Hosted proof fixture collision for ${email}. Choose a new LIVE_PROOF_SUFFIX.`)
    } catch (error) {
      if (!/No users found/i.test(String(error))) throw error
    }
  }
  const existingGroups = await getDocuments(projectId, expectedGroupIds.map((id) => `groups/${id}`))
  if (existingGroups.documents.length > 0 || (await invitationDocumentsFor(expectedGroupIds)).length > 0) {
    throw new Error(`Hosted proof fixture collision for ${suffix}. Choose a new LIVE_PROOF_SUFFIX.`)
  }
}

const createdAuthUids = new Set()
let adminClient
let ownerFixtureUid
let thirdFixtureUid
let testFailure
const cleanupFailures = []

try {
  console.log(`Hosted proof fixture: ${suffix}`)
  const initResponse = await fetch(`${hostedOrigin}/__/firebase/init.json`, { cache: 'no-store' })
  if (!initResponse.ok) throw new Error(`Firebase Hosting init failed with ${initResponse.status}`)
  const configuration = await initResponse.json()
  if (configuration.projectId !== projectId || typeof configuration.apiKey !== 'string') throw new Error('Hosted Firebase configuration is not the expected production project.')

  const account = firebaseAuth.getProjectDefaultAccount(process.cwd()) ?? firebaseAuth.getGlobalDefaultAccount()
  if (!account) throw new Error('Firebase CLI is not authenticated. Run `firebase login` and retry the hosted proof.')
  await requireAuth({ project: projectId, projectDir: process.cwd(), ...account })
  adminClient = new Client({ urlPrefix: identityOrigin(), auth: true })
  await assertFixturesAvailable()
  throwIfTerminated()

  for (const email of [ownerEmail, friendEmail, thirdEmail, unverifiedEmail, deletionEmail]) {
    const fixture = await identityRequest(configuration.apiKey, 'accounts:signUp', { email, password, returnSecureToken: false })
    createdAuthUids.add(fixture.localId)
    if (email === ownerEmail) ownerFixtureUid = fixture.localId
    if (email === thirdEmail) thirdFixtureUid = fixture.localId
    if (email !== unverifiedEmail) await adminClient.post('/v1/accounts:update', { localId: fixture.localId, emailVerified: true, targetProjectId: projectId })
    throwIfTerminated()
  }

  try {
    if (!thirdFixtureUid) throw new Error('Hosted proof third-account fixture is unavailable.')
    const proofEnvironment = {
      ...process.env,
      EXPECTED_HOSTED_COMMIT: expectedHostedCommit,
      LIVE_PROOF_SUFFIX: suffix,
      LIVE_PROOF_PASSWORD: password,
      LIVE_PREVERIFIED_ACCOUNTS: '1',
      LIVE_PROOF_EXTERNAL_CLEANUP: '1',
      LIVE_PROOF_THIRD_UID: thirdFixtureUid,
    }
    await run(process.execPath, [vitestEntrypoint, 'run', 'src/data/__tests__/productionHosted.spec.ts'], {
      stdio: ['ignore', 'pipe', 'pipe'], killProcessGroup: true, env: proofEnvironment,
    })
    throwIfTerminated()
    if (runIosGestureProof) {
      const simulatorId = process.env.SU_IOS_SIMULATOR_ID
      if (!simulatorId || !/^[A-F0-9-]{36}$/.test(simulatorId)) throw new Error('RUN_IOS_GESTURE_PROOF requires a valid SU_IOS_SIMULATOR_ID.')
      const resultBundlePath = join(process.cwd(), 'ios', 'DerivedData', 'NavigationGestureTests.xcresult')
      const appBundlePath = join(process.cwd(), 'ios', 'DerivedData', 'Build', 'Products', 'Debug-iphonesimulator', 'App.app')
      const releaseBuildEnvironment = { ...proofEnvironment, VITE_BUILD_COMMIT: expectedHostedCommit }
      delete releaseBuildEnvironment.VITE_NATIVE_UI_TEST_DEMO
      let iosFailure
      let restoreFailure
      try {
        await run('pnpm', ['build'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...releaseBuildEnvironment, VITE_NATIVE_UI_TEST_DEMO: 'true' },
        })
        await run('pnpm', ['exec', 'cap', 'sync', 'ios'], { stdio: ['ignore', 'pipe', 'pipe'], env: releaseBuildEnvironment })
        rmSync(resultBundlePath, { recursive: true, force: true })
        await run('/usr/bin/xcodebuild', [
          '-quiet',
          '-project', 'ios/App/App.xcodeproj',
          '-scheme', 'App',
          '-configuration', 'Debug',
          '-destination', `platform=iOS Simulator,id=${simulatorId}`,
          '-derivedDataPath', 'ios/DerivedData',
          'CODE_SIGNING_ALLOWED=NO',
          'build-for-testing',
        ], { stdio: ['ignore', 'pipe', 'pipe'], env: releaseBuildEnvironment })
        await run('/usr/bin/xcrun', ['simctl', 'install', simulatorId, appBundlePath], {
          stdio: ['ignore', 'pipe', 'pipe'], env: releaseBuildEnvironment,
        })
        await run('/usr/bin/xcrun', ['simctl', 'terminate', simulatorId, 'app.splitunwise.mobile'], {
          stdio: ['ignore', 'pipe', 'pipe'], env: releaseBuildEnvironment,
        }).catch(() => undefined)
        await run('/usr/bin/xcrun', ['simctl', 'launch', simulatorId, 'app.splitunwise.mobile'], {
          stdio: ['ignore', 'pipe', 'pipe'], env: releaseBuildEnvironment,
        })
        await new Promise((resolve) => setTimeout(resolve, 20_000))
        await run('/usr/bin/xcodebuild', [
          '-quiet',
          '-project', 'ios/App/App.xcodeproj',
          '-scheme', 'App',
          '-configuration', 'Debug',
          '-destination', `platform=iOS Simulator,id=${simulatorId}`,
          '-derivedDataPath', 'ios/DerivedData',
          '-resultBundlePath', resultBundlePath,
          'CODE_SIGNING_ALLOWED=NO',
          '-test-timeouts-enabled', 'YES',
          '-default-test-execution-time-allowance', '180',
          '-maximum-test-execution-time-allowance', '240',
          'test-without-building',
          '-only-testing:AppUITests/NavigationGestureTests/testCancelledAndCompletedEdgeSwipesKeepAVisiblePage',
        ], { stdio: ['ignore', 'pipe', 'pipe'], env: releaseBuildEnvironment })
        const resultSummary = JSON.parse(execFileSync('/usr/bin/xcrun', [
          'xcresulttool', 'get', 'test-results', 'summary', '--path', resultBundlePath,
        ], { encoding: 'utf8' }))
        if (resultSummary.totalTestCount !== 1 || resultSummary.passedTests !== 1 || resultSummary.skippedTests !== 0 || resultSummary.failedTests !== 0) {
          throw new Error(`iOS gesture proof did not execute exactly one passing test: ${JSON.stringify({
            totalTestCount: resultSummary.totalTestCount,
            passedTests: resultSummary.passedTests,
            skippedTests: resultSummary.skippedTests,
            failedTests: resultSummary.failedTests,
          })}`)
        }
        rmSync(resultBundlePath, { recursive: true, force: true })
        console.log('iOS gesture proof passed with one executed test and no skipped or failed tests.')
      } catch (error) {
        iosFailure = error
      }
      try {
        await run('pnpm', ['build'], { stdio: ['ignore', 'pipe', 'pipe'], env: releaseBuildEnvironment })
        await run('pnpm', ['exec', 'cap', 'sync', 'ios'], { stdio: ['ignore', 'pipe', 'pipe'], env: releaseBuildEnvironment })
      } catch (error) {
        restoreFailure = error
      }
      if (iosFailure && restoreFailure) throw new AggregateError([iosFailure, restoreFailure], 'iOS gesture proof and release-bundle restoration both failed.')
      if (iosFailure) throw iosFailure
      if (restoreFailure) throw restoreFailure
    }
    let browserProofResult
    try {
      browserProofResult = await run(process.execPath, ['scripts/runHostedBrowserProof.mjs'], {
        stdio: ['ignore', 'pipe', 'pipe'], killProcessGroup: true, env: proofEnvironment,
      })
    } catch (error) {
      registerBrowserProofResources(error?.stdout)
      throw error
    }
    if (registerBrowserProofResources(browserProofResult.stdout) !== 1) {
      throw new Error('Hosted browser proof did not register exactly one UI-created group for cleanup.')
    }
    await assertAuthUserDeleted(deletionEmail)
  } catch (error) {
    testFailure = error
  }
} catch (error) {
  testFailure = error
} finally {
  if (!keepLiveProof) {
    try {
      const groupResult = await getDocuments(projectId, expectedGroupIds.map((id) => `groups/${id}`))
      const ownedGroups = groupResult.documents.filter((document) => document.fields?.createdByUid?.stringValue === ownerFixtureUid)
      const ownedGroupIds = ownedGroups.map(({ name }) => name.split('/').at(-1)).filter((id) => expectedGroupIds.includes(id))
      const invitationDocuments = (await invitationDocumentsFor(ownedGroupIds)).filter((document) => document.fields?.createdByUid?.stringValue === ownerFixtureUid)
      const invitationPrefix = `projects/${projectId}/databases/(default)/documents/invitations/`
      if (invitationDocuments.some(({ name }) => typeof name !== 'string' || !name.startsWith(invitationPrefix) || name.slice(invitationPrefix.length).includes('/'))) {
        throw new Error('Refusing unsafe invitation cleanup result.')
      }
      if (invitationDocuments.length > 0) await deleteDocuments(projectId, invitationDocuments)
    } catch (error) {
      cleanupFailures.push(error)
    }
    for (const groupId of expectedGroupIds) {
      try {
        const groupResult = await getDocuments(projectId, [`groups/${groupId}`])
        const group = groupResult.documents[0]
        if (group?.fields?.createdByUid?.stringValue === ownerFixtureUid) await deleteFirestorePath(`groups/${groupId}`)
      } catch (error) { cleanupFailures.push(error) }
    }
    for (const uid of createdAuthUids) {
      try { await deleteFirestorePath(`users/${uid}`) } catch (error) { cleanupFailures.push(error) }
    }
    if (adminClient) {
      for (const localId of createdAuthUids) {
        try { await adminClient.post('/v1/accounts:delete', { localId, targetProjectId: projectId }) } catch (error) {
          if (!/USER_NOT_FOUND|not found/i.test(String(error))) cleanupFailures.push(error)
        }
      }
    }
  }
}

const failures = [testFailure, ...cleanupFailures].filter(Boolean)
if (terminationSignal) {
  if (failures.length > 0) console.error(failures.map((error) => error instanceof Error ? error.message : String(error)).join('\n'))
  process.exitCode = terminationSignal === 'SIGINT' ? 130 : 143
} else if (failures.length === 1) throw failures[0]
else if (failures.length > 1) throw new AggregateError(failures, 'Hosted proof and cleanup both failed.')
