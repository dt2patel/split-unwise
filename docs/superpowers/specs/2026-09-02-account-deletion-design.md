# Account Deletion Design

## Purpose

Add permanent self-service account deletion to the Firebase-backed Split Unwise app without Cloud Functions or a paid Firebase plan. The flow must remove the Firebase Authentication account and private account data, remove the user's public name and avatar from shared records, keep the non-personal shared ledger usable by the remaining members, and clear the deleting account's device-local data.

This is an implementation contract, not a claim of legal or regulatory compliance.

## Source behavior

Splitwise exposes account closure from Account settings and requires the current password or an email confirmation. Its privacy statement says that deleting an account removes personal name and contact information while non-personal shared expense and payment information may remain visible to the people with whom it was shared.

Firebase Authentication permits self-service deletion, but requires a recent sign-in. Email/password accounts reauthenticate with the current password. Google accounts reauthenticate with their Google provider before deletion.

## Constraints

- Production remains on the Firebase Spark plan. The solution must not deploy Cloud Functions, Extensions, or Cloud Storage.
- The deletion flow operates only on the currently authenticated UID.
- Shared financial amounts, allocations, payments, revisions, and expense descriptions are retained.
- The deleted UID may remain as the stable participant key in retained ledgers, but its former name, initials, avatar, email, and provider identity must not remain in the records the client controls.
- Existing offline work must be quiesced. An in-flight command blocks deletion because its server result is unknown.
- The operation must be idempotent and safely retryable after network or browser interruption.
- Existing unrelated work and untracked verification artifacts remain untouched.

## User experience

The Account screen replaces the unavailable placeholder with a destructive row. Tapping it opens the same full-height Ionic card modal pattern already used for group lifecycle actions:

- the current page is the `presentingElement`, which gives iOS card presentation and swipe-to-dismiss;
- swipe and Cancel work until deletion begins;
- dismissal is blocked while deletion is running;
- the modal explains that the action is irreversible, shared balances stay with an anonymous `Deleted user`, and local data on this device is removed;
- email/password users enter their current password;
- Google-only users reauthenticate with Google;
- an explicit acknowledgement enables the destructive button;
- progress copy changes from reauthentication to private-data removal and final account deletion;
- errors remain in the modal with the entered password cleared.

Demo mode keeps the control disabled.

## Data contract

### Retained shared data

The following financial data remains unchanged:

- group IDs, group names, currencies, and cover choices;
- expenses, amounts, dates, allocations, payments, split methods, categories, notes, and revision numbers;
- settlements, amounts, dates, methods, and void state;
- balances and currency-conversion provenance;
- activity ordering and subject labels;
- comments written by other members.

### Anonymized shared identity

The canonical replacement is:

```ts
{ id: deletedUid, displayName: 'Deleted user' }
```

The member projection becomes `displayName: 'Deleted user'`, `initials: 'DU'`, `avatarUrl: null`, and `accountStatus: 'deleted'`. Actor snapshots belonging to the deleted UID are rewritten only at these allowlisted locations:

- group `deletedBy`;
- expense root and current-head `createdBy` / `updatedBy`;
- expense revision `actor` and nested expense `createdBy` / `updatedBy`;
- comment `author`;
- settlement `createdBy` and `void.actor`;
- activity `actor`;
- recurring-template `createdBy` / `updatedBy`;
- group settings `updatedBy`.

Comments authored by the deleted UID are redacted to `Comment removed with deleted account` and lose attachment references. Other shared content remains unchanged.

### Group continuity

The deleted UID remains in `memberIds` as a ledger participant, but `accountStatus: 'deleted'` and the account tombstone make it unusable for authorization. This avoids invalidating historical allocations.

If the deleted member is the owner or the only manager and another active, non-deleted member exists, the first remaining member in stable `memberIds` order is promoted to `role: 'owner'` and `canManage: true`; the deleted member becomes `role: 'member'` and `canManage: false`. The group's `createdByUid` is transferred to the promoted member so later owner protections remain coherent.

If no remaining member exists, the group is marked deleted and becomes inaccessible after Auth deletion. Its ledger remains stored but has no remaining audience.

An active recurring template that includes the deleted UID in `involvedMemberIds` is cancelled. A group default split that includes the deleted UID is cleared. Past occurrences and ledger rows remain unchanged.

Friendship projections owned by the remaining friend change their context label to `Deleted user`.

### Removed private data

The deletion preparation removes every reachable document owned only by the deleting account from these subcollections:

