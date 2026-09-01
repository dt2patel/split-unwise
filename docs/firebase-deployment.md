# Firebase deployment record

Current hosted Add Expense, mobile-group, and recurring-expense feature source: `a49eed8ef6439aff7eb4b5ebce97941355e93b05`

## Current state

Firebase access was reauthorized as `heyadityapatel@gmail.com`. A dedicated `split-unwise-aditya` project was created, its exact identity was selected for every mutation, and no existing Firebase project was modified. Firebase Authentication, Firestore rules/indexes, and Firebase Hosting are deployed. The hosted build is live on both Firebase domains. Task 5 was local release preparation only: it did not deploy rules, Hosting, Functions, or any other Firebase resource.

The project has no billing account. Cloud Functions deployment was therefore rejected at the required Artifact Registry/Cloud Build enablement boundary, and Storage could not be provisioned. Authentication, profile bootstrap, atomic group creation, private invitation acceptance, cross-user group reads, replay-safe expense create/edit/delete, immutable revision history, shared comments, comment activity, shared derived balances, manual outside-payment settlement records, account activity, and in-app notifications now run directly against Firebase on the Spark-compatible path. Existing-account hydration now exits after one profile document read instead of opening a no-op transaction. The Firebase repository memoizes and coalesces group documents for the session, reuses the group loaded by the overview when opening its detail route, and defers activity until the user selects Activity. Group, profile, member, and expense reads remain concurrent. Edited expense heads carry a rules-validated `current` projection that must equal the immutable revision written in the same atomic commit, removing the extra revision-document read while preserving the audit trail. Spark notifications aggregate authorized group activity, exclude self-authored events, and overlay immutable owner-private receipts plus a replay-safe inclusive read-all cursor. Spark expenses are rules-validated against active membership and exact minor-unit totals, support at most six involved members, and cannot attach files. The deployed Spark release also supports rules-protected recurring source/template creation, deterministic due-date materialization, occurrence-only edits, exact-frontier future edits, and revision-checked cancellation. The creation snapshot remains immutable; an edit or soft delete atomically advances a bounded head pointer and creates one immutable full version. Comments require a live expense, an active author, and an atomic immutable activity companion; only the author can soft-delete one. Manual settlements require the client to derive and match the current balance basis before write; rules independently enforce active participants, positive same-currency money, deterministic replay metadata, atomic immutable activity, and a single creator-or-manager void transition. Firestore rules cannot aggregate the complete ledger, so these are audited collaborative records of a user-confirmed outside payment, not bank- or provider-confirmed transfers. Server-maintained account projections, provider delivery, and operation-ledger writes remain unavailable without the Functions backend; the Spark client does not claim email or push delivery.

## Spark recurrence release

The current source performs recurrence catch-up when an authorized member opens the group detail or Recurring screen. It processes at most 24 due occurrences per visit and reports when the user must retry. The occurrence ID is derived only from the template ID and due date, while Firestore writes the occurrence, template advancement, and activity atomically. Concurrent clients therefore converge on one occurrence.

Occurrence-only edits preserve the template. Future-series edits must target the exact current source/occurrence frontier and be made by that expense's author or a group manager. Cancellation requires the exact template revision and never deletes the source or posted occurrences. Rules revalidate all stored payers and split participants on every materialization; removing any involved participant stops future posting while past expenses remain.

This is client catch-up, not unattended scheduling. A billed Firebase project and deployed Functions scheduler are required for due items to post while no authorized client opens the app. The matching rules and Hosting bundle are deployed. The disposable hosted proof passed against the exact feature commit with real Auth/Firestore accounts and a 390 x 844 Chrome journey that saved an expense through production's default browser transport; all proof data was removed afterward.

## Deployment invariants

