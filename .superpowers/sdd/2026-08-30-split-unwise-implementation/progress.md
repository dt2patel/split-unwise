# SDD ledger — plan: docs/superpowers/plans/2026-08-30-split-unwise-implementation.md

Branch start: `be56077` on `codex/split-unwise-build`.

## Preflight scan

| Scope | Produces / consumes | Finding |
|---|---|---|
| Task 1 | Produces Ionic app, router, theme, test harness | Internally consistent; later tasks depend on its router and tooling. |
| Task 2 | Produces domain types and pure calculations | Internally consistent; no UI or repository dependency. |
| Task 3 | Consumes Task 2 types; produces repository contracts and demo/Firebase adapters | Internally consistent; Firebase configuration remains optional at runtime. |
| Task 4 | Consumes Task 1 shell; produces shared components and motion tokens | Internally consistent; custom motion must preserve Ionic navigation. |
| Task 5 | Consumes Tasks 3–4; produces home/groups/journal routes | Internally consistent; selected visual target is authoritative for group detail. |
| Task 6 | Consumes Tasks 2–5; produces drafts and add/edit flows | Internally consistent; receipt OCR can use a provider adapter while manual itemization remains functional. |
| Task 7 | Consumes Tasks 3 and 6; produces detail/activity/comments/notifications | Internally consistent; immutable revisions remain authoritative. |
| Task 8 | Consumes Tasks 2–3; produces balances and settlements | Internally consistent; provider links cannot imply confirmed transfer. |
| Task 9 | Consumes Tasks 2–3 and journal data; produces analytics/search/defaults/exports | Internally consistent; chart rendering must remain accessible. |
| Task 10 | Consumes Task 3 environment selection; produces auth/account/invitations | Internally consistent; demo mode and Firebase mode share repository interfaces. |
| Task 11 | Consumes Task 3 collection model and Task 2 invariants; produces Firebase resources | Internally consistent; Functions deployment may depend on project billing. |
| Task 12 | Consumes all earlier tasks; produces verified preview and Firebase deployment | Internally consistent; production provider activation is separately evidenced. |
| Tasks 1 → 4/5/10 | Router and Ionic app shell feed every routed UI slice | Interface is explicit; route names must remain centralized in `src/app/router.ts`. |
| Tasks 2 → 3/6/8/9/11 | Domain types and arithmetic feed persistence, UI validation, reports, and rules | Interface is explicit; minor-unit integers are invariant across all consumers. |
| Task 3 → 5–10 | Repository contracts feed all feature stores/pages | Interface is explicit; feature code must not import Firestore directly. |
| Task 4 → 5–10 | Shared components and motion tokens feed product UI | Interface is explicit; reduced-motion behavior applies globally. |
| Task 5 ↔ 6/7/8/9 | Group context routes into expense, activity, settlement, and analysis | No contradiction; shared routes remain in the originating tab stack. |
| Task 6 → 7/8/9 | Expense revisions feed details, balances, and analytics | No contradiction; edits create revisions and activity events. |
| Task 10 → 11/12 | Auth identity and invitations depend on configured Firebase resources | No contradiction; demo identity remains available before Firebase configuration. |

Ruling: Build a real Ionic Vue app instead of the Product Design `mobile-app` React prototype template — the user's explicit Ionic requirement overrides the template default — cost if wrong: the protected Product Design phone-frame runtime and Sites-specific packaging are not included, while native Ionic behavior and Firebase Hosting compatibility are preserved.

Ruling: Work on `codex/split-unwise-build` in this newly initialized standalone repository — the project itself is isolated and the user explicitly authorized implementation — cost if wrong: no second git worktree exists, but main remains untouched after the branch point.

Ruling: Implement complete provider and OCR interfaces with deterministic local fallbacks, and only mark integrations live when credentials and end-to-end confirmation exist — provider credentials and commercial approvals are absent — cost if wrong: bank/payment/OCR production activation remains configuration work rather than falsely simulated behavior.

Asset: selected group hero cover generated and visually inspected at `public/assets/images/lake-house-cover.png` (1170 × 540); it matches the reference's lake, centered dock, right floating dock, and lavender-blue dusk palette.

Asset: original app icon generated and visually inspected at `public/assets/images/app-icon-1024.png` (1024 × 1024); it uses two interlocking receipt shapes in the Split Unwise indigo/lilac palette without copied branding or text.

Task 1: review at `ed1cd46` found one Important gap: the flat root outlet did not establish four independent Ionic tab stacks. Fix round 1 in progress with the original implementer.

