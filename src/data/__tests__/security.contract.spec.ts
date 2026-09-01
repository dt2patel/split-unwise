import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const firestoreRules = readFileSync(`${process.cwd()}/firestore.rules`, 'utf8')
const storageRules = readFileSync(`${process.cwd()}/storage.rules`, 'utf8')
const functionsSource = readFileSync(`${process.cwd()}/functions/src/index.ts`, 'utf8')
const indexes = JSON.parse(readFileSync(`${process.cwd()}/firestore.indexes.json`, 'utf8')) as { indexes: unknown[]; fieldOverrides: unknown[] }

describe('Firebase security contract', () => {
  it('authorizes groups from active membership documents and default-denies unknown paths', () => {
    expect(firestoreRules).toContain(".data.status == 'active'")
    expect(firestoreRules).toContain('groups/$(groupId)/members/$(request.auth.uid)')
    expect(firestoreRules).toMatch(/function activeMember\(groupId\) \{[\s\S]*?members\/\$\(request\.auth\.uid\)[\s\S]*?\}/)
    expect(firestoreRules).toMatch(/allow update: if validGroupJoin\(groupId\)/)
    expect(firestoreRules).toMatch(/match \/\{document=\*\*\}[\s\S]*allow read, write: if false;/)
  })

  it('keeps operation ledgers server-only while narrowly allowing audited Spark mutations', () => {
    expect(firestoreRules).toMatch(/match \/operations\/\{operationId\}[\s\S]*allow read, write: if false;/)
    for (const collection of ['expenses', 'revisions', 'comments', 'settlements', 'activity', 'recurringTemplates']) {
      expect(firestoreRules).toContain(`match /${collection}/`)
    }
    expect(firestoreRules).toMatch(/match \/expenses\/\{expenseId\}[\s\S]*?allow create: if validSparkExpenseCreate\(groupId, expenseId, request\.resource\.data\);/)
    expect(firestoreRules).toContain('allow update: if validSparkExpenseHeadUpdate(groupId, expenseId, request.resource.data);')
    expect(firestoreRules).toMatch(/match \/revisions\/\{revisionId\}[\s\S]*?allow create: if validSparkExpenseVersionCreate\(groupId, expenseId, revisionId, request\.resource\.data\);[\s\S]*?allow update, delete: if false;/)
    expect(firestoreRules).toContain("'lastOperationId', 'lastRequestFingerprint', 'lastResourceToken', 'headRevision', 'headDeleted', 'current'")
    expect(firestoreRules).toContain('data.current == version.expense')
    expect(firestoreRules).toContain('allow create: if validSparkCommentCreate(groupId, commentId, request.resource.data);')
    expect(firestoreRules).toContain('allow update: if validSparkCommentDelete(groupId, commentId, request.resource.data);')
    expect(firestoreRules).toContain('validSparkCommentActivityCreate(groupId, activityId, request.resource.data)')
    expect(firestoreRules).toContain('validSparkSettingsActivityCreate(groupId, activityId, request.resource.data)')
    expect(firestoreRules).toContain("allow update: if settingId == 'defaults' && validSparkSettingsUpdate(groupId, request.resource.data);")
    expect(firestoreRules).toContain("allow update: if snapshotId == 'current' && validSparkBalanceSettingsUpdate(groupId);")
    expect(firestoreRules).toMatch(/match \/settlements\/\{settlementId\}[\s\S]*?allow write: if false;/)
    expect(firestoreRules).toContain('allow create: if owns(uid) && validProfile(request.resource.data)')
    expect(firestoreRules).toMatch(/match \/notificationReads\/\{notificationId\}[\s\S]*?allow get: if owns\(uid\);[\s\S]*?allow list: if owns\(uid\) && bounded\(100\);[\s\S]*?allow create: if validSparkNotificationReadReceipt\(uid, notificationId, request\.resource\.data\);[\s\S]*?allow update, delete: if false;/)
    expect(firestoreRules).toContain("settingId == 'sparkNotificationReadCursor'")
    expect(firestoreRules).toContain('validSparkNotificationReadCursorUpdate(request.resource.data)')
    expect(firestoreRules).toContain('allow create: if validNewGroup(groupId, request.resource.data) && ownerBundleExists(groupId)')
    expect(firestoreRules).toContain('validUsedInvitation(request.resource.data.invitationId, groupId, uid)')
  })

  it('locks draft uploads to exact owner metadata, safe image types, and the inclusive 15 MiB boundary', () => {
    expect(storageRules).toContain("hasOnly(['ownerUid', 'operationId', 'purpose'])")
    expect(storageRules).toContain('request.resource.size > 0')
    expect(storageRules).toContain('request.resource.size <= 15 * 1024 * 1024')
    expect(storageRules).toContain("image/(jpeg|png|heic|heif|webp)")
    expect(storageRules).toContain('allow list, update: if false')
    expect(storageRules).toContain('allow list, write: if false')
  })

  it('enforces App Check on every callable and binds provider secrets only to workers that use them', () => {
    expect(functionsSource).toContain('enforceAppCheck: true')
    expect(functionsSource).toContain('consumeAppCheckToken: true')
    expect(functionsSource).toContain("defineSecret('INVITATION_HMAC_SECRET')")
    expect(functionsSource).toContain("defineSecret('OCR_PROVIDER_KEY')")
    expect(functionsSource).toMatch(/processPrivateJob[\s\S]*secrets: \[ocrProviderKey\]/)
  })

  it('commits query-driven indexes and unqueried large-map exemptions', () => {
    expect(indexes.indexes.length).toBeGreaterThanOrEqual(5)
    expect(indexes.fieldOverrides).toEqual(expect.arrayContaining([
      expect.objectContaining({ collectionGroup: 'expenses', fieldPath: 'allocations', indexes: [] }),
      expect.objectContaining({ collectionGroup: 'operations', fieldPath: 'result', indexes: [] }),
    ]))
  })
})
