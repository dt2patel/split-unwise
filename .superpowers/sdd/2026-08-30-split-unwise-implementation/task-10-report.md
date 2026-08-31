# Task 10 report — Account, authentication, appearance, and invitations

## Delivered

- Added a session-independent Ionic boot/auth surface so Firebase loading, signed-out, configuration-error, observer-error, and missing-profile states render without constructing a repository, queue, receipt store, or feature store.
- Replaced silent Firebase fallback with a validated three-way runtime union: visibly labelled demo, complete Auth/Firestore core, or fatal partial/malformed Firebase intent. Storage, Functions, App Check, push, Google, and Apple are explicit capability states.
- Added one exact named Firebase bootstrap shared by Auth and Firestore. Existing apps are accepted only when every core and optional option matches.
- Added a private `AuthIdentity` model, Firebase hydration observer, email sign-in/sign-up, password reset, verification email, Google popup/redirect behavior, cancellation handling, mobile redirect preference, and explicit unavailable Apple capability.
- Added `/auth`, `/invite/:invitationId`, `/tabs/account`, `/tabs/account/appearance`, `/tabs/account/currencies`, and group invitation routes, plus hydration-aware Firebase tab guards and sanitized one-shot internal return paths.
- Replaced the Account placeholder with native iOS grouped settings for profile, notification delivery, appearance, all supported ISO currencies, export, offline/local data, sign-out, and deletion readiness.
- Added a pre-mount appearance controller for `system | light | dark`, Ionic class palettes, OS color updates only in system mode, contrast in every mode, theme-color updates, listener cleanup, invalid storage fallback, and reduced-motion preservation.
- Added UID/project/mode-scoped currency preferences. They order the complete picker and seed only new unscoped drafts; group and existing expense money remain authoritative.
- Added reversible session quiescing, unresolved work counts, scoped Keep/Discard decisions, pending-work preservation, safe resume on cancellation/failure, terminal queue clearing, receipt clearing, and exact-principal browser key/database cleanup without broad storage deletion.
- Added invitation primitives with 256-bit fragment secrets, SHA-256 hashing, seven-day expiry, canonical HTTPS links, immediate history stripping, one-time in-memory consumption, status evaluation, and opaque resume nonces. Production creation/inspection/acceptance remains explicitly server-required until Task 11; demo is clearly a local preview.
- Added system-share, cancellation, clipboard, and selectable manual-link fallbacks. Nothing sends automatically.

## Self-review corrections

- Optional Firebase capability variables can be absent or blank without disabling valid Auth/Firestore core, while optional-only configuration and invalid Google flags still fail closed.
- Missing Firebase member profiles now become an actionable boot error instead of a permanent loading spinner.
- Local-data clearing now empties the live principal queue and open receipt store before removing scoped browser records, avoiding immediate re-persistence or a blocked IndexedDB deletion.
- Targeted invitation evaluation treats a verified identity with no email as a mismatch rather than throwing.
- Auth validation now links name, email, and password errors to their fields before any SDK call.

## Verification

- `pnpm typecheck`: pass.
- `pnpm test`: 65 files, 631 tests passing.
- `pnpm build`: pass; 379 modules transformed. Vite reports its existing large-chunk advisory only.
- `git diff --check`: pass.
- Secret/storage audit: no credential persistence, no broad `localStorage.clear()`, no raw invitation token in query/history/queue/export/analytics, and one named Firebase initializer.

## Deferred to bound downstream tasks

- Task 11: callable-backed account profile bootstrap, financial mutations, invitations/resume exchange, receipt promotion, rules, indexes, emulator evidence, and production capability activation.
- Task 12: tracked icon/PWA/Capacitor assets, iOS project, simulator/device visual and accessibility evidence, and Firebase Hosting deployment.