Task 1: minor (deferred): route placeholders expose an unlabeled empty `main`; replace with labeled feature pages as the routed screens land.

Task 1: fix round 1/5 (1 Important addressed, 0 Important open; commit `54f318c`). The re-review also reconfirmed the already-deferred generic placeholder label; it remains Minor and does not extend the fix loop.

Task 1: complete (commits `be56077..54f318c`, Important finding addressed, 1 Minor deferred).

Ruling: Defer adding `terminal.local` to Vite `server.allowedHosts` until the next shell/verification change instead of reopening Task 1 while Task 2 is active — direct local HTTP is healthy, but the Codex in-app browser receives a 403 for that host — cost if wrong: browser-visible QA remains blocked until the configuration lands.

Task 2: review at `932eff8` found four Important gaps: ratio arithmetic can emit non-finite allocations, balance aggregation can overflow safe integers, currency codes/exponents are not authoritative, and stateless month/year recurrence drifts from the intended schedule anchor. Fix round 1 in progress with the original implementer.

Ruling: Recurring schedules retain an explicit original calendar anchor across occurrences — a monthly expense created on the 31st returns to the 31st after short months and a yearly leap-day expense returns to February 29 in later leap years — cost if wrong: consumers must supply and persist anchor metadata instead of relying on stateless clamping.

Task 2: minor (deferred): percentage assignment maps should reject missing and extra participant keys rather than silently ignore them.

Task 2: minor (deferred): `toJson` should reject or define a valid policy for non-JSON top-level values such as `undefined`.

Task 2: fix round 1/5 (3 Important addressed, 1 Important open — inherited object-property names bypass currency validation; commit `6c3f4bf`).

Task 2: fix round 2/5 (1 Important addressed, 0 open — own-property currency validation; commit `96d3791`).

Task 2: complete (commits `54f318c..96d3791`, review clean after 2 fix rounds, 2 Minor findings deferred).

Task 3: implementation landed at `a91adc6`; reported validation is 5 focused repository/queue tests, 38 full-suite tests, typecheck, production build, and `git diff --check` passing. Independent review in progress.

Task 3: review at `a91adc6` found 2 Critical and 6 Important gaps: subscriber exceptions can reclassify a successful command and enable a duplicate retry; operation IDs are not persisted or forwarded to deterministic backend writes; pure contracts statically import Firebase adapters; command state/result typing admits impossible states; Firebase decoding does not validate domain/audit data; initial reads race persisted auth hydration; totals/charts collapse multiple currencies; and the mutation contract does not cover later edit/delete/comment/settlement/default/auth consumers. Fix round 1 in progress with the original implementer.

Ruling: Treat client operation IDs as required end-to-end financial idempotency keys and persist replayable command envelopes, not closures — an ambiguous response or reload must not duplicate a write — cost if wrong: mutations need deterministic document/operation IDs and a serializable command-handler boundary instead of a simpler in-memory promise queue.

Ruling: Represent aggregate totals and chart series by currency with no implicit conversion — no exchange-rate authority is configured — cost if wrong: consumers must render separate currency sections until a verified conversion source and rate timestamp are available.

Task 3: minor (deferred): track the generated Lake House cover with the first visual integration commit so a clean checkout cannot reference a missing image.

Ruling: Make authenticated callable Functions the sole authority for financial writes while allowing rules-bounded client reads — Security Rules cannot enforce cross-document revisions, exact ledger sums, or atomic activity/projection emission — cost if wrong: full cloud-backed writes require a Blaze-capable deployment, while demo/local behavior and Spark-hosted reads remain usable.

Ruling: Use per-user permanent operation ledgers plus immutable expense revisions/activity for cloud idempotency and audit — financial retries must return the original result across reloads and concurrent calls — cost if wrong: additional documents/index exemptions are retained indefinitely instead of relying on cheaper expiring client state.

Ruling: Implement a real service-worker-backed PWA and cache only the app shell/local immutable assets — drafts may be offline but authenticated backend responses and private receipts/exports must not be broadly cached — cost if wrong: deployment includes update coordination and cache policy work beyond a manifest-only install prompt.

Task 3: fix round 1/5 (2 Critical and 5 Important addressed; 1 original Important plus 2 new Important open — all initial Firebase reads must await auth hydration, ledger replay must bind to the original request/user-derived resource identity, and currency-partitioned aggregates still need checked arithmetic; commit `1c9fdbc`).

