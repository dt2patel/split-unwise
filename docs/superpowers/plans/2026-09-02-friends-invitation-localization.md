# Friends and Invitation Localization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a locale-reactive, safe, mobile-usable Friends and invitation journey across all eight supported locales without changing the proven invitation security model.

**Architecture:** Keep the existing Firestore and Spark invitation paths intact. Friends and Invite preparation retain feedback as typed semantic messages resolved by `useI18n`; the public invitation page uses a discriminated state whose copy is computed from the selected locale. Extend the exact-SHA hosted journey to exercise Spanish Friends and invitation acceptance at mobile widths.

**Tech Stack:** Ionic Vue 9, Vue 3, TypeScript 6, Pinia, Firebase JS SDK 12, Vitest 4, Playwright, Capacitor iOS.

**Spec:** `docs/superpowers/specs/2026-09-02-friends-invitation-localization-design.md`

## Global Constraints

- Keep the existing Firestore invitation schema, security rules, Functions, Storage, Auth configuration, and 256-bit fragment secret unchanged.
- Support exactly `en`, `es`, `de`, `nl`, `fr`, `it`, `pt-BR`, and `pt-PT`; every catalog has the exact English key set and matching placeholders.
- Never translate user data or display an arbitrary `Error.message`.
- Retained status/error feedback must rerender when locale changes without repeating the operation.
- Preserve current group/friend invitation acceptance, verified-email recovery, seven-day expiry, single-use behavior, and friendship cap.
- Preserve `.artifacts/**`, `ios/DerivedDataFresh/**`, and `output/**`.
- All behavior changes use a witnessed RED-GREEN test cycle.
- Every release gate includes the hosted production app and native iOS gesture proof on the exact deployed SHA.

---

### Task 1: Localize Friends and fix semantic feedback

**Files:**
- Modify: `src/features/friends/FriendsPage.vue`
- Modify: `src/features/friends/__tests__/FriendsPage.spec.ts`
- Modify: `src/app/i18n.ts`
- Modify: `src/app/__tests__/i18n.spec.ts`

**Interfaces:**
- Consumes: `ApplicationError`, `displayMessageFor`, `displayMessageText`, `ApplicationMessage`, and `DisplayMessage` from `src/app/displayMessages.ts`.
- Produces: the `friends.*` catalog contract from the spec, semantic `createError`/`notice` state, and gender-neutral Activity restore copy in four locales.

- [ ] **Step 1: Write failing Friends localization and message-boundary tests**

Add component tests whose expected literals are independently specified:

```ts
localeController.setPreference('es')
expect(wrapper.get('h1').text()).toBe('Amigos')
expect(wrapper.get('[aria-label="Añadir amigo"]').exists()).toBe(true)
expect(wrapper.text()).toContain('Invitación pendiente')
```

Inject an ordinary failure with the text `Firestore secret diagnostic` and assert the UI shows the Spanish generic add failure but not that diagnostic. Change the preference to `de` after the failure and assert the already-visible error changes to the German catalog value without invoking creation again. Add the same reactivity assertion for a successful invitation-ready notice containing the unchanged target email.

- [ ] **Step 2: Run the focused tests and witness the expected RED state**

Run: `pnpm vitest run src/features/friends/__tests__/FriendsPage.spec.ts src/app/__tests__/i18n.spec.ts`

Expected: FAIL because Friends template/status/error text is still raw English and no `friends.*` keys exist.

- [ ] **Step 3: Add the typed Friends catalogs and semantic component state**

Add every `friends.*` English key from the spec, then idiomatic translations with identical placeholders to all seven non-English catalogs. Reuse identical existing keys named in the spec. Convert `createError` to `Ref<DisplayMessage | undefined>` and `notice` to `Ref<ApplicationMessage | undefined>`; render both through computed `displayMessageText(..., t)`. Throw `ApplicationError` for page-owned validation/runtime states and route all other failures through `displayMessageFor(reason, 'friends.error.addFailed')`.

Replace every application-owned literal in the Friends template and its `friendStatus`/`directionLabel` helpers. Select singular/other context keys from the actual count. Keep friend/group names, emails, currency codes, and money unchanged.

- [ ] **Step 4: Correct the four gendered Activity restore notices**

Apply the exact French, Italian, pt-BR, and pt-PT strings in the spec. Add literal assertions to `i18n.spec.ts` for `activity.defaultExpense` interpolated into both restore notice keys so a future gendered regression is caught.

- [ ] **Step 5: Run focused verification until GREEN**

