# Account Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a permanent, retryable Firebase account-deletion flow that removes Auth and private data, anonymizes shared identity, preserves shared balances, and clears the exact local account namespace.

**Architecture:** A pure transformation module defines the identity-retention contract. A Firebase adapter applies those transforms under a two-phase profile tombstone, then the Auth service performs recent-sign-in reauthentication and deletes the Firebase user. Firestore rules authorize only exact identity-only cleanup, while the Account page owns the native Ionic card modal and local queue gate.

**Tech Stack:** Vue 3, Ionic Vue 9, TypeScript 6, Firebase JS SDK 12, Firestore Security Rules, Vitest 4, Firebase Emulator Suite, Capacitor iOS.

**Spec:** `docs/superpowers/specs/2026-09-02-account-deletion-design.md`

## Global Constraints

- Production remains on Firebase Spark; never deploy Cloud Functions, Extensions, or Storage.
- Reauthenticate before any irreversible remote mutation.
- Preserve financial amounts, allocations, payments, IDs, dates, and revision identity exactly.
- Replace the deleted UID's public identity only with `Deleted user`, `DU`, and a null avatar.
- Keep the operation replay-safe after interruption at every Firestore batch boundary.
- Do not proceed while a local command is pending.
- Every verification run includes the hosted production app on the exact deployed asset.
- Preserve `.artifacts/**`, `ios/DerivedDataFresh/`, and `output/**`.

---

### Task 1: Pure account-deletion transformations

**Files:**
- Create: `src/data/accountDeletion.ts`
- Create: `src/data/__tests__/accountDeletion.spec.ts`

**Interfaces:**
- Produces: `DELETED_ACCOUNT_NAME`, `DELETED_ACCOUNT_INITIALS`, `AccountDeletionPhase`, `AccountDeletionTombstone`, `buildAccountDeletionTombstone`, `anonymizeSharedDocument`, `buildDeletedMemberDocument`, `buildDeletionGroupContinuity`, `buildDeletionRecurringTemplate`, and `buildDeletionSettings`.
- Consumes: plain `Readonly<Record<string, unknown>>` documents so Firebase sentinels stay opaque and no SDK dependency enters the pure module.

- [ ] **Step 1: Write the failing tombstone and actor tests**

```ts
it('builds a non-personal retry tombstone without retaining the former profile', () => {
  expect(buildAccountDeletionTombstone(profile, {
    uid: 'owner', deletionId: 'account-delete-12345678', groupIds: ['group-a'], phase: 'deleting', committedAt: 'now',
  })).toEqual({
    displayName: 'Deleted user', initials: 'DU', avatarUrl: null,
    createdAt: 'created', updatedAt: 'now', deletionRequestedAt: 'now',
    deletionStatus: 'deleting', deletionId: 'account-delete-12345678', deletionGroupIds: ['group-a'],
  })
})

it('rewrites only actor snapshots owned by the deleted uid', () => {
  const result = anonymizeSharedDocument('expense', expense, 'owner', 'deletion-1')
  expect(result).toMatchObject({
    total: expense.total,
    createdBy: { id: 'owner', displayName: 'Deleted user' },
    updatedBy: { id: 'friend', displayName: 'Friend' },
  })
  expect(anonymizeSharedDocument('expense', result!, 'owner', 'deletion-1')).toEqual(result)
})
```

- [ ] **Step 2: Run the focused test and confirm the missing-module failure**

Run: `pnpm vitest run src/data/__tests__/accountDeletion.spec.ts`

Expected: FAIL because `../accountDeletion` does not exist.

- [ ] **Step 3: Implement strict pure transforms**

```ts
export const DELETED_ACCOUNT_NAME = 'Deleted user'
export const DELETED_ACCOUNT_INITIALS = 'DU'
export type AccountDeletionPhase = 'deleting' | 'prepared'

export function anonymizeActor(value: unknown, uid: string): unknown {
  if (!isRecord(value) || value.id !== uid || typeof value.displayName !== 'string') return value
  return value.displayName === DELETED_ACCOUNT_NAME ? value : { ...value, displayName: DELETED_ACCOUNT_NAME }
}
```

Implement per-kind transforms for `group`, `expense`, `revision`, `comment`, `settlement`, `activity`, `recurring`, and `settings`. Return `undefined` when no write is needed. Redact an authored comment body and attachments. Validate strict IDs, unique group IDs, the 100-group limit, existing tombstone continuity, and all expected document shapes before returning a mutation.