Ruling: Bind an operation replay to authenticated user, command kind, group, and a canonical request fingerprint, and derive resource identity from user plus operation ID — same-ID/different-payload or cross-user collisions must fail rather than return or overwrite a phantom success — cost if wrong: deterministic hashing/canonicalization becomes part of the persisted protocol and must remain backward-compatible.

Task 3: fix round 2/5 (auth hydration and checked aggregates addressed; replay/resource binding still has 2 Important gaps — the command queue replays same-ID/same-kind changed payloads before repository validation, and Firebase ledger validation does not require its stored resource ID to match the derived identity; commit `a1fe973`).

Task 3: fix round 3/5 (2 Important replay gaps addressed; changed envelopes persist non-retryable conflict, stale completion cannot overwrite it, and stored resource identity is verified; commit `bad5ffc`).

Task 3: complete (commits `96d3791..bad5ffc`, 2 Critical and 8 Important findings addressed across 3 fix rounds; 52 full-suite tests reported green; Firebase emulator/live concurrency remains assigned to Task 11).

Task 4: implementation in progress from baseline `bad5ffc`; binding target covers the native iOS tab/FAB shell, shared financial components, explicit sync/debt semantics, reduced-motion/capability-safe composables, original theme tokens, and the deferred `terminal.local` preview-host configuration.

Task 4: review at `c47d048` found 1 Critical and 5 Important gaps: the FAB uses an unowned `fixed` slot under `ion-tabs`; formatting round-trips exact minor units through floating-point; route animation duration/reduced-motion is not wired into Ionic; dark/high-contrast palettes conflict and miss Ionic system variables; expense-row money tracks are per-row/unstable with no large-text reflow; and the category is exposed as a dead button. Fix round 1 in progress with the original implementer.

Ruling: Keep the category tile as named, noninteractive content until a real category-filter/detail action exists — a 44-point visual cell must not masquerade as a dead button — cost if wrong: later interactive category behavior will require an explicit semantic change and event contract.

Ruling: Match the selected reference's visual composition but derive all demo balances and row debt directions from the seeded allocations — the generated image's illustrative payer/share/`you lent` labels are mathematically inconsistent — cost if wrong: some displayed sample amounts differ from the reference while the product never presents false financial state.

Ruling: Hide the four-destination global tab bar on group-detail routes and use the selected local Expenses/Activity segment there, while preserving the route inside the Groups Ionic stack — the authoritative target has group-local navigation at the bottom — cost if wrong: tab-bar visibility becomes route-aware and must be restored reliably on every root/back transition.

Task 4: fix round 1/5 (Critical FAB slot, route motion, noninteractive category, stable 62px tracks, and semantic gaps addressed; 4 Important open — locale grouping thresholds are hand-inferred, Dynamic Type at 390px does not trigger narrow reflow, Ionic paired palette variables/contrast remain incomplete, and custom FAB offsets override/double-count Ionic safe-area positioning; commit `2f04e93`).

Ruling: Let Ionic own the FAB's end/bottom/safe-area placement inside `tabs-inner` and limit custom CSS to visual treatment — the tab container already excludes its tab bar — cost if wrong: final group-detail positioning may need a page-owned fixed FAB when the global tab bar is hidden.

Task 4: fix round 2/5 addressed exact native locale grouping, measured 390px overflow reflow, complete paired Ionic palettes/category contrast, and Ionic-owned FAB positioning at `098d4d4`; fresh review found 2 Important gaps and 1 Minor: reflow can oscillate after its own height change, pending sync text misses dark/high-contrast-dark contrast, and custom iOS surface overrides lose specificity to imported Ionic palettes. Fix round 3 in progress with the original implementer.

Task 4: fix round 3/5 addressed same-width observer latching, pending-state contrast, and iOS palette specificity at `050224e`; fresh review found 1 Important gap: content/true-width invalidation still measures the already-reflowed layout and can clear the correct state without a guaranteed un-reflowed remeasure. Fix round 4 in progress with the original implementer.

Task 4: fix round 4/5 addressed intrinsic unreflowed measurement at `e75aad6`; fresh review approved with no Critical or Important findings. Independent validation: 115 tests, typecheck, and production build pass. Browser-visible safe-area/Dynamic Type/OS palette verification remains assigned to final design QA.

Task 4: complete (commits `bad5ffc..e75aad6`, 1 Critical and 12 Important findings addressed across 4 fix rounds; terminal browser relay remains a final QA boundary).

Task 5: implementation in progress from baseline `e75aad6`; binding target is the selected 390x844 Lake House reference with repository-derived financial truth, route-aware global/local tab shells, and real Home/Groups navigation.