- Use one dedicated project and pass its exact project ID to every mutation.
- Discover the public Web SDK configuration from Firebase Hosting's reserved `__/firebase/init.json` endpoint. The native Capacitor shell reads the same endpoint through the explicit CORS-safe Hosting rule; no project API key is committed to Git.
- Create Firestore in an explicit North America multi-region or US region and enable database delete protection when the account/API surface supports it.
- Enable Email/Password and Google authentication only after the support account is confirmed during OAuth setup.
- Deploy Firestore rules and indexes before exposing the hosted app.
- Treat Storage and Cloud Functions as unavailable if the new project remains on Spark. Current Firebase billing rules require Blaze for those deployments; security rules must never be weakened as a workaround.
- Begin App Check in monitoring, then use a separate canary before enforcement.

## Reviewable deployment order

Executed release order:

1. Bind the Firebase tooling to this exact repository and the new exact project ID.
2. Create the Web app and iOS app (`app.splitunwise.mobile`) and keep their public runtime configuration out of Git.
3. Initialize Auth and Firestore without overwriting the reviewed local rules, indexes, Storage rules, Functions, or Hosting configuration.
4. Build with `VITE_BUILD_COMMIT` set to the exact source commit being released.
5. Deploy Firestore rules/indexes, then any billing-permitted Storage/Functions resources.
6. Deploy a seven-day Hosting preview and inspect it before production promotion.
7. Deploy Hosting production and record the project, region, preview URL, production URL, release identifier, providers, billing tier, and App Check state here.
8. Health-check `/`, `/manifest.webmanifest`, `/sw.js`, the hashed startup assets, cache/security headers, and a nested route refresh.
9. Perform real sign-in, profile bootstrap, group creation, invitation acceptance, sign-out/in persistence, expense add/edit/delete replay, immutable-history reads, shared comment add/delete replay, group and account activity reads, two-account balance reads, manual settlement record/replay/void/replay, notification read/replay, and the past-due recurring-series lifecycle on the Spark path.

## Rollback

Rollback Hosting through Firebase release history or redeploy the prior exact commit. Redeploy compatible rules and Functions from that same commit when necessary. Do not delete indexes, financial data, the Firestore database, or the Firebase project as a rollback technique.

## Deployment results

