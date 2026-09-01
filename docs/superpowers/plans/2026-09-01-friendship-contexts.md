# Direct Friend Expense Contexts Implementation Plan

> **Execution note:** Use the approved product design in `docs/superpowers/specs/2026-08-30-split-unwise-design.md`, follow strict test-first implementation, and run hosted verification before reporting completion.

**Goal:** Let a signed-in user add one friend by verified email, share a private invitation, and use a secure two-person expense ledger with the same expense, balance, settlement, search, and activity capabilities as a group.

**Architecture:** Model groups and friendships as two kinds of expense context stored in the existing `groups/{contextId}` ledger. Legacy documents without a kind decode as `group`. A friendship has exactly two members after invitation acceptance; Firestore rules enforce the cap, while the mobile UI presents friendship-specific naming and actions. Reusing the ledger prevents financial rules and balance calculations from diverging.

**Tech stack:** Ionic Vue 3, TypeScript, Pinia, Firebase Authentication, Cloud Firestore, Firebase Functions, Vitest, Firebase Emulator Suite, Playwright, Capacitor iOS.

---

## Task 1: Add an explicit expense-context model

**Files:**

- Modify: `src/data/repositories.ts`
- Modify: `src/data/firebaseDecoders.ts`
- Modify: `src/data/demoRepository.ts`
- Create: `src/domain/expenseContexts.ts`
- Create: `src/domain/__tests__/expenseContexts.spec.ts`
- Modify: decoder tests under `src/data/__tests__/`

1. Write failing tests proving that `group` and `friendship` are the only context kinds, legacy Firebase records decode as `group`, group selectors exclude friendships, and friendship selectors exclude groups.
2. Run `pnpm vitest run src/domain/__tests__/expenseContexts.spec.ts src/data/__tests__/firebaseDecoders.spec.ts` and confirm failures identify the missing kind and selectors.
3. Add `ExpenseContextKind = 'group' | 'friendship'` and require `kind` on the domain `Group` projection.
4. Implement pure `groupContexts` and `friendshipContexts` selectors with stable input order and no mutation.
5. Decode missing `kind` as `group`; reject any persisted value outside the supported union.
6. Mark all demo contexts as `group` and update typed fixtures.
7. Re-run the focused tests and `pnpm typecheck`.

## Task 2: Secure friendship creation and invitation acceptance

**Files:**

- Modify: `src/data/firebaseSparkMutations.ts`
- Modify: `src/data/firebaseSparkMutations.pure.ts`
- Modify: `src/data/__tests__/firebaseSparkMutations.spec.ts`
- Modify: `src/data/__tests__/firebaseSparkFlow.emulator.spec.ts`
- Modify: `firestore.rules`
- Modify: `src/data/__tests__/security.contract.spec.ts`
- Modify: `functions/src/protocol.ts`
- Modify: `functions/src/ledger.ts`
- Modify: relevant Functions tests under `functions/src/__tests__/`

1. Write failing pure and security-contract tests requiring new group documents to include a valid `kind`, requiring friendship invitations to be targeted to an email, preventing new invitations once a friendship has two members, and preventing a third member from joining.
2. Write an emulator flow that creates a friendship, accepts it as the targeted second account, verifies both user projections, then proves another active invitation and third-member join are denied.
3. Run `pnpm vitest run src/data/__tests__/firebaseSparkMutations.spec.ts src/data/__tests__/security.contract.spec.ts` and confirm the new assertions fail for the expected missing validations.
4. Extend group normalization and `createSparkGroup` with `kind`, defaulting existing callers to `group` while always persisting the explicit field.
5. Add a `createSparkFriendship` orchestration boundary that validates the friend's display name and verified email, creates a `friendship` context, and immediately creates a targeted private invitation. Return the context ID and prepared invitation URL. Preserve the created context if link preparation fails so the owner can retry from its detail page.
6. Update Firestore rules so new documents accept only `group` or `friendship`; friendship invitation creation requires a target email and fewer than two members; friendship acceptance caps membership at two. Use `get('kind', 'group')` where existing documents must remain compatible.
7. Extend the Functions request protocol and group creation handler to accept the same optional context kind and enforce the same normalized values.
8. Run focused unit tests, then `pnpm test:firebase` to verify the full rules and Functions suites.

## Task 3: Build the mobile Friends experience

**Files:**

- Create: `src/features/friends/FriendsPage.vue`
- Create: `src/features/friends/__tests__/FriendsPage.spec.ts`
- Modify: `src/features/home/HomePage.vue`
- Modify: `src/features/home/__tests__/HomePage.spec.ts`
- Modify: `src/features/groups/GroupsPage.vue`
- Modify: `src/features/groups/GroupDetailPage.vue`
- Modify: `src/features/groups/__tests__/GroupDetailPage.spec.ts`
- Modify: `src/app/router.ts`
- Modify: `src/app/__tests__/router.spec.ts`

1. Write failing component tests for a Friends entry point on Home, separation of friends from the Groups list, a mobile add-friend form with name/email/currency, pending-invitation presentation, and friendship detail copy that does not call the relationship a group.
2. Write a failing router test for `/tabs/home/friends` and durable links from each friendship row to the existing ledger route.
3. Run the focused component tests and confirm they fail because the page and filtering do not exist.
4. Implement `FriendsPage` with native Ionic toolbar, compact balance rows, loading/empty/error states, and an inline-to-sheet responsive add form. At 390 x 844, all controls must fit without horizontal scrolling and maintain 44-point targets.
5. Add the Friends card to Home with pending and settled language. Filter `GroupsPage` to `group` contexts only.
6. Make `GroupDetailPage` context-aware: friendship heading and balance language use the friend's name, the invite action disappears after two members, and all shared ledger routes continue to work without duplicating financial logic.
7. Keep animations transform/opacity based, respect reduced motion, and avoid animation of monetary values.
8. Re-run focused tests, then `pnpm test`, `pnpm typecheck`, `pnpm build`, and `pnpm cap:sync`.

## Task 4: Verify the real hosted two-account journey and publish it

**Files:**

- Modify: `src/data/__tests__/productionHosted.spec.ts`
- Modify: `scripts/production-hosted-test.sh`
- Modify: `README.md`
- Modify: `docs/implementation-status.md`
- Modify: `docs/verification.md`

1. Extend the hosted flow to create owner and friend accounts, create a targeted friendship, accept it as the friend, add a direct expense, and verify both accounts read the same balance and activity.
2. Ensure hosted proof cleanup removes the friendship ledger, invitations, projections, and temporary Authentication accounts.
3. Run the production Hosted test once against the currently deployed version to confirm it fails at the missing Friends capability.
4. Run `pnpm test:firebase`, `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm cap:sync`, and `pnpm ios:build`.
5. Perform a local 390 x 844 Playwright mobile pass covering Home, Friends, add friend, pending invitation, accepted friendship, direct expense, and nested-route refresh. Confirm no console errors or warnings.
6. Commit the verified implementation, rebuild so `/build-info.json` contains that exact commit SHA, and deploy Firestore rules plus Hosting with `firebase deploy --only firestore:rules,hosting --project split-unwise-aditya`.
7. Run the hosted two-account journey and the 390 x 844 Playwright pass against `https://split-unwise-aditya.web.app`.
8. Verify both hosting domains return HTTP 200 for root, nested routes, manifest, service worker, and build info; verify local HEAD, remote branch SHA, and hosted build SHA match exactly.
9. Remove all production proof data and temporary accounts, record measured timings and screenshots, then push the final evidence commit without rewriting history.