Task 5: implementation landed at `e3ca81d`; reported verification is 139 tests, typecheck, production build, and diff check passing. Fresh review found 2 Important gaps: stale/unordered route loads can present the wrong group's financial journal, and the group summary silently drops non-default currencies while using unchecked aggregate addition. Fix round 1 in progress with the original implementer.

Task 5: fix round 1/5 addressed identity-guarded loads, immediate stale clearing, checked per-currency summaries, and visible overflow failure at `40e75e1`; fresh re-review approved with no Critical or Important findings. Independent verification: 142 tests, typecheck, and diff check pass.

Task 5: complete (commits `e75aad6..40e75e1`; 2 Important findings addressed in 1 fix round; rendered 390x844 reference comparison remains assigned to final design QA).

Task 6: implementation in progress from baseline `40e75e1`; contract migration, app-scoped offline session, native composer, all split methods, recurrence, receipt/manual itemization, and pending-journal reconciliation are one binding slice.

Ruling: Make `payments: readonly Allocation[]` the single canonical payer model for all expenses — one payer is represented by one payment — cost if wrong: domain, demo data, decoders, repositories, balances, aggregates, recurrence, and cloud contracts must migrate together instead of keeping a simpler `payerId` field.

Ruling: Represent friend expenses as two-member direct groups and reuse the group ledger/security model — no separate friendship-expense repository exists and split integrity should have one authority — cost if wrong: friend UX becomes a filtered group context rather than an independent document hierarchy.

Ruling: Add and edit expenses use full-screen origin-scoped routes, take group context from a validated query parameter, hide all tab/FAB chrome, and keep a safe direct-load Cancel/Save fallback — cost if wrong: route state and origin return paths become part of the composer contract.

Ruling: Durable edits require `revision`, `updatedAt`, `getById`, `expectedRevision`, and an updated-expense result — an edit without optimistic concurrency cannot distinguish overwrite from success — cost if wrong: Task 6 expands the Task 3 repository protocol before building edit UI.

Ruling: Persist only durable JSON references in commands and keep receipt blobs in IndexedDB behind a receipt port; OCR suggestions remain editable and never affect allocations before explicit confirmation — offline replay cannot serialize File/Blob and provider output is not ledger truth — cost if wrong: receipt handling needs a local asset lifecycle plus separate upload/recognition states.

Ruling: One app-scoped command queue exposes snapshots, failed-draft discard, conflict retention, and typed unsupported failures so pending rows survive navigation/reload — an in-memory component queue would lose the core offline contract — cost if wrong: queue and journal projection APIs expand before composer delivery.

Ruling: Provide one app-scoped `AppRepository` and `CommandQueue` from the composition root; feature stores must not independently create demo repositories — otherwise edits, comments, activity, and journals diverge between screens — cost if wrong: composition needs injection and tests must isolate the shared session explicitly.

Ruling: Use origin-scoped expense detail routes with validated group context and route metadata as the single app-chrome authority — independent Ionic stacks need deterministic back paths without growing hard-coded route-name lists — cost if wrong: router metadata becomes part of every create/edit/detail route contract.

Ruling: Treat activity as immutable canonical audit and notifications as mutable per-user projections; preferences affect future email/push delivery but never remove self-actions or history — cost if wrong: Task 7 needs separate repositories and read-state operations instead of one combined feed.

Ruling: Derive edit/delete system entries from immutable revisions/activity rather than duplicating them as comment records, and tombstone expenses/comments instead of physically deleting audit data — reconciliation and direct audit links must survive — cost if wrong: demo and Firebase models retain additional immutable history.

Ruling: User comments are plain-text, operation-bound records; authors may tombstone their own comments, comments are not editable, and system entries remain immutable — cost if wrong: Task 7 adds author checks and delete commands now.

Ruling: Keep Task 7 Firebase mutations typed as unavailable until authenticated callable Functions land in Task 11 — direct browser writes cannot uphold audit/notification atomicity — cost if wrong: Firebase-mode UI exposes unavailable states while demo/offline flows remain complete.

Ruling: Make a versioned `GroupBalanceSnapshot` containing pairwise and simplified debts the read contract, and include `expectedBalanceRevision` plus balance basis in every settlement command — overpayment protection cannot survive concurrent ledger changes with an unversioned derived list — cost if wrong: Task 8 expands the repository protocol and Task 11 must atomically maintain the balance revision.

Ruling: Treat settlements as separate immutable audited ledger records and undo them with tombstones rather than deleting them or disguising them as expenses — payment history and corrections must remain explainable — cost if wrong: Activity, demo data, Firebase documents, and routing gain settlement-specific types.

