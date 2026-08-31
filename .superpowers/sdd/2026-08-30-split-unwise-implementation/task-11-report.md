# Task 11 Report — Secure Firebase Backend

## Outcome

Implemented the deployable Firebase backend and connected the Ionic client to its authenticated server surfaces. Authoritative financial writes now run through App Check-protected second-generation callable Functions; Firestore and Storage default-deny all unmatched paths.

## Delivered

- One shared strict command/money/split protocol package consumed by both the client and Functions.
- One named Firebase bootstrap for Auth, Firestore, Functions, Storage, and App Check.
- Active membership authorization from `groups/{groupId}/members/{uid}.status`; no rule authorizes from `memberIds`.
- Bounded, cursor-ready client reads and server-only writes for expenses, immutable revisions, settlements, recurring templates, activity, invitations, jobs, projections, and operation ledgers.
- Transactional command execution with strict decode-before-hash, deterministic IDs, non-expiring per-user dedupe records, active-member replay checks, revision preconditions, exact integer money, actor snapshots, tombstone deletion, balance updates, immutable activity, and attachment validation.
- Authenticated/App Check-protected callables for profile bootstrap, group creation, ledger commands, invitations, draft promotion, receipt OCR jobs, large exports, device registration, and recurrence materialization.
- Deterministic invitation capabilities using versioned HMAC derivation; only token hashes are stored. Expiry, verified-email restriction, revocation, race safety, single-use, and same-user lost-response replay are enforced.
- Operation-aware immutable Storage drafts with exact metadata, safe-image MIME and inclusive 15 MiB checks, server byte sniffing/promotion, group-final assets, and owner-only exports.
- Idempotent activity projection and notification fan-out with retry-safe unread counts.
- Idempotent private job claiming, current-membership rechecks, emulator-only deterministic OCR suggestions, and allowlisted large exports.
- Deterministic recurrence materialization plus scheduled processing, including month-end and leap-year behavior.
- Required composite indexes and large-map single-field exemptions.
- Firebase Hosting SPA configuration and deterministic emulator scripts using demo-project isolation and local non-secret placeholders.

## Verification

- `pnpm typecheck` — passed.
- `pnpm functions:build` — passed.
- `pnpm test` — 68 files passed, 646 tests passed; emulator-only suites skipped in this non-emulator run.
- `pnpm test:firebase` — passed against Auth, Firestore, Functions, and Storage emulators:
  - rules: 5 tests passed, covering anonymous/outsider/removed-member denial, bounded reads, unknown paths, collection-group denial, direct-write denial, exact metadata, every allowed image MIME, size edges, immutable drafts/final paths, and export ownership;
  - Functions/services: 14 tests passed, including twenty-way ledger dedupe, changed-payload collision, removed-member replay denial, exact balances, stale revisions, invitation races/replay, recurrence replay, retry-safe fan-out, job claiming, OCR isolation, and export-field allowlisting.
- `pnpm build` — production build passed, 486 modules transformed.
- `git diff --check` — passed.

## Evidence boundaries

- The local Functions emulator used host Node 26 because that is the installed runtime; production is explicitly configured for Node.js 22 in both `firebase.json` and the Functions package.
- The scheduled Function is exported and its recurrence core is covered directly; the local run did not start a Pub/Sub emulator, so the scheduler transport itself was not invoked.
- Emulator OCR is explicitly labeled deterministic and reports that no live service was contacted. Production OCR fails closed until a real provider implementation/credential is configured.
- App Check enforcement is present on every callable. The required deployed uninstrumented-request rejection remains a Task 12 production canary.
- The production build retains Vite's existing advisory about large chunks; it is non-fatal and release packaging/code-splitting belongs to Task 12.