- `users/{uid}/groups`
- `users/{uid}/activity`
- `users/{uid}/notifications`
- `users/{uid}/notificationReads`
- `users/{uid}/settings`
- `users/{uid}/jobs`
- `users/{uid}/exports`
- `users/{uid}/devices`

Active, used, or revoked invitation documents created by the UID or targeted to its verified email are deleted. The authenticated email itself lives in Firebase Authentication and is removed when the Auth user is deleted.

The root Firestore profile is retained as a non-personal tombstone because deleting Auth first would remove permission to finish Firestore cleanup, while deleting the profile first would make interrupted recovery ambiguous. The tombstone contains only:

- `displayName: 'Deleted user'`
- `initials: 'DU'`
- `avatarUrl: null`
- original `createdAt`
- server-controlled `updatedAt` and `deletionRequestedAt`
- `deletionStatus: 'deleting' | 'prepared'`
- a strict random `deletionId`
- up to 100 opaque group IDs needed for retry

It contains no email or prior display identity.

## Two-phase protocol

1. Quiesce the local command queue. Refuse to proceed while any command is pending.
2. Reauthenticate the current Firebase user with the provider already attached to the account.
3. Read the user's active/removed group projections and either create or resume the deletion tombstone in phase `deleting`.
4. For every tombstoned group ID, page through allowlisted shared collections and apply idempotent identity-only rewrites, recurring cancellation, default-split cleanup, manager continuity, and friendship-label cleanup.
5. Page through and delete allowlisted private subcollections and matching invitations.
6. Move the tombstone to `prepared`. Normal application writes are denied in both deletion phases. While phase is `deleting`, bounded reads of the tombstoned groups and exact deletion cleanup writes are allowed; phase `prepared` denies shared-data access.
7. Call Firebase Auth `deleteUser` while the reauthentication is fresh.
8. Clear the exact mode/project/UID local namespace, receipt database, and currency preferences.

If steps 3–6 fail, Auth remains intact and a retry resumes from the same deletion ID. If step 7 fails, the prepared tombstone prevents normal use; the user can return to Account and retry reauthentication and final deletion. Re-entering phase `deleting` is allowed only with the same deletion ID and group list.

## Firestore authorization

Rules distinguish an active profile from a deletion tombstone. Normal group membership, creation, invitations, and shared writes require an active profile. Deletion-specific updates require all of the following:

- `request.auth.uid` is the tombstone owner;
- phase is `deleting`;
- the target actor or member ID is that UID;
- only allowlisted fields change;
- replacement identity is exactly `Deleted user`, `DU`, and `null` avatar;
- financial values, participant IDs, timestamps from the original ledger, operation IDs, and revision identity remain unchanged;
- recurring cancellation applies only to an active template that references the deleting UID;
- manager transfer chooses an existing active member and never grants capability to an arbitrary UID;
- private deletes target only the caller's own path;
- invitation deletes target only documents created by the caller or addressed to the caller's verified email.

The emulator suite must prove both the accepted bundle and adversarial failures that try to change an amount, another actor, a group member ID, or another user's private document.

## Module boundaries

- `src/data/accountDeletion.ts` owns pure tombstone, actor anonymization, comment redaction, recurring, settings, member, and group-continuity transforms.
- `src/data/firebaseAccountDeletion.ts` owns Firebase reads, pagination, bounded batches, retry ordering, and preparation results.
- `src/features/auth/authService.ts` exposes the provider-neutral deletion input and action.
- `src/features/auth/firebaseAuthService.ts` owns recent-sign-in reauthentication, calls the Firestore preparation boundary, and deletes the Auth user.
- `src/features/account/AccountPage.vue` owns the Ionic card modal, queue gate, progress, error state, and exact local-namespace cleanup.
- `firestore.rules` owns the active-account and deletion-only authorization gates.

## Verification

The release gate includes:

- pure transform tests that prove only identity fields change and repeated transforms are stable;
- Auth tests for password, Google, unsupported-provider, and recent-sign-in error mapping;
- Account-page tests for card presentation, swipe blocking while busy, pending-command protection, provider-specific controls, and destructive completion;
- Firestore emulator tests for the exact two-phase bundle and malicious mutations;
- the complete existing unit and Firebase emulator suites;
- production build and distribution verification;
- native iOS simulator build and the existing interactive-pop gesture XCTest;
- hosted mobile proof on the exact deployed asset, using disposable accounts and a shared group to confirm that the deleted account can no longer sign in while the remaining account sees `Deleted user` and unchanged balances;
- hosted invite and authenticated navigation regressions;
- removal of all disposable Auth and Firestore data after proof.