Ruling: Allow manual settlement recording only when the authenticated user is the sender or recipient and require explicit confirmation that the outside payment already occurred — a third group member must not create a false transfer between two other people — cost if wrong: admins cannot settle on behalf of two other members without a future delegated-authority flow.

Ruling: External payment providers produce handoffs, not transfer results; launch or app return never records a settlement, and provider-confirmed status requires signed server evidence — no provider credentials or callback proof exists — cost if wrong: configured providers require a separate Record completed payment action.

Ruling: Enforce positive same-currency settlement amounts no greater than the selected debt under the group's active pairwise or simplified policy — partial and full settlement are supported without silently creating reverse debt — cost if wrong: overpayments and reimbursements require a separate explicit workflow.

Ruling: Keep balances, simplification, and settlement separate by ISO currency with no implicit total or conversion — no exchange-rate authority is configured — cost if wrong: users settle each currency separately until a verified conversion source and rate timestamp exist.

Ruling: Keep pending settlements visibly pending and leave authoritative balances unchanged until the command is saved — connectivity and provider handoff are not proof of payment — cost if wrong: the screen may temporarily show an outstanding balance beside a pending record.

Ruling: Add a durable settlement detail and audited void route with copy that voiding the ledger record does not cancel outside funds — correction is part of the real settlement lifecycle — cost if wrong: Task 8 expands beyond the original two-page brief by one small detail screen.

Ruling: Make every Task 9 premium-equivalent tool available to every user with no subscription state, daily cap, paywall, advertisement, upsell, or locked result — the user explicitly requested all premium functionality — cost if wrong: provider-gated transaction import/conversion remain honest unavailable states rather than fake success.

Ruling: Analytics authority is saved current expenses plus saved non-void settlements; pending/conflicted commands and historical expense revisions stay outside authoritative totals — current financial state must not double-count audit history — cost if wrong: reporting modules need explicit status/tombstone filtering.

Ruling: Keep every report, search amount, chart scale, balance, and export row separated by ISO currency, with period net distinct from the current balance — no verified conversion authority exists — cost if wrong: every screen/export repeats currency context and independent scales.

Ruling: Search uses normalized local text matching plus structured filters and returns an explicit coverage marker; do not claim fuzzy, semantic, ranked, or native Firestore full-text behavior — the planned Standard-compatible backend has no such proven index — cost if wrong: broad account history may disclose bounded rather than complete coverage until Task 11 adds an authorized provider.

Ruling: Store a versioned shared default-allocation template limited to equal, percentage, or shares; it seeds future drafts only and never supplies payers or retroactively mutates expenses, recurrence, or balances — cost if wrong: membership changes must invalidate or atomically repair affected defaults.

Ruling: Only members with `canManage` may change shared defaults, and writes use expected settings revision — concurrent membership/settings changes must not silently redistribute shares — cost if wrong: Task 9 adds settings snapshots and conflict UI.

Ruling: Small authorized snapshots download client-side while large exports are authenticated server jobs and remain visibly unavailable until Task 11 proves them — mobile memory and authorization boundaries preclude unbounded browser exports — cost if wrong: export UI has explicit readiness/server-required states.

Ruling: CSV is a current-ledger transaction export and JSON is the auditable account/group backup; neither includes secrets, raw receipt blobs, provider tokens, operation secrets, or temporary URLs — cost if wrong: exporters need strict allowlists and formula-injection protection.

Ruling: Transaction import and live currency conversion are current official premium features but remain provider-gated and unimplemented until a verified credentialed source exists — cost if wrong: the app cannot honestly show deterministic demo success for those two integrations.

Task 6: implementation landed at `f935d17`; reported validation was 197 tests, typecheck, production build, and diff check passing. Independent review found 2 Critical and 13 Important gaps across account isolation, single-flight/editor races, split/revision validation, durable queue and receipt handling, reconciliation/conflict recovery, recurrence scope, mobile sheets, accessibility, and contrast. Fix round 1 in progress with the original implementer.

Ruling: Bind every durable local command, receipt namespace, repository session, and feature-store lifecycle to one resolved mode/project/UID principal, and reconstruct the complete app data session on auth changes — financial drafts must never surface or execute under a later user — cost if wrong: auth hydration precedes repository construction and Task 10 must perform full store/session teardown rather than swapping a user field in place.

