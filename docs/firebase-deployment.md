# Firebase deployment record

Release candidate: `128506f6d1143e3e69bf7146fb89b9c3d3bdabd4`

## Current state

Firebase access was reauthorized as `heyadityapatel@gmail.com`. A dedicated `split-unwise-aditya` project was created, its exact identity was selected for every mutation, and no existing Firebase project was modified. Firestore rules/indexes and Firebase Hosting are deployed. The hosted build is live on both Firebase domains.

The project has no billing account. Cloud Functions deployment was therefore rejected at the required Artifact Registry/Cloud Build enablement boundary, and Storage could not be provisioned. Because secure financial writes are owned by callable Functions, the hosted bundle intentionally omits production Firebase runtime configuration and runs in demo mode. It must not be described as live Firebase persistence.

## Deployment invariants

- Use one dedicated project and pass its exact project ID to every mutation.
- Keep the Web SDK values in gitignored `.env.production.local`. Although Firebase Web configuration is public metadata, the release contract intentionally keeps environment selection out of Git.
- Create Firestore in an explicit North America multi-region or US region and enable database delete protection when the account/API surface supports it.
- Enable Email/Password and Google authentication only after the support account is confirmed during OAuth setup.
- Deploy Firestore rules and indexes before exposing the hosted app.
- Treat Storage and Cloud Functions as unavailable if the new project remains on Spark. Current Firebase billing rules require Blaze for those deployments; security rules must never be weakened as a workaround.
- Begin App Check in monitoring, then use a separate canary before enforcement.

## Reviewable deployment order

Executed release order:

1. Bind the Firebase tooling to this exact repository and the new exact project ID.
2. Create the Web app and iOS app (`app.splitunwise.mobile`). Keep the Web config out of the production bundle until callable Functions can be deployed.
3. Initialize Auth and Firestore without overwriting the reviewed local rules, indexes, Storage rules, Functions, or Hosting configuration.
4. Build with `VITE_BUILD_COMMIT=128506f6d1143e3e69bf7146fb89b9c3d3bdabd4`.
5. Deploy Firestore rules/indexes, then any billing-permitted Storage/Functions resources.
6. Deploy a seven-day Hosting preview and inspect it before production promotion.
7. Deploy Hosting production and record the project, region, preview URL, production URL, release identifier, providers, billing tier, and App Check state here.
8. Health-check `/`, `/manifest.webmanifest`, `/sw.js`, the hashed startup assets, cache/security headers, and a nested route refresh.
9. If Functions are live, perform real sign-in, bootstrap/group creation, add, edit, settle, identical-operation replay, sign-out/in persistence, and compare immutable revisions/activity/operation records. If Functions are billing-gated, label the hosted result a read/demo surface instead.

## Rollback

Rollback Hosting through Firebase release history or redeploy the prior exact commit. Redeploy compatible rules and Functions from that same commit when necessary. Do not delete indexes, financial data, the Firestore database, or the Firebase project as a rollback technique.

## Deployment results

| Field | Value |
| --- | --- |
| Exact project | `split-unwise-aditya` (`906824460273`), display name `Split Unwise` |
| Registered apps | Web `1:906824460273:web:ac56072d30a1dd5e72c650`; iOS `1:906824460273:ios:ff6f05e1bc4e087872c650`; bundle `app.splitunwise.mobile` |
| Billing | No billing account / Spark-compatible resources only |
| Firestore | Native mode, Standard edition, `nam5`, free tier, pessimistic concurrency, delete protection enabled |
| Firestore rules / indexes | Deployed successfully from the reviewed repository files; deployment job `1788226382428` |
| Auth providers | Email/Password and Google configured; runtime sign-in not exercised because the hosted bundle remains in demo mode |
| Preview URL / release | `https://split-unwise-aditya--split-unwise-rc-iy5k2wwr.web.app`; commit `128506f6d1143e3e69bf7146fb89b9c3d3bdabd4`; expires 2026-09-08T01:36:43.187899648Z |
| Production URL / release | `https://split-unwise-aditya.web.app` and `https://split-unwise-aditya.firebaseapp.com`; Hosting version `73b4ef77f867c406`; commit `128506f6d1143e3e69bf7146fb89b9c3d3bdabd4` |
| Production health | Root, manifest, service worker, hashed asset, build metadata, nested-route rewrite, cache policy, CSP, and security headers passed on both domains |
| Storage | Not provisioned; deployment was rejected at project setup/billing, and local security rules were not weakened |
| Functions | Source build and 16 emulator tests pass; production deployment blocked because Blaze is required to enable Artifact Registry/Cloud Build |
| App Check | Not configured; enforcement is not claimed |
| Authenticated add/edit/settle replay | Not run against production because callable Functions are not deployed; transaction/replay/conflict behavior is emulator-verified only |
