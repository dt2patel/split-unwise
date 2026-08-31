# Task 8 Fix Round 2 Review

Date: 2026-08-31

Review baseline: `5ed2c4a`

Outcome: all 8 Important re-review findings are addressed. No browser, simulator, or Playwright claim is included; visual/device verification remains assigned to Task 12.

## Important findings addressed

1. **Principal-owned settlement operation proofs:** A restored settlement created by the active principal must retain its matching `settlement.record` ledger proof, and a void performed by that principal must retain its matching `settlement.void` proof. Shared settlements created by another member remain visible without incorrectly requiring that member's private operation ledger.
2. **Exact void replay parity:** A restored void result must exactly match the current settlement revision, sync state, operation ID, reason, actor, timestamp, and void revision. A tampered replay result now quarantines the complete document.
3. **Recoverable browser quarantine:** Production browser demo storage now writes malformed state to a principal-scoped quarantine document before removing the active corrupt copy and falling back to the safe baseline.
4. **Queue creator invariant:** Saved settlement results and conflict remotes are valid only when `createdBy` is the sender or recipient, even when a forged Activity actor is made internally consistent with the forged creator.
5. **Single safe void transition:** Firebase decoding and queue validation accept only revision 1 for an active settlement and revision 2 for its one audited void. Unsafe integers and fabricated later revisions are rejected.
6. **Dedicated payment announcement:** Settle Up keeps a persistent polite, atomic live region separate from the retained-operation list. It announces only the payment operation whose status changed and does not reannounce headings, other rows, errors, or action controls.
7. **Dedicated void announcement:** Settlement detail uses the same focused status-announcement contract for retained void retries and conflicts.
8. **Conflicted-void remount coverage:** A regression now proves exact-settlement filtering after remount, authoritative Reload without discarding the conflict, and targeted Dismiss without touching another settlement's conflict.

## Strict RED-first evidence

- Restored-state, browser-quarantine, queue-creator, conflict-creator, and decoder-revision regressions failed exactly 7 of 43 focused data tests before production changes.
- Dedicated live-region regressions failed exactly 3 of 21 settlement page tests before the shared announcement helper and persistent regions were added.
- The conflicted-void remount regression passed against the existing recovery implementation, confirming a coverage gap rather than manufacturing a production rewrite.
- A focused GREEN run passed 4 files and 64 tests, followed by TypeScript and diff checks.

## Full GREEN verification

- `pnpm test`: 43 files passed, 532 tests passed.
- `pnpm run typecheck`: passed.
- `pnpm run build`: passed; 330 modules transformed. Vite emitted only its existing large-chunk advisory.
- `git diff --check`: passed.

## Files in the fix round

- Persistence and validation: `src/data/demoRepository.ts`, `commandQueue.ts`, `firebaseDecoders.ts`, and focused Task 8 tests.
- Mobile status recovery: `SettleUpPage.vue`, `SettlementDetailPage.vue`, `useSettlementOperationAnnouncement.ts`, and `SettleUpPage.spec.ts`.

`public/assets/images/app-icon-1024.png` remains untouched and untracked for Task 12 packaging.
