# Firebase deployment record

Verified P1 shared-ledger release source: `968fa0c2ee7bb367de8518e5b4e2a4445ef34c14`

## Current state

Firebase access was reauthorized as `heyadityapatel@gmail.com`. A dedicated `split-unwise-aditya` project was created, its exact identity was selected for every mutation, and no existing Firebase project was modified. Firebase Authentication, Firestore rules/indexes, and Firebase Hosting are deployed. The hosted build is live on both Firebase domains.

The project has no billing account. Cloud Functions deployment was therefore rejected at the required Artifact Registry/Cloud Build enablement boundary, and Storage could not be provisioned. Authentication, profile bootstrap, atomic group creation, private invitation acceptance, cross-user group reads, immutable expense creation, replay-safe expense retries, and shared derived balances now run directly against Firebase on the Spark-compatible path. Spark expense creation is rules-validated against active membership and exact minor-unit totals, supports at most six involved members, and cannot attach files or recurrence. Expense edits/deletes, settlements, activity projections, and operation-ledger writes remain denied unless the secure callable backend is deployed.

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
9. Perform real sign-in, profile bootstrap, group creation, invitation acceptance, sign-out/in persistence, immutable expense add/replay, and two-account balance reads on the Spark path. Exercise edit/delete/settle only if callable Functions are live.

## Rollback

Rollback Hosting through Firebase release history or redeploy the prior exact commit. Redeploy compatible rules and Functions from that same commit when necessary. Do not delete indexes, financial data, the Firestore database, or the Firebase project as a rollback technique.

## Deployment results

| Field | Value |
| --- | --- |
| Exact project | `split-unwise-aditya` (`906824460273`), display name `Split Unwise` |
| Registered apps | Web `1:906824460273:web:ac56072d30a1dd5e72c650`; iOS `1:906824460273:ios:ff6f05e1bc4e087872c650`; bundle `app.splitunwise.mobile` |
| Billing | No billing account / Spark-compatible resources only |
| Firestore | Native mode, Standard edition, `nam5`, free tier, pessimistic concurrency, delete protection enabled |
| Firestore rules / indexes | Immutable Spark expense rules released successfully from source `968fa0c2ee7bb367de8518e5b4e2a4445ef34c14`; existing indexes unchanged |
| Auth providers | Identity Platform/Firebase Auth initialized; Email/Password and Google enabled; both Hosting domains authorized |
| Preview URL / release | `https://split-unwise-aditya--split-unwise-rc-iy5k2wwr.web.app`; commit `128506f6d1143e3e69bf7146fb89b9c3d3bdabd4`; expires 2026-09-08T01:36:43.187899648Z |
| Production URL / release | `https://split-unwise-aditya.web.app` and `https://split-unwise-aditya.firebaseapp.com`; source commit `968fa0c2ee7bb367de8518e5b4e2a4445ef34c14` |
| Production health | Root, manifest, service worker, hashed asset, build metadata, nested-route rewrite, cache policy, CSP, and security headers passed on both domains |
| Storage | Not provisioned; deployment was rejected at project setup/billing, and local security rules were not weakened |
| Functions | Source build and 16 emulator tests pass; production deployment blocked because Blaze is required to enable Artifact Registry/Cloud Build |
| App Check | Not configured; enforcement is not claimed |
| Auth/profile/group/invite P1 | Production pass with two temporary Email/Password accounts: owner created a group and private link, friend joined, both read the same two-member group, and the group persisted across sign-out/in. |
| Shared expense/balance P1 | Production pass with two fresh temporary Email/Password accounts: owner added a $24.00 expense split equally, replayed the identical operation without duplication, and both owner and friend read the same $12.00 debt. Both Auth users were deleted; the exact group, invitation, profile/projection trees, and expense were removed and confirmed not found through Firebase MCP. |
| Native Auth | Capacitor uses Firebase's resolver-free Auth initialization with persistent local sessions. The final simulator build opened the real Email/Password sign-in surface; browser-based Google OAuth stays enabled on Hosting and is deliberately disabled in the native WebView. |
| Authenticated add/replay | Production pass on the immutable Spark path; deterministic operation identity, single-document transaction replay, membership, totals, and cross-user balance visibility verified |
| Authenticated edit/delete/settle | Not available on Spark; remains denied until callable Functions are deployed |
