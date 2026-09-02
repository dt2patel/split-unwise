import { initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'
import { setGlobalOptions } from 'firebase-functions/v2'
import { onDocumentCreated } from 'firebase-functions/v2/firestore'
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https'
import { defineSecret } from 'firebase-functions/params'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { LedgerError, executeLedgerCommand } from './ledger.js'
import {
  acceptInvitationService,
  bootstrapProfileService,
  createGroupService,
  createInvitationService,
  createJobService,
  fanOutActivity,
  inspectInvitationService,
  materializeRecurrenceService,
  processScheduledRecurrences,
  promoteDraftService,
  registerPushDeviceService,
  revokeInvitationService,
  runJobWorker,
  type Identity,
} from './services.js'

initializeApp()
const db = getFirestore()
const storage = getStorage()
const invitationHmacSecret = defineSecret('INVITATION_HMAC_SECRET')
const ocrProviderKey = defineSecret('OCR_PROVIDER_KEY')
const region = 'us-central1'

setGlobalOptions({ region, minInstances: 0 })

const ledgerOptions = { region, minInstances: 0, maxInstances: 10, concurrency: 40, timeoutSeconds: 60, enforceAppCheck: true, consumeAppCheckToken: true } as const
const ordinaryOptions = { region, minInstances: 0, maxInstances: 10, concurrency: 40, timeoutSeconds: 60, enforceAppCheck: true } as const

export const executeCommand = onCall(ledgerOptions, guarded(async (request) => executeLedgerCommand(db, request.auth!.uid, request.data)))
export const bootstrapProfile = onCall(ordinaryOptions, guarded(async (request) => bootstrapProfileService(db, request.auth!.uid, identity(request), request.data)))
export const createGroup = onCall(ledgerOptions, guarded(async (request) => createGroupService(db, request.auth!.uid, request.data)))

export const invitationCreate = onCall({ ...ledgerOptions, secrets: [invitationHmacSecret] }, guarded(async (request) => createInvitationService(db, request.auth!.uid, request.data, invitationSecret())))
export const invitationInspect = onCall(ordinaryOptions, guarded(async (request) => inspectInvitationService(db, request.auth!.uid, identity(request), request.data)))
export const invitationAccept = onCall(ledgerOptions, guarded(async (request) => acceptInvitationService(db, request.auth!.uid, identity(request), request.data)))
export const invitationRevoke = onCall(ledgerOptions, guarded(async (request) => revokeInvitationService(db, request.auth!.uid, request.data)))

export const promoteDraft = onCall(ledgerOptions, guarded(async (request) => promoteDraftService(db, storage, request.auth!.uid, request.data)))
export const createReceiptOcrJob = onCall(ledgerOptions, guarded(async (request) => createJobService(db, request.auth!.uid, request.data, 'receipt-ocr')))
export const createLargeExportJob = onCall(ledgerOptions, guarded(async (request) => createJobService(db, request.auth!.uid, request.data, 'large-export')))
export const registerPushDevice = onCall(ordinaryOptions, guarded(async (request) => registerPushDeviceService(db, request.auth!.uid, request.data)))
export const materializeRecurrence = onCall(ledgerOptions, guarded(async (request) => materializeRecurrenceService(db, request.auth!.uid, request.data)))

export const scheduledRecurrenceProcessing = onSchedule({ region, schedule: 'every day 00:15', timeZone: 'UTC', minInstances: 0, maxInstances: 1, timeoutSeconds: 300 }, async () => {
  await processScheduledRecurrences(db)
})

export const projectGroupActivity = onDocumentCreated({ region, document: 'groups/{groupId}/activity/{activityId}', minInstances: 0, maxInstances: 10, concurrency: 20, timeoutSeconds: 60 }, async (event) => {
  if (!event.data) return
  const activity = event.data.data()
  if (!activity) return
  await fanOutActivity(db, event.params.groupId, event.params.activityId, activity)
})

export const processPrivateJob = onDocumentCreated({ region, document: 'users/{uid}/jobs/{jobId}', minInstances: 0, maxInstances: 2, concurrency: 1, memory: '512MiB', timeoutSeconds: 300, secrets: [ocrProviderKey] }, async (event) => {
  if (!event.data) return
  const job = event.data.data()
  if (!job) return
  // Reading the bound secret here ensures only this worker receives provider material.
  if (process.env.FUNCTIONS_EMULATOR !== 'true') void ocrProviderKey.value()
  await runJobWorker(db, storage, event.params.uid, event.params.jobId, job, process.env.FUNCTIONS_EMULATOR === 'true')
})

function guarded(handler: (request: CallableRequest<unknown>) => Promise<unknown>): (request: CallableRequest<unknown>) => Promise<unknown> {
  return async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to continue.')
    try { return await handler(request) } catch (error) {
      if (error instanceof HttpsError) throw error
      if (error instanceof LedgerError) throw new HttpsError(error.code, error.message)
      console.error('Callable failed', error)
      throw new HttpsError('internal', 'The request could not be completed.')
    }
  }
}

function identity(request: CallableRequest<unknown>): Identity {
  const token = request.auth!.token
  return {
    ...(typeof token.email === 'string' ? { email: token.email.toLowerCase() } : {}),
    emailVerified: token.email_verified === true,
    ...(typeof token.name === 'string' ? { displayName: token.name } : {}),
    ...(typeof token.picture === 'string' ? { photoURL: token.picture } : {}),
  }
}

function invitationSecret(): string {
  if (process.env.FUNCTIONS_EMULATOR === 'true') return process.env.SPLIT_UNWISE_EMULATOR_INVITE_SECRET ?? 'split-unwise-emulator-secret-at-least-32-bytes'
  return invitationHmacSecret.value()
}