| Field | Value |
| --- | --- |
| Exact project | `split-unwise-aditya` (`906824460273`), display name `Split Unwise` |
| Registered apps | Web `1:906824460273:web:ac56072d30a1dd5e72c650`; iOS `1:906824460273:ios:ff6f05e1bc4e087872c650`; bundle `app.splitunwise.mobile` |
| Billing | No billing account / Spark-compatible resources only |
| Firestore | Native mode, Standard edition, `nam5`, free tier, pessimistic concurrency, delete protection enabled |
| Firestore rules / indexes | Audited Spark expense, recurrence, comment/activity, manual-settlement, private notification-read, and validated current-expense projection rules released successfully from feature source `a49eed8ef6439aff7eb4b5ebce97941355e93b05`; existing indexes unchanged |
| Auth providers | Identity Platform/Firebase Auth initialized; Email/Password and Google enabled; both Hosting domains authorized |
| Preview URL / release | `https://split-unwise-aditya--split-unwise-rc-iy5k2wwr.web.app`; commit `128506f6d1143e3e69bf7146fb89b9c3d3bdabd4`; expires 2026-09-08T01:36:43.187899648Z |
| Production URL / release | `https://split-unwise-aditya.web.app` and `https://split-unwise-aditya.firebaseapp.com`; Add Expense/mobile-group/recurrence feature source `a49eed8ef6439aff7eb4b5ebce97941355e93b05`; `/build-info.json` records the exact final release commit |
| Production health | Root, manifest, service worker, hashed asset, build metadata, nested-route rewrite, cache policy, CSP, and security headers passed on both domains |
| Storage | Not provisioned; deployment was rejected at project setup/billing, and local security rules were not weakened |
| Functions | Source build and 16 emulator tests pass; production deployment blocked because Blaze is required to enable Artifact Registry/Cloud Build |
| App Check | Not configured; enforcement is not claimed |
| Auth/profile/group/invite P1 | Production pass through the real Auth service with two temporary Email/Password accounts: owner created a group and private link, friend joined, a fresh owner sign-in read the persisted group and decoded both members. The release fixes the P1 contract mismatch where the schema-valid `avatarUrl: null` for accounts without photos was rejected by the member decoder. |
| Shared expense/balance P1 | Production pass with two fresh temporary Email/Password accounts: owner added a $24.00 expense split equally, replayed the identical operation without duplication, and both owner and friend read the same $12.00 debt. Both Auth users were deleted; the exact group, invitation, profile/projection trees, and expense were removed and confirmed not found through Firebase MCP. |
| Authenticated edit/delete P1 | Production pass with two fresh temporary accounts: a non-author edit was denied; the author edited $24.00 to $30.00 and replayed it; both accounts read the same $15.00 debt and revision 2; delete/replay produced revision 3, an empty live ledger, empty balances, and immutable created/updated/deleted history. Both Auth users and every exact proof document were deleted; follow-up Firebase queries returned zero users, groups, and invitations. |
| Shared comments/activity | Production pass with two fresh temporary accounts: the friend added/replayed a comment on the owner's expense; the owner read the same comment and group activity but could not delete it; the author deleted/replayed it and both immutable activity events remained readable. Both Auth users and every exact proof document were deleted; follow-up Firebase queries returned zero users, groups, and invitations. |
| Firebase load/mobile group priority | Production pass at 390 x 844 after removing the invalid nested Ionic page/split-pane structure and pinning the Ionic Vue pre-mount transition guard that caused the observed `classList` navigation failure. The phone UI exposes Settle up, Balances, Invite, and More without horizontal scrolling; More reveals the secondary actions with reduced-motion support; expense rows use a deterministic two-row layout. Existing profiles use one read, overview-loaded groups are reused, activity is lazy, and edited expenses avoid an N+1 revision lookup. A fresh hosted two-account run measured the combined group/profile/member/edited-expense/activity read at 127 ms; the full account, invitation, expense, settlement, and notification flow passed in 17.9 seconds. The hosted detail, More tray, and Activity views produced zero browser errors or warnings. All three proof groups, their recursive document trees, invitations, and six temporary Auth accounts were deleted and confirmed absent. |
| In-app notifications | Production pass with two temporary accounts. Four friend-authored expense/settlement events appeared for the owner while the friend saw no self-notifications; unread count, one immutable individual receipt, inclusive read-all, and both replay paths passed. The exact 20-document proof tree and both Auth users were deleted and confirmed absent. Email and push delivery remain unavailable. |
| Spark recurring expenses | Production pass with two disposable users: atomic source/template creation and replay, deterministic concurrent catch-up, cross-user replay, occurrence-only and exact-frontier future edits, manager cancellation, retained history, no post-cancellation catch-up, and recurrence-derived notifications. A real hosted Chrome journey saved an expense through production's default browser transport, loaded the Add Expense recurrence card modal and recurring-series screen at 390 x 844, and produced no page/console errors or horizontal overflow. True unattended scheduling still requires billed Functions. |
| Native Auth | Capacitor uses Firebase's resolver-free Auth initialization with persistent local sessions. The `c76dde2` generic-simulator package embeds the exact P1 fix; the prior installed build opened the real Email/Password sign-in surface. Browser-based Google OAuth stays enabled on Hosting and is deliberately disabled in the native WebView. |
| Authenticated add/replay | Production pass on the immutable Spark path; deterministic operation identity, single-document transaction replay, membership, totals, and cross-user balance visibility verified |
| Authenticated edit/delete | Available and production-proven on the audited Spark head/version path |
| Authenticated settlement | Available and production-proven for audited manual outside-payment record/replay and creator-or-manager void/replay. The repository verifies the current derived debt and balance revision before write; rules enforce active participants, shape, replay identity, positive amount, immutable activity, and the one-time void transition. Provider-confirmed transfers remain unavailable. |