Ruling: Preserve the authoritative state of an existing operation when the same operation ID is replayed with a different envelope, and validate every saved/conflict result against its exact command group/resource identity before projection — malformed persistence or handler output must not mutate another expense — cost if wrong: replay mismatch returns a rejected handle without overwriting the original operation and queue decoding becomes stricter.

Ruling: Require an explicit `occurrence | future` scope for every edit of a recurring instance and bind all editor initialization, context, receipt, and save completions to the active route request — stale async work must not mutate the next composer — cost if wrong: even simple recurring description changes require one scope choice and asynchronous helpers carry editor identity guards.

Task 6: fix round 1/5 landed at `ff925c5`; reported verification is 27 files/265 tests, typecheck, production build, and diff check passing. Fresh independent data and UX re-review are in progress; browser-visible design QA remains assigned to Task 12.

Ruling: Task 10 consumes the principal-owned Task 6 session instead of creating a second auth/session path; missing Firebase configuration is visibly labeled demo, complete valid configuration is Firebase, and partial or malformed configuration is fatal — cost if wrong: boot has an explicit configuration state and cannot silently downgrade production mistakes into a plausible demo.

Ruling: Production invitations are online-only, server-created single-use seven-day group capabilities with 256-bit secrets stored only as hashes; raw tokens live briefly in an HTTPS URL fragment, are stripped from history, and never enter queues, logs, exports, or analytics — cost if wrong: demo invites remain clearly local previews until Task 11 callables and Task 12 universal-link deployment are proven.

Ruling: Appearance is a schema-validated device-local `system | light | dark` preference owned by one pre-mount Ionic palette controller, while account currency preferences only seed new unscoped drafts and never convert or relabel existing money — cost if wrong: theme startup and picker ordering require explicit controllers without changing ledger authority.

Task 6: fix round 2/5 landed at `6829c4a`; full-principal namespacing/session reconstruction, persist-first queue execution, strict lifecycle result validation, durable tombstone reconciliation, stale-conflict authority, demo tombstone rejection, independent receipt/context request guards, truthful receipt durability, sheet dirty tracking, and VisualViewport keyboard avoidance are integrated. Independent controller verification: 28 files/326 tests, typecheck, production build, and `git diff --check ff925c5..6829c4a` pass. Fresh scoped data and mobile UX re-review are in progress.

Task 6: fix round 2/5 review found 7 Important issues still open — terminal queue state notifies before durable save, stale-session post-commit is persisted as an ordinary failure, repository UID is not checked against the full principal, command-owned receipt blobs can be stale-cleaned, receipt promotion changes across replay, failed same-principal activation is memoized, and sheet focus ignores clipped/sticky-header bounds. Fix round 3 is in progress with the original implementer.

Task 6: minor (deferred): `removeReceipt` physically deletes an existing authoritative attachment before an edit commits; no production UI currently calls it, but future removal UI must stage cleanup until the authoritative edit succeeds and protect shared references.

Task 6: fix round 3/5 landed at `088c5fd`; controller verification is 28 files/335 tests, typecheck, production build, and diff check passing. Scoped re-review addressed terminal durability, stale-session adoption, full-principal UID binding, replay-stable receipt promotion, activation recovery, Firebase observer rejection handling, and clipped-sheet focus. One Important remains open: receipt claim/delete are non-atomic and the editor submits before ownership is durably established, so IndexedDB interleaving can still delete a queue-owned blob. Fix round 4 is in progress with a fresh implementer.

Task 6: fix round 4/5 addressed atomic IndexedDB receipt ownership/deletion and pre-submit claim gating at `a7bbf24`; scoped rereview is clean. Independent verification: 28 files/337 tests, typecheck, production build, and `git diff --check 088c5fd..a7bbf24` pass.

Task 6: complete (commits `40e75e1..a7bbf24`; 2 Critical and 21 Important findings addressed across 4 fix rounds; one latent attachment-removal Minor deferred; device/browser visual QA remains assigned to Task 12).

Ruling: Client premium exports require both at most 5,000 rows and at most 5 MiB of encoded output; exceeding either boundary returns server-required before Blob creation — bounded mobile memory must not produce partial or misleading backups — cost if wrong: larger exports remain unavailable until Task 11 server jobs are deployed.

Ruling: Only fresh confirmed current projections enter authoritative analytics/exports; stale cached rows may appear only as a labelled non-authoritative preview, and client account search becomes bounded after 100 groups or 10,000 current expenses — coverage must be explicit rather than claiming full history — cost if wrong: offline users see estimates separated from authoritative totals and large histories require the server provider.

Ruling: When active membership removal invalidates a shared default split, clear the whole default atomically instead of redistributing it — silent repair could change future financial intent — cost if wrong: a manager must reconfigure the default after membership changes.