- [ ] **Step 4: Add failing continuity, recurrence, settings, and malicious-shape tests**

```ts
it('promotes the first remaining member and transfers group ownership', () => {
  expect(buildDeletionGroupContinuity(group, members, 'owner', 'deletion-1', 'now')).toMatchObject({
    group: { createdByUid: 'friend' },
    deletedMember: { role: 'member', canManage: false, accountStatus: 'deleted' },
    promotedMember: { id: 'friend', role: 'owner', canManage: true },
  })
})

it('cancels only active recurrence involving the deleted uid', () => {
  expect(buildDeletionRecurringTemplate(template, 'owner', 'deletion-1', 'now')).toMatchObject({ status: 'cancelled' })
  expect(buildDeletionRecurringTemplate({ ...template, involvedMemberIds: ['friend'] }, 'owner', 'deletion-1', 'now')).toBeUndefined()
})
```

- [ ] **Step 5: Run the focused suite until green**

Run: `pnpm vitest run src/data/__tests__/accountDeletion.spec.ts`

Expected: PASS with no warnings.

- [ ] **Step 6: Commit the pure contract**

```bash
git add src/data/accountDeletion.ts src/data/__tests__/accountDeletion.spec.ts
git commit -m "feat: define account deletion transforms"
```

### Task 2: Firestore deletion authorization

**Files:**
- Modify: `firestore.rules`
- Modify: `src/data/__tests__/security.emulator.spec.ts`

**Interfaces:**
- Consumes: tombstone and document shapes from Task 1.
- Produces: `activeAccount`, `accountDeleting`, actor/member anonymization validators, deletion-phase transition validators, shared-document deletion validators, and owner-private delete authorization.

- [ ] **Step 1: Add failing emulator tests for the two profile phases**

```ts
await assertSucceeds(setDoc(doc(owner, 'users/owner'), deletingProfile('owner', ['group-delete']), { merge: false }))
await assertFails(commitSparkProfileUpdate(owner, 'owner', 'group-delete', 'Usable Again', 'UA'))
await assertSucceeds(updateDoc(doc(owner, 'users/owner'), { deletionStatus: 'prepared', updatedAt: serverTimestamp() }))
await assertFails(getDoc(doc(owner, 'groups/group-delete')))
```

Also prove a different UID cannot start, advance, or delete against this tombstone.

- [ ] **Step 2: Run the security suite and confirm permission failures**

Run: `pnpm exec firebase emulators:exec --project demo-split-unwise --only firestore "pnpm vitest run src/data/__tests__/security.emulator.spec.ts"`

Expected: FAIL because profile deletion transitions are denied.

- [ ] **Step 3: Add exact profile and active-account rules**

```text
function accountDeleting() {
  let profile = get(/databases/$(database)/documents/users/$(request.auth.uid)).data;
  return signedIn() && profile.deletionStatus == 'deleting';
}

function activeAccount() {
  let profile = get(/databases/$(database)/documents/users/$(request.auth.uid)).data;
  return signedIn() && !('deletionStatus' in profile);
}
```

Require `activeAccount()` from normal group membership, group creation, invitation creation/join, and normal shared writes. Permit a `deleting` tombstone to read only its listed groups; deny shared reads in `prepared`.

- [ ] **Step 4: Add failing shared-anonymization and adversarial tests**

Create a complete shared fixture containing an expense head and revision, activity, authored comment, settlement with void actor, recurring template, settings, group member, friendship projection, and invitation. Assert that exact anonymization succeeds. Then assert failures for:

```ts
await assertFails(updateDoc(expenseRef, { 'total.minorAmount': 1 }))
await assertFails(updateDoc(expenseRef, { 'updatedBy.displayName': 'Forged' }))
await assertFails(updateDoc(friendMemberRef, { accountStatus: 'deleted' }))
await assertFails(deleteDoc(doc(owner, 'users/friend/settings/notifications')))
```

- [ ] **Step 5: Implement collection-specific deletion validators**

Use `map.diff().affectedKeys().hasOnly(...)` at every level. Actor rewrites must preserve `id`, change only `displayName`, and accept only the deleting UID. Recurrence cancellation must preserve payload and increment revision once. Settings cleanup may remove only a default split containing the deleting UID. Manager promotion must select an existing active member already in `memberIds`.

- [ ] **Step 6: Run the security suite until green**

