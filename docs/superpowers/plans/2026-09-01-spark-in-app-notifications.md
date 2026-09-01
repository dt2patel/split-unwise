# Spark In-App Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing in-app notification center fully functional on the production Spark deployment, including durable individual and bulk read state, without claiming email or push delivery.

**Architecture:** Reuse the authorized account-activity aggregation as the notification source when Cloud Functions projections are unavailable. Exclude the signed-in actor's own events, overlay owner-only read receipts plus a replay-safe read-all cursor, and preserve the existing server-projection path for future Blaze deployments.

**Tech Stack:** Ionic Vue, TypeScript, Firebase Auth/Firestore Web SDK, Firestore Security Rules, Vitest, Firebase Emulator Suite.

**Spec:** `docs/superpowers/specs/2026-08-30-split-unwise-design.md`

## Global Constraints

- Group membership remains the authorization boundary.
- Read state is private to the authenticated principal and cannot mutate activity.
- Every write is replay-safe and uses the existing command identity contract.
- Account reads remain bounded to 100 groups and 100 activity rows per group.
- Email and push delivery are provider capabilities and are not inferred from in-app notification state.

---

### Task 1: Deterministic Private Read-State Records

**Files:**
- Modify: `src/data/firebaseSparkMutations.ts`
- Test: `src/data/__tests__/firebaseSparkMutations.spec.ts`

**Interfaces:**
- Consumes: `NotificationReadCommand`, `NotificationReadAllCommand`, `NotificationItem`, and `OperationIdentity`.
- Produces: `buildSparkNotificationReadRecord(...)` and `buildSparkNotificationReadAllRecord(...)`.

- [x] Write a failing builder test proving a normalized private read receipt includes the exact notification/activity/group identity, command replay fields, and commit timestamp.
- [x] Run `pnpm vitest run src/data/__tests__/firebaseSparkMutations.spec.ts` and confirm the builder is missing.
- [x] Implement the minimal receipt and cursor builders using `parseExecuteCommandRequest` and `assertSparkPrivateOperationIdentity`.
- [x] Rerun the focused test and confirm it passes.

### Task 2: Rules-Protected Owner Read State

**Files:**
- Modify: `firestore.rules`
- Test: `src/data/__tests__/security.emulator.spec.ts`
- Test: `src/data/__tests__/security.contract.spec.ts`

**Interfaces:**
- Consumes: receipt/cursor documents from Task 1.
- Produces: owner-only create access under `users/{uid}/notificationReads/{notificationId}` and replay-safe create/update access for `users/{uid}/settings/sparkNotificationReadCursor`, isolated from the Functions projection cursor schema.

- [x] Write a failing emulator test proving an owner may save exact read state while another user, malformed identity, physical delete, and unrelated settings update are denied.
- [x] Run the focused emulator test and confirm permission denial on the intended owner write.
- [x] Add strict shape, replay, immutable receipt, and monotonic cursor rules.
- [x] Rerun the focused emulator test and contract suite.

### Task 3: Spark Notification Repository

**Files:**
- Modify: `src/data/firebaseRepository.ts`
- Test: `src/data/__tests__/firebaseSparkFlow.emulator.spec.ts`

**Interfaces:**
- Consumes: `activity.listForAccount`, private receipts/cursor, and Task 1 builders.
- Produces: Spark implementations of `notifications.list`, `unreadCount`, `markRead`, and `markAllRead`.

- [x] Write a failing two-account emulator flow: one member creates group activity, the other sees it as unread, records/replays individual read state, then records/replays an inclusive read-all cursor without including self-authored activity.
- [x] Run the flow and confirm it fails because Spark notification reads are unsupported.
- [x] Implement bounded activity projection, read-state overlay, replay handling, and cache invalidation after writes.
- [x] Rerun the two-account flow and existing notification component tests.

### Task 4: Hosted Production Proof And Release

**Files:**
- Modify: `src/data/__tests__/productionHosted.spec.ts`
- Modify: `docs/firebase-deployment.md`
- Modify: `docs/verification.md`

**Interfaces:**
- Consumes: Tasks 1-3 and the existing hosted two-account proof.
- Produces: deployed rules/client, real production notification evidence, and an exact source release.

- [x] Extend the hosted flow to prove cross-account unread notification, individual read/replay, read-all/replay, and self-event exclusion.
- [x] Run typecheck, the full unit/component suite, Firebase emulator suite, production build, Capacitor sync/build, and `git diff --check`.
- [ ] Commit and push the exact branch without force.
- [ ] Build with `VITE_BUILD_COMMIT=$(git rev-parse HEAD)` and deploy Hosting plus Firestore rules to `split-unwise-aditya`.
- [ ] Run the hosted suite against `https://split-unwise-aditya.web.app`, verify root/deep routes and `/build-info.json`, delete exact proof data, and confirm Auth/Firestore cleanup.