Ruling: JSON backups may include only authorized durable receipt descriptor metadata and opaque durable asset IDs, never local references, blobs, URLs, storage paths, provider payloads, tokens, or unconfirmed OCR suggestions — backup portability must not leak private/runtime data — cost if wrong: receipt images themselves require a separate authenticated export job.

Task 7: implementation landed at `a4f56d6` with verification report `e0531ea`; implementer reported 35 files/404 tests, typecheck, production build, and committed-baseline diff check passing. Independent data and mobile UX review are in progress; Firebase mutation proof remains assigned to Task 11 and browser/device visual proof to Task 12.

Ruling: Use one named Firebase bootstrap for Auth, Firestore, Functions, Storage, and App Check, and share one strict versioned command protocol and financial validator package between client and Functions — independent initialization or duplicate invariants can cross principals or diverge — cost if wrong: Task 11 restructures existing Firebase adapters before adding callables.

Ruling: Recheck current active group membership before returning a stored idempotent group result, and hash a server-normalized versioned request rather than client JSON serialization — replay must not become a removed-member read channel or serialization-dependent conflict — cost if wrong: operation replay performs an authorization read and uses a dedicated canonical schema.

Ruling: Draft receipt storage is immutable owner-only upload through 15 MiB with exact image MIME and metadata allowlists, followed by server byte inspection and promotion to opaque group assets — rules cannot prove file contents and ledger commands must never accept paths, URLs, or local references — cost if wrong: receipt uploads become operation-aware and Storage/Functions are required for durable assets.

Ruling: Keep canonical group ledger/activity/balance writes atomic while projecting account activity and notifications through deterministic idempotent fan-out, and represent mark-all-read as a server-owned read-through cursor plus unread projection — unbounded multi-user fan-out and document updates do not fit one transaction — cost if wrong: global feeds are eventually projected but canonical audit remains authoritative.

Ruling: Firebase production mode can boot with Auth and Firestore when Storage is unavailable, but every unavailable Storage/Functions capability is explicit and a Spark-hosted release cannot claim durable financial mutation — current billing gates must not cause silent demo fallback or weaker rules — cost if wrong: capability discovery is separate from core configuration and the hosted Spark surface is labelled demo/read-only.

Ruling: The PWA service worker caches only public shell and immutable local assets, never authenticated Firebase/Functions responses, receipts, exports, or financial commands, and updates require a prompt when unsynced local work exists — the principal-owned command queue is the sole replay authority — cost if wrong: Task 12 adds cache-policy tests and a state-aware waiting-worker controller.

Ruling: Task 12 release acceptance includes a committed Capacitor iOS project, a real iPad master/detail seam, same-state same-viewport combined visual comparison, and separate runtime accessibility evidence — manifests, screenshots, or component tests alone do not prove native mobile quality — cost if wrong: simulator/device unavailability is reported as a blocker rather than converted into a claim.

Ruling: Deploy through emulator gates, exact-project preview, production health checks, and release-history rollback while preserving Firestore delete protection and financial data — Hosting rollback cannot safely roll back ledger data or schemas — cost if wrong: release documentation records commit, project, region, test identity, and deployment identifiers before promotion.

Task 7: independent review found 1 Critical and 18 Important gaps across real demo reload durability, execution-envelope intent, resumed stale-session rejection, Firebase tombstone/unread/cursor behavior, deterministic timeline ordering, discriminated decoders, comment/delete recovery, keyboard avoidance, strict edit context, pending timestamps, pagination/unread authority, notification loading, group Activity projection, audit readability, attachment presentation, and row targets. Fix round 1/5 is in progress with the original implementer.

Ruling: Treat Auth and Firestore as Firebase core configuration while Storage, Functions, App Check, push, and providers are explicit optional capabilities — missing optional billing-gated services must not silently select demo or make core Auth unusable — cost if wrong: runtime configuration exposes a capability union in addition to mode.

Ruling: Exchange a stripped invitation fragment secret immediately for a short-lived opaque server resume nonce before mobile OAuth redirect — raw invitation tokens cannot be durably stored yet in-memory state cannot survive redirect — cost if wrong: Task 11 adds one resume exchange and Task 10 persists only the nonce.

Ruling: Sign-out uses reversible principal-session quiescing with unresolved-work disclosure and scoped Keep/Discard choices, never irreversible freeze or broad storage clearing — failed or cancelled sign-out must safely resume the same user — cost if wrong: Task 10 adds a principal-scoped local-data port and pause/resume lifecycle.