Run: `pnpm exec firebase emulators:exec --project demo-split-unwise --only firestore "pnpm vitest run src/data/__tests__/security.emulator.spec.ts"`

Expected: PASS, including all existing rules tests.

- [ ] **Step 7: Commit rules and adversarial proof**

```bash
git add firestore.rules src/data/__tests__/security.emulator.spec.ts
git commit -m "feat: authorize safe account anonymization"
```

### Task 3: Firebase preparation adapter

**Files:**
- Create: `src/data/firebaseAccountDeletion.ts`
- Create: `src/data/__tests__/firebaseAccountDeletion.spec.ts`
- Modify: `src/data/__tests__/firebaseSparkFlow.emulator.spec.ts`

**Interfaces:**
- Produces: `AccountDeletionFirestorePort`, `createAccountDeletionPreparer(port)`, and `prepareFirebaseAccountDeletion(configuration, input): Promise<AccountDeletionPreparation>`.
- Input: `{ uid: string; email?: string; deletionId?: string; onProgress?: (progress: AccountDeletionProgress) => void }`.
- Output: `{ deletionId: string; phase: 'prepared'; groupsProcessed: number; sharedDocumentsChanged: number; privateDocumentsDeleted: number; invitationsDeleted: number }`.

- [ ] **Step 1: Write a failing adapter-order test against an injected Firestore port**

```ts
expect(port.events).toEqual([
  'profile:deleting',
  'group:group-a:history',
  'group:group-a:continuity',
  'invitations:delete',
  'private:delete',
  'profile:prepared',
])
```

The test also interrupts after the first history batch, reruns with the same tombstone, and expects the same final result without duplicate semantic changes.

- [ ] **Step 2: Run the focused test and confirm the missing adapter failure**

Run: `pnpm vitest run src/data/__tests__/firebaseAccountDeletion.spec.ts`

Expected: FAIL because the adapter is absent.

- [ ] **Step 3: Implement bounded pagination and batching**

```ts
const PRIVATE_COLLECTIONS = ['groups', 'activity', 'notifications', 'notificationReads', 'settings', 'jobs', 'exports', 'devices'] as const
const SHARED_COLLECTIONS = ['expenses', 'comments', 'settlements', 'activity', 'recurringTemplates'] as const
const MAX_BATCH_WRITES = 20
```

Query every collection with `orderBy(documentId())`, `startAfter`, and `limit(100)`. Commit no more than 20 writes at once so every guarded write stays below Firestore's rules-expression budget. Process history before member continuity, private projections after every group, and `prepared` last. Query invitations separately by `createdByUid == uid` and verified `targetEmail == email`, deduplicate IDs, and delete only matching documents.

- [ ] **Step 4: Run the adapter unit test until green**

Run: `pnpm vitest run src/data/__tests__/firebaseAccountDeletion.spec.ts`

Expected: PASS.

- [ ] **Step 5: Add a failing real emulator journey**

Create owner and friend Auth/Firestore accounts, a shared expense and settlement, an active recurrence, a default split, a comment, and an invitation. Run `prepareFirebaseAccountDeletion`, then prove:

- the owner profile is `prepared` and contains no old name;
- the friend's view reads `Deleted user`;
- money and balances are byte-for-byte unchanged;
- recurrence is cancelled and default split cleared;
- owner-private documents and matching invitations are absent;
- a second preparation call is idempotent.

- [ ] **Step 6: Run the Spark flow emulator suite until green**

Run: `pnpm exec firebase emulators:exec --project demo-split-unwise --only auth,firestore "pnpm vitest run src/data/__tests__/firebaseSparkFlow.emulator.spec.ts"`

Expected: PASS.

- [ ] **Step 7: Commit the Firebase adapter**

```bash
git add src/data/firebaseAccountDeletion.ts src/data/__tests__/firebaseAccountDeletion.spec.ts src/data/__tests__/firebaseSparkFlow.emulator.spec.ts
git commit -m "feat: prepare Firebase account deletion"
```

### Task 4: Recent-sign-in and Auth deletion

**Files:**
- Modify: `src/features/auth/authService.ts`
- Modify: `src/features/auth/firebaseAuthService.ts`
- Modify: `src/features/auth/__tests__/authService.spec.ts`

