# Final review fix report

Status: DONE

Base: `6be164f79faf0c7c189765c42884dc99c6566827`

Runtime: Node `v22.23.2` from `/Users/adityapatel/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin/node`.

## Intent and test changes caught

This wave resolves the two Important final-review findings without changing invitation creation, validation, token handling, backend/security configuration, or hosted fixture state.

- Localized share boundary: the helper behavior test catches a Web Share payload that drops the selected-locale title/body or changes the prepared URL. Friends and Invite component tests catch either caller passing only the URL. The Friends behavior test additionally catches discarding the manual result URL, rendering a mutable/unlabelled/unassociated control, placing the promised control before the “below” instruction, freezing its accessible label across locale changes, or leaving a stale manual URL after a later non-manual result.
- Hydrated Spanish Friends proof: the structural hosted contract catches removal or reordering of the explicit 390 px starting viewport, known `.friend-entry` readiness, exact localized hydrated context, row expansion, visible breakdown, localized add-friend action, visible form, either overflow check, 390 px restoration, form closure, or row collapse. The existing contract still binds `verifySpanishFriendsLocalization(page)` into the Spanish language journey, so the helper cannot remain as dead source.

## Witnessed RED

First test-first command:

```sh
PATH=/Users/adityapatel/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin:$PATH pnpm vitest run src/features/invitations/__tests__/invitations.spec.ts src/features/friends/__tests__/FriendsPage.spec.ts src/features/invitations/__tests__/InviteSheet.spec.ts src/app/__tests__/i18n.spec.ts scripts/__tests__/hostedBundleContract.spec.ts
```

Exit `1`: 5 files failed; 5 tests failed and 31 passed. The failures were the expected behavior assertions:

- the share helper returned `manual` instead of `shared` because it did not accept the localized-copy argument;
- Friends and Invite called the helper with only the URL;
- the English catalog lacked `invite.shareTitle` and `invite.shareBody`;
- the hosted helper lacked the hydrated fixture-row sequence.

The Friends failure stopped at the caller-argument assertion before reaching the also-missing manual textarea, so the same finalized test covers both defects in GREEN.

Second narrow test-first command:

```sh
PATH=/Users/adityapatel/.npm/_npx/52027bd8fc0022aa/node_modules/node/bin:$PATH pnpm vitest run src/features/friends/__tests__/FriendsPage.spec.ts scripts/__tests__/hostedBundleContract.spec.ts
```

Exit `1`: 2 files failed; 2 tests failed and 14 passed. The manual status/control order assertion received `0`, and the hosted order contract could not find the Spanish heading after an explicit initial 390 px viewport action. This proved both final determinism adjustments were absent before implementation.

## Minimal implementation

### Finding 1: localized sharing and usable Friends fallback

- `sharePreparedInvitation` now requires typed `{ title, text }` application copy, still validates the URL before reaching Web Share/clipboard/manual fallback, and passes the validated URL unchanged in the Web Share payload and manual result.
- Friends and Invite resolve `invite.shareTitle` and `invite.shareBody` through `t(...)` at the user action, so the currently selected locale supplies the OS share payload.
- All eight catalogs contain both keys with no placeholders; the existing exact-key and placeholder-multiset catalog test covers parity.
- Friends retains only a `manual` result URL and renders it in a read-only textarea with the locale-reactive prepared-URL label, focus selection, and `aria-describedby` association to the preceding manual status. Creating another friend or receiving any later non-manual share result clears the stale manual URL.
- No catch, diagnostic, status discriminant, clipboard order, prepared-link validation, invitation security, or data flow changed.

### Finding 2: deterministic hydrated Spanish Friends overflow proof

- `verifySpanishFriendsLocalization` explicitly establishes 390 x 844, waits up to 120 seconds for the known `Live Proof Friend` `.friend-entry` and exact `En 2 contextos compartidos` hydrated copy, expands that row and waits for its real breakdown, opens the real localized `Añadir amigo` form, then checks both 390 px and 320 px with the existing document-plus-visible-Ionic-scroll-host helper.
- The helper restores 390 x 844, closes the add-friend form, waits for it to be hidden, collapses the fixture row, and waits for the breakdown to be hidden before the later localized journey continues.
- The structural contract requires every readiness/action/check/restoration in order and preserves the existing helper-invocation wiring.

## Witnessed GREEN and verification

- Five-file focused GREEN: exit `0`; 5 files and 36 tests passed.
- Second focused GREEN: exit `0`; 2 files and 16 tests passed.
- `pnpm typecheck`: exit `0`; shared TypeScript build and `vue-tsc --noEmit` passed on Node 22.
- `node --check scripts/runHostedBrowserProof.mjs`: exit `0` with no output.
- `git diff --check`: exit `0` with no output.

Vitest emitted only the pre-existing installed Ionic source-map warnings.

## Changed files

- `src/features/invitations/shareInvitation.ts`
- `src/features/invitations/__tests__/invitations.spec.ts`
- `src/features/friends/FriendsPage.vue`
- `src/features/friends/__tests__/FriendsPage.spec.ts`
- `src/features/invitations/InviteSheet.vue`
- `src/features/invitations/__tests__/InviteSheet.spec.ts`
- `src/app/i18n.ts`
- `src/app/__tests__/i18n.spec.ts`
- `scripts/runHostedBrowserProof.mjs`
- `scripts/__tests__/hostedBundleContract.spec.ts`
- `docs/superpowers/specs/2026-09-02-friends-invitation-localization-design.md`
- `.superpowers/sdd/2026-09-02-friends-invitation-localization/final-fix-report.md`

## Self-review and preservation

- Reviewed all eight `invite.shareTitle`/`invite.shareBody` catalog entries; exact key and placeholder parity pass.
- The exact private URL is asserted at the Web Share boundary and in the read-only Friends manual control. User email, group names, invitation URLs, and tokens are not translated or mutated.
- Share copy is resolved at action time; retained manual status and accessible URL label retranslate without repeating an operation.
- The manual textarea is border-box, 100% width, non-resizable, and remains inside the existing bounded mobile invitation card. Existing 44-point Friends controls are unchanged.
- The runner diff is isolated to `verifySpanishFriendsLocalization`; prior exact-SHA, startup-asset, cleanup, console-monitoring, member-removal, unverified-email, token persistence, account-deletion, and iOS assertions remain in place.
- No push, deployment, hosted fixture journey, Firebase/GitHub/backend/security mutation, or protected untracked artifact change was performed.

## Concerns

- The live hosted proof was intentionally not run because this task forbids hosted fixture journeys. Hydrated Spanish behavior is locally protected by the strengthened executable source contract; live proof remains a later exact-deployed-SHA gate.
- Translation quality was self-reviewed for the eight supported catalogs but not independently reviewed by native speakers.
