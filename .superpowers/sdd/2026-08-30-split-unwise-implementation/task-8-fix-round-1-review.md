# Task 8 Fix Round 1 Review

Date: 2026-08-31

Review baseline: `a1cc7a2`

Outcome: all 2 Critical and 12 Important findings are addressed. No browser or Playwright claim is included; the assigned browser/device verification boundary remains Task 12.

## Critical findings addressed

1. **Cross-command persistence rollback:** Demo financial commands now execute through one serialized persistence boundary. A rejected earlier `stateStorage.save` restores only its own command snapshot and cannot erase a later saved settlement. The deferred-save regression releases the failed write after a later settlement is requested and proves the later settlement and balance revision remain authoritative.
2. **Remount-safe operation identity:** Settlement record and void commands now use collision-resistant client operation IDs based on `crypto.randomUUID`, with a timestamp/random fallback for runtimes without it. Record/remount/record and void/remount/void regressions prove distinct durable operations and effects.

## Important findings addressed

1. **Authoritative acknowledgement revision:** `settlementStore` acknowledges a saved operation only when refreshed reads contain both the settlement revision and a balance snapshot at least as new as the saved result.
2. **Restored demo-state decoding:** Persisted settlements, settlement Activity, and settlement operation-ledger results are decoded and cross-checked for money, basis, actors, revisions, void audit, subject identity, and immutable result identity. Invalid state is quarantined as one document and the repository falls back to its safe baseline.
3. **Real v5 principal-key migration:** Browser queue storage discovers the actual principal-scoped v5 key, quarantines it under v6, removes the legacy key, persists an empty v6 document, and executes none of its operations.
4. **Persisted record intent validation:** Restored v6 `settlement.record` envelopes with `outsidePaymentConfirmed: false` or an amount above the selected basis debt are quarantined before any handler call.
5. **Conflict identity validation:** Settlement conflict payloads are accepted only when group, settlement, remote record, and balance snapshot identities exactly match the originating command. Runtime mismatches are scrubbed to an invalid-conflict reason; persisted mismatches are quarantined.
6. **Firebase creator identity:** `decodeSettlement` rejects a `createdBy` actor who is neither the settlement sender nor recipient.
7. **Safe revision exhaustion:** Record and void reject at `Number.MAX_SAFE_INTEGER` before timestamp, settlement, Activity, ledger, persistence, or balance side effects.
8. **Durable Activity destinations:** Saved settlement-created and settlement-voided events link to `/tabs/groups/:groupId/settlements/:settlementId` after strict structured-ID validation.
9. **Retained recovery UI:** Settlement detail filters retained void operations by exact settlement ID and restores Pending, Failed, and Conflict status after remount. Failed operations expose Retry/Discard; conflicts expose Reload/Dismiss. Settle Up conflicts likewise reload authoritative state or dismiss the retained conflict instead of rendering inert text.
10. **Truthful provider handoffs:** Only the selected debt's sender can open a payer-mode provider URL. Recipient accounts see an explicit unavailable explanation. Invalid, zero, or over-limit amount input makes every handoff unavailable and never substitutes the full debt.
11. **Keyboard and focus behavior:** Both Ionic plan segments handle `ionChange` in addition to pointer clicks, and the visually hidden debt radio receives a visible label-level `:focus-within` ring.
12. **Touch target and live status:** The provider anchor itself has a 44 by 44 point minimum target, and the Payment updates region exposes polite status semantics.

## Strict RED-first evidence

- Deferred save rejection and page-remount operation-ID regressions failed before command serialization and collision-resistant IDs; the remount pair produced exactly 2 failures in the 13-test page suite.
- Saved-result/stale-snapshot acknowledgement failed 1 of 5 settlement-store tests before the balance-revision gate.
- Malformed restored settlement state failed 6 of 17 repository tests before strict decode/quarantine.
- Real v5 storage plus false-confirmation/overpay envelopes failed 3 of 12 queue tests; three conflict-identity cases then failed before the same queue cluster reached 15/15.
- Unrelated Firebase creator failed 1 of 3 decoder tests.
- Record and void revision exhaustion failed exactly 2 of 19 repository tests by resolving with revision `9007199254740992`.
- Settlement Activity destinations failed exactly 2 of 13 Activity tests.
- Conflict actions and failed-void remount recovery failed exactly 2 of 14 page tests.
- Recipient-mode and invalid-amount provider behavior failed exactly 2 of 16 page tests.
- Final mobile interaction/accessibility RED was 5 of 19: both `ionChange` paths, live Payment updates semantics, provider-anchor sizing, and the visible debt-radio focus ring.

## GREEN verification

- Data/queue focus: 7 files passed, 130 tests passed.
- Final Activity/settlement UX focus: 4 files passed, 40 tests passed.
- `pnpm test`: 43 files passed, 524 tests passed.
- `pnpm typecheck`: passed.
- `pnpm build`: passed; 329 modules transformed. Vite emitted only its existing large-chunk advisory.
- `git diff --check`: passed.

## Files in the fix round

- Data and recovery: `src/data/commandQueue.ts`, `demoRepository.ts`, `firebaseDecoders.ts`, `clientOperationId.ts`, and their Task 8/repository tests.
- Activity and settlement state: `src/features/activity/activityStore.ts`, `src/features/balances/settlementStore.ts`, and focused tests.
- Mobile UI: `BalancesPage.vue`, `SettleUpPage.vue`, `SettlementDetailPage.vue`, and `SettleUpPage.spec.ts`.

`public/assets/images/app-icon-1024.png` remains untouched and untracked.