Run: `pnpm vitest run src/features/friends/__tests__/FriendsPage.spec.ts src/app/__tests__/i18n.spec.ts`

Expected: PASS with the ordinary diagnostic absent, locale-reactive retained feedback, exact user-data interpolation, and catalog completeness enforced by TypeScript.

- [ ] **Step 6: Run typecheck and commit**

Run: `pnpm typecheck`

```bash
git add src/features/friends/FriendsPage.vue src/features/friends/__tests__/FriendsPage.spec.ts src/app/i18n.ts src/app/__tests__/i18n.spec.ts
git commit -m "Localize Friends feedback"
```

### Task 2: Localize invitation preparation and landing states

**Files:**
- Create: `src/features/invitations/__tests__/InviteSheet.spec.ts`
- Modify: `src/features/invitations/InviteSheet.vue`
- Modify: `src/features/invitations/InvitationLandingPage.vue`
- Modify: `src/features/invitations/__tests__/InvitationLandingPage.spec.ts`
- Modify: `src/app/i18n.ts`
- Modify: `src/app/__tests__/i18n.spec.ts`

**Interfaces:**
- Consumes: semantic display-message contract from `src/app/displayMessages.ts` and `locale`/`t` from `useI18n()`.
- Produces: complete `invite.*` and `inviteLanding.*` catalogs from the spec; locale-aware expiry formatting; a discriminated landing state that never retains rendered text.

- [ ] **Step 1: Write failing Invite preparation tests**

Mount the page with a manageable Firebase group and Spanish locale. Assert `Invitar personas`, `Invitar a Viaje`, an optional target-email field, and a translated prepare action. Make preparation reject `new Error('Firebase internal diagnostic')`; assert the Spanish generic failure is visible, the diagnostic is absent, and switching to German changes the same visible error without a second call. Resolve a prepared invitation and assert the target email/link are unchanged while status/date/controls are localized.

- [ ] **Step 2: Write failing invitation-landing state tests**

Extend the existing unverified-email and verified-resume tests with Spanish literals and exact unchanged group/email interpolation. Add a test that stores an action failure semantically, changes locale, and observes the translated retained status. Add an ordinary acceptance failure containing `sensitive internal acceptance detail` and assert only the localized generic acceptance error appears.

- [ ] **Step 3: Run the focused tests and witness the expected RED state**

Run: `pnpm vitest run src/features/invitations/__tests__/InviteSheet.spec.ts src/features/invitations/__tests__/InvitationLandingPage.spec.ts src/app/__tests__/i18n.spec.ts`

Expected: FAIL because both components retain raw English strings and Invite preparation still exposes ordinary `Error.message` values.

- [ ] **Step 4: Add complete invitation catalogs**

Add every `invite.*` and `inviteLanding.*` English key from the spec and idiomatic translations with identical placeholders in all seven non-English catalogs. Keep the catalog type exact; do not add fallback-only keys or omit regional Portuguese variants.

- [ ] **Step 5: Implement semantic Invite preparation feedback**

Use `ApplicationError` for invalid group, manager-only, Firebase-not-ready, and invalid-response conditions. Keep `error` as `DisplayMessage | undefined` and `status` as `ApplicationMessage | undefined`, resolved by computed values. Map share results to the exact `invite.status.*` keys. Use `displayMessageFor(reason, 'invite.error.prepareFailed')` and the separate revoke fallback. Format expiry with `new Intl.DateTimeFormat(locale.value, ...)` and route all template copy through `t`.

- [ ] **Step 6: Implement the invitation landing state machine**

Replace the rendered `message` string with discriminated semantic state carrying only required data such as `groupId`, `groupName`, `email`, and reason. Compute visible copy from `t` on every render. Keep the current verification recovery decision, but isolate its legacy service-message recognition inside a classifier that returns a semantic reason and never exposes service text. Route verification/send/accept failures to localized application fallbacks; preserve the secret capture/consumption and router behavior exactly.

- [ ] **Step 7: Run focused verification until GREEN and commit**

Run: `pnpm vitest run src/features/invitations/__tests__/InviteSheet.spec.ts src/features/invitations/__tests__/InvitationLandingPage.spec.ts src/features/invitations/__tests__/invitations.spec.ts src/app/__tests__/i18n.spec.ts`

Run: `pnpm typecheck`