Ruling: Account currency preferences validate the complete supported ISO list, keep the default in a unique ordered preference list, and affect only new unscoped drafts and picker order — hard-coded currency subsets or preference-driven conversion would misrepresent existing ledger money — cost if wrong: composer currency options become configuration-driven.

Ruling: Account owns notification delivery preferences while Activity owns immutable history and the notification feed; reuse one repository/store contract without duplicating the feed in settings — cost if wrong: Task 10 splits Task 7's combined component before composing native grouped Account settings.

Task 7: fix round 1/5 landed at `969e3fe`; all 1 Critical and 18 Important initial findings were addressed across durable demo reloads, queue/session recovery, bounded Firebase reads, strict audit decoding, routed detail/comments/activity/notification UX, pagination, readable audit and attachment states. Full suite reported 435 tests green; re-review found 1 Critical and 9 Important recovery/interleaving gaps.

Task 7: fix round 2/5 landed at `ca44a68`; exact failed-comment truth, comment/delete conflict recovery, resumed delete reconciliation, exponent-aware audit money, filter-aware Activity, notification generation/recreated recovery, prepare cloning, and stale-session persistence were addressed. Full suite reported 447 tests green; re-review found 3 Important remaining generation races.

Task 7: fix round 3/5 landed at `721dbd3`; post-freeze repository rejection, Activity filter paging, and notification refresh/load-more interleavings were covered. Full suite reported 450 tests green; final review found one Important receipt-preparation rejection path.

Task 7: fix round 4/5 landed at `c061b43`; stale receipt-preparation rejection can no longer overwrite a newer session while active-session upload failures remain durable and retryable. Scoped final rereview is clean; full suite reported 451 tests green, with typecheck, production build, and diff checks passing.

Task 7: complete (commits `a4f56d6..c061b43`; 2 Critical and 31 Important findings addressed across 4 fix rounds; Firebase callable mutation proof remains assigned to Task 11 and browser/device visual proof to Task 12).

Task 8: implementation completed from baseline `c061b43`; versioned authoritative balance snapshots, exact pairwise/simplified settlement semantics, immutable record/void audit, schema-v6 recovery, UID-configured provider handoffs, and durable mobile Ionic balance/settlement routes are integrated. Reported verification is 43 files/497 tests, typecheck, production build, and baseline diff check. Firebase callable mutation proof remains assigned to Task 11 and browser/device visual proof to Task 12.

Task 8: independent review at `a1cc7a2` found 2 Critical and 12 Important gaps across persistence rollback isolation, remount operation identity, authoritative acknowledgement, restored-state decoding, queue migration/envelope/conflict validation, Firebase creator identity, safe revision exhaustion, Activity links, retained recovery, provider direction/amount truth, Ionic keyboard focus, touch targets, and live status semantics. Fix round 1 proceeded RED-first with the original implementation agent.

Task 8: fix round 1/5 addressed all 2 Critical and 12 Important findings. Full verification is 43 files/524 tests, typecheck, production build with 329 modules transformed, and diff check passing. `public/assets/images/app-icon-1024.png` remains untouched and untracked; Firebase callable mutation proof remains Task 11 and browser/device visual proof remains Task 12.

Task 8: fix round 1 re-review found 8 Important gaps across principal-owned settlement operation proofs, exact void replay parity, recoverable browser quarantine, queue creator invariants, safe single-transition void decoding, focused live announcements, and conflicted-void remount coverage. Fix round 2 proceeded RED-first.

Task 8: fix round 2/5 addressed all 8 Important findings. Focused verification is 4 files/64 tests; full verification is 43 files/532 tests, typecheck, production build with 330 modules transformed, and diff check passing. Browser/device visual proof remains assigned to Task 12.

Task 8: final data and mobile-UX re-review found 2 Important recovery gaps: malformed browser JSON threw before quarantine, and a successful retained void retry disappeared before its `Saved` announcement. Fix round 3 proceeded RED-first.

Task 8: fix round 3/5 addressed both final Important findings. Focused verification is 2 files/46 tests; full verification is 43 files/534 tests, typecheck, production build with 330 modules transformed, and diff check passing. Final scoped re-review is in progress; browser/device visual proof remains assigned to Task 12.

Task 8: complete (commits `a1cc7a2..da56505`; 2 Critical and 22 Important findings addressed across 3 fix rounds; final data and mobile-UX closure reviews are clean. Firebase callable mutation proof remains assigned to Task 11 and browser/device visual proof to Task 12).
