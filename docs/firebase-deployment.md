# Firebase deployment record

Release candidate: `73016574a5a4b9b563a5aa145accd4aca87927af`

## Current state

The secure Firebase architecture and local emulator matrix are complete. Production project creation and deployment are waiting only for completion of normal Firebase browser OAuth. No project was selected by guess, no credential or SDK configuration was committed, and no existing Firebase environment was mutated.

This means the current release is a native/local demo build. It must not be described as live Firebase persistence yet.

## Deployment invariants

- Use one dedicated project and pass its exact project ID to every mutation.
- Keep the Web SDK values in gitignored `.env.production.local`. Although Firebase Web configuration is public metadata, the release contract intentionally keeps environment selection out of Git.
- Create Firestore in an explicit North America multi-region or US region and enable database delete protection when the account/API surface supports it.
- Enable Email/Password and Google authentication only after the support account is confirmed during OAuth setup.
- Deploy Firestore rules and indexes before exposing the hosted app.
- Treat Storage and Cloud Functions as unavailable if the new project remains on Spark. Current Firebase billing rules require Blaze for those deployments; security rules must never be weakened as a workaround.
- Begin App Check in monitoring, then use a separate canary before enforcement.

## Reviewable deployment order

After OAuth completes:

1. Bind the Firebase tooling to this exact repository and the new exact project ID.
2. Create the Web app and iOS app (`app.splitunwise.mobile`), then write the Web config to `.env.production.local`.
3. Initialize Auth and Firestore without overwriting the reviewed local rules, indexes, Storage rules, Functions, or Hosting configuration.
4. Build with `VITE_BUILD_COMMIT=73016574a5a4b9b563a5aa145accd4aca87927af`.
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
| Exact project ID | Pending OAuth |
| Firestore location / delete protection | Pending OAuth |
| Auth providers | Pending OAuth |
| Preview URL / release | Pending OAuth |
| Production URL / release | Pending OAuth |
| Storage | Pending billing check |
| Functions | Pending billing check |
| App Check | Pending project creation |
| Authenticated add/edit/settle replay | Not run; no live project yet |
