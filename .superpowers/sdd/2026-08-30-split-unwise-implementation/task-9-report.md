# Task 9 Implementation Report

Date: 2026-08-31

Implementation baseline: `7783451`

Scope: Unlocked analytics, accessible charts, authorized full-history search, versioned group defaults, bounded CSV/JSON exports, and explicit import/FX provider boundaries.

## Outcome

Task 9 is implemented on the existing principal-owned repository/session/queue boundary. Totals and charts select only fresh, current expenses and fresh non-void settlements, preserve currency isolation, use checked `BigInt` intermediates, and keep period net distinct from current balance. Category, daily, monthly, member-contribution, and balance-over-time models now render as clean mobile plots with exact semantic tables, currency legends, deterministic ordering, and reduced-motion-safe animation.

Home and group search now support normalized case/diacritic-insensitive text plus group, person, category, inclusive date, amount, and currency filters. Dimensions combine with AND, selections within a dimension use OR, stable authorized facets do not disappear as results narrow, and every result reports complete or bounded source coverage.

Managers can save or clear versioned equal, percentage, or shares defaults with expected-revision conflict protection. Defaults seed future new drafts only; payers, existing expenses, recurring records, and itemized receipts retain their own intent. The settings decoder, durable command queue, demo persistence, and Firebase read adapter share strict runtime validation.

CSV exports contain confirmed current transactions, explicit currency, formula-safe text, and deterministic signed member impacts. JSON backups contain allowlisted groups, members, confirmed ledger rows, immutable revisions/activity/comments, recurrence, settings, and durable receipt descriptors while excluding local receipt references, raw blobs, URLs, paths, provider material, and secrets. Client downloads enforce both 5,000-row and 5 MiB limits before Blob creation and always revoke object URLs. Transaction import and live FX remain honestly provider-gated; the FX preview contract requires source authority/timestamp and cannot relabel stored money.

## Routes and discoverability

- `/tabs/home/search` (`home-search`)
- `/tabs/groups/:groupId/search` (`group-search`)
- `/tabs/groups/:groupId/totals` (`group-totals`)
- `/tabs/groups/:groupId/charts` (`group-charts`)
- `/tabs/groups/:groupId/settings` (`group-settings`)
- `/tabs/groups/:groupId/export` (`group-export`)
- `/tabs/account/export` (`account-export`)

All routes are registered before the generic group route, hide global app chrome, validate scalar group context, use exact back paths, and are discoverable from Home, Group, or Account. Premium routes are lazy-loaded to reduce the initial mobile bundle.

## RED-first evidence

- Report selector/aggregate suites started against missing models and then covered authority exclusions, settlement semantics, multi-currency isolation, category/daily/monthly/member/balance series, safe-integer overflow, and same-date persisted timestamp ordering.
- Search suites started against a missing search domain and then covered Unicode normalization, AND/OR filter semantics, malformed ranges, fresh/current authority, both client ceilings, stable facets, named participants, result destinations, and honest coverage.
- Group settings suites started against missing contracts and then covered manager/revision gates, exact runtime schemas, active-member ratio keys, membership invalidation, valid percentage seeding, durable demo persistence, queue quarantine, and future-draft-only precedence.
- Export suites started against missing typed exporters and then covered deterministic rows/impacts, formula injection, strict JSON, audit history, receipt allowlists, exact row/byte boundaries, Blob suppression, URL cleanup, and direct group authorization.
- Provider suites started against a missing adapter and then covered explicit unavailable states, no command emission from unverified imports, verified FX authority/timestamp, checked conversion, and immutable source money.
- Page and router suites covered named routes, hidden chrome, one `h1`, exact back paths, complete/bounded copy, no results, semantic chart tables, all visual plot series, provider states, and no subscription/paywall language.

## Final GREEN verification

- `pnpm test`: 55 files passed, 596 tests passed.
- `pnpm typecheck`: passed (`vue-tsc --noEmit`).
- `pnpm build`: passed; 353 modules transformed. Premium routes emitted separate lazy chunks. Vite emitted only its existing large-session-chunk advisory.
- `git diff --check`: passed with no whitespace errors.

No browser or Playwright validation was run because the user has not approved browser automation. Component/source accessibility and responsive CSS checks are complete; same-viewport device evidence remains assigned to Task 12.

## Self-review

- Confirmed reports, search, CSV, and JSON never include stale/pending/failed/conflicted projections in authoritative results.
- Confirmed currencies never combine or convert without an explicit verified FX rate authority and timestamp.
- Confirmed direct group exports fail closed for non-members before audit history is read.
- Confirmed malformed group search/export routes cannot widen into account scope, CSV rows cannot escape the fresh authorized group set, and embedded revision snapshots must match their audit identity.
- Confirmed JSON export uses explicit field construction rather than dumping repository objects, and excludes comment/revision attachment references unless represented by validated durable descriptors.
- Confirmed settings command persistence rejects extra fields, duplicate participants, mismatched ratio keys, and invalid percentages before replay.
- Confirmed concurrent settings conflicts reload the authoritative revision and that invalid defaults cannot block or overwrite existing expense edits.
- Confirmed every premium screen has one page heading, 44-point controls, safe-area padding, Dynamic Type wrapping/reflow, textual chart values, and global reduced-motion handling.

## Residual boundaries

- Firebase full-history search and large authenticated export jobs remain explicitly unavailable until Task 11 deploys and proves their providers.
- Transaction import and live currency conversion require verified external providers and credentials; the app does not simulate either capability.
- Browser/device visual comparison and runtime accessibility evidence remain Task 12 work under the user's no-browser-automation boundary.
- `public/assets/images/app-icon-1024.png` remains untouched and untracked for Task 12 asset integration.