**Interfaces:**
- Add: `AccountDeletionInput = { readonly password?: string; readonly onProgress?: (progress: AccountDeletionProgress) => void }`.
- Add to `AuthService`: `deleteAccount(input: AccountDeletionInput): Promise<void>`.
- Add: `createFirebaseAccountDeletionAction(dependencies)` as the testable strict-order adapter used by `createFirebaseAuthService`.
- Consumes: `prepareFirebaseAccountDeletion` from Task 3.

- [ ] **Step 1: Add failing provider-selection tests**

```ts
expect(accountDeletionProvider(identity(['password']))).toBe('password')
expect(accountDeletionProvider(identity(['google.com']))).toBe('google')
expect(() => accountDeletionProvider(identity(['apple.com']))).toThrow('not supported')
```

Add an injected Firebase-operation test that asserts strict order: email credential creation, reauthentication, Firestore preparation, `deleteUser`.

- [ ] **Step 2: Run the auth test and confirm missing APIs**

Run: `pnpm vitest run src/features/auth/__tests__/authService.spec.ts`

Expected: FAIL because the provider helper and service method do not exist.

- [ ] **Step 3: Implement provider-specific recent sign-in**

```ts
if (provider === 'password') {
  if (!user.email || !input.password) throw new Error('Enter your current password.')
  await firebase.reauthenticateWithCredential(user, firebase.EmailAuthProvider.credential(user.email, input.password))
} else {
  await firebase.reauthenticateWithPopup(user, new firebase.GoogleAuthProvider())
}
await prepareFirebaseAccountDeletion(configuration, { uid: user.uid, ...(user.email ? { email: user.email } : {}), onProgress: input.onProgress })
await firebase.deleteUser(user)
```

Map `auth/wrong-password` and `auth/invalid-credential` to `The password is incorrect.`; map popup cancellation to `Google reauthentication was cancelled.`; map `auth/requires-recent-login` to `Reauthenticate and try deleting the account again.`. Demo mode throws the existing fixed-identity error.

- [ ] **Step 4: Run auth tests until green**