```bash
git add src/features/invitations/InviteSheet.vue src/features/invitations/InvitationLandingPage.vue src/features/invitations/__tests__/InviteSheet.spec.ts src/features/invitations/__tests__/InvitationLandingPage.spec.ts src/app/i18n.ts src/app/__tests__/i18n.spec.ts
git commit -m "Localize invitation journeys"
```

### Task 3: Extend hosted mobile localization proof

**Files:**
- Modify: `scripts/runHostedBrowserProof.mjs`
- Modify: `scripts/__tests__/hostedBundleContract.spec.ts`

**Interfaces:**
- Consumes: Spanish Friends/Invite/landing copy from Tasks 1 and 2 and the existing hosted fixture accounts/group.
- Produces: exact-SHA proof for Spanish Friends at 390/320 px, Spanish invite preparation, Spanish existing-account acceptance, and visible Ionic scroll-host overflow detection.

- [ ] **Step 1: Write a failing hosted-proof contract test**

Extend the executable contract fixture so removing any of these behaviors makes the test fail: navigation to `/tabs/home/friends` while Spanish is selected; the Spanish Friends heading; `assertNoHorizontalOverflow` at 390 and 320 px; Spanish invite preparation heading/action; and a verified invitation landing reload that retains its session token while switching to Spanish.

- [ ] **Step 2: Run the contract test and witness RED**

Run: `pnpm vitest run scripts/__tests__/hostedBundleContract.spec.ts`

Expected: FAIL because the hosted script has no localized Friends or invitation checks.

- [ ] **Step 3: Add hosted Spanish Friends and invite coverage**

In `verifyLanguagePreference`, visit `/tabs/home/friends` before restoring English, require the Spanish heading and intro, and call `assertNoHorizontalOverflow` at 390 px and again at 320 px before restoring 390 px. During invitation preparation, select Spanish through the persisted language setting, require the localized group-name heading/action/link label, assert overflow, then restore English for unrelated existing selectors.

For existing-account acceptance, sign in first, preserve the captured token in session storage, set `split-unwise.locale` to `es`, reload the fragment-free invitation route, require `Te invitaron a unirte a Live Account Proof.` and `Unirse al grupo`, and complete the existing acceptance. Do not weaken any existing member-removal, verification-recovery, cleanup, console, or exact-SHA assertion.

- [ ] **Step 4: Run contract and nearby tests until GREEN**

Run: `pnpm vitest run scripts/__tests__/hostedBundleContract.spec.ts src/features/invitations/__tests__/InvitationLandingPage.spec.ts src/features/friends/__tests__/FriendsPage.spec.ts`

Expected: PASS.

- [ ] **Step 5: Commit hosted proof coverage**

```bash
git add scripts/runHostedBrowserProof.mjs scripts/__tests__/hostedBundleContract.spec.ts
git commit -m "Test hosted localized invitations"
```

### Task 4: Verify and release the exact reviewed SHA

**Files:**
- Modify only if generated by the established release commands: `dist/**`, `ios/App/App/public/**`

**Interfaces:**
- Consumes: reviewed commits from Tasks 1–3.
- Produces: matching local/GitHub/Hosting/native build SHA and complete local, Firebase, hosted, and iOS evidence.

- [ ] **Step 1: Run the complete Node 22 app and Firebase gates**

Run with the configured Node 22 runtime:

```bash
pnpm test
pnpm test:firebase
pnpm build
pnpm cap:sync
pnpm ios:build
```

Expected: all commands exit 0; `verify:dist` reports the complete artifact set.

- [ ] **Step 2: Perform the final whole-slice review**

Review the full plan range for spec compliance, localization completeness, safe error boundaries, invitation security preservation, mobile overflow, test honesty, and unrelated regressions. Resolve every Critical or Important finding before release.

- [ ] **Step 3: Push and deploy the exact reviewed SHA**

Push the same-name branch with an explicit non-force refspec. Deploy Firebase Hosting only to `split-unwise-aditya`; this slice does not authorize or require Functions, rules, Storage, Extensions, or Auth configuration changes.

- [ ] **Step 4: Run exact deployed hosted and native proof**

Run `pnpm test:hosted` with the established exact-commit environment and the iOS gesture proof enabled. Require the production SDK test, complete browser journey, Spanish Friends/invitation additions, one executed passing native gesture test, cleanup, and zero console errors.

- [ ] **Step 5: Reconcile release identity**

Verify local `HEAD`, `origin/codex/split-unwise-build`, `git ls-remote`, Hosting `/build-info.json`, web bundle metadata, and synced iOS public assets all equal the same full commit SHA. Keep the broader every-feature goal active after this slice.