Run: `pnpm vitest run src/features/auth/__tests__/authService.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit the Auth boundary**

```bash
git add src/features/auth/authService.ts src/features/auth/firebaseAuthService.ts src/features/auth/__tests__/authService.spec.ts
git commit -m "feat: delete recently authenticated users"
```

### Task 5: Native Ionic account-deletion card

**Files:**
- Modify: `src/features/account/AccountPage.vue`
- Modify: `src/features/account/__tests__/AccountPage.spec.ts`
- Modify: `src/data/repositories.ts`
- Modify: `src/data/firebaseDecoders.ts`
- Modify: `src/features/expenses/expenseStore.ts`
- Modify: `src/features/expenses/__tests__/expenseStore.spec.ts`
- Modify: `src/features/groups/GroupSettingsPage.vue`
- Modify: `src/features/groups/__tests__/GroupSettingsPage.spec.ts`
- Modify: `src/features/balances/settlementStore.ts`
- Modify: `src/features/balances/__tests__/settlementStore.spec.ts`

**Interfaces:**
- Add optional `accountStatus?: 'deleted'` to `Member`.
- Deleted members remain available for ledger labels. `expenseStore` excludes them from new expense, itemization, payer, split, and recurrence inputs; `GroupSettingsPage` excludes them from default splits; `settlementStore` refuses a new settlement whose sender or recipient is deleted.

- [ ] **Step 1: Add failing card-modal tests**

```ts
const modal = wrapper.getComponent({ name: 'IonModal' })
expect(modal.props('presentingElement')).toBe(wrapper.get('.ion-page').element)
expect(await (modal.props('canDismiss') as () => Promise<boolean>)()).toBe(true)
expect(wrapper.get('[data-testid="confirm-account-delete"]').attributes('disabled')).toBeDefined()
```

Add cases for password vs Google controls, acknowledgement, pending-command blocker, busy swipe lock, error password clearing, and exact local principal cleanup after success.

- [ ] **Step 2: Run the Account page test and confirm the placeholder behavior fails**

Run: `pnpm vitest run src/features/account/__tests__/AccountPage.spec.ts`

Expected: FAIL because Delete account is not actionable and no card modal exists.

- [ ] **Step 3: Implement the card modal and queue gate**

Use `IonModal`, `IonInput`, `IonCheckbox`, `IonSpinner`, and the existing `presentingElement` helper pattern. The confirm action must:

```ts
const summary = session.quiesce()
if (summary.pending > 0) throw new Error('Wait for in-flight changes before deleting your account.')
const principal = await session.principal
await auth.deleteAccount({ password: password.value, onProgress: (next) => { deletionProgress.value = next } })
await createBrowserPrincipalLocalDataPort().clear(principal)
```

Resume the queue on any pre-deletion failure. Do not restore normal work after the Firestore phase reaches `prepared`; keep retry UI available. Disable dismissal while busy.

- [ ] **Step 4: Decode and exclude deleted members from new obligations**

Decode `accountStatus: 'deleted'` only when the member document contains the exact canonical anonymous identity. Keep the row usable for historical balance labels. Filter such members from participant pickers, settlement creation, group default-split selection, and recurrence creation/editing.

- [ ] **Step 5: Run focused account, expense, group, and balance tests**

Run: `pnpm vitest run src/features/account/__tests__/AccountPage.spec.ts src/features/expenses/__tests__/expenseStore.spec.ts src/features/expenses/__tests__/ExpenseEditorPage.spec.ts src/features/groups/__tests__/GroupSettingsPage.spec.ts src/features/groups/__tests__/RecurringExpensesPage.spec.ts src/features/balances/__tests__/settlementStore.spec.ts src/features/balances/__tests__/SettleUpPage.spec.ts`

Expected: PASS.

- [ ] **Step 6: Commit the native deletion experience**

```bash
git add src/features/account src/data/repositories.ts src/data/firebaseDecoders.ts src/features/expenses/expenseStore.ts src/features/expenses/__tests__/expenseStore.spec.ts src/features/groups/GroupSettingsPage.vue src/features/groups/__tests__/GroupSettingsPage.spec.ts src/features/balances/settlementStore.ts src/features/balances/__tests__/settlementStore.spec.ts
git commit -m "feat: add native account deletion flow"
```

### Task 6: Full release and hosted proof

**Files:**
- Modify: `docs/verification.md` only when the executed evidence changes the documented contract.
- Preserve: `.artifacts/**`, `ios/DerivedDataFresh/`, `output/**`.

**Interfaces:**
- Produces one release SHA that matches local HEAD, GitHub branch tip, Hosting build metadata, and the loaded production asset.

- [ ] **Step 1: Run all app and Firebase suites**

Run: `pnpm test`

Run: `pnpm test:firebase`

Expected: all existing and new tests pass with no new skipped emulator cases.

- [ ] **Step 2: Build web and native iOS artifacts**

Run: `pnpm build`

Run: `pnpm cap:sync`

Run: `pnpm ios:build`

Expected: production dist verification and generic iOS Simulator build pass.

- [ ] **Step 3: Run the iOS interactive-pop regression**

Run the existing SplitUnwiseUITests gesture XCTest against a booted simulator.

Expected: one pass, zero skips, zero failures, and no blank page after repeated swipe-back gestures.

- [ ] **Step 4: Commit any verification-contract update and publish safely**

```bash
git add docs/verification.md
git commit -m "docs: verify account deletion release"
git -c core.fsmonitor=false push origin refs/heads/codex/split-unwise-build:refs/heads/codex/split-unwise-build
```

Skip the documentation commit when there is no meaningful diff. Never amend, force-push, or stage untracked artifacts.

- [ ] **Step 5: Deploy Hosting and Firestore rules only**

Run: `firebase deploy --project split-unwise-aditya --only hosting,firestore:rules`

Expected: Hosting and rules succeed; no Functions or Storage deployment occurs.

- [ ] **Step 6: Verify the exact hosted release**

Confirm the loaded production build metadata and JavaScript asset contain the release SHA. Run `pnpm test:hosted`, then use disposable owner/friend accounts to prove:

- password reauthentication succeeds;
- shared group and balances exist before deletion;
- the owner account is deleted and cannot sign in again;
- the friend still sees the same expense, settlement, and balance values;
- every owner label reads `Deleted user`;
- active recurrence is stopped and no new obligation can include the deleted member;
- invitation join and authenticated iOS-sized navigation regressions still pass.

- [ ] **Step 7: Clean hosted proof data and verify Git equality**

Delete every disposable Auth account and Firestore group/profile/tombstone created by the proof through the authorized test cleanup boundary. Leave real Aditya and Shreya data untouched. Fetch/prune, then confirm local HEAD, tracking ref, `ls-remote`, Hosting build metadata, and the loaded production asset all identify the same SHA.
