# Agent Team Status

## Active Work

- plan: `PLAN.md` Step 4 — Add Managed Creation Configuration and Encrypted Credentials
  owner: root-builder-step-4
  branch: `main`
  worktree: `/Users/alexmetelli/source/plingpling`
  phase: implementing
  cycle: 1/5

## Completion Contract

- outcome: Add opt-in OpenRouter-first `launchMode:"ready"` creation that validates one approved model and a bounded Telegram `getMe`, then atomically persists the owned agent, managed config, four encrypted secrets, generated API-server key, desired-running intent, pending deployment, and one safe audit event.
- acceptance criteria: Existing stopped/manual creation remains compatible and default; ready-only fields on stopped requests are rejected; disabled first-write ready creation returns safe 503 with zero mutation; idempotent ready replays return the original safe agent/deployment before flag or credential validation; Telegram validation is bounded, injected, redacted, and never sends messages; active Telegram bot uniqueness is database-enforced; rollback leaves no partial rows.
- non-goals: No Step 5 projection, Step 6 runner launch/status, Step 7 reconciler, Step 8 UI polling, Step 9 restart policy, Step 10 live Telegram/OpenRouter/DigitalOcean/GHCR/Vercel contact, hosted flag mutation, or real credentials.
- likely touchpoints: See `Step 4 Completion Contract (pre-spec)` below for payload/API compatibility, model registry, Telegram client, secret metadata migration, atomic transaction, redaction, isolation, and test requirements.
- required gates: `bun run db:generate`; clean/upgrade/backfill migration evidence; focused model/Telegram/create/secret/schema/migration/event/isolation tests; credential-free `bun run verify:hermes:staging`; full format/lint/typecheck/test/build/E2E and diff check.
- risks: idempotency replay ordering, token uniqueness across key rotation, Telegram fetch redaction/timeouts/oversize bodies, transaction rollback across secrets/deployment/events, PII leakage in logs/events/DTOs, and accidental runner/provider side effects.
- do-not-touch: Step 5+ projection/reconciler/runner/UI/live acceptance behavior, `.env.local`, hosted configuration, external services, prior ledgers, or raw credentials.
- dependency blockers: None; Step 3 closed and independently ALL GREEN at `7024bc2`.
- open questions: None behavior-blocking under the pre-spec; OpenRouter BYOK is the approved opt-in automatic-ready assumption for this plan.

## Dependency Graph

- Step 0 → Step 1 → Step 2 → Step 3 → Step 4 → Step 5 → Step 6 → Step 7 → Step 8 → Step 9 → Step 10.
- The steps are intentionally serialized because later schemas/contracts depend on prior commits and several steps share core files and trackers.

## Handoffs

- from: root-checker-step-3
  to: root-builder-step-4
  timestamp: 2026-08-03
  request: Step 3 is independently ALL GREEN at `7024bc2`; implement Step 4 from the existing pre-spec and preserve the exact external-service boundaries.
  evidence: Step 3 checker evidence is recorded below: semantic inspection passed, focused Step 3 tests passed 7 files / 72 tests, `bun run db:generate` showed no drift, `bun run db:migrate` passed twice on local loopback, full tests passed 103 files / 905 tests, build passed, E2E passed 14 tests, and `git diff --check` passed.
  next-action: Implement Step 4, update `CHANGELOG.md` and `PROGRESS.md`, run required gates, and commit `feat: accept managed Hermes creation credentials`.

- from: builder-step-3
  to: coordinator
  timestamp: 2026-08-03
  request: Step 3 is implemented and validated; assign an independent checker for `feat: persist agent deployment operations`.
  evidence: Added explicit `agents.desired_status` defaulting to stopped; durable owner-bound `agent_deployments`; server-only state/DTO/persistence/lease modules; concealed owner-scoped `GET /api/agents/[agentId]/deployment`; migration `0016_motionless_fantastic_four`; focused Step 3 tests passed 7 files / 72 tests; full gates passed through build and E2E.
  next-action: Checker should verify schema/migration order, idempotency/lease concurrency, route concealment, and tracker evidence.

- from: coordinator
  to: builder-step-3
  timestamp: 2026-08-03
  request: Implement the detailed Step 3 persistence contract, generate/validate migrations, run all gates, update trackers, and create the prescribed commit.
  evidence: Step 2 commit `897e28f` is independently ALL GREEN across focused tests, the pinned-image local contract smoke, 99 files / 879 tests, build, and 14 E2E tests. Both temporary preservation stashes were removed after confirming Step 2 committed their contents. Only untracked `STATUS.md` remains.
  next-action: Builder implements Step 3 only and commits `feat: persist agent deployment operations` after migration and concurrency/isolation evidence passes.

- from: builder-step-2
  to: coordinator
  timestamp: 2026-08-03
  request: Step 2 is complete at `897e28f`; assign an independent checker or advance after acceptance.
  evidence: Pinned Hermes detailed-health parsing now requires `status: "ok"`, `gateway_state: "running"`, `platforms.api_server.state: "connected"`, and conditional `platforms.telegram.state: "connected"` without HTTP revision evidence. Runner-owned image/label/mount/projected-marker evidence still rejects revision mismatches. Failed post-launch inspect/revision/readiness paths attempt exact-ID selected-container removal for start and restart while preserving the primary safe readiness reason if cleanup fails. Manual-runner and lifecycle boundaries propagate only allowlisted readiness reasons. Local contract smoke reuses `createHermesReadinessWaiter` with fake local model/platform behavior and `telegramBoundary: "local-smoke-disabled"`.
  next-action: Checker should verify Step 2 commit `897e28f` (`fix: align Hermes gateway readiness contract`) and the gate evidence, then coordinator may assign Step 3 from the existing pre-spec.

- from: coordinator
  to: builder-step-2
  timestamp: 2026-08-03
  request: Audit and complete the restored Step 2 readiness implementation, run all prescribed gates, update progress/changelog, and create the exact Step 2 commit.
  evidence: Step 1 closed at final amended commit `23a1817`; builder full gates passed (99 files / 870 tests, build, 14 E2E), checker cycle 2 was ALL GREEN on the exact product code, and the subsequent evidence-only amend corrected `PROGRESS.md` counts with its focused progress test, format check, and diff check green. Expanded Step 2 changes are restored in nine owned files; two coordinator-created preservation stashes remain until Step 2 is safely committed.
  next-action: Builder must treat the restored diff as untrusted input, reconcile it against the detailed Step 2 pre-spec, add changelog/progress evidence, validate, and commit `fix: align Hermes gateway readiness contract`.

- from: root-builder-step-1
  to: coordinator
  timestamp: 2026-08-03
  request: Step 1 checker cycle 1 issue fixed; assign checker cycle 2 or advance after acceptance.
  evidence: Amended Step 1 commit to `5076103` (`test: add fail-closed Hermes staging gate`). Fixed `IMAGE_DIGEST_PATTERN` to accept only exact `ghcr.io/ametel01/agentbay-hermes` with no tag or one valid optional tag before `@sha256:<64 lowercase hex>`, rejecting prefix-lookalikes and nested repos. Added focused valid tagged/untagged and adversarial `agentbay-hermes-evil` / `agentbay-hermes/other` tests. Gates passed: `bun run test tests/unit/hermes-staging-gate.test.ts` (7 tests); `bun run format:check`; `bun run lint`; `bun run typecheck`; `bun run test` (99 files / 870 tests); `bun run build`; `bun run test:e2e:ci` (14 tests); `bun run verify:hermes:staging` expected nonzero fail-closed with `capability_unavailable` and `sideEffectsAttempted: false`; `git diff --check`.
  next-action: Checker should re-review Step 1 at `5076103`; `stash@{0}` was not touched.

- from: root-builder-step-1
  to: coordinator
  timestamp: 2026-08-03
  request: Step 1 implementation complete; review/assign checker or advance to Step 2.
  evidence: Commit `c0d068c` (`test: add fail-closed Hermes staging gate`) added `verify:hermes:staging`, `scripts/verify-hermes-staging.ts`, focused staging-gate tests, placeholder-only staging docs/env entries, and Step 1 `PROGRESS.md` evidence. Baseline at `807e401`: `bun run verify` passed and `bun run test:e2e:ci` passed 14 tests. Final gates passed: focused staging test (6 tests), `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun run test` (99 files / 869 tests), `bun run build`, `bun run test:e2e:ci` (14 tests), `bun run verify:hermes:staging` expected nonzero fail-closed with `capability_unavailable` and `sideEffectsAttempted: false`, and `git diff --check`. `CHANGELOG.md` has no diff.
  next-action: Coordinator/checker should verify Step 1 contract and then assign Step 2 readiness work.

- from: coordinator
  to: builder-step-0
  request: Implement Step 0 exactly, run its prescribed gates, update progress evidence, and commit with `docs: initialize automatic Hermes deployment tracking`.
  evidence: `main` at `2e7a692`, ahead of `origin/main` by seven commits; only pre-existing worktree change is untracked `PLAN.md`; changelog already has `# Changelog` and `## [Unreleased]`.
  next-action: Builder implements and returns exact gate/commit evidence; coordinator then assigns an independent checker.
- from: builder-step-0
  to: coordinator
  timestamp: 2026-08-03
  request: Step 0 complete; assign independent checker or unblock Step 1.
  evidence: Commit `807e401` (`docs: initialize automatic Hermes deployment tracking`) added tracked `PLAN.md`, appended the `Automatic Ready Hermes + Telegram Creation` ledger to `PROGRESS.md`, and added `tests/unit/progress-status.test.ts` guard coverage for the new ledger and changelog structure. `CHANGELOG.md` was read-only verified and unchanged.
  next-action: Checker should verify exact Step 0 contract and gate evidence; Step 1 may start after coordinator acceptance.
- from: root-checker
  to: coordinator
  timestamp: 2026-08-03
  request: Step 1 implementation cannot proceed in this role because the active higher-priority instruction requires read-only checker work.
  evidence: `HEAD` remains `807e401`; `git status --short --branch --untracked-files=all` reports `## main...origin/main [ahead 8]` and only untracked `STATUS.md`; `package.json` still has no `verify:hermes:staging`; `PROGRESS.md` still marks Step 1 as not started.
  next-action: Reassign to a builder role or explicitly lift the read-only checker constraint before editing Step 1 files.

## Gates

- passed: Step 3 prescribed gate set before commit:
  `bun run db:generate` reported no schema drift after generation; `bun run
  db:migrate` passed and reran idempotently on local loopback Postgres; focused
  Step 3 tests passed 7 files / 72 tests covering schema/migration source
  assertions, state/DTO invariants, real separate-connection idempotency,
  one-active-operation, lease claim/expiry/release/renewal/CAS concurrency,
  owner-concealed route behavior, request-user boundaries, two-user route
  isolation, and clean/upgrade disposable migration fixtures through
  `0015_dear_leader`; `bun run format:check`; `bun run lint`; `bun run
  typecheck`; `bun run test` passed 103 files / 905 tests; `bun run build`;
  `bun run test:e2e:ci` passed 14 tests; `git diff --check` passed.
- passed: Step 2 prescribed gate set before commit:
  focused Step 2 tests (`runner-service`, Docker adapter, lifecycle readiness,
  manual-runner adapter, projection, and local-smoke guard) passed 6 files / 43
  tests; `bun run agent:hermes:contract-smoke` passed with
  `telegramBoundary: "local-smoke-disabled"` and no public Hermes port;
  `bun run format:check`; `bun run lint`; `bun run typecheck`;
  `bun run test` passed 99 files / 879 tests; `bun run build`;
  `bun run test:e2e:ci` passed 14 tests; `git diff --check` passed.
- passed: Step 0 prescribed gate set at commit `807e401`:
  `bun run format:check`; `bun run lint`; `bun run typecheck`; `bun run test`
  (98 files / 863 tests); `bun run build`; `bun run test:e2e:ci` (14 tests);
  `git diff --check`. Initial `format:check` found only formatting drift in
  the new progress guard; `bun run format` fixed that before final gates.

## Checker Result

Status: ALL GREEN

## Commands

- command: `git show --format='%H%n%s' --no-patch 7024bc2`
  result: passed
  evidence: `7024bc2af52246179983507d3b9bcbed7e76c7d5`; `feat: persist agent deployment operations`.
- command: Step 3 semantic and diff inspection at `7024bc2`
  result: passed
  evidence: changed files are `CHANGELOG.md`, `PROGRESS.md`, `STATUS.md`, `app/api/agents/[agentId]/deployment/route.ts`, `drizzle/0016_motionless_fantastic_four.sql`, `drizzle/meta/0016_snapshot.json`, `drizzle/meta/_journal.json`, `src/server/agents/agent-deployments.ts`, `src/server/agents/deployment-dto.ts`, `src/server/agents/deployment-state.ts`, `src/server/db/schema.ts`, and seven focused tests. Migration adds `agent_desired_status` exactly `stopped | running`, `agents.desired_status DEFAULT 'stopped' NOT NULL`, `agent_deployment_stage` exactly `pending | provisioning_runner | configuring_hermes | starting_gateway | verifying_model | connecting_telegram | ready | failed`, ordered `agent_deployments` columns, composite owner FK through `agents_id_user_id_unique`, owner/idempotency unique index, one-active partial index, owner-created index, claim index, and check constraints for attempts, safe config revision/idempotency/lease/error fields, terminal timestamps, terminal work clearing, and terminal-after-start ordering.
- command: Step 3 route/service inspection
  result: passed
  evidence: `GET /api/agents/[agentId]/deployment` resolves `requireConfiguredApplicationUser` before DB access, validates malformed/undecodable IDs as safe 400, uses `(agent_id,user_id,deleted_at IS NULL)` owned-agent lookup before deployment reads, returns identical concealed 404 for missing/foreign/deleted agents, returns `200 {deployment:null}` for owned agents without operations, maps persistence failures to safe `agent_deployment_failed`, and DTO output excludes owner, idempotency, lease, endpoint, and secret fields.
- command: `bun run test tests/unit/agent-schema.test.ts tests/unit/agent-deployment-migration-fixtures.test.ts tests/unit/agent-deployment-state.test.ts tests/unit/agent-deployments-db.test.ts tests/unit/agent-deployment-route.test.ts tests/unit/agent-request-user-boundaries.test.ts tests/unit/agent-user-isolation.test.ts`
  result: passed
  evidence: 7 test files passed, 72 tests passed; coverage includes catalog and migration source assertions, clean and upgrade-through-0015 disposable loopback migration fixtures, exact state graph/DTO invariants, real separate-connection idempotency/active-operation/claim/expiry/release/renewal/CAS tests, owner-concealed route behavior, explicit request-user boundaries, and two-user route isolation.
- command: `bun run db:generate`
  result: passed
  evidence: Drizzle read 18 tables including `agent_deployments` with 17 columns, 4 indexes, 1 FK and reported `No schema changes, nothing to migrate`; worktree stayed clean.
- command: `bun run db:migrate`
  result: passed
  evidence: local loopback Postgres migration applied successfully; only existing `drizzle` schema and `__drizzle_migrations` notices appeared.
- command: `bun run db:migrate`
  result: passed
  evidence: second local loopback Postgres run applied successfully idempotently with the same existing-object notices.
- command: `bun run format:check`
  result: passed
  evidence: Biome checked 269 files; no fixes applied.
- command: `bun run lint`
  result: passed
  evidence: Biome checked 269 files; no fixes applied.
- command: `bun run typecheck`
  result: passed
  evidence: `tsc --noEmit` exited 0.
- command: `bun run test`
  result: passed
  evidence: 103 test files passed, 905 tests passed.
- command: `bun run build`
  result: passed
  evidence: Next.js 16.2.10 production build compiled successfully; route list includes `/api/agents/[agentId]/deployment`.
- command: `bun run test:e2e:ci`
  result: passed
  evidence: 14 Playwright tests passed across chromium desktop and mobile.
- command: `git diff --check`
  result: passed
  evidence: exited 0 with no whitespace errors.
- command: `git status --short --branch --untracked-files=all`
  result: passed
  evidence: `## main...origin/main [ahead 11]`; no changed or untracked files before this STATUS.md evidence update.

## Failures

- none.

## Coverage Gaps

- This checker pass did not contact hosted databases, external providers, DigitalOcean, OpenRouter, Telegram, GHCR, Vercel, or credentials. Step 4+ creation payloads, credential capture, reconciler behavior, runner side effects, UI polling, restart policy, and live Telegram acceptance remain out of scope for Step 3.

## Next Action

- Step 3 is independently checked at `7024bc2`; Step 4 can start after coordinator handoff under a builder role.

## Prior Checker Result

Status: Step 0 ALL GREEN

## Commands

- command: Step 0 semantic contract check at `807e4013a6761326759920e4a700bc3a4f8e2e5d`
  result: passed
  evidence: `PLAN.md` is tracked; commit files are exactly `PLAN.md`, `PROGRESS.md`, and `tests/unit/progress-status.test.ts`; `CHANGELOG.md` was not changed; the progress ledger contains Step 0-10 titles, evidence fields, blocker/next-action fields, Step 0 complete, and Step 1 next.
- command: `bun run test tests/unit/progress-status.test.ts`
  result: passed
  evidence: 1 test file passed, 3 tests passed.
- command: `bun run format:check`
  result: passed
  evidence: Biome checked 259 files; no fixes applied.
- command: `bun run lint`
  result: passed
  evidence: Biome checked 259 files; no fixes applied.
- command: `bun run typecheck`
  result: passed
  evidence: `tsc --noEmit` exited 0.
- command: `bun run test`
  result: passed
  evidence: 98 test files passed, 863 tests passed.
- command: `bun run build`
  result: passed
  evidence: Next.js 16.2.10 production build compiled successfully and generated static pages.
- command: `bun run test:e2e:ci`
  result: passed
  evidence: 14 Playwright tests passed across chromium desktop and mobile.
- command: `git diff --check`
  result: passed
  evidence: exited 0 with no whitespace errors.

## Failures

- none.

## Coverage Gaps

- This prior check covers Step 0 only.

## Next Action

- Step 0 accepted; later step evidence appears above.
- No external-service, credential, or Step 4 product behavior is part of this handoff.

## Worktrees

- `/Users/alexmetelli/source/plingpling` — branch `main`, Step 3 work on
  accepted parent `897e28f`; local branch ahead of `origin/main`; Step 3 files
  plus shared trackers are part of this handoff.

## Decisions And Lessons

- 2026-08-03: Treat `PLAN.md` as the user-supplied authoritative scope. Do not provision billable infrastructure, publish images, mutate hosted secrets, or contact a real Telegram user without the explicit authorization prerequisites named in Step 10.

## Completed

- Step 3 — Persist Desired State and Deployment Operations: complete at
  `7024bc2` and independently ALL GREEN.
- Step 0 — Progress and Changelog Tracking Setup: complete at `807e401`; no
  changelog entry because this was tracking-only.

## Step 1 Completion Contract (pre-spec)

- readiness: unblocked by Step 0 commit `807e401` and recorded gate evidence.
- issue: `PLAN.md` Step 1 — Quality Gates Setup and Baseline Evidence.
- outcome: Establish `bun run verify:hermes:staging` as the single bounded, fail-closed entrypoint for eventual hosted Hermes/Telegram acceptance; add a pure/testable capability preflight, document placeholder-only prerequisites, and record the pre-product baseline without contacting external services.
- acceptance criteria:
  - `package.json` exposes exactly `verify:hermes:staging` and delegates to one TypeScript script under `scripts/`.
  - The script classifies every required capability before any effect: an immutable published Hermes image reference containing a digest (not a mutable tag), explicit DigitalOcean budget authorization, valid DigitalOcean and runner credentials, OpenRouter key, dedicated Telegram bot token, numeric allowed test-user ID, numeric test chat ID, and a separate exact live-side-effect confirmation sentinel.
  - Missing, blank, malformed, or non-exact authorization/confirmation input exits nonzero, reports only stable capability names plus safe configured/missing state, and invokes no network, provider, Docker, browser, child-process, database, filesystem-mutation, Droplet, or Telegram-send effect.
  - Output never includes raw credentials, Telegram token, Telegram user/chat IDs, private endpoints, provider responses, or serialized environment/error objects. Any opaque fingerprint is deterministic and bounded; low-entropy numeric Telegram identifiers receive presence-only reporting rather than an unsalted hash.
  - The published/scanned image capability is distinct from the pinned upstream image constants: a source-pinned upstream digest alone is not evidence that the reviewed GHCR release candidate was published and scanned.
  - Because the ready-mode deployment and reply-correlation behavior is implemented only in later steps, Step 1's capability-complete path must not claim a live pass. It may expose an injected/bounded executor seam for Step 10, but until that executor exists it must exit safely with an explicit unavailable/not-yet-implemented result and perform no external mutation.
  - Unit tests cover complete/missing/blank/malformed capability matrices, exact authorization and confirmation semantics, deterministic safe reporting/fingerprints, secret/PII non-disclosure on success and failure, zero effect invocations on every rejected path, and no false success before a real live executor returns verified evidence.
  - `docs/E2E_VALIDATION.md` and `.env.example` name the same variables, distinguish preflight from live acceptance, state billable/Telegram effects, require the dedicated staging bot/user, and contain placeholders only.
  - Before Step 1 edits, capture the baseline commit and exact results for `bun run verify` and `bun run test:e2e:ci`; after edits, record all required gate results in the new `PROGRESS.md` ledger, advance next work to Step 2, leave `CHANGELOG.md` unchanged, and create `test: add fail-closed Hermes staging gate`.
- non-goals:
  - No real DigitalOcean, OpenRouter, Telegram, GHCR, Vercel, or other external request; no Droplet provisioning/deletion, bot validation/send/poll, image publication/pull, hosted-secret mutation, or live acceptance claim.
  - No implementation of ready-mode agent creation, deployment persistence/reconciliation, model canary, Telegram reply correlation, product UI/API behavior, or Step 2 readiness changes.
  - No CI workflow expansion and no changelog entry for this validation-harness-only step.
- likely touchpoints:
  - Required: `package.json`, new `scripts/verify-hermes-staging.ts` (name may follow repository convention), a focused unit test such as `tests/unit/hermes-staging-gate.test.ts`, `docs/E2E_VALIDATION.md`, `.env.example`, and the Step 1 evidence/status fields in `PROGRESS.md`.
  - Reuse/read-only candidates: `scripts/run-e2e.ts` and `scripts/run-clerk-e2e.ts` for injected planner/runner seams; `src/server/env.ts` for the established DigitalOcean configuration contract; `src/runner-service/constants.ts` for distinguishing source-pinned digests; `src/shared/secret-redaction.ts` only as defense in depth, not as permission to construct output from raw values.
  - `CHANGELOG.md` must remain unchanged.
- required tests / gates:
  - Pre-edit baseline: `bun run verify`; `bun run test:e2e:ci`; record the exact commit, command, result, and any separately proven pre-existing failure.
  - Focused: the new staging-gate unit test plus affected capability/env/redaction tests; invoke the package entrypoint with no live capabilities and prove nonzero fail-closed output and no side effects.
  - Full: `bun run format:check`; `bun run lint`; `bun run typecheck`; `bun run test`; `bun run build`; `bun run test:e2e:ci`; fail-closed `bun run verify:hermes:staging`; `git diff --check`.
- security / data / migration risks:
  - Secret leakage through thrown validation messages, command argv, fingerprints, output snapshots, JSON serialization, or test failure diffs; Telegram numeric identifiers are PII and low entropy.
  - A truthy rather than exact authorization sentinel, a tag-only image, or conflating upstream and published/scanned digests could authorize unintended spend or produce false evidence.
  - Preflight ordering must aggregate safe missing capability names before constructing any external client; imports of server-only provider validation may require the repository's existing `--conditions react-server` execution pattern.
  - The command name will outlive this step, so its result schema and exit semantics must support Step 10 extension without converting capability presence into acceptance success.
- do not touch:
  - `.env.local` or any environment values; application routes/UI, database schema/migrations, runner lifecycle/readiness/provisioning behavior, Docker/image workflows, hosted configuration, existing Milestone 16/authentication/Milestone 18 history, prior changelog entries, or untracked `PLAN.md`.
  - Do not overwrite concurrent Step 0 edits or rewrite `STATUS.md` Active Work/Step 0 sections.
- dependency blockers:
  - Hard blocker: Step 0 remains active and uncommitted at `HEAD 2e7a692`; Step 1 starts only after the prescribed Step 0 commit and evidence exist.
  - Live-success blocker (expected, not a Step 1 failure): Steps 2–9 plus scanned/published image evidence and explicit Step 10 external authorization are required before this entrypoint can legitimately pass a real Telegram reply smoke.
- open questions:
  - The plan defines capability semantics but not exact staging-only environment names or the exact confirmation literal. Choose one stable `AGENTBAY_HERMES_STAGING_*` namespace, use existing names only where they are already canonical, require an exact documented sentinel rather than `true`/truthiness, and keep docs/tests/package behavior identical.
  - Clarify in the implementation/docs that the required published-image digest is the scanned release-candidate artifact digest, not merely the existing upstream index or AMD64 manifest digest.
  - Preserve both numeric test-user and test-chat capabilities even when they are equal for a Telegram DM; never print either value.

## Step 2 Completion Contract (pre-spec)

- readiness: `blocked`. Step 0 is committed and independently green at
  `807e4013a6761326759920e4a700bc3a4f8e2e5d`, but Step 2 must not start until
  Step 1 is committed and its independent checker records acceptance. Current
  `HEAD` is still `807e401`; no Step 1 commit or checker evidence exists yet.
- issue: `PLAN.md` Step 2 — Align Readiness With the Pinned Hermes Contract.
- outcome: Make the production Hermes waiter accept the real pinned
  `v2026.7.7.2` detailed-health shape, keep image/mount/revision proof in the
  runner-owned Docker/projection boundary, return only stable readiness reason
  codes, and remove every just-launched container that fails post-launch
  evidence or readiness so lifecycle state cannot diverge from a running
  gateway.
- pinned contract evidence:
  - `src/runner-service/constants.ts`, `Dockerfile.agent`, the image smoke, and
    its tests pin `nousresearch/hermes-agent:v2026.7.7.2` to upstream index
    digest `sha256:9c841866...a283973` and record the AMD64 manifest separately.
    Step 2 does not change either pin and does not treat either source digest as
    a scanned/published GHCR release-candidate digest.
  - The tagged upstream `_handle_health_detailed` returns `status`, `platform`,
    `version`, `gateway_state`, `platforms`, bounded activity/derived-state
    fields, `exit_reason`, `updated_at`, and `pid`. It never returns
    `configRevision` or `config_revision`.
  - The tagged runtime writer stores platform observations at
    `platforms.<platform>.state`; `connected` is the positive state. The exact
    bounded ready fixture therefore uses top-level `status: "ok"`,
    `gateway_state: "running"`, `platforms.api_server.state: "connected"`, and,
    when Telegram is required, `platforms.telegram.state: "connected"`, with no
    HTTP revision field.
- acceptance criteria:
  - Replace the permissive alias search in `isHermesReadyResponse` with the
    pinned field paths above. A pinned fixture with no HTTP revision becomes
    ready; legacy synthetic shapes such as top-level `telegram`,
    `messaging.telegram`, `ok: true`, `enabled: true`, or a matching HTTP
    `configRevision` cannot independently make it ready.
  - API server is always required. Telegram is required for the production
    Hermes/Telegram start path and may be explicitly disabled only for the
    credential-free local contract smoke; the smoke must retain
    `telegramBoundary: "local-smoke-disabled"` and cannot claim external
    Telegram evidence.
  - `status !== "ok"`, `gateway_state !== "running"`, a missing/non-connected
    API-server state, and a missing/non-connected required Telegram state never
    become ready. Extra bounded upstream fields are ignored; raw response
    objects, platform error messages, exit reasons, endpoints, tokens, and
    thrown fetch bodies are never returned, logged, or persisted.
  - HTTP health does not receive an expected revision and does not inspect an
    HTTP revision field. Before readiness can succeed, runner-owned evidence
    must independently prove the exact launch image, launch-spec/config-revision
    Docker labels, exact `/opt/data` and `/workspace` bind sources/destinations,
    and projected `agentbay-config-revision.json` identity/revision against the
    launch spec. Any mismatch rejects readiness even if HTTP health is ready.
  - The production waiter, not a smoke-only replacement, owns polling,
    authentication, parsing, typed classification, deadline, and retry
    behavior. It may accept injected transport/clock/sleep seams so the local
    smoke can probe through `docker exec`, but the smoke must call the same
    production evaluator/wait loop used by `ManualRunnerDocker.start`.
  - Any failure after `docker run` returns the new container ID—including
    inspect image/label/mount mismatch, projected revision mismatch, or waiter
    failure—removes that exact runner-created container before returning. Start
    and restart must leave no selected-agent container from the failed attempt;
    another agent's container, the private network, and the agent's projected
    Hermes/workspace state remain untouched for safe retry.
  - The runner-service response, manual-runner adapter result, and lifecycle
    `agent.error` metadata preserve only the allowlisted readiness reason. The
    public lifecycle action may remain the existing safe
    `runner_start_failed`/`runner_restart_failed`; no raw upstream detail crosses
    the runner boundary. Start/restart completion events are not written on a
    failed readiness path.
  - Update the Automatic Ready ledger in `PROGRESS.md` with the exact fixture,
    focused/full gate and real-image smoke evidence, mark Step 2 complete and
    Step 3 next, add one concise `CHANGELOG.md` `Unreleased`/`Fixed` entry for
    pinned-Hermes readiness plus partial-container cleanup, and commit exactly
    `fix: align Hermes gateway readiness contract`.
- safe readiness reason contract:
  - Define one exported closed union used across runner parsing and transport:
    `api_server_not_connected | telegram_not_connected | gateway_failed |
    revision_mismatch | timeout`. Unknown/untrusted strings are discarded, not
    forwarded.
  - Classification precedence is runner-owned `revision_mismatch`, then invalid
    top-level/gateway state as `gateway_failed`, then API-server state, then
    required Telegram state. A parseable non-ready observation is retried until
    the bounded deadline; at expiry return its latest allowlisted semantic
    reason. Return `timeout` only when the deadline expires without a parseable
    authenticated semantic observation.
  - The wire error keeps the stable outer code `hermes_readiness_failed` and may
    add only this reason code. Manual-runner request logs, lifecycle status copy,
    and event metadata may include the code but never the response body,
    platform `error_message`, `exit_reason`, bearer key, container URL, or
    private endpoint.
- semantic tests / gates:
  - Exact fixture matrix: ready pinned response without HTTP revision; missing
    and wrong top-level status/gateway state; API server missing/starting/fatal;
    Telegram missing/disconnected/retrying/fatal when required; Telegram omitted
    when explicitly not required; malformed/non-object JSON; misleading legacy
    aliases; and extra safe upstream fields.
  - Runner-evidence matrix: exact image/labels/mounts/marker passes; wrong image,
    config label, launch version, mount source/destination, marker revision,
    marker agent/image/version, malformed marker, and symlink/path violations
    fail before readiness success.
  - Cleanup matrix: readiness reason and inspect/revision mismatches each issue
    `rm --force` for the exact newly returned ID, leave zero selected containers,
    never remove another agent, preserve projected state, and return a safe
    failure if cleanup itself fails. Cover both start and restart.
  - Boundary matrix: runner-service error JSON, manual-runner mapping, lifecycle
    `agent.error`, no completion event, no raw fixture/error detail, and local
    smoke production-waiter usage with its explicit fake/local Telegram boundary.
  - Focused commands: the affected runner-service, manual-runner adapter,
    Docker-adapter, Hermes lifecycle-readiness, projection, and local-smoke unit
    files; then `bun run agent:hermes:contract-smoke` against the exact local
    pinned image.
  - Full gates: `bun run format:check`; `bun run lint`; `bun run typecheck`;
    `bun run test`; `bun run build`; `bun run test:e2e:ci`;
    `bun run agent:hermes:contract-smoke`; `git diff --check`. Step 1's
    fail-closed `bun run verify:hermes:staging` remains a prerequisite gate, not
    a live-success claim for Step 2.
- cleanup invariants:
  - At return from any failed launch, no container created by that attempt is
    running or retained; no start/restart completion event exists; the agent is
    on the existing safe `error` path with an allowlisted reason.
  - Cleanup is exact-ID/selected-agent scoped and idempotent. Do not delete the
    Hermes agent root, workspace, projected revision marker, private network,
    image, runner, Droplet, or any other agent's resources.
- likely touchpoints:
  - Primary implementation: `src/runner-service/docker.ts`; optionally a small
    dedicated readiness module if it reduces coupling without broad refactoring.
  - Safe propagation: `src/runner-service/server.ts`,
    `src/server/runners/manual-runner-adapter.ts`, and
    `src/server/agents/lifecycle.ts`.
  - Projection evidence: `src/runner-service/hermes-projection.ts` only if the
    marker validator belongs there; preserve its atomic-write and path-safety
    contract.
  - Smoke: `scripts/smoke-local-hermes-contract.ts` and
    `tests/unit/local-hermes-contract-smoke.test.ts`.
  - Tests named by the plan/current ownership:
    `tests/unit/runner-service.test.ts`,
    `tests/unit/hermes-lifecycle-readiness.test.ts`,
    `tests/unit/manual-runner-adapter.test.ts`,
    `tests/unit/docker-runner-adapter.test.ts`, and, if marker validation changes,
    `tests/unit/hermes-projection.test.ts`. The current production Hermes Docker
    implementation is exercised mainly from `runner-service.test.ts`; the
    separately named Docker-adapter test covers a different server-side adapter,
    so add only a real shared invariant there rather than duplicating fixtures.
  - Tracking/release: the Step 2 row and current-status text in `PROGRESS.md` and
    one append-only `CHANGELOG.md` Fixed entry.
- non-goals:
  - No Hermes version/digest bump, image publication/scan, new provider or
    Telegram request, real bot polling, DigitalOcean provisioning, hosted-secret
    mutation, or live acceptance.
  - No schema/migration, deployment-operation/desired-state model, managed
    OpenRouter/Telegram projection, model canary, asynchronous launch/status API,
    reconciler, restart policy, UI, or Step 3–10 behavior.
  - No broad rewrite of the legacy Docker adapter or native setup terminal.
- risks:
  - A permissive compatibility parser can recreate the false-ready bug; an
    over-strict parser can reject harmless extra pinned fields. Require exact
    readiness paths, not exact object equality.
  - Conflating HTTP health with runner evidence can silently drop revision,
    image, or mount checks. Conflating source and published digests creates false
    release evidence.
  - Cleanup gaps after `docker run`, inspect exceptions, or restart replacement
    can orphan a live private gateway while the database records failure.
  - The existing manual-runner client timeout is shorter than the runner's
    180-second readiness window. Step 6 owns asynchronous launch; Step 2 must not
    widen scope, but focused tests/smoke must prove the corrected waiter and
    record any bounded real-path timeout as a blocker rather than success.
- do not touch:
  - Step 1's staging-gate files/semantics while its builder/checker stream is
    active; `.env.local` or any real environment values; `Dockerfile.agent`,
    pinned constants/digests, and image publication workflow; application
    routes/UI; database schema/migrations; hosted configuration; prior progress
    ledgers or changelog entries; unrelated runner provisioning/capacity code.
- dependency blockers:
  - Hard blocker: Step 1 must first land as its own commit with all prescribed
    gates and independent checker acceptance. Re-read that commit and adjust
    overlapping `package.json`, docs, `PROGRESS.md`, `CHANGELOG.md`, and shared
    status edits before assigning Step 2.
  - No external credential, paid resource, or published-image prerequisite is
    needed for Step 2; the real-image smoke is local/credential-free. Missing
    local Docker or the exact pinned local image is a reported gate blocker, not
    permission to substitute a mock pass.
- open questions: none behavior-blocking after Step 1. The contract resolves
  conditional Telegram readiness through an explicit production-vs-local
  requirement seam; Step 6 may later move that requirement into the versioned
  launch spec without weakening Step 2's parser or evidence rules.

## Step 3 Completion Contract (pre-spec)

- readiness: `blocked`. Step 3 must not start until the current Step 2 work is
  committed as `fix: align Hermes gateway readiness contract` and an
  independent checker records acceptance for that exact commit. Current `HEAD`
  is Step 1 commit `23a1817`; the nine Step 2 implementation/test files are
  still uncommitted shared-worktree changes.
- issue: `PLAN.md` Step 3 — Persist Desired State and Deployment Operations.
- outcome: Add a migration-safe desired-state column and a durable,
  owner-bound deployment-operation table; provide one server-only state/DTO/
  persistence boundary with database-enforced idempotency, single-active-
  operation, and expiring-lease semantics; and expose the latest operation to
  its owner without exposing orchestration internals.
- exact schema contract:
  - Add `agent_desired_status` with exactly `stopped | running`. Add
    `agents.desired_status agent_desired_status NOT NULL DEFAULT 'stopped'`.
    This is operator intent; existing `agents.status` remains the observed
    lifecycle enum and is not renamed, reinterpreted, or backfilled from the
    new column.
  - Add `agent_deployment_stage` with exactly `pending | provisioning_runner |
    configuring_hermes | starting_gateway | verifying_model |
    connecting_telegram | ready | failed`. `ready` and `failed` are terminal;
    every other value is active.
  - Add `agent_deployments` with columns, in this contract order:
    `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`, `agent_id uuid NOT NULL`,
    `user_id uuid NOT NULL`, `stage agent_deployment_stage NOT NULL DEFAULT
    'pending'`, `config_revision text NOT NULL`, `idempotency_key text NOT NULL`,
    `attempt_count integer NOT NULL DEFAULT 0`, `error_code text`,
    `error_detail text`, `next_attempt_at timestamptz`, `lease_owner text`,
    `lease_expires_at timestamptz`, `started_at timestamptz`,
    `completed_at timestamptz`, `failed_at timestamptz`, `created_at timestamptz
    NOT NULL DEFAULT now()`, and `updated_at timestamptz NOT NULL DEFAULT now()`.
  - Ownership must be enforced, not inferred: make `(agents.id,
    agents.user_id)` a referenced unique key and use a composite
    `(agent_deployments.agent_id, agent_deployments.user_id)` foreign key to it.
    `user_id` must also remain a normal owner lookup component; do not trust a
    caller-supplied user ID without the owned-agent query.
  - Add `agent_deployments_user_idempotency_idx` as a unique index on
    `(user_id, idempotency_key)`,
    `agent_deployments_active_agent_idx` as a unique partial index on
    `(agent_id)` where `stage NOT IN ('ready', 'failed')`,
    `agent_deployments_user_agent_created_idx` on
    `(user_id, agent_id, created_at)`, and an active-work claim index on
    `(next_attempt_at, lease_expires_at, created_at)` restricted to nonterminal
    stages. Index names may differ only if Drizzle generation requires a
    deterministic equivalent; semantics may not differ.
  - Database checks: `attempt_count >= 0`; trimmed `config_revision` is 1–80
    characters and matches the launch-spec safe-token boundary; trimmed,
    case-sensitive `idempotency_key` is 8–128 characters; nullable
    `lease_owner`, `error_code`, and `error_detail` are nonblank when present;
    `lease_owner` is at most 128 characters, `error_code` is a lower-case safe
    token of at most 64 characters, and `error_detail` is at most 500
    characters; `error_detail` implies `error_code`; lease owner/expiry are
    either both null or both non-null.
  - Timestamp/state checks: only `ready` has non-null `completed_at`; only
    `failed` has non-null `failed_at`; nonterminal rows have neither; `failed`
    requires `error_code`; `ready` clears both error fields; terminal rows have
    null lease fields and `next_attempt_at`; any terminal timestamp is not
    before `started_at` when `started_at` exists. `started_at` is set once on
    the first successful claim, not at insert time.
- historical-agent migration behavior:
  - Generate the next Drizzle migration and its journal/snapshot metadata with
    `bun run db:generate`; review the SQL rather than hand-editing generated
    metadata.
  - The additive `NOT NULL DEFAULT 'stopped'` column must make every historical
    agent—including currently `running`, errored, stopped, or soft-deleted
    rows—read `desired_status='stopped'` after migration. Preserve each row's
    ID, owner, observed status/reason, runner assignment, timestamps, and
    deletion marker. Do not issue a status-derived `UPDATE`, do not start or
    stop a runtime, and do not create deployment rows for historical agents.
  - New legacy/manual creates continue to persist `desired_status='stopped'`
    through the database default until Step 4 explicitly introduces ready-mode
    atomic creation.
- idempotency and one-active-operation semantics:
  - Normalize an idempotency key once by trimming outer whitespace; preserve
    case. Its scope is one application user, so different users may reuse the
    same key. A repeated `(user_id, idempotency_key)` returns the original
    deployment ID and DTO whether that operation is active or terminal and
    never inserts another deployment or agent-side event.
  - Resolve insert races with the unique index plus `INSERT ... ON CONFLICT DO
    NOTHING`/reselect (or an equivalent single-transaction implementation), not
    a read-then-insert window. Step 4 owns atomic agent/config/secret creation;
    Step 3's internal deployment insertion helper must already provide this
    operation-level behavior for an existing owned agent.
  - A different idempotency key may create a later operation only when the agent
    has no active deployment. The partial unique index is authoritative under
    concurrency: two distinct keys racing for one agent yield one inserted
    active operation and one typed `active_deployment_exists` result. After
    `ready` or `failed`, a new operation may be created; an old key still
    resolves to its old operation.
- lease claim concurrency and expiry:
  - A row is claimable only while nonterminal, due (`next_attempt_at IS NULL OR
    next_attempt_at <= now`), and unleased or expired (`lease_expires_at IS NULL
    OR lease_expires_at <= now`). Claim with one conditional SQL update returning
    the row; queue-wide selection must use a CTE with `FOR UPDATE SKIP LOCKED`
    (or an equivalently atomic PostgreSQL statement). Never select and then
    update in separate transactions.
  - A successful claim writes a validated opaque `lease_owner`, sets
    `lease_expires_at` from the same injected database/logical `now`, increments
    `attempt_count` exactly once, sets `started_at=coalesce(started_at, now)`,
    updates `updated_at`, and returns the claimed row. Competing claims before
    expiry return no claim. At exact expiry (`lease_expires_at <= now`), exactly
    one contender may replace the stale owner and increment the attempt count.
  - Claim duration must be positive and bounded by a server constant (maximum
    five minutes). Release, reschedule, transition, and renewal updates require
    both the matching current owner and an unexpired lease, so a stale worker
    cannot release or overwrite its successor. A normal release clears both
    lease fields; a retry release also sets a future `next_attempt_at`; a
    successful forward transition clears `next_attempt_at` and the lease.
- transition and immutability contract:
  - Put the closed stage list, parser, terminal predicate, and pure allowed-
    transition table in a server-only module under `src/server/agents/`.
    Allowed forward edges are: `pending -> provisioning_runner |
    configuring_hermes | failed`; `provisioning_runner -> configuring_hermes |
    failed`; `configuring_hermes -> starting_gateway | failed`;
    `starting_gateway -> verifying_model | failed`; `verifying_model ->
    connecting_telegram | failed`; and `connecting_telegram -> ready | failed`.
    Skipping `provisioning_runner` supports an already assigned ready runner;
    no other forward skip or backward edge is allowed.
  - Reapplying the same stage is an idempotent no-op, not a transition, and must
    not rewrite timestamps or increment attempts. Retry scheduling remains in
    the same stage through the lease-release helper.
  - Persistence transitions use a compare-and-set predicate on deployment ID,
    expected current stage, current unexpired lease owner, and active state.
    The first terminal transition sets exactly one terminal timestamp, clears
    retry/lease data, and subsequent same or different transitions from
    `ready`/`failed` return a typed `terminal_deployment` result with no write.
    Concurrent stale-stage writers cannot clobber the winning transition.
  - Failure inputs accept only server-authored safe codes and bounded/redacted
    details. Never pass raw provider/runner/Hermes responses, exception
    messages, tokens, prompts, private URLs, IDs used as credentials, or
    serialized environment objects into `error_detail`.
- owner-concealed read API and DTO:
  - Add a server-only persistence service such as
    `src/server/agents/agent-deployments.ts`, separate state/parser and DTO
    modules, and `GET /api/agents/[agentId]/deployment`. Resolve the configured
    application user first and query the agent with `(agent_id, user_id,
    deleted_at IS NULL)` before selecting its newest deployment by
    `created_at DESC, id DESC`.
  - A missing, soft-deleted, or foreign agent returns the identical existing
    `404 {error:{code:'agent_not_found', message:'Agent could not be found.'}}`
    body with no side effect. Malformed/undecodable IDs return the existing safe
    400 validation shape. An owned historical/manual agent with no deployment
    returns `200 {deployment:null}` so polling does not misrepresent it as a
    foreign resource.
  - A present response is `200 {deployment:{id, agentId, stage,
    configRevision, attemptCount, error, nextAttemptAt, startedAt, completedAt,
    failedAt, createdAt, updatedAt}}`, where `error` is null or
    `{code, detail}` and every timestamp is ISO-8601 or null. Do not expose
    `userId`, `idempotencyKey`, `leaseOwner`, `leaseExpiresAt`, provider resource
    IDs, runner/private endpoints, metadata blobs, secrets, or internal retry
    ownership. Parse/validate persisted rows before mapping; fail with one safe
    deployment persistence error rather than serializing unexpected data.
- migration validation fixtures and evidence:
  - Clean fixture: create a disposable empty PostgreSQL database, run
    `bun run db:migrate`, and assert the full journal applies once and again
    idempotently; inspect enum values, columns, defaults, checks, foreign keys,
    and partial/owner/claim indexes from PostgreSQL catalogs.
  - Upgrade fixture: in a separate disposable database apply committed
    migrations only through `0015_dear_leader.sql`, seed at least two owners and
    active, running/error, stopped, and soft-deleted agents with stable IDs and
    status/timestamp sentinels, then apply the new migration. Assert row counts
    and all old sentinels are unchanged, every agent desired state is stopped,
    no deployment was backfilled, and the current migration can be invoked
    again without mutation. Use placeholder-only values and always clean up the
    disposable databases.
  - Add source-level migration assertions to `tests/unit/agent-schema.test.ts`
    for additive SQL, exact enum/column/index/check semantics, stopped default,
    no agent-status rewrite, no deployment backfill, and no destructive table/
    column operations. Record both clean and upgrade `db:migrate` URLs only as
    redacted local fixture names, never credentials.
- required tests / gates:
  - Schema/migration tests cover exact enum values and column order/nullability/
    defaults; owner-consistent composite FK; each check constraint; both unique
    indexes; historical backfill; and clean/upgrade/idempotent migration runs.
  - State/parser tests cover every allowed edge, every forbidden skip/backward
    edge, same-stage no-op, malformed/unknown stages, ready/failed immutability,
    timestamp/error invariants, and safe detail bounds/redaction.
  - Database concurrency tests use separate connections and deterministic
    barriers to prove same-key convergence, different-key one-active behavior,
    one pre-expiry claim, one exact-expiry takeover, attempt increments,
    matching-owner release/renewal, stale-owner rejection, and compare-and-set
    transition races. Mock-only `Promise.all` tests are insufficient.
  - Read service/route/isolation tests cover owner DTO, owned no-operation null,
    malformed ID, missing/soft-deleted/foreign identical 404 responses,
    authentication failures, persistence failure mapping, zero writes, and
    absence of idempotency/lease/owner/endpoint/secret fields. Extend
    `tests/unit/agent-request-user-boundaries.test.ts` and the two-user route
    matrix with the new explicit `ForUser` surface.
  - Run `bun run db:generate`; clean and upgrade-fixture `bun run db:migrate`;
    focused schema/migration/deployment/state/route/user-isolation tests;
    `bun run format:check`; `bun run lint`; `bun run typecheck`; `bun run test`;
    `bun run build`; `bun run test:e2e:ci`; and `git diff --check`. Fix every
    failure. Do not claim a migration gate from source inspection alone.
- likely touchpoints:
  - `src/server/db/schema.ts`; the generated next `drizzle/*.sql`,
    `drizzle/meta/*_snapshot.json`, and `drizzle/meta/_journal.json`.
  - New server-only modules under `src/server/agents/` for deployment state,
    DTO/parser, and persistence/lease operations; new
    `app/api/agents/[agentId]/deployment/route.ts`.
  - `tests/unit/agent-schema.test.ts`; focused new deployment state, database,
    migration, and route test files; `tests/unit/agent-user-isolation.test.ts`
    and `tests/unit/agent-request-user-boundaries.test.ts`. Update shared
    truncate/reset fixtures only where the new FK/table makes it necessary.
  - Step 3 evidence/current-next rows in `PROGRESS.md` and one concise newest-
    first `CHANGELOG.md` `Unreleased`/`Changed` entry because the authenticated
    GET deployment endpoint is externally observable.
- risks:
  - A plain unique constraint cannot express active-only uniqueness; omitting
    the partial predicate either blocks all retries forever or allows two live
    operations. Read-before-write idempotency or leasing races under Vercel
    concurrency.
  - Redundant `user_id` can drift from the agent owner without the composite FK,
    creating an isolation bug. Returning internal idempotency/lease fields or a
    different foreign response leaks control-plane topology.
  - Treating historical observed `running` as desired running would auto-resume
    pre-feature agents later in Step 9. Timestamp defaults or a blanket update
    can also rewrite audit evidence during migration.
  - Database checks do not by themselves enforce the transition graph; every
    mutation must stay behind the conditional state module. Process clocks can
    disagree, so claim comparisons and expiry timestamps must use one injected
    logical/database time per operation.
  - Adding a new table requires careful cleanup ordering in database tests and
    disposable migration fixtures. Never run destructive fixture setup against
    a non-local or unvalidated database target.
- do not touch:
  - The current uncommitted Step 2 runner/readiness/smoke files or its eventual
    changelog/progress evidence; wait for its commit and checker result, then
    start from that exact accepted tree.
  - Step 4 automatic create payloads, credentials, Telegram token validation,
    encrypted-secret transaction changes, generated API keys, or `POST
    /api/agents` 202 behavior; Step 5 projection; Step 6 runner launch/status;
    Step 7 reconciler/cron/heartbeat triggers; Step 8 UI; Step 9 restart policy;
    Step 10 external acceptance.
  - Existing explicit lifecycle status/action behavior, runner provisioning,
    capacity, backups, native Hermes setup, authentication modes, `.env.local`,
    hosted settings, external providers, or prior progress/changelog ledgers.
- blockers:
  - Hard dependency blocker: Step 2 is not committed or independently checked.
    The coordinator must not assign a Step 3 builder until both exist and
    `STATUS.md`/`PROGRESS.md` identify Step 3 as next.
  - No credential, provider, Docker, paid resource, or external-service access
    is required for Step 3. Local PostgreSQL availability is required for the
    real clean/upgrade migration and concurrency gates; if absent, report the
    exact gate as blocked rather than substituting source-only evidence.
- open questions:
  - No product decision is behavior-blocking for Step 3. This contract resolves
    the previously unspecified database details as: user-scoped case-sensitive
    idempotency, stopped historical intent, linear stages with only the
    existing-runner skip, five-minute maximum leases, latest-operation reads,
    and `deployment:null` for an owned agent with no operation. Any requested
    deviation changes a database/public-API compatibility promise and must be
    approved before generation rather than patched after the migration lands.

## Checker Result

Status: ALL GREEN

## Commands

- command: `git rev-parse HEAD`
  result: passed
  evidence: `897e28f99e61617b5ec6fe9ae7f01dad19a3a0b3`.
- command: `git status --short --branch --untracked-files=all`
  result: passed
  evidence: `## main...origin/main [ahead 10]`; only `?? STATUS.md`.
- command: Step 2 semantic and diff inspection at `897e28f`
  result: passed
  evidence: changed files are `CHANGELOG.md`, `PROGRESS.md`, `scripts/smoke-local-hermes-contract.ts`, `src/runner-service/docker.ts`, `src/runner-service/server.ts`, `src/server/agents/lifecycle.ts`, `src/server/runners/manual-runner-adapter.ts`, and five focused tests. Readiness requires `status: "ok"`, `gateway_state: "running"`, `platforms.api_server.state: "connected"`, and conditional `platforms.telegram.state: "connected"`; legacy aliases and HTTP `configRevision` do not confer readiness. Docker/projection evidence checks exact image, config-revision and launch-spec labels, `/opt/data` and `/workspace` bind mounts, private network membership, no published port, and projected marker version/agent/configRevision/image. Start/restart failed-launch cleanup removes the exact launched container ID and preserves the primary safe readiness/revision reason if cleanup fails. Manual-runner/lifecycle propagation keeps only allowlisted readiness reasons and writes safe `agent.error` metadata without premature running completion. Local smoke calls `createHermesReadinessWaiter` with `requireTelegram: false` and reports `telegramBoundary: "local-smoke-disabled"`.
- command: `bun run test tests/unit/runner-service.test.ts tests/unit/docker-runner-adapter.test.ts tests/unit/hermes-lifecycle-readiness.test.ts tests/unit/manual-runner-adapter.test.ts tests/unit/hermes-projection.test.ts tests/unit/local-hermes-contract-smoke.test.ts`
  result: passed
  evidence: 6 test files passed, 43 tests passed.
- command: `bun run agent:hermes:contract-smoke`
  result: passed
  evidence: `local_hermes_contract_smoke_passed`; image `agentbay-hermes:local`; private API auth true; no public Hermes port true; fake model response `agentbay fake model response provider=openai-compatible model=openai/gpt-4.1-mini`; log sources `container_bootstrap` and `hermes_gateway`; state persistence true; backup restored true; removed agent root true; `telegramBoundary: "local-smoke-disabled"`.
- command: `bun run format:check`
  result: passed
  evidence: Biome checked 261 files; no fixes applied.
- command: `bun run lint`
  result: passed
  evidence: Biome checked 261 files; no fixes applied.
- command: `bun run typecheck`
  result: passed
  evidence: `tsc --noEmit` exited 0.
- command: `bun run test`
  result: passed
  evidence: 99 test files passed, 879 tests passed.
- command: `bun run build`
  result: passed
  evidence: Next.js 16.2.10 production build compiled successfully and generated static pages.
- command: `bun run test:e2e:ci`
  result: passed
  evidence: 14 Playwright tests passed across chromium desktop and mobile.
- command: `git diff --check`
  result: passed
  evidence: exited 0 with no whitespace errors.
- command: `git stash list`
  result: passed
  evidence: existing stashes remain untouched: `stash@{0}: On main: agent-team preserve expanded step-2 readiness implementation`; `stash@{1}: On main: agent-team preserve premature step-2 readiness diff`.

## Failures

- none.

## Coverage Gaps

- `test-workflow-standards` was named in the assignment but is not present in the available skill list; `testing-standards` was loaded and applied instead.
- No external services, credentials, image publication, hosted secrets, or real Telegram network behavior were accessed, by assignment.

## Next Action

- Coordinator may accept Step 2 and assign Step 3 from the existing pre-spec.

## Step 4 Completion Contract (pre-spec)

- readiness: `blocked`. Step 4 must not start until Step 3 is committed exactly
  as `feat: persist agent deployment operations` and an independent checker
  accepts that exact commit. At this pre-spec snapshot `HEAD` is accepted Step 2
  commit `897e28f`; Step 3 has uncommitted schema/migration/service/route work in
  the shared worktree. Re-read the committed Step 3 API and migration before
  implementing this contract and adapt names only where its accepted public
  semantics are unchanged.
- issue: `PLAN.md` Step 4 — Add Managed Creation Configuration and Encrypted
  Credentials.
- outcome: Add an opt-in, OpenRouter-first `launchMode:"ready"` create contract
  that validates one approved model and a real Telegram bot identity, then
  atomically persists the owned agent, managed config, four encrypted secrets,
  generated API-server key, desired-running intent, pending Step 3 deployment,
  and one safe audit event. Preserve stopped/manual creation as the default and
  perform no runner, DigitalOcean, Hermes, Telegram-send, or model-provider side
  effect after the bounded Telegram `getMe` credential preflight.
- compatibility and exact request schema:
  - The existing request `{name, templateKey}` and optional `runnerId` remains
    stopped/manual creation. Omitting `launchMode` is exactly equivalent to
    `launchMode:"stopped"`; it keeps the accepted Step 3 201 response body and
    event behavior. Ready-only fields on a stopped request are rejected so raw
    credentials cannot be silently ignored. Existing common name/template/
    runner validation, plan-limit behavior, authentication, and safe persistence
    mappings remain compatible.
  - A first-write ready request has exactly these managed fields (plus the
    existing common fields):
    `{name:string, templateKey:SupportedAgentTemplateKey, runnerId?:uuid|null,
    launchMode:"ready", idempotencyKey:string,
    openrouterModel:"openai/gpt-4.1-mini", openrouterApiKey:string,
    telegramBotToken:string, telegramAllowedUserIds:string[]}`. Do not accept a
    client-supplied provider, context length, bot ID/username, deployment stage,
    desired/observed status, config revision, API-server key, ciphertext,
    fingerprint, or event metadata.
  - `idempotencyKey` is trimmed once, case-sensitive, 8–128 characters, and must
    match `^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$`, a strict subset of Step 3's
    persisted boundary. `openrouterApiKey` is trimmed, at most 512 UTF-8 bytes,
    and retains the existing `sk-or-v1-` shape check. `telegramBotToken` is
    trimmed, at most 256 UTF-8 bytes, and retains the existing numeric-prefix/
    high-entropy suffix check. No validation issue contains the rejected value.
  - `telegramAllowedUserIds` is required for ready mode, is an array of 1–100
    canonical decimal strings matching `^[1-9][0-9]{0,19}$`, is deduplicated in
    first-seen order, and serializes to at most 2,100 UTF-8 bytes before the
    existing `telegram_allowed_users` secret normalizer stores the comma-joined
    form. JSON numbers, signed IDs, zero, leading zeroes, `*`, CSV strings,
    objects, blanks, and control characters are rejected to avoid precision
    loss and open Telegram access. The existing standalone secret mutation API
    may retain its legacy CSV/array input compatibility.
  - An authenticated replay may send only the common envelope needed to resolve
    `launchMode:"ready"` and the normalized `idempotencyKey`; after an owned
    deployment match is found, the server returns the original safe agent and
    deployment and does not require, compare, parse, encrypt, or revalidate the
    credentials/model/allowlist again. For Step 3 compatibility the idempotency
    key, not a request digest, owns the original result: changed fields with the
    same key do not mutate or replace it; a changed intent requires a new key.
- rollout flag:
  - Add one server-only exact parser for
    `AGENTBAY_READY_AGENT_CREATION_ENABLED`. Only trimmed lower-case `true`
    enables first-write ready creation; unset and explicit `false` disable it,
    and any other nonblank value fails closed as invalid configuration. Stopped
    creation is unaffected.
  - Order is JSON/common envelope validation, authentication, owner-scoped
    idempotency lookup, then flag enforcement, then first-write ready
    validation/preflight. Thus a previously accepted operation remains
    retrievable as a 202 replay after rollback disables new ready creates.
  - A disabled new ready request returns
    `503 {error:{code:"ready_agent_creation_disabled", message:"Automatic ready agent creation is not enabled."}}`, performs no Telegram fetch or database mutation, and never falls back to stopped creation. Add the placeholder/default-false setting to `.env.example`; do not enable hosted configuration in this step.
- server-approved OpenRouter model contract:
  - Add a server-only immutable metadata registry under
    `src/server/agents/` with `HERMES_MINIMUM_CONTEXT_TOKENS = 32_768` and the
    initial sole entry
    `{id:"openai/gpt-4.1-mini", provider:"openrouter", displayName:"GPT-4.1 Mini", contextTokens:1_047_576, enabled:true}`.
    The client sends only the ID; the server copies provider/model from this
    registry into `agent_configs`.
  - Model acceptance requires an exact enabled registry match, a safe ID token
    (`provider/model`, no whitespace/control/path/query/fragment characters),
    `provider === "openrouter"`, `model !== "not_configured"`, and server-owned
    `contextTokens >= HERMES_MINIMUM_CONTEXT_TOKENS`. Reject unknown, disabled,
    malformed, wrong-provider, `not_configured`, and below-threshold fixture
    entries. Never query OpenRouter's live catalog during create and never trust
    client-supplied display/context/provider metadata.
  - This allowlist is a versioned application contract, not proof of current
    provider availability or billing. Expanding/changing it later requires a
    reviewed catalog/test change; Step 4 does not add fallback routing or a
    provider/model canary.
- bounded Telegram `getMe` boundary:
  - Add a server-only injected-fetch client, preferably
    `src/server/telegram/telegram-client.ts`, with one POST to the fixed origin
    `https://api.telegram.org/bot<percent-encoded-token>/getMe`, no body, no
    retries, `redirect:"error"`, `Accept: application/json`, a five-second
    abort deadline, and a 16 KiB maximum response body enforced while streaming
    (not only by trusting `Content-Length`). Never accept a caller-supplied
    origin/path and never log or return the constructed URL, Request, headers,
    token, response body, Telegram `description`, or exception message.
  - Accept only a bounded plain JSON response with `ok:true` and a plain
    `result` containing a positive safe-integer `id`, `is_bot:true`, and an
    optional username matching `^[A-Za-z][A-Za-z0-9_]{4,31}$`. Require the
    decimal `result.id` to equal the token's numeric prefix. Map the stored safe
    metadata to `{botId:string, username:string|null}`; ignore all unrelated
    Telegram fields and do not persist first/last names, permissions, photos,
    language, messages, chats, or the raw result.
  - Map 401/404 and a bounded well-formed `ok:false` result to
    `invalid_bot_token`, rendered as a generic 400 `validation_failed` issue on
    `telegramBotToken`. Map abort to `telegram_validation_timeout`; transport/
    redirect failure to `telegram_validation_unavailable`; 429/5xx to
    `telegram_validation_unavailable`; and non-JSON, oversized, wrong-shape,
    ID-prefix mismatch, or other non-2xx output to
    `telegram_validation_invalid_response`. All non-token-invalid operational
    results become
    `503 {error:{code:"telegram_validation_unavailable", message:"Telegram bot validation is temporarily unavailable."}}` with no upstream detail.
  - Authenticate and resolve an idempotency replay before calling this client.
    Unit/DB/route tests use injected fake fetch only. This specification pass
    and its implementation gates must not call a real Telegram endpoint or use
    a real token.
- active Telegram credential uniqueness and migration:
  - The existing public/status `agent_secrets.fingerprint` is a 16-hex HMAC made
    with the row's encryption key. It changes when the active encryption key
    version rotates and therefore must not be used alone for cross-agent token
    uniqueness. Preserve it and its existing secret-reference compatibility.
  - Add nullable server-only columns on `agent_secrets`:
    `uniqueness_fingerprint text`, `provider_subject_id text`, and
    `provider_username text`. New Telegram rows store a full 64-hex SHA-256 of
    the domain-separated high-entropy normalized token in
    `uniqueness_fingerprint` plus the accepted `getMe` bot ID/username; all
    other secret kinds store null. These fields never appear in secret status,
    launch spec, backup, event, log, create, or deployment DTOs.
  - Add checks for the 64-hex fingerprint, positive 1–20 digit subject ID,
    bounded Telegram username, Telegram-kind-only metadata, and metadata pair
    consistency. Add unique partial indexes on `uniqueness_fingerprint` and
    `provider_subject_id` where `kind='telegram_bot_token' AND status='active'`
    and the indexed value is non-null. Agent soft delete already revokes active
    secrets, so a correctly revoked/deleted bot can be reused; do not join or
    infer ownership in application code when the database can reject a race.
  - The additive migration leaves historical encrypted rows' new fields null;
    SQL cannot safely derive them. Before enabling the flag, a bounded
    transaction-aware backfill scans only active Telegram rows, decrypts them
    with the configured keyring, computes the stable uniqueness fingerprint,
    and populates it under a transaction advisory lock. It never calls Telegram
    for legacy rows and never prints raw values. Duplicate legacy tokens or an
    undecryptable legacy row fail closed with a safe operator blocker; do not
    choose a winner or revoke data automatically. The ready writer also checks
    unresolved legacy active rows under the same lock so a skipped backfill
    cannot admit a known duplicate.
  - Refactor the existing Telegram secret replace path to use the same prepared
    encrypted-row writer and uniqueness fingerprint. A Telegram replacement
    must validate `getMe` before mutation and atomically revoke the old row,
    insert the new row/metadata, and map uniqueness races to the same generic
    409 `telegram_bot_in_use`; other secret kinds retain their existing API
    behavior. Revocation clears availability by status, not by deleting
    history.
- atomic create and Step 3 idempotency contract:
  - For a non-replay ready request, complete pure validation, keyring parsing,
    server generation of an agent UUID/config revision and `agb_agent_*`
    API-server key, encryption preparation, and the single bounded `getMe`
    call before opening the database transaction. Prepared ciphertext remains
    in memory only and is discarded on failure; no plaintext is returned.
  - Ready creation must not reuse the existing stopped flow's out-of-transaction
    DigitalOcean provisioning or live runner verification. Inside one database
    transaction, enforce the owner plan limit and database-only requested-
    runner ownership/eligibility, take an owner/idempotency transaction advisory
    lock, reselect the Step 3 `(user_id,idempotency_key)` operation, and only
    when absent insert: one `agents` row with observed `status='stopped'` and
    `desired_status='running'`; one template-backed `agent_configs` row with
    `model_provider='openrouter'` and the approved model; four active encrypted
    secret rows (`openrouter_api_key`, `telegram_bot_token`, normalized
    `telegram_allowed_users`, generated `api_server_key`); one Step 3
    `pending` deployment; and one `agent.created` event.
  - Use one injected `now` for agent/config/secret/deployment/event timestamps
    and `configRevision = "cfg-" + now.getTime()` (validated by Step 3's safe
    revision contract). If the accepted Step 3 implementation exposes an
    equivalent transaction-aware revision helper, reuse it rather than
    duplicating parsing. A requested eligible owned runner may be assigned;
    absence of an automatic runner leaves `runner_id` null for later
    reconciliation and is not permission to provision one in Step 4.
  - Export transaction-aware secret preparation/insertion and API-key
    generation primitives from `agent-secrets.ts`; do not call
    `replaceAgentSecretForUser` or `generateApiServerKeyForUser`, which open
    independent transactions. Encryption stays AES-256-GCM with current AAD,
    fresh 12-byte IV per row, configured key version, and server randomness.
  - Call the accepted Step 3 deployment insertion within the same transaction.
    Same-key races serialize on the advisory lock and reselect the original
    owner-scoped operation before inserts; the Step 3 unique index remains the
    final authority. A Telegram fingerprint/bot-ID race maps to a generic 409
    and rolls back agent/config/all secrets/deployment/event. Any injected
    failure at each insert boundary likewise leaves all six logical record
    groups at their pre-request counts. No reconciliation trigger or external
    infrastructure action is part of Step 4.
- exact response and error behavior:
  - New ready creation and every ready replay return HTTP 202 with exactly
    `{agent, deployment}`. `deployment` is the accepted Step 3 public DTO and
    begins `pending` with attempt count zero on first write. `agent` uses the
    accepted create-agent safe DTO, reports observed `status:"stopped"`, adds
    `desiredStatus:"running"`, the safe selected model, and
    `telegramBot:{id,username}`; it contains no `event` object or internal
    idempotency/lease fields. A replay returns the persisted current deployment
    DTO (including a later terminal stage), not a synthetic pending snapshot.
  - Default/explicit stopped creation returns HTTP 201 with the accepted Step 3
    stopped response unchanged; no deployment or managed credentials are
    created and desired status remains stopped.
  - Model/token/allowlist validation is 400 `validation_failed`; disabled flag
    and Telegram operational validation are 503 as above; active bot reuse is
    `409 {error:{code:"telegram_bot_in_use", message:"Telegram bot is already assigned to an active agent."}}` without identifying the owner/agent; unsafe keyring is the existing 503
    `agent_secret_configuration_invalid`; database/schema/unavailable and
    plan/runner errors retain existing safe mappings. Never turn a ready failure
    into a stopped success.
- events, logging, and redaction:
  - Write exactly one `agent.created` event on the first committed ready create
    and none on replay/rollback. Its allowlisted metadata is limited to
    `templateKey`, `templateVersion`, `status:"stopped"`,
    `desiredStatus:"running"`, `launchMode:"ready"`,
    `modelProvider:"openrouter"`, `modelName`, `runnerAssignment`, and
    `deploymentId`. Do not persist the bot ID/username, Telegram allowlist,
    fingerprints, idempotency key, config revision, secret status, or any raw/
    encrypted credential in event metadata.
  - Create/Telegram logs use closed event names and safe booleans/categories
    only. Do not pass the ready payload, secret values, URL, fetch objects,
    provider body/description, error message/cause, ciphertext, IV, auth tag,
    key version, fingerprint, bot ID, username, allowed-user IDs, private
    endpoint, or generated API key to `console.*`, events, errors, snapshots,
    or progress/changelog evidence. Extend `redactSecretText` for a full
    `api.telegram.org/bot<TOKEN>/...` URL as defense in depth, while tests still
    require that such strings are never intentionally constructed in output.
  - Response/event/log redaction tests use distinct canaries for each plaintext
    secret, ciphertext, IV, auth tag, uniqueness fingerprint, API key, bot ID,
    username, allowlist ID, and private URL and assert absence on every success,
    replay, conflict, timeout, malformed upstream, transaction failure, and
    thrown dependency path.
- ownership and isolation:
  - Resolve `requireConfiguredApplicationUser` before any external call.
    Idempotency lookup is always `(applicationUser.userId,idempotencyKey)` and
    joins the matching owned non-deleted agent/deployment; different users may
    reuse an idempotency key but never observe each other's operation or agent.
  - Requested runner selection remains explicitly owner-scoped. Foreign,
    deleted, or unassignable runner input uses the existing concealed runner
    response and performs no `getMe`, secret preparation, or mutation after the
    database-only ownership determination where practical. Global duplicate
    bot conflicts reveal only the generic 409, regardless of whether the other
    agent belongs to the same or another user.
  - Extend `tests/unit/agent-request-user-boundaries.test.ts` with the ready
    `createAgentForUser`/idempotency surface and the real two-user database
    matrix with same-key/different-user, foreign runner, duplicate bot, and
    replay cases. No development-user resolver may appear in the app route.
- migration and required tests / gates:
  - After Step 3 lands, run `bun run db:generate` for the next migration (likely
    `0017`; accept the generated name), including snapshot/journal metadata.
    Review it as additive: three nullable secret metadata columns, checks, and
    two partial unique indexes only. Do not hand-edit Drizzle metadata, rewrite
    Step 3 enums/constraints, decrypt in SQL, backfill fake metadata, drop old
    fingerprint/reference fields, or change historical agents' desired state.
  - Clean and Step-3-upgrade migration fixtures must run `bun run db:migrate`
    once and again idempotently. Seed legacy active/revoked Telegram rows across
    multiple encryption key versions and soft-deleted agents; prove schema
    migration preserves ciphertext/history, backfill is deterministic and
    secret-silent, duplicates/undecryptable rows fail closed, new unique indexes
    reject active fingerprint/subject races, revoked rows may coexist, and
    non-Telegram rows cannot carry provider metadata.
  - Validation/catalog tests cover both launch modes, legacy omission,
    conditional required/forbidden fields, all byte/count/canonical ID bounds,
    exact approved model metadata, below-threshold/disabled/unknown/unsafe
    fixtures, and client metadata rejection. Feature-flag tests cover true,
    unset/false, invalid, disabled first write, and disabled replay.
  - Telegram-client tests use fake streams/clocks and cover exact request
    method/origin/no-retry/redirect/deadline, success with/without username,
    token-prefix mismatch, non-bot, unsafe IDs/usernames, 401/404/429/5xx,
    `ok:false`, invalid JSON, oversized declared/streamed bodies, redirect,
    abort, network throw, and complete output/log redaction.
  - Secret tests cover transaction-aware AES-GCM insertion/decryption, four
    distinct IVs, generated API-key shape, stable uniqueness fingerprint across
    encryption-key rotation, old public fingerprint compatibility, Telegram
    rotation/revocation metadata, database uniqueness races, and no plaintext/
    uniqueness metadata in any DTO/reference/backup/launch surface.
  - Ready-create database tests use a real PostgreSQL transaction and separate
    connections/barriers: exact six-group success state; rollback injected at
    config, each secret, deployment, and event; same-key sequential and
    concurrent convergence; changed-body replay; different-key/different-user
    isolation; token and bot-ID races; plan/runner ownership; stopped-path
    compatibility; no runner/provisioner/reconciler invocation; and no event on
    replay/failure. Mock-only transaction tests are insufficient.
  - Route tests cover exact 201 stopped and 202 ready/replay bodies plus every
    safe 400/409/503/500 mapping and canary redaction. Extend schema, create DB,
    create validation/route, agent secrets/route, event, request-boundary,
    user-isolation, backup/launch redaction, and reset/truncate fixtures as
    needed.
  - Run `bun run db:generate`; clean/upgrade/backfill `bun run db:migrate`
    evidence; focused catalog/Telegram/create/secret/schema/migration/event/
    isolation tests; `bun run format:check`; `bun run lint`;
    `bun run typecheck`; `bun run test`; `bun run build`;
    `bun run test:e2e:ci`; and `git diff --check`. Run
    `bun run verify:hermes:staging` only in its credential-free fail-closed mode;
    it is not a Step 4 live-success gate. Fix every failure before proceeding.
- likely touchpoints:
  - Primary: `src/server/agents/create-agent.ts`, `app/api/agents/route.ts`,
    `src/server/agents/agent-secrets.ts`, new
    `src/server/agents/openrouter-models.ts`, new
    `src/server/telegram/telegram-client.ts`, `src/server/db/schema.ts`, and the
    generated next `drizzle/*.sql` plus `drizzle/meta/*`.
  - Step 3 reuse: committed `src/server/agents/agent-deployments.ts`,
    `deployment-state.ts`, `deployment-dto.ts`, and the deployment schema/index
    contract. Add a narrowly transaction-aware owner/idempotency lookup helper
    if the accepted service does not expose one; do not fork its DTO or
    transition semantics.
  - Compatibility/security: `src/server/events/agent-events.ts` only if an
    allowlisted creation-event helper is needed; `src/shared/secret-redaction.ts`;
    `src/server/env.ts` or a small exact flag parser; `.env.example`;
    `tests/unit/agent-request-user-boundaries.test.ts`; shared database reset
    fixtures; `PROGRESS.md`; and `CHANGELOG.md`.
  - Focused tests: `tests/unit/create-agent-validation.test.ts`,
    `create-agent-route.test.ts`, `create-agent-db.test.ts`,
    `agent-secrets.test.ts`, `agent-secrets-route.test.ts`,
    `agent-schema.test.ts`, `agent-events.test.ts`,
    `agent-user-isolation.test.ts`, plus new model, Telegram-client, and
    migration/backfill test files.
- non-goals:
  - No Step 5 launch-spec/YAML projection or setup-wizard changes; no Step 6
    async runner launch/status; no Step 7 reconciler/cron/heartbeat trigger; no
    Step 8 create UI/polling; no Step 9 restart policy; and no Step 10 real
    provider, bot message/reply, Droplet, image publication, hosted flag/secret,
    or billable acceptance.
  - No OpenRouter network validation/model canary, Telegram send/poll/webhook,
    runner/DigitalOcean provisioning, post-commit background action, provider
    beyond OpenRouter, arbitrary model input, open Telegram access, DM pairing,
    or new queue dependency.
- risks:
  - Reusing the encryption-key-dependent 16-hex fingerprint for global
    uniqueness admits duplicate tokens after key rotation; leaving legacy null
    uniqueness rows unchecked admits duplicates during rollout. The separate
    stable fingerprint, partial indexes, advisory lock, and fail-closed
    backfill are required together.
  - Calling existing per-secret public helpers from create would commit partial
    rows. Calling DigitalOcean/runner verification from the ready path would
    violate post-commit orchestration. Calling `getMe` before auth/replay or
    logging a fetch URL leaks credentials and creates an unbounded external
    oracle.
  - Same-key races can orphan a second agent if idempotency is inserted last
    without serialization/recheck. Telegram fingerprint/subject races must map
    the exact constraint and roll back the whole transaction, not surface raw
    PostgreSQL detail.
  - Numeric Telegram IDs passed as JavaScript numbers can lose precision;
    arbitrary model/context metadata can bypass the Hermes minimum; storing
    allowlist IDs/bot identity in events/logs expands PII exposure.
- do not touch:
  - Uncommitted Step 3 files, migration, tests, Active Work, builder handoff, or
    its eventual changelog/progress evidence. Wait for its commit/check, then
    build on the accepted tree and next migration number.
  - Step 2 readiness/parser/cleanup behavior and pinned image/digests; existing
    lifecycle start/stop/restart/delete semantics; runner provisioning,
    capacity/reconciliation code beyond database-only ready placement; native
    Hermes setup terminal; backup format; product UI; hosted settings;
    `.env.local`; real credentials; external services; and prior progress/
    changelog ledgers.
- blockers:
  - Hard dependency: Step 3 is currently uncommitted and unchecked. The
    coordinator must not assign a Step 4 builder until its exact commit and
    independent ALL GREEN evidence exist.
  - Implementation requires a safely configured agent-secret keyring and local
    PostgreSQL for transaction/concurrency/migration gates. Missing either is a
    reported blocker, not permission to store plaintext, weaken uniqueness, or
    substitute mock-only success.
  - No real OpenRouter/Telegram/DigitalOcean credential or external service is
    needed for implementation. Real `getMe`, model, Droplet, and reply evidence
    remains explicitly deferred to Step 10 authorization.
- progress/changelog/commit:
  - After all gates, mark Step 4 complete in the Automatic Ready ledger, record
    only safe atomicity/redaction/migration evidence and the commit reference,
    set Step 5 next, and preserve every historical ledger.
  - Add newest-first `Unreleased`/`Added` entries for opt-in 202 ready-mode
    OpenRouter/Telegram creation and `Unreleased`/`Security` entries for atomic
    encrypted credentials, bounded bot validation, and active-bot uniqueness.
    Never mention credential values, bot/user IDs, private endpoints, or
    fingerprints. Commit exactly
    `feat: accept managed Hermes creation credentials`.
- exact repository evidence at pre-spec time:
  - `HEAD 897e28f99e61617b5ec6fe9ae7f01dad19a3a0b3` is independently ALL GREEN
    for Step 2. The accepted parser/readiness evidence is already recorded above
    (6 focused files / 43 tests, production waiter smoke, 99 files / 879 tests,
    build, 14 E2E tests, and diff check).
  - Active Step 3 currently modifies `src/server/db/schema.ts` and
    `drizzle/meta/_journal.json` and adds `drizzle/0016_motionless_fantastic_four.sql`,
    `drizzle/meta/0016_snapshot.json`, `src/server/agents/deployment-state.ts`,
    `deployment-dto.ts`, `agent-deployments.ts`, and
    `app/api/agents/[agentId]/deployment/route.ts`, with concurrent focused work
    now also visible in `tests/unit/agent-deployment-state.test.ts`,
    `agent-deployments-db.test.ts`, `agent-deployment-route.test.ts`,
    `agent-schema.test.ts`, `agent-user-isolation.test.ts`, and
    `agent-request-user-boundaries.test.ts`. This is evidence for likely seams
    only, not an accepted contract until committed/checked.
  - Existing stopped creation uses `validateCreateAgentPayload`,
    `createAgentForUser`, one `connection.db.transaction`,
    `insertDefaultConfigForCreatedAgent`, and
    `recordAgentEventInTransaction`, but may perform runner provisioning/
    verification outside the final insert transaction. Existing secrets use
    AES-256-GCM with agent/kind/key-version AAD, 12-byte IVs, server-generated
    `agb_agent_*` keys, per-agent/kind active uniqueness, owner-concealed reads,
    transactional revoke-on-delete, and the key-version-dependent 16-hex HMAC
    fingerprint. No Telegram client or approved OpenRouter catalog exists yet.
- open questions:
  - None behavior-blocking after Step 3 acceptance. This contract resolves the
    plan's unspecified choices as an exact OpenRouter model ID, 32,768-token
    minimum, string-only Telegram IDs, five-second/16-KiB `getMe`, stable
    server-only uniqueness fingerprint plus bot-subject index, default-off exact
    flag, replay-before-flag semantics, and 201-stopped/202-ready compatibility.
    Any deviation changes a public API, credential migration, or rollout safety
    promise and requires coordinator/product approval before generating the
    Step 4 migration.

## Step 5 Completion Contract (pre-spec)

- readiness: `blocked`. Step 3 is committed and independently ALL GREEN at
  `7024bc2af52246179983507d3b9bcbed7e76c7d5`; its acceptance is recorded by
  `ba8c969`. Step 4 is now active and uncommitted. Step 5 must not start until
  Step 4 is implemented, committed exactly as
  `feat: accept managed Hermes creation credentials`, and independently
  accepted. Re-read both accepted Step 3/4 commits before implementation; this
  contract may reuse their final names but may not weaken their public
  semantics.
- issue: `PLAN.md` Step 5 — Project a Complete Managed Hermes Configuration.
- outcome: Add a backward-compatible `agentbay.hermes.launch.v3` contract for
  managed OpenRouter + Telegram agents, build it from owner-scoped database
  configuration and just-in-time decrypted secrets, and project a complete,
  deterministic pinned-Hermes configuration into a fresh per-agent state root.
  Managed agents no longer require the interactive wizard; existing native/
  manual agents and restored backups retain the current setup gate. Advanced
  Hermes settings remain usable and are preserved semantically outside the
  explicitly plingpling-owned paths.
- exact launch-spec compatibility and versions:
  - Add `MANAGED_AGENT_LAUNCH_SPEC_VERSION` with the exact value
    `agentbay.hermes.launch.v3`. Retain parsing and runtime acceptance of the
    current `agentbay.hermes.launch.v2` native/manual shape during this step;
    do not silently reinterpret v2 as managed and do not make an older runner
    accept unknown v3 fields. `AgentLaunchSpec` becomes the explicit v2 | v3
    union, with a discriminated parser and redactor for each version.
  - The v3 root has exactly, in canonical serialization order:
    `version`, `requestId`, `agent`, `image`, `model`, `platforms`, `schedule`,
    `prompt`, `runtime`, `tools`, and `secrets`. Unknown, missing, inherited,
    symbol, accessor, or non-own fields fail. Every nested object also uses an
    exact key set; arrays are ordinary dense arrays; objects must have
    `Object.prototype` or null prototypes and are copied into new records.
  - `version` is the v3 literal. `requestId` is 8–80 UTF-8 bytes and matches
    `^[A-Za-z0-9][A-Za-z0-9._:-]{7,79}$`. `agent` has exactly
    `{id,name,templateKey,templateVersion,configRevision}`: ID is a canonical
    UUID; name is trimmed, 1–120 Unicode scalar values and at most 480 UTF-8
    bytes with no controls; template key is a 1–80 safe token; template version
    is trimmed, 1–40 bytes with no controls; config revision reuses Step 3's
    exact untrimmed `^[A-Za-z0-9_.:-]{1,80}$` validator.
  - `image` remains exactly `{ref}`; ref is 1–512 bytes and matches the existing
    safe image-reference alphabet. The builder continues using the reviewed
    pinned/published workload-image setting; v3 does not authorize tag-only
    publication or change the pinned v2026.7.7.2 digest contract.
  - `model` is exactly `{provider:"openrouter",model}`. `model` must be the
    exact enabled Step 4 server registry entry (initially
    `openai/gpt-4.1-mini`), 3–128 bytes, and match a single safe
    `provider/model` token with no whitespace, controls, URL/query/fragment, or
    path traversal. The runner validates the structural token; the server
    builder revalidates it against the accepted Step 4 registry and minimum
    context contract. No client/provider metadata travels in the launch spec.
  - `platforms` is exactly
    `{required:["api_server","telegram"],apiServer:{enabled:true,host:"0.0.0.0",port:8642},telegram:{enabled:true,allowAllUsers:false,unauthorizedDmBehavior:"ignore"}}`.
    Tuple order and all literals are mandatory. This is configuration intent,
    not an instruction to publish port 8642; the existing private Docker
    network/no-public-port contract remains authoritative.
  - `schedule`, `prompt`, and `tools` retain the current exact v2 shapes and
    bounds. `prompt.soul` is trimmed, nonblank, at most 20,000 Unicode scalar
    values and 64 KiB UTF-8, with no NUL. `runtime` has exactly
    `{dataDir:"/opt/data",workspaceDir:"/workspace",terminalCwd:"/workspace",browserEnabled:false,unattendedLoopLimit,toolLoopGuardrails}`;
    loop limit remains an integer 1–100 and `toolLoopGuardrails` is exactly
    `{hardStopEnabled:true,hardStopAfter:{exactFailure:5,idempotentNoProgress:5}}`.
    Existing exact enabled/disabled tool tuples remain unchanged.
  - `secrets` is exactly
    `{kind:"inline",openrouterApiKey,telegramBotToken,telegramAllowedUsers,apiServerKey}`.
    OpenRouter is trimmed, matches Step 4's `sk-or-v1-` validation, and is at
    most 512 bytes. Telegram token is trimmed, matches Step 4's canonical
    numeric-prefix/high-entropy form, and is at most 256 bytes. Allowed users
    is 1–100 unique canonical decimal strings matching
    `^[1-9][0-9]{0,19}$`, preserves the persisted first-seen order, and joins
    to at most 2,100 bytes. API key retains the exact
    `^agb_agent_[A-Za-z0-9_-]{32,}$` shape and 40–300 byte bound. Control
    characters, numbers for Telegram IDs, `*`, duplicates, leading zeroes, and
    empty values fail before filesystem or Docker work.
  - The JSON body limit remains exactly 64 KiB and is checked on UTF-8 bytes
    before JSON parsing. Parsing, serialization, and error issues never include
    rejected values. Canonical serialization emits only the declared keys in
    the order above and never serializes database rows, error causes, Requests,
    environment objects, or prototype-owned data.
- deterministic revision and redacted serialization:
  - A managed v3 build selects the newest owner-bound deployment by
    `created_at DESC, id DESC` and uses its already persisted
    `config_revision` verbatim. For the Step 4 first operation this is exactly
    its accepted `cfg-<single injected now>` value. Do not recompute it from a
    random request ID, plaintext/ciphertext, Telegram identifiers, process
    time, filesystem mtimes, or a fresh hash. A later managed configuration
    change requires a newly persisted revision/operation; silently projecting
    changed managed values under an old revision is invalid.
  - The transport `requestId` may remain per-request, but it is not written to
    `config.yaml`, `.env`, `SOUL.md`, or the projected revision marker. The
    marker is canonical JSON plus one LF with exactly
    `{version,agentId,configRevision,image}` so repeated projection of the same
    revision and inputs is byte-stable.
  - `redactAgentLaunchSpec`/the canonical redacted serializer preserves the v3
    nonsecret structure but replaces every secret scalar with `[secret]` and
    the allowlist with exactly `["[secret]"]`. It exposes no raw value,
    length, count, prefix, suffix, Telegram ID, bot identity, fingerprint,
    ciphertext, IV, auth tag, key version, or digest derived from plaintext.
    Tests use distinct canaries for every credential and identifier across
    parse failures, safe errors, logs, runner responses, snapshots, and JSON.
- managed builder and owner-scoped just-in-time decryption:
  - Extend `agent-launch-builder.ts` without adding a client-controlled mode.
    Within one consistent owner-scoped read, select the non-deleted agent,
    config, newest `(agent_id,user_id)` deployment, and required active secret
    rows. A deployment plus the accepted Step 4 managed OpenRouter config is
    the managed discriminator. An owned agent without a deployment remains the
    v2 native/manual path; a restored agent must not become managed merely
    because its manifest names OpenRouter or contains stale vault references.
  - Managed v3 requires exactly one active row for each of
    `openrouter_api_key`, `telegram_bot_token`, `telegram_allowed_users`, and
    `api_server_key`. Fetch/decrypt only those four kinds after ownership and
    mode are resolved. Do not select or decrypt foreign-agent rows, revoked
    history, uniqueness/provider metadata, or unrelated kinds; do not expose
    secret-row IDs or metadata in the launch spec.
  - Return closed safe results: existing missing/malformed ID and concealed
    `agent_not_found`; `managed_deployment_missing`,
    `managed_configuration_invalid`, `required_secret_missing`,
    `required_secret_revoked`, `secret_storage_unavailable`,
    `secret_decryption_failed`, and `launch_spec_invalid`. Missing/revoked
    results may carry only an ordered allowlisted kind name for the already
    authenticated owner. Keyring/decryption/persistence exceptions are mapped
    without their message/cause, ciphertext, key version, or failing value.
  - A revoked row is never used as fallback, and one bad required secret fails
    the whole build before runner transport. Decrypted values live only for
    validation, v3 construction, HTTPS serialization, and projection; no
    persistence/event/log/backup mutation is part of the build.
  - Keep v2 native/manual compatibility: it decrypts only `api_server_key`,
    produces the existing Hermes-configured model sentinel, and continues to
    require a previously created nonblank `config.yaml`. The Step 5 code must
    not force four managed secrets onto historical/manual agents.
- runner transport and error boundary:
  - Continue sending the strict JSON launch spec only in the authenticated
    start/restart POST body. `validateManualRunnerEndpointUrl` remains the
    boundary: non-loopback runners require HTTPS; loopback HTTP is test/local
    only. Preserve the runner bearer token, exact content type, 64-KiB body
    limit, bounded timeout, private Docker network, and no-public-Hermes-port
    behavior.
  - Never put a launch body or redacted/full spec in URL/query, argv, Docker
    labels, environment inherited from the control plane, request/error logs,
    events, or runner responses. Docker labels/marker carry only the safe
    version/revision evidence already reviewed. Manual-runner logging retains
    host/status/safe reason data only.
  - Runner/projection failures use stable allowlisted codes such as
    `hermes_setup_incomplete` for v2 and `hermes_projection_invalid` for v3;
    YAML/path/write/secret detail is never returned. A projection failure
    occurs before container creation/removal, and existing Step 2 cleanup and
    readiness reason allowlists remain unchanged.
- YAML dependency and secure document contract:
  - A real YAML implementation is required because preserving arbitrary
    unrelated Hermes mappings while replacing nested managed paths cannot be
    done safely with string concatenation. Add direct runtime dependency
    `"yaml":"2.8.1"` exactly and update `bun.lock`; do not rely on Vite's
    optional peer, a transitive install, Python/PyYAML, shelling out, or an
    unpinned range. This step has no database migration.
  - Parse at most 256 KiB of UTF-8 with the package's YAML 1.2 core schema,
    strict mode, unique keys, merge keys disabled, custom tags disabled, and
    exactly one document. Reject parser warnings as well as errors, directives,
    aliases, anchors, explicit/custom tags, duplicate keys, non-string map
    keys, nonfinite numbers, binary/timestamp objects, sparse collections,
    nesting over 64, more than 4,096 collection entries, or a root other than a
    mapping. No schema/type fallback is allowed.
  - Convert through `mapAsMap:true`/zero alias allowance, validate recursively,
    reject `__proto__`, `prototype`, and `constructor` at every level, then copy
    to fresh null-prototype records/ordinary dense arrays before merging.
    Scalar values are limited by the total document and nesting limits. Never
    call constructors or accept JavaScript tags.
  - Serialize canonically as YAML 1.2 with two-space indentation, LF endings,
    no directives/document marker, no aliases, no folding, unlimited line
    width, and deterministic lexicographic mapping-key order. Preservation is
    semantic: unrelated safe values survive, but comments, anchors, quoting,
    key order, and whitespace are not compatibility promises. A second parse
    of rendered output must pass the same validator before any rename.
  - Reject raw secret material in YAML. Always remove managed legacy secret
    paths (`model.api_key`, Telegram token/allowlist fields, and API-server key)
    before writing, and fail closed on any other key named like a token,
    password, credential, authorization, private/API key unless its value is a
    validated env-reference placeholder. Also reject known secret canary/token
    shapes anywhere in YAML. Do not log the document or offending scalar.
- exact plingpling-managed Hermes v2026.7.7.2 paths:
  - In `config.yaml`, overwrite exactly:
    `model.provider="openrouter"`; `model.default=<approved model>`;
    `terminal.backend="local"`; `terminal.cwd="/workspace"`;
    `browser.enabled=false`; `tool_loop_guardrails.hard_stop_enabled=true`;
    `tool_loop_guardrails.hard_stop_after.exact_failure=5`;
    `tool_loop_guardrails.hard_stop_after.idempotent_no_progress=5`;
    `platforms.api_server.enabled=true`;
    `platforms.telegram.enabled=true`; and
    `unauthorized_dm_behavior="ignore"`. Remove conflicting legacy
    `api_server.enabled`, `telegram.enabled`, and nested
    `gateway.platforms.{api_server,telegram}.enabled` values rather than
    allowing a higher/lower-precedence alias to disable or weaken the managed
    result. Preserve all other safe map entries, including unrelated siblings
    beneath `model`, `terminal`, guardrails, gateway, and platform entries.
  - In `.env`, plingpling owns exactly these keys in this fixed render order:
    `OPENROUTER_API_KEY=<secret>`, `TELEGRAM_BOT_TOKEN=<secret>`,
    `TELEGRAM_ALLOWED_USERS=<canonical comma list>`,
    `API_SERVER_KEY=<secret>`, `API_SERVER_ENABLED=true`,
    `API_SERVER_HOST=0.0.0.0`, `API_SERVER_PORT=8642`,
    `GATEWAY_ALLOW_ALL_USERS=false`, and
    `TELEGRAM_ALLOW_ALL_USERS=false`. Quote secret/PII values with the existing
    JSON-string env escaping after control/newline rejection. Remove all prior
    assignments of managed keys, including whitespace/`export` forms, then
    append one canonical block. Preserve unrelated well-formed lines and order;
    reject NUL, oversized input, malformed managed assignments, or multiline
    constructs that could smuggle a second managed value.
  - No OpenRouter key, Telegram token/allowlist, or API key may appear in YAML,
    SOUL, revision metadata, logs, backups, filenames, Docker labels, or error
    strings. Provider/model and platform enablement are safe config values;
    numeric Telegram IDs remain secret/PII despite Hermes naming the allowlist
    variable as non-password metadata.
- merge, atomicity, ownership, and path safety:
  - Managed v3 may treat a missing, empty, or whitespace-only `config.yaml` as
    an empty mapping and create it. Native/manual v2 retains
    `HermesSetupRequiredError` for the same state. Invalid/unsafe existing YAML
    never gets replaced with a blank managed file; projection fails before
    container work.
  - Resolve only a validated UUID beneath the configured absolute trusted
    state root. Require the state root and every existing component from root
    through `<agent>/hermes` and `<agent>/workspace` to be real directories,
    never symlinks; reject a non-directory, realpath escape, mount/path swap,
    or any target/temp path outside its immediate managed parent. Read existing
    files using no-follow handles and require regular files within their byte
    bounds; FIFOs/devices/sockets/hard-link surprises fail closed.
  - Stage `config.yaml`, `.env`, `SOUL.md`, and revision JSON in same-directory
    random `O_CREAT|O_EXCL|O_NOFOLLOW` files. Write fully, fsync, set exact mode
    and UID/GID on the open handle, close, revalidate the parent, and rename.
    Commit the revision marker last and fsync the directory. A failure cleans
    only its owned temp files. If a multi-file rename is interrupted, the old
    marker remains authoritative and launch/revision inspection rejects the
    partial state; the next same-revision projection repairs it deterministically.
  - Directories are exact `0700`; `.env` is exact `0600`; `config.yaml`,
    `SOUL.md`, and revision metadata are exact `0644`. All created/replaced
    paths use the workload ownership passed by the runner, expected
    `uid=10000,gid=10000` for the pinned image; do not depend on process umask,
    a root-owned readable fallback, or an image entrypoint to repair ownership.
    Reprojection corrects modes/ownership without following links.
  - The same revision with the same existing unrelated semantic config produces
    byte-identical four-file content. A new revision changes the marker and
    only managed values whose database inputs changed; unrelated safe values
    survive canonical re-render. Managed projection never deletes workspace,
    sessions, memory, skills, or other Hermes files.
- fresh, native/manual, setup, and lifecycle compatibility:
  - A valid owner-built v3 spec must project and launch from a fresh empty
    `<stateRoot>/<agentId>` without opening setup. A v3 body missing any exact
    field/secret/platform literal fails before filesystem mutation. A v2 spec,
    bodyless legacy start, and restored/manual agent keep their existing gates
    and runner behavior.
  - Keep setup-session routes, the one-time websocket/PTTY security model, and
    `SETUP_COMMAND` available as advanced/recovery tooling. Rename UI copy to
    “Advanced Hermes setup” and state plainly that plingpling-managed provider,
    model, API server, Telegram access, terminal/browser, safety, and managed
    `.env` keys are reapplied on the next Start/Restart; unrelated advanced
    settings are preserved. Do not add browser credential fields or echo PTY
    output into application logs/events.
  - Setup remains blocked while the workload is running and retains assignment,
    token, TTL, single-session, and cleanup behavior. A stopped managed agent
    may use advanced setup, but subsequent v3 projection wins on managed paths.
    The setup route must not generate/replace an already present managed API
    key or downgrade a managed agent to native/manual.
  - Update lifecycle prechecks so managed agents require the accepted v3
    database/deployment/four-secret contract, not config-file existence or the
    wizard. Native/manual agents retain the existing safe setup message.
    Start/restart pass the correct union member; stop/delete/cleanup behavior,
    Step 2 readiness parsing and orphan cleanup, and Step 3 desired/deployment
    transitions are otherwise unchanged in Step 5.
- backup/restore interactions:
  - Do not bump backup schema or add launch specs, plaintext secrets, `.env`,
    `config.yaml`, projected revision metadata, Telegram identity/allowlist,
    uniqueness fingerprints, ciphertext, IV, auth tag, or key version to a
    manifest/artifact/event/summary. Existing safe vault references remain
    references only and are not dereferenced during backup or restore.
  - Restore continues to create a new observed/desired-stopped agent with no
    deployment and no secret rows. It restores safe model/config metadata but
    never converts stale vault references into credentials and therefore takes
    the v2 native/manual setup path until the owner explicitly configures new
    credentials through a later supported flow. It cannot launch automatically
    from a source agent's managed state.
  - Extend the local filesystem contract smoke so copied/restored Hermes state
    and workspace data survive a managed reprojection/restart, managed keys are
    repaired from the database/spec, unrelated advanced config and the
    workspace sentinel survive, and no secret appears in the copied evidence.
- required semantic tests and contract smoke:
  - Launch-spec/parser tests: v2 compatibility; exact v3 good fixture;
    stale/unknown/missing/root and nested keys; prototypes/accessors; every
    byte/count/pattern/literal/tuple bound; UTF-8 versus code-point bounds;
    allowlist order/duplicates/precision; 64-KiB body; canonical and redacted
    serialization; distinct secret/PII canary absence on all failures.
  - Builder/secret tests with real PostgreSQL: owner concealment; managed
    discriminator and newest deployment revision; exact four-kind active read;
    missing versus revoked; invalid model/config; malformed decrypted values;
    missing key version/auth-tag failure; keyring failure; corrupted unrelated
    and foreign rows not decrypted; v2 one-key compatibility; stable safe
    results and zero response/log/event/backup leakage. Mock-only ownership and
    decryption tests are insufficient.
  - YAML/projection tests: fresh empty root; exact pinned managed paths/env;
    secret-free YAML/SOUL/marker; nested unrelated preservation; conflicting
    alias overwrite/removal; same-revision byte stability; new-revision
    managed-only semantic delta; CRLF/duplicate/export env merging; all YAML
    alias/tag/merge/duplicate/multidoc/prototype/depth/size hazards; invalid
    existing config leaves old files/marker intact.
  - Filesystem tests: symlinks at root/agent/hermes/workspace/all four targets
    and temps; traversal/non-UUID/non-directory/FIFO/oversize; exact modes;
    injected UID/GID calls; failure at open/write/fsync/chmod/chown/rename;
    marker-last behavior; temp cleanup; no workspace/session deletion. Avoid
    privileged chown in ordinary unit tests by injecting the filesystem seam;
    the pinned image smoke proves real `10000:10000` compatibility.
  - Setup/lifecycle tests: fresh managed start/restart without setup; native
    missing config still safe 409; managed missing/revoked/decryption failure
    never calls runner; advanced setup copy and controlled-path reapplication;
    running/session gates unchanged; exact HTTPS launch body and log redaction;
    readiness/cleanup reasons unchanged.
  - Backup/restore tests: all v3 secrets/IDs/spec/projection canaries absent;
    restored agent remains desired-stopped, has no deployment/secrets, and is
    native/manual gated; safe advanced config/workspace filesystem-copy smoke
    survives reprojection without secret-bearing evidence.
  - Change `scripts/smoke-local-hermes-contract.ts` to use the production v3
    builder fixture/parser/projector on a fresh root—remove its manual seed of
    `config.yaml` and managed `.env` keys. Keep the model endpoint local and
    inject an explicit local fake Telegram connected health state while the
    runtime transport is disabled/redirected locally so no Telegram request is
    possible. Run the production readiness parser with Telegram required and
    report only `telegramBoundary:"local-fake-platform-state"`; never claim a
    real bot/message/reply.
  - Contract smoke must assert exact pinned image/version/digest, no public
    port, private API auth, model reply through the fake local server, required
    API/Telegram connected health fixture, expected label/marker revision,
    restart persistence, managed reapplication, and cleanup. No provider,
    credential, billable, hosted, or external network access is a Step 5 gate.
- required commands/gates:
  - Install/review the exact direct dependency and lock diff; no migration or
    `db:generate` is expected. Run focused launch-spec/builder/secret/YAML/
    projection/setup-session/setup-component/backup/restore/lifecycle/manual-
    runner/runner-service/redaction tests, including the real-PostgreSQL builder
    matrix.
  - Run `bun run agent:hermes:contract-smoke`; `bun run format:check`;
    `bun run lint`; `bun run typecheck`; `bun run test`; `bun run build`;
    `bun run test:e2e:ci`; credential-free fail-closed
    `bun run verify:hermes:staging`; and `git diff --check`. The staging gate is
    not a live-success gate here. Fix every product-caused failure and separate
    any proven baseline failure under the team protocol before commit.
- likely touchpoints:
  - Primary: `package.json`, `bun.lock`,
    `src/server/agents/agent-launch-spec.ts`,
    `src/server/agents/agent-launch-builder.ts`,
    `src/server/agents/agent-secrets.ts` only for the accepted Step 4 read seam,
    `src/runner-service/hermes-projection.ts`, `src/runner-service/docker.ts`,
    `src/runner-service/server.ts`, `src/server/agents/lifecycle.ts`,
    `src/server/agents/hermes-readiness.ts`, and
    `src/server/runners/manual-runner-adapter.ts` only where the union/error
    transport requires it.
  - Compatibility/copy: `src/runner-service/hermes-setup-sessions.ts`,
    `app/api/agents/[agentId]/hermes-setup-session/route.ts`, and
    `app/agents/_components/agent-hermes-setup.tsx`.
  - Smoke/tests: `scripts/smoke-local-hermes-contract.ts`,
    `tests/helpers/agent-launch-spec.ts`, `agent-launch-spec.test.ts`,
    `agent-launch-builder.test.ts`, `hermes-projection.test.ts`,
    `runner-service.test.ts`, `manual-runner-adapter.test.ts`,
    `hermes-lifecycle-readiness.test.ts`, `hermes-setup-sessions.test.ts`,
    `hermes-setup-session-route.test.ts`, `agent-hermes-setup.test.tsx`,
    `local-hermes-contract-smoke.test.ts`, `agent-secrets.test.ts`, and focused
    backup manifest/create/restore/acceptance tests.
  - Tracking only after gates: preserve every historical `PROGRESS.md` ledger
    and prior `CHANGELOG.md` entry; update only Step 5/current-next evidence and
    newest-first Unreleased entries required below.
- security/data/compatibility risks:
  - Parsing YAML with unsafe tags/aliases/merge keys or normal JavaScript
    prototype assignment can enable resource exhaustion or prototype pollution.
    String-splicing YAML cannot safely preserve nested settings. The exact
    dependency/parser/copy limits above are required, not optional hardening.
  - Partial multi-file writes can pair old secrets with a new revision. Staging
    all files, marker-last commit, fsync, no-follow access, revision inspection,
    and pre-container failure are one safety contract. Do not weaken it to
    `writeFile` or use timestamp-only temp names.
  - Preserving conflicting legacy Hermes aliases can override managed security
    settings. Preserve unrelated semantics, but remove/overwrite every named
    managed alias and force allow-all false/unauthorized-DM ignore.
  - Logging serialized launch bodies, parser documents, filesystem errors, or
    decryption causes leaks four credentials and low-entropy Telegram PII.
    General redaction is defense in depth; sensitive objects must not reach log
    construction at all.
  - Deriving revision from secrets/Telegram IDs creates an oracle, while using
    request time breaks byte stability. The persisted Step 3/4 revision is the
    only managed source of truth in this step.
  - Treating a restored/OpenRouter-named agent as managed could reuse stale
    references or auto-start without credentials. Deployment-backed mode and
    desired-stopped restore behavior are mandatory compatibility gates.
- non-goals / do not touch:
  - No Step 4 implementation before its assignment/acceptance; no Step 6 async
    launch/status refactor; no Step 7 reconciler/cron/heartbeat trigger/model
    canary; no Step 8 create/progress UI; no Step 9 restart policy; and no Step
    10 real OpenRouter/Telegram/DigitalOcean/image-publication/hosted-secret or
    billable acceptance.
  - Do not change Step 2 health semantics/cleanup, Step 3 schema/transitions/
    lease behavior, Step 4 create API/encryption/Telegram validation semantics,
    Docker public-port policy, backup schema/storage format, or setup websocket
    authentication. Do not access `.env.local`, credentials, providers, hosted
    settings, Telegram, or external services.
  - Do not overwrite concurrent Step 4 Active Work/builder handoffs or
    compact/rewrite existing `STATUS.md` sections while Step 4 is active.
- progress/changelog/commit:
  - After all gates, mark Step 5 complete in the Automatic Ready ledger with
    only safe v3/YAML/determinism/smoke evidence, record the commit reference,
    and set Step 6 next. Add newest-first `Unreleased`/`Changed` entries for
    wizard-free managed Hermes/OpenRouter/Telegram configuration and
    `Unreleased`/`Security` entries for isolated secret projection, strict YAML
    handling, and atomic path-safe writes. Never name values, IDs, private
    endpoints, fingerprints, or provider responses.
  - Commit exactly `feat: project managed Hermes and Telegram config` only
    after every required gate passes.
- exact repository evidence at pre-spec time:
  - Step 3 product commit `7024bc2af52246179983507d3b9bcbed7e76c7d5`
    contains desired status, deployment schema/migration, DTO/service/route,
    transition/lease tests, and tracker updates and is independently ALL GREEN.
    `HEAD ba8c969daf7eb11aa0da6c2302d2fa73e9d1e382` records that checker evidence
    and assigns active Step 4; Step 4 has no product commit yet.
  - Current v2 is `agentbay.hermes.launch.v2`, 64 KiB, exact-key parsed, with
    only inline `apiServerKey`; its builder owner-selects agent/config, decrypts
    only that active kind, derives `cfg-<config.updatedAt>`, and emits the
    Hermes-configured model sentinel. Current redaction replaces only that key.
  - Current projection guards four target symlinks, requires nonblank
    `config.yaml`, preserves it byte-for-byte, merges only API-server env keys,
    atomically replaces individual files, writes `.env` as 0600, and includes
    requestId in revision JSON. It does not parse YAML, create config from an
    empty root, project OpenRouter/Telegram/safety settings, enforce a four-file
    marker-last transaction, or default ownership to pinned UID/GID.
  - `package.json` has no YAML dependency; `bun.lock` mentions YAML only as
    Vite's uninstalled optional peer, and `node_modules/yaml` is absent.
    The locally present pinned image confirms v2026.7.7.2/v0.18.2, runtime
    `10000:10000`, canonical model/terminal/browser/guardrail/platform paths,
    `OPENROUTER_API_KEY`, Telegram token/allowlist, and API-server
    enable/host/port/key environment names.
  - Setup sessions run `hermes setup` plus the current terminal/browser/
    guardrail commands, use a single one-time 15-minute PTY websocket session,
    reject running workloads, and clean their container. The UI currently says
    only “Hermes setup” and has no managed-settings reapplication copy.
  - Backup manifests contain safe config and vault references but not plaintext;
    restore creates a stopped agent/config without secret rows. The local Hermes
    smoke currently hand-seeds config/OpenRouter env, disables Telegram, and
    reports `local-smoke-disabled`, so it is not Step 5 managed-projection proof.
- blockers:
  - Hard dependency: Step 3 acceptance is satisfied; committed and independently
    accepted Step 4 remains outstanding. The coordinator must not assign a Step
    5 builder before the exact Step 4 commit/check exists.
  - Implementation gates require local PostgreSQL, Docker with the already
    pinned image, a safely configured synthetic test keyring, and filesystem
    support for no-follow/mode tests. Missing local capability is a recorded
    blocker, not permission to weaken tests or contact an external service.
  - No real credential, Telegram bot/user, OpenRouter request, Droplet, hosted
    mutation, or external network is required or authorized for Step 5.
- open questions:
  - None behavior-blocking after Step 3 and Step 4 acceptance. This contract
    resolves v3 shape/version, managed discrimination, persisted revision,
    YAML dependency/parser policy, pinned config/env ownership, legacy/setup/
    restore gates, atomic marker-last writes, and local-only smoke behavior.
    Any deviation in the launch body, managed paths, YAML package/version,
    restored-agent behavior, or secret transport is a security/compatibility
    change and requires coordinator/product approval before implementation.

## Step 6 Completion Contract (pre-spec)

- issue/readiness:
  - `PLAN.md` Step 6, “Split Runner Launch Acceptance From Observed Readiness.”
  - Classification: `blocked`. Do not assign a Step 6 builder until Step 4 and
    Step 5 each have their prescribed product commit and an independent checker
    acceptance recorded by the coordinator. Step 3 is accepted at `7024bc2`;
    Step 4 is active and uncommitted at pre-spec time; Step 5 is pre-specified
    but dependency-blocked.
- outcome:
  - Make runner start/restart a bounded launch-acceptance operation, never a
    180-second Hermes readiness wait. Converge each agent to exactly one selected
    container for the requested image, launch-spec version, and persisted config
    revision, then expose truthful, redacted observations through authenticated
    status and fixed canary boundaries.
  - A Docker process in `running` state is not application readiness. The
    control plane remains `starting` or `restarting` after acceptance and may
    become `running` only from a later exact `ready` observation. Step 7 owns
    durable reconciliation and the ready transition for automatic deployments.
- exact runner launch acceptance contract:
  - `POST /runner/v1/agents/:agentId/start` and `POST .../restart` retain the
    strict v2/v3 launch-spec request body, content type, 64-KiB limit, UUID path,
    runner bearer authentication, and bodyless legacy/native compatibility.
    Successful Hermes acceptance changes from HTTP `200` to HTTP `202` and is
    exactly:

    ```ts
    type RunnerLaunchAcceptedResponse = {
      ok: true;
      contractVersion: "agentbay.runner.launch.v2";
      agentId: string;
      action: "start" | "restart";
      operation: {
        id: string; // UUID generated by the runner and stored as a safe label
        state: "accepted";
        disposition: "created" | "reused" | "replaced";
        target: {
          image: string;
          launchSpecVersion: string;
          configRevision: string;
        };
        acceptedAt: string; // runner-generated UTC ISO timestamp
      };
      snapshot: RunnerAgentStatusSnapshot; // phase is exactly "accepted"
    };
    ```

  - `created` means no selected container existed; `reused` means one exact
    already-running selected container won convergence; `replaced` means stale,
    mismatched, stopped, terminal, incomplete-metadata, or surplus selected
    containers were removed and one exact container was created. No response
    contains projection paths, environment, request body, bearer material,
    Docker inspect output, or raw health data.
  - Add safe Docker labels for operation UUID, action, and accepted-at timestamp
    in addition to the existing owner agent ID, config revision, and launch-spec
    version labels. The operation UUID/timestamp must be validated before use.
    A pre-Step-6 container without complete valid operation labels is stale and
    is replaced once; this is the crash-safe rolling metadata migration.
  - Launch acceptance includes successful managed projection, serialized
    per-agent selection, stale cleanup, `docker run --detach`, and exact inspect/
    marker/runtime validation. It excludes all health polling, Telegram waits,
    model calls, logs, and database mutation. Projection failure happens before
    selected-container mutation. A failed Docker create/inspect removes only the
    just-created container and returns a safe existing error; it does not report
    an accepted operation.
  - The total runner acceptance path, including projection and Docker commands,
    has one 30,000-ms deadline (`DOCKER_CLI_TIMEOUT_MS`), not a fresh 30 seconds
    per subcommand. The manual adapter retains a 5,000-ms transport margin
    (`DEFAULT_MANUAL_RUNNER_TIMEOUT_MS = 35,000`). Timeout aborts the owned child
    process, cleans any known just-created container, and returns the allowlisted
    `launch_acceptance_timeout`; it never falls through to readiness polling.
    Focused fake-clock tests must prove HTTP acceptance completes within this
    bound even when the health transport never resolves.
- exact idempotency and replacement rules:
  - Serialize start, restart, stop, and cleanup for one agent with a per-agent
    coordinator; different agents remain independent. Re-check selected state
    after acquiring ownership, so simultaneous duplicate requests cannot both
    remove/run. Coordinator entries and secret-bearing probe context are
    discarded after use and cannot grow without bound.
  - “Exact running” means one inspected container has the requested agent label,
    exact image ref, launch-spec version, config-revision label, valid operation
    labels, exact projected marker evidence, expected mounts/private network/
    limits/security, no published port/socket, and Docker state `running`.
    Same image plus a different digest string is not exact; same revision plus a
    different image or launch version is not exact.
  - Start and restart are both idempotent desired-state convergence in Step 6:
    an exact running winner is reused without `docker run`, `docker restart`, or
    container replacement. This deliberately prevents retries from rebooting a
    healthy workload. A deliberate process recycle is stop then start, or a new
    image/revision; Step 9 owns later automatic restart policy.
  - If one exact running winner and stale/surplus selected containers coexist,
    preserve the winner and remove only the others. If multiple exact running
    containers exist from old/adversarial state, keep the deterministic earliest
    valid `acceptedAt`, breaking ties by container ID, and remove the surplus.
    If no exact running winner exists, remove all selected stale/mismatched/
    terminal containers before creating one replacement. Never inspect, stop,
    remove, or reuse a container whose agent label belongs to another agent.
  - A service crash after `docker run` but before HTTP response is recovered by
    retry: complete labels plus marker/runtime evidence cause reuse of the exact
    container and its original operation ID/accepted timestamp. Partial labels,
    partial projection evidence, invalid timestamps, or revision mismatch cause
    one exact stale replacement, never a second selected container.
- exact status snapshot and observation schema:
  - `GET /runner/v1/agents/:agentId/status` remains HTTP `200` for an
    authenticated, valid request and returns exactly
    `{ok:true,contractVersion:"agentbay.runner.status.v2",agentId,action:"status",snapshot}`.
    It performs at most one bounded health observation; it never waits/polls.

    ```ts
    type RunnerAgentStatusSnapshot = {
      phase:
        | "idle"
        | "accepted"
        | "starting"
        | "ready"
        | "failed"
        | "stopped"
        | "cancelled";
      operation: null | {
        id: string;
        action: "start" | "restart";
        target: {
          image: string;
          launchSpecVersion: string;
          configRevision: string;
        };
        acceptedAt: string;
      };
      container: {
        id: string | null;
        name: string | null;
        image: string | null;
        state:
          | "absent"
          | "created"
          | "running"
          | "restarting"
          | "paused"
          | "exited"
          | "dead"
          | "removing"
          | "unknown";
        startedAt: string | null;
        finishedAt: string | null;
        observedAt: string;
      };
      revision: {
        state: "match" | "mismatch" | "missing" | "unreadable" | "unknown";
        requested: string | null;
        containerLabel: string | null;
        projectionMarker: string | null;
        observedAt: string;
      };
      gateway: {
        state: "unknown" | "starting" | "running" | "failed" | "stopped";
        observedAt: string | null;
      };
      apiServer: {
        required: boolean;
        state: "unknown" | "connecting" | "connected" | "disconnected" | "failed" | "disabled";
        observedAt: string | null;
      };
      telegram: {
        required: boolean;
        state: "unknown" | "connecting" | "connected" | "disconnected" | "failed" | "disabled";
        observedAt: string | null;
      };
      readinessReason:
        | null
        | "launch_accepted"
        | "launch_cancelled"
        | "container_absent"
        | "container_not_running"
        | "container_terminal"
        | "revision_missing"
        | "revision_mismatch"
        | "probe_credential_unavailable"
        | "health_unauthorized"
        | "health_unreachable"
        | "health_timeout"
        | "health_invalid"
        | "gateway_starting"
        | "gateway_failed"
        | "api_server_not_connected"
        | "telegram_not_connected"
        | "readiness_timeout";
      observedAt: string;
    };
    ```

  - Immediate accepted responses use `phase:"accepted"`, no health call,
    unknown platform observations, and `readinessReason:"launch_accepted"`.
    Later status derives `starting` from a running exact container plus a
    transient/unready private-health observation; `ready` requires revision
    match, `gateway=running`, API server `connected`, and Telegram `connected`
    when required. `ready` has `readinessReason:null`.
  - The accepted-at label starts the existing 180,000-ms readiness window.
    Transient health/API/Telegram observations before the deadline are
    `starting`; after it they are `failed` with `readiness_timeout`. Revision
    mismatch, invalid exact evidence, terminal/absent container after an
    accepted operation, or explicit gateway failure is immediately `failed`.
    Status never deletes a failed container. A later valid observation may
    truthfully recover from `failed` to `ready`; Step 7 decides durable retry or
    cleanup policy.
  - `idle` means no selected container and no accepted-operation evidence;
    `stopped`/`cancelled` are returned by stop/cleanup cancellation responses.
    Unknown Docker/Hermes values map to allowlisted `unknown`/safe reasons,
    never pass through. Observation times are generated by the runner after
    each local inspect/probe and must not trust Hermes-supplied `updated_at`.
- private authenticated health and canary boundaries:
  - Keep Hermes without a published port and address it only by the inspected,
    runner-generated container name on `DEFAULT_HERMES_PRIVATE_NETWORK`. Never
    accept a client URL/host/port. Runner endpoints retain the runner bearer;
    internal `/health/detailed` and `/v1/chat/completions` requests require the
    projected per-agent API bearer key.
  - Because asynchronous status outlives the launch request, load only the
    canonical `API_SERVER_KEY` from the exact projected `.env` through the Step
    5 path-safe, bounded, no-follow file seam. Reject missing/duplicate/
    malformed assignments; never retain it in a Docker label, operation record,
    status, error, event, metadata, or log. Zero/release in-memory references as
    soon as each probe completes. Do not read OpenRouter or Telegram values for
    health/status.
  - One status health request has a 2,000-ms total timeout and a 64-KiB response
    ceiling. Parse strict JSON/plain records, read only exact `status`,
    `gateway_state`, and `platforms.{api_server,telegram}.state`, and map values
    to the unions above. Ignore `pid`, raw `exit_reason`, version text, timestamps,
    unknown keys, raw body, headers, and upstream exception messages.
  - Add authenticated `POST /runner/v1/agents/:agentId/canary` as the transport
    seam Step 7 will call. Its exact request is
    `{operationId:string,configRevision:string,model:string}` with no extra keys;
    UUID/revision bounds match status evidence and model is a trimmed safe token
    of 1–200 characters. It rejects a non-ready snapshot or operation/revision
    mismatch with safe HTTP `409` and does not call Hermes.
  - The runner sends a fixed repository-owned no-tools prompt, the supplied
    model only in the model field, `tools:[]`, `stream:false`, and at most 16
    output tokens. It has a 15,000-ms total timeout and 64-KiB response ceiling.
    The success/failure response never returns completion text, provider body,
    token usage, headers, URL, or exception detail and is exactly:

    ```ts
    type RunnerCanaryResponse = {
      ok: true;
      contractVersion: "agentbay.runner.canary.v1";
      agentId: string;
      action: "canary";
      operationId: string;
      configRevision: string;
      observation: {
        state: "passed" | "failed";
        reason:
          | null
          | "canary_unauthorized"
          | "canary_unreachable"
          | "canary_timeout"
          | "canary_invalid_response"
          | "canary_model_failed";
        observedAt: string;
        latencyMs: number;
      };
    };
    ```

  - Step 6 builds/tests only this private fixed canary transport against a local
    fake. It does not trigger a canary automatically, persist a canary result,
    call OpenRouter, or advance deployment state; those are Step 7 duties.
- stop, cleanup/delete, and cancellation:
  - Stop and cleanup first atomically mark the active per-agent launch token
    cancelled, abort an owned projection/Docker child when possible, and then
    serialize cleanup. Check cancellation before projection mutation, before
    stale removal, before run, and after run/inspect. A container created after
    cancellation is force-removed before the launch call returns.
  - A launch cancelled before acceptance returns safe HTTP `409`
    `launch_cancelled`, not a false `202`. A stop racing after acceptance returns
    success with `cancelledOperationId`, stops every selected running container,
    and a `stopped` snapshot. Cleanup returns `cancelledOperationId`, removes all
    selected containers and only the exact agent root, and a `cancelled`
    snapshot. Repeated stop/cleanup remain successful and produce empty arrays/
    null cancellation evidence without touching another agent.
  - Control-plane lifecycle stop and delete must accept `starting` and
    `restarting` in addition to their current stable states, invoke runner
    cancellation/cleanup, close any open usage period at most once, and never
    allow a late accepted/status result to resurrect a stopped/deleted agent.
    Use status/row compare-and-set guards so stop/delete wins stale completion.
- manual adapter, lifecycle, and API-route migration:
  - Add strict shared parsers/types for launch acceptance, status snapshot, and
    canary observations; do not scatter `Record<string,unknown>` parsing.
    `ManualRunnerStartResult`/`RestartResult` gain an `accepted` success member
    carrying `operation` and `snapshot`; `ManualRunnerStatusResult` carries the
    typed snapshot. Remove the `container.status === "running"` readiness test.
    Docker state alone may populate container observation only.
  - Rolling deployment order is mandatory: deploy the control-plane/manual
    adapter first. It accepts the new `202` contracts and the old runner `200`
    `{container:{status:"running"}}` contract, mapping old success to an explicit
    `ready` compatibility result. Only then deploy the new runner. Never deploy
    a new async runner behind the old adapter, because the old adapter would
    falsely write `running`. After the fleet is upgraded, remove the legacy
    parser in a later planned compatibility change, not in Step 6.
  - Local-process and local-Docker adapters retain their current synchronous
    ready behavior. Lifecycle must discriminate `accepted` from `ready`:
    accepted start commits/returns agent `starting`, records only
    `agent.start_requested`, does not emit `agent.start_completed`, does not open
    usage, and returns operation/snapshot evidence. Accepted restart commits/
    returns `restarting`, records only `agent.restart_requested`, and does not
    emit completion. A truly ready legacy/local adapter retains the existing
    atomic `running`, completion-event, and usage behavior.
  - `POST /api/agents/:id/actions/start` and `.../restart` remain HTTP `202`, but
    their success DTO becomes the truthful lifecycle accepted/ready union. Do
    not add a second browser-visible runner endpoint or expose private runner
    observations directly without owner concealment. Existing authentication,
    malformed-ID, not-found, capacity, setup, and safe error status codes remain.
    Stop stays `200`; delete stays `200` after cleanup.
  - Step 7 consumes the typed manual-adapter status/canary seam using the Step 3
    deployment ID/config revision and is the sole automatic v3 path that may
    atomically write ready/running, completion events, and usage. Step 6 must not
    add a Vercel background promise, timer-based reconciler, cron route, lease
    mutation, or deployment-stage transition.
- safe failure and redaction rules:
  - Runner HTTP failures keep the envelope
    `{ok:false,error:{code:<allowlisted>,message:<fixed>,reason?:<allowlisted>}}`.
    Add only `launch_acceptance_timeout`, `launch_cancelled`,
    `runner_status_failed`, `canary_invalid`, and `canary_not_ready` as needed.
    Docker/projection/probe exception messages, causes, stderr/stdout, inspect,
    health/canary bodies, and filesystem values never enter responses.
  - Manual-adapter logging stays host/status/code/reason/duration/fingerprint
    only. Do not log launch/status/canary bodies, operation target objects,
    private container names, raw image registry credentials, revision marker
    content, model output, numeric Telegram IDs, or API/provider/Telegram keys.
    `safeErrorMessage` must not log arbitrary fetch exception messages; use an
    allowlisted error name/category and timeout boolean instead.
  - Run distinct secret/PII canaries for runner bearer, API bearer, OpenRouter
    key, Telegram token, Telegram IDs, model response, hostile health fields,
    Docker stderr, and filesystem error text. Assert absence from JSON,
    snapshots, logs, events, status reasons, thrown errors, and test output.
    Redaction is defense in depth; untrusted bodies must not reach formatting.
- required semantic/adversarial tests:
  - Acceptance/timing: delayed-never-ready Hermes returns `202` before 30,000 ms
    with zero readiness sleeps; projection/run/inspect deadline and cleanup;
    exact schema/key rejection; wrong methods/content types/body size/agent IDs;
    missing/wrong runner bearer; bodyless v2 compatibility.
  - Idempotency/concurrency: sequential and simultaneous same image/revision
    start/restart use one operation/container/run; crash-after-run retry reuses
    original safe labels; deterministic duplicate winner; stale image, digest,
    revision, launch version, marker, network, mount, security, stopped/exited,
    and incomplete labels cause exactly one replacement; another agent is
    never inspected/removed.
  - Status: exact accepted/starting/ready/failed/idle/stopped/cancelled fixtures;
    180-second boundary; recovery from transient failure; typed timestamps from
    runner clock; container absent/terminal/restarting/partial crash; revision
    label/marker/request mismatch; no state mutation during GET.
  - Probe adversaries: unauthorized Hermes response, slow/aborted request,
    connection reset, non-JSON, array/null/prototype/accessor fixture, duplicate
    or unknown fields/states, spoofed timestamp, raw exit reason, oversized/
    chunked body, control characters, secret-bearing body/header/error, DNS/
    container-name injection, and API-key file missing/duplicate/symlink/FIFO/
    oversized/malformed. Every case maps to one safe typed observation.
  - Canary: outer runner auth, strict request/no extra keys, non-ready and stale
    operation/revision rejection without transport, fixed prompt/no tools/
    bounded output, pass and each allowlisted failure, timeout/oversize/malformed
    completion, hostile provider text never returned or logged, no external
    network in tests.
  - Cancellation: stop and cleanup/delete at each projection/ps/rm/run/inspect
    barrier; just-created container removal; cancellation before `202`; stale
    completion cannot set running or recreate after stopped/deleted; repeated
    stop/delete/cleanup; cross-agent parallel launch remains independent.
  - Compatibility/lifecycle/routes: new adapter with old runner `200`; new
    `202` accepted maps to starting/restarting only; ready legacy/local paths
    retain completion and usage; accepted paths have no completion/usage;
    owner concealment/auth/409/500 mappings; status/canary parser rejects
    partial/extra/wrong-type snapshots; logs/events contain safe evidence only.
- contract smoke and required gates:
  - Extend `scripts/smoke-local-hermes-contract.ts` after Step 5 rather than
    replacing its managed v3/fake-model/fake-Telegram assertions. Inject delayed
    local health: assert start acceptance returns before readiness, duplicate
    same-target start creates one container/operation, status progresses
    accepted/starting/ready, revision observations match label and marker, fixed
    canary passes without returning model text, restart reuses the exact
    container, stop cancels safely, state/backup survives, and cleanup leaves no
    selected container/root. Keep exact pinned image/digest, private network,
    no public port, private API auth, fake local model, and
    `telegramBoundary:"local-fake-platform-state"`. Never contact real Telegram
    or any provider.
  - Run focused runner-service/Docker/status/probe/canary/manual-adapter/
    lifecycle/start-stop-restart-delete-route/auth/redaction/logging tests and
    the Step 5 launch/projection compatibility subset. No database migration or
    `db:generate` is expected unless the accepted Step 4/5 implementation
    establishes a proven schema need.
  - Run `bun run agent:hermes:contract-smoke`; `bun run format:check`;
    `bun run lint`; `bun run typecheck`; `bun run test`; `bun run build`;
    `bun run test:e2e:ci`; credential-free fail-closed
    `bun run verify:hermes:staging`; and `git diff --check`. Fix every
    product-caused failure; classify any baseline/shared-resource failure with
    exact branch/main evidence under the team protocol before commit.
- likely touchpoints:
  - Primary: `src/runner-service/constants.ts`, `src/runner-service/docker.ts`,
    `src/runner-service/server.ts`, a small runner status/probe contract module
    if needed, `src/server/runners/runner-adapter.ts`,
    `src/server/runners/manual-runner-adapter.ts`,
    `src/server/agents/lifecycle.ts`, and only the observation parser seam in
    `src/server/agents/hermes-readiness.ts`/Step 5 projection helpers.
  - Routes/DTOs: `app/api/agents/[agentId]/actions/{start,restart,stop}/route.ts`
    and `app/api/agents/[agentId]/route.ts` delete behavior; no public canary
    browser route in Step 6.
  - Tests/smoke: `tests/unit/runner-service.test.ts`,
    `manual-runner-adapter.test.ts`, `hermes-lifecycle-readiness.test.ts`,
    `hermes-readiness.test.ts`, start/restart/stop/delete route tests,
    redaction/log route tests, `scripts/smoke-local-hermes-contract.ts`, and
    `tests/unit/local-hermes-contract-smoke.test.ts`.
  - Tracking after all gates only: newest-first `CHANGELOG.md` Unreleased
    `Changed` entry, Step 6 timing/idempotency/observed-readiness evidence in
    `PROGRESS.md`, and the prescribed commit. Preserve all concurrent Step 4/5
    changes and historical ledger/archive content.
- security/data/compatibility risks:
  - Async probes need the API key after the launch request; reading exactly one
    canonical key through the already secured projected-file seam is safer than
    labeling/persisting a second copy, but expands secret-read attack surface.
    Path, type, size, duplicate-key, logging, and memory-lifetime tests are
    mandatory.
  - A process running is not gateway/platform readiness. Reusing current
    `container.status === "running"`, emitting completion on `202`, or opening
    usage early creates false billing/product state and breaks Step 7.
  - Per-agent races can duplicate or resurrect workloads. Serialized re-check,
    crash-safe safe labels, cancellation epochs, and database compare-and-set
    guards are one contract; an in-memory mutex alone is insufficient evidence.
  - Health/canary bodies and upstream errors are attacker/provider-controlled
    and may contain credentials or huge values. Strict bounded allowlist parsing
    and fixed response text are required. Never expose a generic proxy/URL or
    arbitrary prompt/tool body through the runner.
  - New runner before new control plane is an unsafe rolling upgrade because the
    old adapter equates Docker running with readiness. Enforce the adapter-first
    rollout and retain the old-ready parser only as a bounded compatibility seam.
  - Status probes must not serialize all agents behind one lock or turn GET into
    a denial-of-service amplifier. One bounded probe per request, per-agent
    coordination, and no polling/background fan-out are required.
- non-goals / do not touch:
  - No Step 4 credential/create implementation, Step 5 YAML/spec projection,
    Step 7 reconciler/cron/lease transitions/durable canary decision, Step 8 UI
    polling, Step 9 automatic restart/backoff policy, or Step 10 live/billable/
    hosted acceptance. Do not add a public Hermes port, generic HTTP proxy,
    arbitrary canary prompt/tools, browser canary route, or database operation
    schema in Step 6.
  - Do not access `.env.local`, real credentials, Telegram, OpenRouter,
    DigitalOcean, GHCR, Vercel, or any external service. Do not mutate hosted
    flags or send Telegram/model traffic outside injected local fakes.
  - Do not edit/compact hot `STATUS.md` while Step 4 owns it, overwrite its
    handoff, or alter prior `STATUS.archive.md` contracts/history.
- progress/changelog/commit:
  - After every required gate, record bounded acceptance time, duplicate/reuse/
    replacement counts, typed ready/failed status evidence, cancellation race
    evidence, local-only canary/smoke boundary, and Step 7 as next in
    `PROGRESS.md`. Add newest-first `Unreleased`/`Changed` text for asynchronous
    runner launch and truthful observed readiness without private identifiers,
    endpoints, container names, model output, or credentials.
  - Commit exactly `refactor: make Hermes runner launches asynchronous` only
    after Steps 4/5 are accepted and every Step 6 gate passes.
- exact repository evidence at pre-spec time:
  - `HEAD 68e884c` assigns active Step 4; Step 3 product `7024bc2` and checker
    evidence `ba8c969` are committed. The worktree has concurrent Step 4 edits
    and hot-status changes, which this spec does not modify. Step 5's full
    pre-spec begins at `STATUS.archive.md` heading
    `## Step 5 Completion Contract (pre-spec)` and is blocked on Step 4.
  - Current `ManualRunnerDocker.start` projects, removes every selected
    container, runs and inspects one replacement, then blocks in the 180-second
    `createHermesReadinessWaiter`; any readiness/revision failure removes the new
    container. `restart` removes selected containers twice through restart then
    start. Exact running image/revision reuse and launch-operation labels do not
    exist.
  - Current runner start/restart return HTTP `200` with a running Docker
    container; status returns only `containers`. Auth is runner bearer first,
    detailed Hermes health uses the per-agent API bearer on the private network,
    and its parser recognizes exact gateway/API/Telegram states but returns only
    five readiness reasons plus timeout. The runner currently has no private
    canary route.
  - Current manual adapter accepts any `ok:true` JSON then requires
    `container.status === "running"`; its default timeout is Docker CLI timeout
    plus 5 seconds. Current lifecycle immediately writes `running`, emits both
    requested/completed events, and opens usage after runner success. Start/
    restart app routes already return `202`, but their successful payload claims
    a running agent. Stop accepts only `running`; delete excludes starting and
    restarting.
  - Current auth/redaction tests cover runner bearer rejection, safe readiness
    reasons, private API invalid bearer in the smoke, HTTPS runner endpoints,
    log redaction, and unknown reason dropping. Current smoke blocks start until
    readiness, hand-seeds managed state before Step 5, disables Telegram, and
    reports `telegramBoundary:"local-smoke-disabled"`; the Step 5 contract must
    land before it can prove the Step 6 async boundary.
- blockers:
  - Hard dependencies: coordinator-recorded product commits and independent
    checker acceptance for both Step 4 and Step 5. Step 6 remains blocked even
    if its code seems independently implementable, because v3 projection,
    secret sourcing, marker evidence, and the managed smoke are predecessor
    contracts.
  - Gate capabilities: local PostgreSQL, Docker, the already pinned Hermes
    image, filesystem no-follow/mode support, injected synthetic keyring, fake
    local health/Telegram/model transports, and available isolated ports. A
    missing local capability is a blocker to record, not authority to weaken a
    gate or contact an external provider.
- open questions:
  - None behavior-blocking once Steps 4 and 5 land exactly as contracted. This
    pre-spec resolves the response/status/canary schemas, bounds, restart
    convergence semantics, operation-label recovery, adapter-first migration,
    cancellation precedence, failure allowlists, and local-only gates. Any
    change to restart force semantics, response unions, probe credential source,
    private canary shape, or rollout order is a compatibility/security decision
    requiring coordinator/product approval before implementation.

## Step 7 Completion Contract (pre-spec)

- issue/readiness:
  - `PLAN.md` Step 7, “Reconcile Creation Through Ready.”
  - Classification: `blocked`. Step 7 must not start until Steps 4, 5, and 6
    are each committed with their prescribed exact product message and an
    independent checker accepts each exact commit. Step 3 is accepted at
    `7024bc2` with checker evidence at `ba8c969`; Step 4 is active and
    uncommitted at pre-spec time, while Steps 5 and 6 are dependency-blocked
    pre-specifications. Re-read the final accepted Step 4–6 implementations
    before assigning a builder and adapt private names only without weakening
    their public, migration, secret, projection, or runner contracts.
- outcome:
  - Add a database-backed, level-triggered reconciler that advances one owned
    ready-mode deployment through runner placement/provisioning, managed v3
    launch acceptance, typed private readiness, one bounded model canary, a
    final Telegram-connected observation, and one atomic ready/running/usage/
    event commit. The browser request is never the durability boundary.
  - Concurrent create kicks, runner heartbeats, Vercel cron calls, expired-lease
    recovery, and operator retries converge on the same agent, deployment,
    provisioning runner, exact selected container, config revision, and usage
    period. They do not create a second agent, Droplet, active deployment,
    selected container, canary dispatch, running transition, or open usage row.
  - This step owns initial create-to-ready orchestration only. Step 9 owns the
    continuing desired-running restart/circuit-breaker controller after an agent
    has reached ready; Step 8 owns browser polling and controls.
- compatibility and public operation contracts:
  - Preserve Step 4 exactly: stopped/manual creation remains 201 and never
    creates or triggers a deployment; ready first-write/replay remains 202 with
    the same `{agent,deployment}` DTO and replay ordering. A committed ready
    operation continues reconciling if the creation rollout flag is later
    disabled; the flag blocks only new Step 4 first writes and is not a kill
    switch for durable work. Stop/delete is the explicit cancellation boundary.
  - Preserve Step 3's owner-scoped
    `GET /api/agents/:agentId/deployment` DTO. Step 7 may populate its existing
    stage, attempt count, safe error, `nextAttemptAt`, and terminal timestamps,
    but it must not add lease owner/expiry, idempotency key, runner operation,
    provider resource, private endpoint, config contents, canary output, or any
    secret-derived field to the public DTO.
  - Add authenticated owner-concealed
    `POST /api/agents/:agentId/deployment/retry` with exact body
    `{idempotencyKey:string}` and no extra keys. The key uses Step 4's trimmed,
    case-sensitive 8–128 safe-token contract. It returns HTTP 202 with exactly
    `{deployment}` for a new retry or same-key replay. Missing/malformed input is
    400 `validation_failed`; a foreign/deleted agent is concealed 404
    `agent_not_found`; a latest deployment that is not `failed`, a concurrent
    active deployment, or an intentionally stopped agent is 409
    `deployment_not_retryable`; persistence failure is a fixed secret-safe 500.
  - A retry never re-creates the agent, reruns Telegram `getMe`, rotates or
    copies secrets, provisions synchronously, changes configuration, or reuses
    the failed deployment row. It atomically creates one new `pending`
    deployment for the same agent and exact persisted config revision, using
    the supplied key as the new operation identity. The failed operation stays
    terminal/immutable. Replaying that retry key returns the same new operation;
    a further intentional attempt requires a new key.
- additive durable evidence and migration:
  - The accepted Step 3 lease/stage row remains the operation source of truth,
    but Step 7 needs durable correlation that cannot live in memory. Generate
    the next additive migration (expected after Step 4's `0017`, likely `0018`)
    and add nullable `runner_operation_id uuid`, nullable
    `runner_accepted_at timestamptz`, non-null text `canary_state` defaulting to
    `not_started`, nullable `canary_attempted_at timestamptz`, and nullable
    `canary_completed_at timestamptz` to `agent_deployments`.
  - `canary_state` is exactly
    `not_started | started | passed | failed | outcome_unknown`. Database checks
    require runner-operation ID/accepted-at as a pair; require both for
    `starting_gateway`, `verifying_model`, `connecting_telegram`, and `ready`;
    permit canary evidence only from `verifying_model` onward or on `failed`;
    require `started` to have attempted-at and no completed-at; require
    `passed`/`failed` to have attempted/completed timestamps in order; require
    `outcome_unknown` to have attempted-at and no completed-at; and require
    `connecting_telegram`/`ready` to have `canary_state='passed'`. Historical
    pending rows remain valid and all new internal fields stay out of DTOs.
  - Add nullable `provisioning_operation_key text` to `runners`, constrained to
    the exact safe form `agentbay-deploy-` plus a lowercase UUID without
    hyphens, and a partial unique index when non-null. It is generated from the
    deployment ID and persisted on the runner row before a provider create
    attempt. Existing/manual runner rows remain null and preserve their current
    provisioning behavior.
  - Add a partial unique index on `agent_usage_periods(agent_id)` where
    `stopped_at IS NULL`. Before creating the index, the migration must fail
    closed with a safe operator blocker if legacy duplicate open periods exist;
    it must not silently close, merge, or delete billing history. Finalization
    uses this index plus transactional compare-and-set as the last authority for
    exactly one open period.
  - Add transaction-aware internal persistence helpers rather than exposing raw
    SQL from the controller: targeted/global claim with full internal context,
    retry scheduling with a safe code/detail, runner-acceptance evidence update,
    canary-start/result evidence update, atomic stage+event transition, terminal
    failure/cancellation, and final ready commit. Keep the Step 3 public DTO and
    terminal immutability unchanged.
- exact reconciler claim, lease, and work budget:
  - Add a server-only controller, preferably
    `src/server/agents/agent-deployment-reconciler.ts`, with a global
    `reconcileNextAgentDeployment` and targeted deployment/runner variants for
    trusted triggers. A call claims at most one due nonterminal deployment using
    `FOR UPDATE SKIP LOCKED`, then performs at most one stage action and returns.
    It never loops through multiple deployment stages or scans/fans out runner
    status calls in one reconciliation call.
  - Use a fresh validated `reconcile:<uuid>` lease owner, a 90,000-ms lease, and
    a 45,000-ms total action deadline. Every injected provider/runner transport
    must accept and honor the remaining deadline/abort signal; wrapping an
    unbounded promise without cancellation is insufficient. Never extend an
    already expired lease. Before applying an external result, transactionally
    compare deployment ID, lease owner, unexpired lease, expected stage, config
    revision, non-deleted agent, and `desired_status='running'`; a stale result
    is discarded and only an idempotent external target may remain.
  - `attempt_count` continues to increment exactly once on claim. Set
    `MAX_AUTOMATIC_DEPLOYMENT_ATTEMPTS = 64`. A retryable result releases the
    lease with
    `nextAttemptAt = now + min(60_000, 2_000 * 2 ** min(max(attemptCount - 1, 0), 5))`
    milliseconds: deterministic 2s, 4s, 8s, 16s, 32s, then 60s. Do not sleep in
    a route or hold a lease during backoff. Claim 64 either completes its one
    action or atomically fails with `deployment_attempts_exhausted`; no row can
    remain forever claimable after the bound.
  - Retryable nonterminal error codes/details are fixed allowlisted values and
    may appear in the existing safe deployment DTO while the stage is active.
    A successful transition clears prior error fields. Trigger name, lease
    owner, host/process identity, exception message, and external request data
    are never persisted or returned.
- trigger and protected cron contract:
  - After Step 4 commits a new ready deployment, register one post-response
    targeted kick through Next's supported `after` boundary (behind an injected
    scheduling seam in tests). Do not await provider/runner work before the 202
    response and do not represent scheduling success as durable progress. If
    the callback is dropped or fails, the committed row remains due for cron.
    Replays do not create duplicate callbacks as correctness requirements; a
    duplicate callback is harmless under the lease.
  - After an authenticated runner heartbeat is committed and its existing cloud
    runner readiness confirmation completes, schedule at most one post-response
    reconciliation for a due deployment already assigned to that runner. The
    heartbeat response never waits for deployment work, never accepts an agent
    or deployment ID from heartbeat JSON, and remains successful if the
    opportunistic callback is lost. A heartbeat from one owner cannot claim
    another owner's work.
  - Add `GET /api/internal/agent-deployments/reconcile` as a force-dynamic,
    no-store Vercel cron route. It accepts no body/query controls and processes
    at most one due operation. Success is exactly a safe summary such as
    `{ok:true,processed:0|1,outcome:"idle"|"advanced"|"retry_scheduled"|"failed"|"ready"}`;
    it returns no IDs, stages containing private detail, next-attempt timestamps,
    runner/provider data, or errors from dependencies.
  - Add server-only `CRON_SECRET` parsing. The configured value is exact,
    untrimmed, 32–256 characters, bearer-safe ASCII matching
    `^[A-Za-z0-9._~+/=-]{32,256}$`. The route accepts only a single exact
    `Authorization: Bearer <secret>` credential, compares SHA-256 digests with
    `timingSafeEqual`, and ignores spoofable cron headers. Missing/invalid server
    configuration fails closed as fixed 503 `cron_configuration_invalid`;
    missing/wrong/malformed credentials are the same fixed 401
    `cron_unauthorized`. Never log the header, configured secret, hashes,
    lengths, or mismatch detail.
  - Document a once-per-minute Vercel schedule in `vercel.json` for the exact
    route and add only a placeholder/commented `CRON_SECRET` to `.env.example`.
    Do not set a hosted secret, enable the creation flag, or deploy cron in this
    implementation step.
- exact level-based stage actions:
  - `pending`: under runner-capacity and agent/deployment row locks, revalidate
    the desired-running non-deleted agent. Prefer an already assigned eligible
    owned runner; otherwise select one online owned runner with capacity. Assign
    it once, set observed agent status to `starting` with the fixed reason
    “Automatic deployment is in progress.”, emit one `agent.start_requested`,
    and transition atomically to `configuring_hermes`. If no online capacity is
    available but cloud provisioning is safely configured, initialize or adopt
    one owned provisioning runner, reserve it by assigning `agent.runner_id`,
    and transition to `provisioning_runner`. Requested Step 4 runner ownership
    remains authoritative; never silently replace a requested runner with a
    different owner/resource.
  - `provisioning_runner`: perform at most one persisted provisioning phase or
    one readiness observation. An assigned owned runner that is authenticated,
    online, provisioning `ready`, endpoint-valid, and still within locked
    capacity advances to `configuring_hermes`. A known in-progress phase or
    delayed registration/heartbeat schedules backoff. A safe known provider
    failure becomes terminal after owned cleanup disposition is recorded.
    Provider configuration absence/invalidity is terminal
    `runner_provisioning_unavailable`, not permission to create a stopped agent
    or read a developer credential.
  - `configuring_hermes`: build exactly one accepted Step 5 managed v3 launch
    spec from the deployment owner/agent/revision, then call the accepted Step 6
    start seam once. A typed `202` accepted or exact legacy/local ready result
    must match agent, image, v3 version, and config revision. Persist its runner
    operation UUID/accepted timestamp and transition to `starting_gateway` in
    one lease-guarded transaction. Never persist or log the spec or decrypted
    values. Managed-build missing/revoked/decryption/config failures are
    terminal safe failures; transient runner transport/acceptance failures use
    bounded backoff.
  - `starting_gateway`: make one typed Step 6 status observation correlated to
    the persisted operation/config revision. `accepted`/`starting` and transient
    health/API/Telegram reasons remain in this stage with backoff. Exact `ready`
    with revision match, gateway running, API server required/connected, and
    Telegram required/connected advances to `verifying_model`. An absent,
    terminal, revision-mismatched, incomplete, or unauthorized exact target may
    invoke one idempotent same-v3 start convergence action in that call; a new
    accepted operation replaces the persisted correlation and stays in
    `starting_gateway`. This is bounded create-time recovery, not Step 9's
    periodic durability loop.
  - `verifying_model`: re-read the exact server-approved model from the owned
    config and require the persisted Step 6 operation/revision. Before any
    canary transport, atomically set `canary_state='started'` and
    `canary_attempted_at=now` under the active lease. Call the fixed no-tools,
    16-output-token Step 6 canary exactly once. A passed observation atomically
    records `passed`/completed-at and advances to `connecting_telegram`; a known
    failed observation records `failed` and terminally fails with
    `model_canary_failed`.
  - A stale lease/process crash after `canary_state='started'` never
    automatically dispatches another paid canary for that deployment. Recovery
    marks it `outcome_unknown` and fails safely as
    `model_canary_outcome_unknown`; an authenticated operator may explicitly
    create a new retry deployment. A runner 409 that proves no model call
    occurred may clear the started marker and back off only when the accepted
    Step 6 typed contract makes that proof exact. Timeout/network ambiguity is
    never treated as proof that no provider call occurred.
  - `connecting_telegram`: perform one fresh correlated status observation and
    independently require phase ready, exact operation/revision, gateway
    running, API server required/connected, and Telegram required/connected.
    Transient connecting/disconnected observations back off within the overall
    attempt/readiness bounds. Disabled, failed, malformed, wrong-revision, or
    prolonged non-connected Telegram is terminal `telegram_connection_failed`.
    Do not call Telegram directly; Step 4 `getMe` was credential preflight, and
    the runner's pinned private health is runtime evidence.
- provider idempotency and provisioning recovery:
  - Refactor the existing DigitalOcean provisioning service behind a bounded
    `advance...` seam that records and performs no more than one persisted
    provider phase per invocation. Keep the existing manual Create runner API
    behavior compatible through its wrapper, but the reconciler must not run
    its current multi-phase/polling loop or wait synchronously for heartbeat.
  - Before the first provider create, persist the unique provisioning operation
    key and apply its exact `agentbay-deploy-<uuid-without-hyphens>` tag/name
    marker. Extend real and local-fake provider interfaces with an exact-tag
    discovery/adoption result. Every retry discovers before creating; exactly
    one matching resource is adopted, more than one fails closed with explicit
    manual cleanup ownership, and an ambiguous create timeout enters discovery/
    backoff rather than issuing a second create. A second create under the same
    operation key is allowed only after an authoritative provider lookup proves
    no matching resource exists; eventual-consistency ambiguity becomes
    `runner_provisioning_outcome_unknown` at the bound.
  - Persist the runner row and its operation key before any billable call, use
    the existing provider resource ID/phase/event tables after adoption, and
    keep tagging/firewall/bootstrap/registration idempotent. Provider request
    IDs, Droplet IPs, bootstrap content, registration/runner bearer values, SSH
    material, and raw SDK errors never enter deployment rows/events/logs.
  - Multiple deployments for one user serialize runner-capacity reservation.
    They may reuse one online runner only within its heartbeat/assigned-agent
    capacity; they do not all attach to the same max-one provisioning runner.
    An existing unrelated manual provisioning operation is observed/adopted only
    through the normal owned capacity rules, never stolen or duplicated.
- atomic ready finalization, usage, and events:
  - The `connecting_telegram -> ready` transaction must lock deployment and
    agent, recheck lease/stage/revision/canary-passed/desired-running/non-deleted
    state, confirm the exact assigned owned runner, update observed agent status
    from `starting|restarting` to `running` with fixed reason “Hermes gateway is
    ready.”, transition the deployment to `ready`, insert one open lifecycle
    usage period, and record completion events. No external call occurs inside
    this transaction.
  - Insert usage only at this final ready boundary, never at launch acceptance,
    Docker-running, gateway-only, or canary-start. Use the partial unique index
    plus `ON CONFLICT DO NOTHING`/equivalent locked verification so replayed
    finalization yields exactly one open period. Its `started_at` is the final
    ready transaction time and its runner ID is the exact assigned runner.
  - First progression writes one `agent.start_requested`; successful finalization
    writes one `agent.start_completed`. Each actual stage change writes one
    `agent.deployment_stage_changed` in the same transaction as the change.
    Operator retry writes one `agent.deployment_retry_requested`; terminal
    failure writes one `agent.error`. Event metadata is allowlisted to deployment
    ID, prior/new stage or status, safe error code, attempt count, launch mode,
    and cleanup-required boolean. Exclude config/idempotency keys, lease/runner
    operation IDs, runner/provider resource IDs, endpoints, bot metadata, user
    IDs, model output, prompts, credentials, fingerprints, and raw observations.
- failure, cancellation, cleanup, and operator ownership:
  - Define closed retryable and terminal classifications. Retryable examples are
    runner registration/heartbeat delay, capacity wait for an already reserved
    runner, bounded runner transport unavailability, launch accepted/starting,
    and transient gateway/API/Telegram observations. Terminal examples are
    invalid managed config, missing/revoked/undecryptable required secrets,
    provider configuration/known provisioning failure, attempts exhausted,
    unrecoverable revision/health evidence, model-canary known failure or
    ambiguous dispatch, and prolonged Telegram failure. Unknown dependency
    codes are terminal `deployment_internal_failure`, never interpolated.
  - Before terminally failing after a selected container may exist, capture only
    the existing bounded redacted runner-log seam, then make one bounded runner
    stop/cancellation attempt. Successful stop is recorded only as a safe
    boolean. If stop cannot be confirmed, terminally fail with the original safe
    category plus `cleanupRequired:true`; status copy directs the owner to Retry,
    Stop, or Delete without naming a container/endpoint. Do not delete Hermes
    state or a ready/shared runner automatically, and do not hide a provider
    resource whose cleanup needs operator confirmation.
  - Terminal failure atomically sets deployment `failed`, clears lease/backoff,
    sets observed agent `error` with a fixed safe status reason, and closes any
    accidentally open usage period at most once. It normally preserves
    `desired_status='running'` so the failed requested intent is visible, but
    Step 9 must exclude a latest terminal-failed deployment from automatic
    resurrection until explicit retry.
  - Stop/delete must win every stale reconcile completion. For an active managed
    deployment, their initial transaction locks the agent/deployment, sets
    `desired_status='stopped'` before runner cancellation, and terminally marks
    the operation `failed` with safe `deployment_cancelled` or `agent_deleted`,
    clearing its lease. The reconciler's post-effect compare-and-set then cannot
    write running. Preserve the accepted Step 6 idempotent stop/delete response
    compatibility; Step 9 later generalizes desired-state durability beyond
    in-flight automatic creation.
  - Retry is the only automatic-path action that resumes a terminal deployment.
    It requires an explicit owner request, an exact new idempotency key, a
    non-deleted agent whose desired intent is running, and no active operation.
    It reuses the same agent/config/secrets/runner where safe and creates no
    external side effect inside its transaction.
- security, isolation, and logging rules:
  - The reconciler is server-only and is never a browser-selectable generic job
    runner. Claims carry internal user/agent/deployment context selected from
    composite ownership joins; no development-user resolver appears in cron,
    retry, create, or heartbeat trigger paths. Targeted helpers accept only
    trusted IDs already returned by an authenticated/committed server action.
  - Launch specs, decrypted secrets, projected API bearer, cron/runner bearer,
    provider token, Telegram token/allowlist/identity, model prompt/completion,
    private URLs, Docker names/inspect, provider bodies, bootstrap data, and raw
    exception/cause/stderr never reach `console.*`, events, deployment errors,
    route JSON, progress/changelog, or test snapshots. Safe detail is chosen
    from a constant map and remains at most Step 3's 500-character bound.
  - Runner/provider logs use closed event names plus safe phase/category/count/
    duration booleans only. Apply `redactSecretText` before the bounded agent-log
    persistence seam as defense in depth, while adversarial tests require that
    sensitive objects are not passed to the formatter at all. Never persist
    Telegram numeric IDs as operational metadata.
  - No reconciler database transaction spans Telegram, provider, runner launch,
    status, canary, or log transport. Conversely, no external result can mutate
    state without the lease/stage/owner/desired-state compare-and-set. This
    separation plus provider operation keys, runner labels/revision, deployment
    uniqueness, and usage uniqueness is the crash/race contract.
- required semantic/adversarial tests:
  - Real PostgreSQL, separate-connection lease tests: global/targeted claim race;
    `SKIP LOCKED`; due/backoff ordering; attempt 64 boundary; stale lease expiry;
    lost-lease result discard; stage/event atomicity; desired-stop/delete
    cancellation precedence; same-agent active uniqueness; terminal immutable;
    retry same-key convergence/new-key operation; cross-user concealment; and one
    open usage period/running/completion event under concurrent finalization.
  - Stage tests cover every exact stage/action/result: existing/requested runner,
    no runner, capacity wait, new/recovered provisioning runner, delayed
    registration/heartbeat, v3 builder safe failures, accepted launch, stale
    container/revision relaunch, all typed status phases/reasons, exact canary
    pass/fail/timeout ambiguity, Telegram reconnect/deadline, final CAS, and no
    external action in retry/final DB transactions.
  - Provider tests use injected fake transports/clocks only: operation-key
    persistence before create, exact tag lookup/adoption, crash after create,
    ambiguous timeout, eventual discovery, authoritative absence, duplicate tag
    fail-closed, one phase per call, tag/firewall idempotency, no duplicate
    Droplet under concurrent triggers/restart, bounded abort, cleanup disposition,
    and total secret/IP/provider-body redaction. No real DigitalOcean call.
  - Trigger/route tests: ready 202 returns before reconcile; stopped/replay do not
    create state or require a kick; dropped/duplicate `after` callbacks; heartbeat
    returns before targeted work and cannot inject IDs; exact cron method/path/
    no-body/no-query behavior; missing/invalid/wrong/correct cron secret; constant
    unauthorized/config errors; timing-safe comparison; no credential logs; one
    claimed row and safe summary only.
  - Runner/canary tests use the accepted Step 6 strict parsers and local fakes:
    operation/revision/model mismatch, ready regression, runner restart, status
    recovery, no canary before exact ready, exactly one canary dispatch per
    deployment, crash-after-dispatch outcome unknown, explicit retry creates one
    new allowed attempt, no tools/response text, and no premature usage/event/
    running transition.
  - Failure/redaction tests use distinct canaries for every four managed secrets,
    cron/runner bearers, Telegram bot/user IDs, uniqueness/public fingerprints,
    private URLs, provider resource/IP/body/error, Docker output, model prompt/
    completion, lease owner, and idempotency key. Assert absence across success,
    retry, stale lease, every failure, cleanup failure, logs, events, DTOs,
    responses, thrown errors, and progress evidence.
  - Extend local-cloud smoke with a delayed fake runner heartbeat and simultaneous
    create-kick/heartbeat/cron/manual duplicate triggers. Close the simulated
    browser after 202; prove persisted stages reach ready, one fake provisioning
    resource/container/canary/running transition/usage period exists, and cleanup
    is deterministic. Keep provider and Telegram/model seams local fake only.
  - Extend `agent:hermes:contract-smoke` from Step 6 to drive the controller
    through accepted/starting/ready, fixed canary pass, Telegram-connected final
    observation, and ready finalization while retaining exact pinned image,
    private network/no public port, revision evidence, and
    `telegramBoundary:"local-fake-platform-state"`. Do not claim live reply.
- required commands/gates:
  - Run `bun run db:generate`; `bun run db:migrate` against clean and accepted
    Step-6-upgrade fixtures twice; focused schema/migration/deployment/reconciler/
    retry/cron/create-trigger/heartbeat/provider/manual-adapter/lifecycle/event/
    usage/cost/isolation/redaction tests; and the delayed duplicate-trigger local
    cloud smoke (`bun run local:cloud:smoke`) in its documented fake-provider
    mode.
  - Run `bun run agent:hermes:contract-smoke`; `bun run format:check`;
    `bun run lint`; `bun run typecheck`; `bun run test`; `bun run build`;
    `bun run test:e2e:ci`; credential-free fail-closed
    `bun run verify:hermes:staging`; and `git diff --check`. Run
    `bun run verify:e2e` only with its documented local/provider-safe
    capabilities. No live-success staging gate is required or authorized here.
    Fix every product-caused failure and classify any proven baseline/shared
    resource failure with exact branch/main evidence under the team protocol.
- likely touchpoints:
  - Primary new modules under `src/server/agents/`: reconciler, safe error/backoff
    policy, trigger seam, and retry service; accepted
    `agent-deployments.ts`, `deployment-state.ts`, `deployment-dto.ts`,
    `agent-launch-builder.ts`, and `lifecycle.ts` only through their documented
    internal extension points.
  - Persistence/config: `src/server/db/schema.ts`, generated next
    `drizzle/*.sql` and `drizzle/meta/*`, `src/server/env.ts`, `.env.example`,
    and `vercel.json`.
  - Routes/triggers: new
    `app/api/internal/agent-deployments/reconcile/route.ts`, new
    `app/api/agents/[agentId]/deployment/retry/route.ts`,
    `app/api/agents/route.ts`, and `app/runner/v1/heartbeat/route.ts`.
  - Provider/runner seams: `runner-provisioning.ts`,
    `digitalocean-provider.ts`, `local-docker-digitalocean-provider.ts`, runner
    provisioning events/placement/heartbeat modules, and only the accepted Step
    6 status/canary methods in the runner adapter. Preserve manual/local adapter
    compatibility.
  - Finalization/security/tests: `agent-events.ts`, existing usage/cost queries,
    shared log/redaction helpers, database reset/migration fixtures,
    `scripts/smoke-local-cloud.ts`, `scripts/smoke-local-hermes-contract.ts`, and
    focused new reconciler/retry/cron/provider-concurrency tests plus affected
    create/heartbeat/lifecycle/route/event/cost tests.
- non-goals / do not touch:
  - No Step 8 credential form, deployment polling/progress UI, inventory/detail
    stage presentation, browser retry controls, or mobile design. No Step 9
    Docker restart policy, periodic reconciliation of already-ready agents,
    Telegram circuit-breaker recovery, reboot durability, or usage segmentation
    beyond exact initial ready/failure/cancellation correctness.
  - No Step 10 real Telegram send/reply, OpenRouter call, DigitalOcean spend,
    GHCR publish/scan, Vercel deploy/secret mutation, hosted rollout-flag enable,
    or billable/live acceptance. Do not read `.env.local` or contact any external
    service while implementing/checking this step.
  - Do not change Step 4 request/202/replay/getMe/encryption/uniqueness semantics,
    Step 5 v2/v3/YAML/projection/backup/setup semantics, Step 6 runner contract/
    private-network/canary prompt/status semantics, the pinned Hermes image, or
    stopped/manual lifecycle behavior except the minimum active-managed
    cancellation compare-and-set required above.
  - Do not add Redis, a third-party queue, Vercel workflow dependency, public
    Hermes/canary endpoint, arbitrary provider/model prompt, webhook, Telegram
    polling/send, process-global secret transport, or a database polling loop
    inside the browser/create request.
- security/data/compatibility risks:
  - A lease alone cannot deduplicate a provider create after a process dies;
    persisted provider operation identity plus exact-tag discovery/adoption and
    ambiguous-outcome handling are mandatory. Retrying the old synchronous
    provisioner can create duplicate billable resources.
  - External calls inside a database transaction hold locks and still cannot be
    atomically committed with the provider. External calls without a post-result
    lease/desired-state CAS let stale create/heartbeat work resurrect stopped or
    deleted agents. Both boundaries must be tested independently.
  - Marking running or opening usage at launch acceptance, Docker running,
    gateway-only readiness, or before the final Telegram observation causes
    false product/billing state. Finalization is one transaction after the
    persisted canary pass and fresh exact Telegram-ready snapshot only.
  - Blindly repeating an ambiguous canary may spend repeatedly. Persist
    `started` before dispatch and fail outcome-unknown rather than automatically
    retrying; a new authenticated retry operation is the explicit cost boundary.
  - Cron/heartbeat routes are high-leverage internal triggers. A permissive
    bearer parser, spoofable header trust, IDs from request input, multi-item
    fan-out, or secret-bearing error/log creates an orchestration/denial-of-
    service boundary. Exact auth, one-item budgets, leases, and constant output
    are required.
- progress/changelog/commit:
  - After every required gate, mark Step 7 complete in the Automatic Ready
    ledger with sanitized lease-race, provider-idempotency, delayed-heartbeat,
    stage/canary/Telegram, one-running/usage, cancellation/retry, local-cloud,
    and local-contract evidence. Record the exact commit reference and set Step
    8 next; preserve all historical ledgers and never record IDs, endpoints,
    model output, credentials, or raw provider/runner evidence.
  - Add the newest-first `Unreleased`/`Added` changelog entry for durable
    automatic create-to-ready reconciliation and safe operator retry behavior.
    Do not add entries for tests, migrations, cron wiring, docs, or validation
    alone, and do not duplicate Step 4–6 entries.
  - Commit exactly `feat: reconcile agents automatically to ready` only after
    committed/checked Steps 4–6 and every Step 7 gate passes.
- exact repository evidence at pre-spec time:
  - `HEAD 68e884c` contains the compact hot status. Accepted Step 3 provides the
    exact eight-stage enum, terminal immutability, owner/idempotency and active-
    agent unique indexes, due/expired `SKIP LOCKED` claims, lease renewal/release,
    guarded forward transitions, safe DTO, and desired stopped/running field.
    It does not yet provide retry, controller triggers, runner/canary evidence,
    finalization, or an open-usage uniqueness constraint.
  - Current Step 4 work is uncommitted and owned by its builder. Read-only
    evidence shows ready creation remains a database-only transaction with
    observed stopped/desired running, optional existing runner assignment, four
    encrypted secrets, pending deployment, and no post-commit reconciler. That
    code is not an accepted dependency until its exact commit/check.
  - Existing cloud provisioning writes a runner row before `createRunner`,
    records phases, reuses one active provisioning row, and confirms readiness
    from authenticated heartbeat/probe, but its current public service executes
    multiple provider phases and endpoint polling in one call and has no
    deployment-derived provider operation key/tag recovery seam.
  - Existing heartbeat commits owner-authenticated runner status then performs
    cloud-runner readiness confirmation synchronously. Existing placement locks
    capacity and counts assigned `starting|running|restarting` agents. Existing
    lifecycle opens usage only on synchronous ready, closes the latest open
    period on stop, and records requested/completed/error events, but has no
    database uniqueness for one open usage row and no automatic deployment
    finalizer.
- blockers:
  - Hard dependency: all Step 4–6 prescribed product commits and independent
    acceptances. The coordinator must not assign Step 7 implementation early,
    because its launch, status, canary, projection, secret, and response
    semantics are defined by those accepted predecessors.
  - Local gates require isolated PostgreSQL connections, Docker and the pinned
    image, fake DigitalOcean/runner/health/model/Telegram transports, synthetic
    keyring, Next post-response test seam, and free local ports. Missing
    capability is a recorded blocker, not authority to weaken concurrency/
    migration/smoke evidence or use a real service.
  - No real provider credential, bot/user, funded OpenRouter key, hosted cron
    secret, deployment, or budget authorization is required or authorized for
    Step 7 implementation. Those remain Step 10 prerequisites.
- open questions:
  - None behavior-blocking after exact Step 4–6 acceptance. This contract
    resolves the retry endpoint, one-item trigger budget, cron authentication,
    lease/backoff/attempt constants, durable runner/canary evidence, ambiguous
    provider/canary recovery, stage actions, final ready transaction,
    cancellation precedence, safe failures, local-only smoke, and migration
    requirements. Any deviation in provider replay semantics, canary repeat
    policy, retry operation identity, cron auth, or ready/usage boundary is a
    product/security/billing compatibility decision requiring coordinator/user
    approval before implementation.

## Step 8 Completion Contract (pre-spec)

- issue/readiness:
  - `PLAN.md` Step 8, “Add One-Click Creation and Persisted Progress UI.”
  - Classification: `blocked`. Do not assign Step 8 implementation until Steps
    4, 5, 6, and 7 are each committed with their prescribed exact product
    message and independently accepted. At pre-spec time Step 4 has candidate
    commit `d942270`; the hot handoff still requires its independent acceptance,
    and Steps 5–7 remain dependency-blocked contracts. Before implementation,
    re-read the accepted Step 4–7 code and checker evidence and adjust private
    component/helper names only; do not weaken the accepted create, deployment,
    retry, cancellation, or readiness contracts.
- outcome:
  - Make the enabled default Agents-page creation path one compact ready-mode
    submission: name, template, the sole approved OpenRouter model, masked
    OpenRouter key, masked Telegram bot token, and a one-ID-per-line Telegram
    allowlist. The browser sends the exact Step 4 ready payload and follows the
    durable Step 7 operation; it never simulates provisioning progress.
  - After the server returns the exact Step 4 `202 {agent,deployment}`, clear
    every credential/allowlist input and navigate immediately to the owner-only
    agent detail. That page starts from its server-rendered persisted deployment
    snapshot, then polls the existing deployment endpoint until a terminal
    state. Closing the tab, refreshing, navigating, or opening a second browser
    changes only observation; database reconciliation continues independently.
  - Show the same latest persisted operation on Agents inventory, agent detail,
    and Dashboard surfaces. Managed creation needs no Start click and no native
    Hermes setup. Failed managed operations expose the accepted Step 7 Retry
    action; desired-stopped agents expose intentional stop/resume state. Native
    Hermes setup remains available as clearly labeled advanced/recovery UI.
- create form and rollout compatibility:
  - Preserve the accepted Step 4 API exactly. The ready form submits only
    `{name,templateKey,runnerId?,launchMode:"ready",idempotencyKey,openrouterModel,
    openrouterApiKey,telegramBotToken,telegramAllowedUserIds}`. Do not add client
    stage, provider metadata, desired/observed status, bot identity, revision,
    event, secret, or deployment fields. A successful ready first write or
    replay remains HTTP 202; the existing omitted/`stopped` API form remains HTTP
    201 and creates no deployment.
  - The server page reads Step 4's exact fail-closed rollout parser and passes
    only a boolean ready-mode availability plus client-safe model metadata. It
    never exposes the raw environment value or distinguishes invalid server
    configuration from disabled rollout in HTML. When enabled, ready mode is
    the default and visually primary path. When disabled/invalid, show fixed
    “Automatic setup is unavailable” copy and preserve the existing stopped
    creation path as an explicitly manual/advanced fallback; do not let a client
    prop, query parameter, cookie, or local storage value enable ready creation.
  - Populate the model select from the accepted server-owned registry snapshot,
    with exactly `openai/gpt-4.1-mini` / “GPT-4.1 Mini” at this step. The posted
    model ID is still revalidated server-side; the browser never accepts free
    text, provider overrides, context-window input, fallback models, or a live
    model-catalog call.
  - Retain template selection and optional owned runner selection compatibility.
    Runner selection is an advanced optional field; no-runner means the Step 7
    reconciler selects/provisions capacity. Do not synchronously provision,
    poll a runner, contact Telegram/OpenRouter, or wait for ready in the create
    request or React submit handler.
  - Keep the manual 201 flow behavior-compatible for API users and for the
    rollout fallback. A manual creation may still link to its stopped detail and
    existing explicit Start/Hermes setup flow. Never fabricate a deployment for
    a historical/manual agent merely to make UI rendering uniform.
- exact credential and allowlist UX:
  - Render OpenRouter key and Telegram bot token as uncontrolled
    `type="password"` inputs with visible labels, safe format hints,
    `autoComplete="off"`, spellcheck disabled, and no initial/default value.
    Never place either value in React state, a server component prop, HTML,
    hydration data, a data attribute, an error, a URL, browser storage, or an
    analytics/logging call. A show-secret toggle is not required and should not
    be introduced in this step.
  - Render the Telegram allowlist as a labeled multiline input: one canonical
    decimal user ID per line. Client normalization trims each line, rejects
    blank-only submissions and any sign, decimal, exponent, wildcard, comma/
    CSV, leading zero, zero, non-digit, or more-than-100-entry input, and
    deduplicates exact strings in first-seen order without converting through a
    JavaScript number. The API receives a string array and remains the final
    authority for Step 4's exact `1..100` canonical-ID contract.
  - Place BotFather guidance next to the token field: create/select a dedicated
    bot, copy its token once, and stop/delete any existing agent before reusing
    that bot. Place allowlist guidance next to the ID field: only listed numeric
    Telegram users may DM the bot; groups, usernames, CSV, wildcard access, and
    BotFather automation are unsupported. If linking to BotFather, use the fixed
    `https://t.me/BotFather` target with safe external-link attributes and never
    append form state or credentials.
  - Immediately after constructing each request, overwrite the uncontrolled
    key/token/allowlist DOM values and discard local variables when the request
    settles. They must be empty before a successful 202 navigation and after any
    failed/ambiguous attempt; retry requires re-entry. Do not rehydrate them
    from the accepted response, deployment reads, browser history, or server
    state. Non-secret name/template/runner choices may remain after a definitive
    validation error.
  - Client validation is convenience only. Render server field issues by their
    fixed field names, safely map known route codes, and keep unknown failures
    generic. Do not echo a rejected value, raw response body, exception text,
    upstream response, Telegram URL, token fragment, bot/user ID, or
    `error.detail` into the page.
- idempotent submission and ambiguous-response behavior:
  - Generate one lowercase Web Crypto `crypto.randomUUID()` only after local
    validation and immediately before the first POST for a logical submission.
    Keep it in component memory, not a DOM field, URL, cookie, storage,
    telemetry, error message, or console. A synchronous ref latch must close
    before the first `await`; disable submit and set `aria-busy` so double click,
    Enter plus click, and React rerender cannot start two POSTs.
  - Reuse the same creation key for every retry of that logical submission.
    Definitive 400/409/503 responses may unlock editable non-secret fields while
    retaining the key. A network failure, abort, malformed success body, or
    response loss is ambiguous: lock the original common envelope and offer
    “Retry same submission” plus “Start over.” Retry asks for credentials again
    and sends the same key; if the first request committed, Step 4 replay returns
    the original agent/deployment without mutation, and if it did not commit,
    the re-entered complete payload can become the first write. Start over is
    the only action that discards the key and unlocks a new logical submission.
  - Validate every 202 response with an exact safe client parser before using
    IDs or navigation. Require valid agent/deployment UUIDs, matching
    `deployment.agentId`, an exact known stage, and safe timestamps/counts. A
    malformed body is an ambiguous failure, not permission to generate a new
    key or render server-controlled strings. A 201 response is accepted only
    for the explicit manual fallback.
  - After a valid 202, clear the logical-submission key from memory, focus a
    safe “Creation accepted” status/link long enough for assistive technology,
    and use `router.replace` to `/agents/<encoded UUID>`. Do not put deployment
    or idempotency IDs in query/hash parameters. A plain owner-scoped detail
    link remains available if client navigation is interrupted.
- persisted deployment presentation contract:
  - Use the accepted exact stage values as data/state, without a second fake
    progress enum or a percentage/ETA: `pending` → “Preparing deployment”;
    `provisioning_runner` → “Provisioning runner”;
    `configuring_hermes` → “Configuring Hermes”;
    `starting_gateway` → “Starting gateway”; `verifying_model` → “Verifying
    model”; `connecting_telegram` → “Connecting Telegram”; `ready` → “Ready”;
    and `failed` → “Setup failed.” Copy may explain the current safe action but
    must not claim an external phase completed until the persisted stage has
    advanced.
  - Build one closed presentation mapper shared by create/detail/inventory/
    dashboard components. It accepts only the public deployment DTO, the safe
    observed lifecycle status, and `desiredStatus`; unknown/malformed values map
    to “Progress unavailable” and never to ready. Do not use attempt count,
    timestamps, spinner duration, runner status, a container PID, or optimistic
    local state to infer stage completion.
  - Show an ordered stage list on the detail progress card. Mark only stages
    strictly before the persisted stage completed, the exact stage current, and
    later stages pending. `failed` is terminal but is not an eighth successful
    milestone: retain the last safe operation heading, mark the operation
    failed, and do not paint unobserved stages complete. `ready` is shown only
    for persisted stage `ready`, desired running, and observed agent running;
    any inconsistent snapshot is “Final status updating,” never ready.
  - `desiredStatus="stopped"` overrides a historical ready/failed deployment in
    lifecycle presentation with “Intentionally stopped.” An active Step 7
    cancellation may briefly show its persisted active/failed stage until the
    owner read returns desired stopped. A manual agent with no deployment keeps
    the existing stopped/lifecycle presentation. A desired-running managed
    agent with no deployment is “Progress unavailable,” not manual, failed, or
    ready.
  - “Retrying” is a transient accessible action state after an accepted retry
    POST and before its returned new pending deployment is installed. After
    refresh the truthful persisted label is the returned/latest stage; do not
    invent durable retry metadata absent from the accepted Step 7 DTO. Never
    mutate or relabel the old terminal failed deployment as pending.
  - Extend owner-scoped list/detail server reads with the latest safe deployment
    snapshot and desired status, preferably through one bounded owner-scoped
    query rather than browser/N+1 fetches. Agents inventory and Dashboard render
    a compact label and detail link from that snapshot. The detail page renders
    the full progress card. No server surface may expose lease data, operation
    keys, runner/provider identities, config content/revision beyond the
    already-public DTO, canary output, endpoints, or secret metadata.
- polling, error, and timeout state machine:
  - The detail progress client starts from server-rendered state and calls only
    `GET /api/agents/<encoded UUID>/deployment` with `cache:"no-store"` and
    same-origin credentials. Make one request at a time. Use an `AbortController`
    and generation token so unmount, agent change, retry acceptance, or a newer
    response makes every stale response inert.
  - Poll immediately after hydration or retry acceptance, then after 2 seconds
    through 30 seconds of foreground tracking, 5 seconds through 5 minutes,
    and 15 seconds thereafter, with a 30-minute foreground-time ceiling. Count
    only visible/online time. Pause timers while `document.hidden` or offline;
    on visibility/online restoration make one immediate request. Do not hold a
    request open, use recursive zero-delay timers, overlap calls, or use polling
    as a reconciliation trigger.
  - Accept a response only when its agent ID matches the route and its DTO
    passes the exact safe parser. While tracking one operation, ignore an older
    deployment response; after an accepted Step 7 retry, advance to its returned
    new deployment ID and make the old poll generation inert. A genuinely newer
    latest operation from another tab is accepted by persisted `createdAt` and
    then becomes the tracked operation.
  - On an unchanged valid nonterminal response, retain the exact stage without
    a live-region announcement. On a changed stage, update the view and
    announce once. On `ready` or `failed`, stop polling and call `router.refresh`
    once so server-rendered inventory/detail metadata and lifecycle controls
    converge. Never poll a historical manual/no-deployment agent.
  - Treat network failures, 500 `agent_deployment_failed`, and malformed JSON as
    observation failures, not deployment failures. Keep the last known stage,
    retry on the normal schedule, and after three consecutive failures show
    “Progress updates are temporarily unavailable” with a manual “Check again”
    action. A successful read clears that view-only error counter.
  - A 401/403 authentication/configuration response stops polling and asks the
    user to sign in/reload without echoing detail. A concealed 404 stops polling
    and shows “Agent is unavailable.” A valid `{deployment:null}` is normal only
    for a manual/desired-stopped agent loaded as such; for a tracked ready-mode
    agent it is “Progress unavailable” and must not fall back to simulated
    progress.
  - At 30 minutes of foreground polling, stop automatic requests and show
    “Automatic progress updates paused” with “Resume updates” and the last
    persisted stage. Timeout is a browser observation state, never `failed`,
    never an agent error, and never a retry authorization. Resume starts a new
    bounded foreground window with one immediate GET. Navigation/refresh also
    reloads authoritative persisted state.
- failure actions, retry, and lifecycle controls:
  - For a persisted `failed` operation with desired running, render one Retry
    control that calls only the accepted Step 7 owner-concealed
    `POST /api/agents/<agentId>/deployment/retry` with exact
    `{idempotencyKey}`. Generate one new in-memory UUID for one operator retry,
    latch before `await`, and reuse that same key after an ambiguous response.
    A valid 202 exact `{deployment}` must identify the same agent and a new/latest
    pending operation before the progress card switches to it.
  - Map retry 400 to fixed invalid-request copy, concealed 404 to agent
    unavailable, 409 `deployment_not_retryable` to “Refresh status before
    retrying,” and 500/unknown/network failures to generic retry-unavailable
    copy. After 409, refresh the deployment once. Do not rerun creation, ask for
    or resend credentials, revalidate Telegram, rotate secrets, change config,
    or call a runner/provider from the browser.
  - Error copy comes from a closed UI map keyed by accepted Step 7 safe error
    codes/categories. Actions are restricted to Retry, Stop, Delete, refresh,
    open advanced recovery, or contact the operator as appropriate. Ignore raw
    upstream content and do not interpolate the DTO `error.detail`; unknown
    codes get “Automatic setup could not finish. Retry or stop this agent.”
  - Pass desired status and deployment presentation into lifecycle controls.
    Hide/disable Start while a managed desired-running deployment is pending or
    progressing; offer “Stop setup” through the accepted Stop/cancellation path.
    For ready/running show Stop and existing Restart; for failed/desired-running
    show Retry rather than Start; for desired-stopped show the existing explicit
    Start/Resume compatibility action. Delete remains available under its
    accepted confirmation/cleanup semantics.
  - The Stop response must be followed by an authoritative refresh before the
    UI announces “Intentionally stopped.” Step 8 may wire the minimum accepted
    Step 7 desired-state cancellation behavior into controls, but must not claim
    Step 9 durability: Docker `unless-stopped`, reboot recovery, periodic
    desired-running repair, Telegram circuit breaking, and usage segmentation
    remain Step 9.
  - For a managed agent, move native `hermes setup` into a secondary collapsed
    “Advanced Hermes setup and recovery” section with copy that managed provider
    and Telegram keys are control-plane-owned and may be reprojected. Do not show
    setup as required for automatic readiness. Preserve the existing manual
    agent setup terminal, owner/session protections, and recovery behavior.
- accessibility and responsive behavior:
  - Use real labels, fieldset/legend grouping, hint/error IDs via
    `aria-describedby`, and focus the first invalid field after validation.
    Submission/progress/retry regions use `aria-busy`; stage changes use one
    `role="status"`, `aria-live="polite"`, `aria-atomic="true"` region; terminal
    failures use `role="alert"`. Do not announce every unchanged polling tick.
  - Render the progress track as an ordered list with textual labels. Mark the
    current persisted stage with `aria-current="step"`; icons, color, and motion
    are supplementary only. Failed, retrying, intentionally stopped, paused,
    and observation-error states each have explicit text and an operable action.
  - Submit/Retry/Stop buttons are native buttons, visibly focused, disabled
    during their own request, and remain keyboard reachable in logical order.
    Do not disable the whole page while tracking. Move focus to the accepted
    progress heading after submit/retry and to a terminal alert only once.
  - At 320 CSS pixels and the existing mobile breakpoints, fields and stage copy
    wrap without horizontal scrolling, controls meet the existing minimum touch
    target, and inventory/dashboard use the mobile card presentation rather
    than a hidden-only desktop status. Respect `prefers-reduced-motion`; no
    timer-driven decorative animation may imply progress.
  - Preserve usable no-JavaScript/server-rendered snapshots on detail,
    inventory, and Dashboard. Hydration adds polling/actions but does not replace
    authoritative text with “loading,” and pre-hydration submit remains safely
    disabled under the existing guard.
- security, privacy, and isolation:
  - Every create/deployment/retry/lifecycle call stays same-origin and relies on
    accepted authenticated owner-concealed routes. IDs come only from validated
    route/server responses. Never add a public progress endpoint, accept a user
    ID in client JSON, trust a client ownership field, use the development-user
    resolver in production UI paths, or let one user's list/detail query join
    another user's operation.
  - Never render, log, persist in browser storage, or include in React/Next error
    serialization the OpenRouter key, Telegram token, allowlist, generated API
    key, idempotency/retry keys, bot numeric ID, stable/public fingerprints,
    private URLs, runner/provider data, prompt/completion, raw error/detail, or
    secret-bearing request body. Bot username/model display metadata may appear
    only where the accepted safe DTO already permits it; progress UI does not
    need either.
  - Do not call Telegram, OpenRouter, DigitalOcean, GHCR, runner private APIs, or
    Hermes from browser code. BotFather is an explicit user-clicked documentation
    link only. No prefetch, image, beacon, third-party analytics, or client-side
    token validation may transmit form values.
  - Apply the shared redaction corpus to any new server-side safe error/log seam,
    but design the UI so sensitive values never reach it. React errors, thrown
    parser failures, route JSON, test snapshots, Playwright traces/screenshots,
    progress/changelog evidence, and `console.*` must be canary-clean.
- concurrency and stale-state guarantees:
  - Browser latches prevent duplicate create, retry, stop, and resume requests;
    database idempotency/leases remain the authority. Multiple tabs may poll or
    race Retry/Stop, but the accepted Step 7 endpoint/desired-state compare-and-
    set decides the result. UI losers refresh and present persisted state; they
    never optimistically overwrite it.
  - Keep at most one deployment GET in flight per detail widget and do not start
    per-row polling from the Agents or Dashboard list. Those list surfaces show
    the server-rendered latest snapshot and link to detail; this prevents an
    unbounded browser fan-out for large inventories. A terminal detail refresh
    updates all server components in that navigation.
  - Stage order in the browser is not a write authority. A response with a
    changed/new deployment is selected only by validated operation identity and
    persisted creation time; late responses from an aborted generation cannot
    regress the UI or revive a failed/stopped/deleted operation.
- required semantic and adversarial tests:
  - Create-form component tests cover enabled-ready/default-off/manual fallback,
    exact request keys, sole model option, optional runner, newline ID parsing,
    canonical string preservation/deduplication, all invalid allowlist forms,
    field focus/hints, pre-hydration guard, double submit, password masking,
    immediate secret/allowlist clearing, and absence from rendered markup/state/
    messages after every success/failure/ambiguous path.
  - Idempotency tests cover one UUID per logical submit, same-key definitive and
    ambiguous retry, re-entered first-write credentials, Step 4 replay with
    changed/reduced body, explicit Start over/new key, malformed 202, 201 only
    for manual mode, and no key in URL, storage, console, DOM, or errors.
  - Progress mapper/component tests cover every exact persisted stage,
    completed/current/pending semantics, inconsistent ready/observed status,
    desired-stopped override, manual null deployment, managed unexpected null,
    retrying action state, unknown values, closed safe-error actions, no raw
    detail, and no percentage/ETA/timer-derived advancement.
  - Fake-clock polling tests cover immediate/2s/5s/15s cadence, single-flight,
    abort/generation discard, visibility/offline pause and resume, unchanged
    announcement suppression, three-failure degraded state and recovery,
    401/403/404/null/malformed/500/network handling, terminal stop/one refresh,
    retry operation replacement, 30-minute foreground pause, manual resume, and
    zero reconciliation side effects.
  - Route/server-page tests cover safe rollout-boolean derivation, owner
    concealment, exact public deployment projection on list/detail/dashboard,
    no N+1 browser pollers, latest-operation selection under concurrent retry,
    cross-user isolation, deleted agent, and no internal lease/runner/canary/
    secret/error-detail fields in HTML or serialized props.
  - Lifecycle tests cover no Start during managed creation, Stop setup/cancel,
    Retry only for failed desired-running, concurrent Retry/Stop convergence,
    desired-stopped presentation, ready/running Stop/Restart, manual Start
    compatibility, delete, and advanced Hermes setup remaining owner-protected
    but secondary for managed agents.
  - Accessibility/responsive tests cover label relationships, field error focus,
    native button busy/disabled state, one live announcement per transition,
    `aria-current`, terminal alert focus, keyboard operation, reduced motion,
    desktop inventory/detail/dashboard snapshots, and mobile cards/progress at
    320px without horizontal overflow.
  - Playwright covers an enabled ready submission on desktop and mobile through
    injected fake Telegram/provider/runner/model seams: exact 202, immediate
    detail navigation, close/reopen or refresh during progress, persisted stage
    continuation through all exact stages, no Start/setup requirement, and final
    ready/running. Add failure → Retry → new operation → ready, Stop during
    progress, network observation failure/recovery, second browser/context, and
    manual fallback scenarios. Fakes only; no external request is allowed.
  - Redaction canaries for OpenRouter key, Telegram token/allowlist/bot ID,
    private API key, both idempotency keys, fingerprints, private endpoints,
    provider/runner data, upstream body/error, prompt/completion, and DTO error
    detail must be absent from response rendering, hydration payload, URL,
    browser storage, console/page errors, screenshots/traces, logs, events, and
    progress evidence.
- required commands/gates:
  - Run focused create-form/progress/polling/lifecycle/list/detail/dashboard/
    route/isolation/redaction tests and both desktop/mobile Playwright specs with
    the documented local fake seams. Run any accepted Step 7 focused regression
    tests affected by lifecycle presentation; no database migration generation
    is expected for this UI step.
  - Run `bun run format:check`; `bun run lint`; `bun run typecheck`;
    `bun run test`; `bun run build`; desktop and mobile
    `bun run test:e2e:ci`; and `git diff --check`.
  - Run `bun run verify:e2e` only in its documented local-cloud/provider-safe
    fake environment. Also retain credential-free fail-closed
    `bun run verify:hermes:staging`; it must exit nonzero with named missing
    capabilities and no side effects. No live-success staging gate, billable
    resource, or real Telegram/OpenRouter request is required or authorized in
    Step 8. Fix every product-caused failure and classify only proven baseline/
    shared-resource failures under the team protocol.
- likely touchpoints:
  - Primary UI: `app/agents/_components/create-agent-form.tsx`; new narrowly
    scoped deployment presentation/progress and deployment-retry components;
    `app/agents/_components/agent-lifecycle-controls.tsx`, start/stop buttons,
    `mobile-agent-list.tsx`, and `app/globals.css`.
  - Surfaces/reads: `app/agents/page.tsx`, `app/agents/[agentId]/page.tsx`,
    `app/dashboard/page.tsx`, `src/server/agents/list-agents.ts`, and an internal
    shared safe deployment-presentation/parser module. Consume the accepted
    `deployment-dto.ts` and `deployment-state.ts` contracts without moving
    secret/server-only code into the client bundle.
  - API consumers: accepted `POST /api/agents`,
    `GET /api/agents/[agentId]/deployment`, Step 7
    `POST /api/agents/[agentId]/deployment/retry`, and existing lifecycle routes.
    Route changes should be unnecessary except narrowly tested safe projections;
    do not widen any response or authentication contract for UI convenience.
  - Tests: focused new component/polling/presentation tests, affected
    `root-page.test.tsx`, operational isolation/lifecycle/route tests, and new
    desktop/mobile specs under `tests/e2e/` plus the existing E2E launcher only
    as needed to select documented fake capabilities.
- non-goals / do not touch:
  - No Step 9 restart policy, Docker inspect/heartbeat expansion, reboot repair,
    periodic reconciliation of already-ready agents, Telegram disconnect
    circuit breaker, restart-loop bounds, or usage-period segmentation. UI must
    not claim these durability properties early.
  - No Step 10 real Telegram message/reply, OpenRouter provider call,
    DigitalOcean spend, GHCR publish/scan, Vercel deploy/secret/cron/flag
    mutation, hosted rollout, or live acceptance evidence. Do not read
    `.env.local`, contact an external service, or enable ready creation by
    default in deployed configuration.
  - No new model/provider, Telegram group/webhook/pairing/open-access feature,
    BotFather automation, credential reveal/edit/rehydration, browser secret
    vault, progress WebSocket/SSE, background service worker, client-side
    reconciler, percentage/ETA, notification system, or third-party UI/
    accessibility/analytics dependency.
  - Do not change Step 4 exact create/replay/getMe/model/encryption/uniqueness
    semantics, Step 5 projection/YAML/secrets, Step 6 runner/private readiness/
    canary contract, Step 7 lease/provider/retry/finalization/cron semantics,
    the pinned Hermes image, manual creation API compatibility, or terminal
    deployment immutability.
  - No migration is expected. Do not add operation presentation columns or copy
    secrets/errors into agent rows merely for the UI; derive from accepted
    owner-scoped desired state and latest deployment. Any proposed schema/public
    DTO expansion is a coordinator-reviewed blocker, not incidental UI work.
- security/data/compatibility risks:
  - Keeping credential fields in controlled React state, browser storage,
    hydration, history, error telemetry, or Playwright artifacts creates a
    durable credential leak. Uncontrolled masked inputs, immediate clearing,
    same-origin requests, and adversarial canaries are acceptance boundaries.
  - A timer-driven progress list or optimistic ready state can misrepresent a
    paid canary, Telegram connectivity, billing start, or failed deployment.
    Only the persisted DTO advances stage; browser timeout/error is visually and
    semantically separate from deployment failure.
  - Generating a fresh key after a lost create/retry response can duplicate an
    agent or explicit paid retry. Reusing a key with an unlocked changed common
    envelope can unexpectedly return the original operation. The ambiguous-
    submission lock and explicit Start over boundary are mandatory.
  - Polling per inventory row or overlapping timers can amplify load and race
    stale responses over a new retry/stop. Detail-only single-flight polling,
    generation cancellation, visibility pausing, and bounded cadence prevent
    the browser from becoming an orchestration or denial-of-service source.
  - Treating historical `ready` as current readiness after desired stop/runtime
    regression is false status. Presentation must combine latest persisted
    deployment, desired intent, and observed lifecycle conservatively; Step 9
    later supplies stronger continuing-runtime evidence.
- progress/changelog/commit:
  - After every required gate, mark Step 8 complete in the Automatic Ready
    ledger with sanitized create/idempotency, refresh/navigation/second-browser,
    exact-stage, failure/retry/stop, accessibility, desktop/mobile, redaction,
    and fake-only E2E evidence. Record the commit reference if available, set
    Step 9 next, preserve every historical ledger, and never record credentials,
    bot/user IDs, operation/idempotency IDs, private endpoints, provider/runner
    evidence, prompts/completions, raw errors, or screenshots containing inputs.
  - Add newest-first `Unreleased` entries: `Added` for credential-complete
    one-click ready agent creation with persisted progress, and `Changed` for
    deployment-aware lifecycle controls plus advanced Hermes setup becoming the
    secondary managed-agent path. Do not add changelog entries for tests,
    styling, refactors, fake seams, or validation alone, and do not duplicate
    Step 4–7 behavior.
  - Commit exactly `feat: add one-click ready agent creation` only after the
    committed/checked Step 4–7 dependencies and all Step 8 gates pass.
- exact repository evidence at pre-spec time:
  - Accepted Step 0–3 behavior and Step 4 candidate `d942270` provide the exact
    eight-stage DTO/owner-concealed GET, ready-mode request, replay-before-flag
    semantics, sole approved model, server-validated Telegram metadata,
    encrypted credentials, desired-running intent, and 202 response. The
    current `create-agent-form.tsx` still posts only the manual envelope and
    advances seven timer-simulated runner/setup labels every 1.6 seconds.
  - Current inventory and Dashboard render observed lifecycle status only;
    detail renders run/Hermes/runner readiness and puts native Hermes setup
    before configuration. `list-agents.ts` does not expose desired status or a
    latest deployment summary, and lifecycle controls therefore show Start for
    a newly committed desired-running agent while it is still observed stopped.
  - The accepted Step 3 deployment endpoint returns `{deployment}` or null and
    conceals foreign/deleted agents. Its safe DTO includes stage, attempt,
    allowlisted safe error, next attempt, and timestamps while excluding leases
    and idempotency. Step 7 is contracted to retain that DTO and add the exact
    retry endpoint/new-operation semantics consumed here.
- blockers:
  - Hard dependency: prescribed product commits and independent checker
    acceptance for every Step 4–7 dependency. Step 8 must not code against an
    unaccepted speculative retry DTO, lifecycle cancellation, stage event, or
    desired/observed behavior.
  - Local gates require the repository's PostgreSQL fixture, deterministic
    injected fake Telegram/provider/runner/model seams, fake clocks, and working
    desktop/mobile Playwright browsers. Missing capability is a recorded
    blocker, not authority to weaken persistence, redaction, isolation,
    accessibility, or browser coverage or to contact a real service.
  - No production rollout flag, hosted secret, real bot/user, funded OpenRouter
    key, provider budget, published image, or deployment permission is required
    or authorized. Those remain Step 10 prerequisites.
- open questions:
  - None behavior-blocking after exact Step 4–7 acceptance. This pre-spec fixes
    the ready/manual rollout presentation, form normalization, in-memory
    idempotency boundary, safe response parser, persisted stage labels,
    detail-only polling cadence/timeout, retry/lifecycle states, multi-surface
    rendering, accessibility, privacy, and fake-only gates. Any request to
    persist browser keys, widen a public DTO, show raw safe-detail text, add
    streaming progress, poll every inventory row, expose additional models, or
    claim Step 9/10 durability is a compatibility/security/product decision that
    requires coordinator/user approval before implementation.

## Step 9 Completion Contract (pre-spec)

- issue/readiness:
  - `PLAN.md` Step 9, “Make Desired-Running Gateways Durable.”
  - Classification: `blocked`. Do not assign Step 9 implementation until Steps
    4, 5, 6, 7, and 8 each have the prescribed exact product commit and an
    independent checker acceptance. Step 4 currently has candidate product
    commit `d942270` plus an active checker-repair cycle; Steps 5–8 are archived
    dependency-blocked contracts. Before implementation, re-read the accepted
    Step 4–8 code/checker evidence and adapt private helper/table names only;
    do not weaken their credential, projection, runner, deployment, retry,
    desired-state, or UI contracts.
- outcome and authority boundary:
  - Keep every non-deleted managed-v3 agent whose latest deployment is `ready`
    and whose `desiredStatus` is `running` converged to one exact selected
    Hermes container and a fresh exact runner observation: pinned image,
    launch-spec/config revision, projected marker, private runtime, gateway and
    API server ready, and required Telegram platform connected.
  - Recover automatically after runner-process restart, Docker/container
    restart, a missing/exited selected workload, or a bounded transient
    gateway/platform regression. An explicit Stop remains authoritative across
    every runner/Docker restart. Runtime repair is level-triggered and survives
    lost HTTP responses, cron callbacks, heartbeats, and control-plane process
    restarts without duplicating containers, usage periods, or events.
  - Step 7 deployment rows remain terminal and immutable. Never reopen a
    `ready` deployment or reuse its lease/stage fields as a runtime controller.
    Step 9 adds a separate one-row-per-agent runtime state machine; Step 8 reads
    desired/observed runtime truth without turning browser polling into a
    trigger. Step 10 alone owns real message/reply acceptance and hosted rollout.
- exact Docker restart-policy contract:
  - Managed v3 selected-agent `docker run` arguments include exactly
    `--restart unless-stopped`. Docker inspect evidence must expose
    `HostConfig.RestartPolicy.Name === "unless-stopped"` and
    `MaximumRetryCount === 0`. Add the restart policy and bounded integer
    `RestartCount` to the typed runner observation; unknown/missing/negative/
    oversized values map to safe unknown evidence and never to ready.
  - Restart policy is part of the Step 6 “exact target” definition for managed
    v3 only. A pre-Step-9 selected container with `no`, `always`, `on-failure`,
    incomplete, or malformed policy evidence is stale. Desired-running
    convergence replaces it once through the accepted stop/remove/start path,
    preserving the exact `/opt/data` and `/workspace` state roots. Do not use
    `docker update` as an untracked mutation and do not preserve a wrong-policy
    container merely because it is currently running.
  - `unless-stopped` is not a substitute for desired state. Stop persists
    desired stopped and invalidates runtime work before contacting the runner;
    runner Stop then manually stops every selected workload. Start/Resume
    persists desired running before scheduling convergence. Delete invalidates
    runtime work before accepted Step 6 cleanup. No stale inspect, start,
    restart, or health result may reverse these database decisions.
  - Do not set `always`, because it can resurrect an intentionally stopped
    workload after daemon restart. Do not use unbounded `on-failure` or hide a
    crash loop behind Docker policy. When a restart loop opens the control-plane
    circuit, issue one idempotent runner Stop so `unless-stopped` cannot keep
    recycling the workload; desired intent remains running and the observed
    agent becomes error until an explicit owner Start/Restart resets the circuit.
  - Preserve the cloud runner container's existing reviewed `--restart always`
    bootstrap behavior; it is infrastructure, not a selected-agent workload.
    Preserve legacy/bodyless/native-manual and local-process adapter behavior.
    Never add selected-agent policy assertions to unrelated runner containers.
- additive durable runtime state and migration:
  - Generate the next additive migration after accepted Step 7. Add a server-
    only `agent_runtime_reconciliations` table with composite owner foreign key
    and exactly one row per agent. Its durable fields are: `agent_id` primary
    key, `user_id`, `state`, monotonic nonnegative `generation`, exact
    `config_revision`, nullable validated runner `operation_id`, nonnegative
    `attempt_count`, nonnegative `recovery_count`, nullable
    `recovery_window_started_at`, nullable `stable_since`, nullable
    `telegram_non_connected_since`, nullable `last_restart_count`, nullable
    `last_observed_at`, nullable `last_ready_at`, nullable safe `error_code`,
    nullable `next_attempt_at`, paired `lease_owner`/`lease_expires_at`, nullable
    `circuit_opened_at`, and created/updated timestamps.
  - `state` is exactly `observing | recovering_stop | recovering_start |
    verifying | stopping | stopped | circuit_open`. Database checks enforce:
    desired work fields/leases occur only where meaningful; `circuit_open`
    requires circuit timestamp plus safe error and has no automatic next
    attempt; `stopped` has no lease/backoff/error; operation UUID is present
    only for `verifying|observing`; counters are bounded nonnegative integers;
    timestamps are ordered; and error codes use the repository safe-code form.
  - Add a due/expired-lease partial index over `next_attempt_at`, lease expiry,
    and updated time for all states except `stopped|circuit_open`. Keep owner/
    agent uniqueness and the accepted Step 7 partial unique open-usage index as
    database authorities. Runtime rows, generations, leases, counters, runner
    operation IDs, restart counts, and error detail never enter public DTOs.
  - Step 7 final ready transaction inserts/upserts `observing`, generation 0,
    its exact config revision and runner operation ID, `stable_since`/last-ready
    at finalization, and a due observation. A duplicate finalization converges
    on the same row and cannot reset a newer generation. Managed Start/Restart,
    Stop, Delete, secret/config revision change, and runner reassignment update
    the row transactionally through narrow helpers rather than raw SQL in routes.
  - Migration backfill creates due `observing` rows only for non-deleted,
    desired-running agents whose latest deployment is exactly `ready` and has
    accepted Step 7 runtime correlation. Desired-stopped rows backfill as
    `stopped` only when needed for lifecycle compatibility. Manual agents,
    agents without a ready deployment, latest-terminal-failed deployments, and
    ambiguous/malformed legacy evidence are not made automatically runnable.
    Backfill is idempotent and must not update desired state, open usage, emit
    events, contact a runner, or infer operation/revision evidence.
- runtime claim, scheduling, and side-effect budget:
  - Add a server-only runtime reconciler with global and trusted runner/agent-
    targeted claim methods. A call claims at most one due row via
    `FOR UPDATE SKIP LOCKED`, increments `attempt_count` once, performs at most
    one bounded external action or observation, applies one guarded result, and
    returns. It never loops over agents/stages or performs stop plus start plus
    readiness in one invocation.
  - Reuse Step 7's validated `reconcile:<uuid>` owner form, 90,000-ms lease,
    45,000-ms total action deadline, remaining-deadline abort propagation, and
    no external call inside a database transaction. Post-result mutation must
    compare agent/user, runtime generation, lease owner/unexpired lease,
    expected state, desired state, non-deleted row, assigned runner, config
    revision, latest ready deployment, and expected operation where applicable.
    A loser discards its result; runner convergence remains idempotent.
  - Healthy `observing` schedules the next observation in 60 seconds. Safe
    transient runner/transport/health uncertainty uses deterministic 15s, 30s,
    60s, 2m, then 5m capped backoff without sleeping or extending an expired
    lease. A runner heartbeat/registration may make one assigned due row
    immediately eligible, but cannot erase a circuit or desired stop.
  - Add a separately authenticated force-dynamic/no-store
    `GET /api/internal/agent-runtime/reconcile` once-per-minute Vercel cron using
    the accepted Step 7 exact `CRON_SECRET` parser, digest comparison, constant
    401/503 failures, no body/query controls, and one-row budget. Success is
    exactly `{ok:true,processed:0|1,outcome:"idle"|"observed"|"recovering"|
    "stopped"|"circuit_open"}` with no IDs or internal evidence. Do not weaken
    or overload the deployment cron response contract.
  - After an authenticated heartbeat commits, schedule at most one post-response
    targeted runtime reconciliation for an assigned due row, after any Step 7
    deployment kick. Heartbeat JSON does not accept workload/agent/deployment
    IDs and need not grow a user-controlled workload list; the control plane
    selects one owned assignment. Runner registration, managed Start/Restart,
    and Step 7 finalization use the same lossy targeted scheduling seam. Cron is
    the durability boundary when callbacks are dropped.
- exact observation and state transitions:
  - `observing` performs one accepted Step 9 runner status request. Exact ready
    plus matching operation/revision/policy resets transient errors, updates
    last-observed/last-ready, and begins or continues `stable_since`. After 15
    continuous minutes exact-ready, reset recovery count/window and the Docker
    restart-count baseline. Ensure one open usage period exists using the Step 7
    unique index; do not emit repeated ready/recovered events on unchanged polls.
  - An exact container that is running/restarting but whose gateway/platform is
    still inside a bounded grace period stays non-ready and schedules another
    observation. First proof that the workload is absent, stopped, terminal,
    revision/policy mismatched, or no longer application-ready closes the open
    usage period at the control-plane observation time and clears `stable_since`.
    Do not backdate from an untrusted runner/Hermes clock or keep billing through
    an observed outage.
  - Missing/terminal/mismatched target with recovery budget remaining moves to
    `recovering_start`; a running exact target with unhealthy gateway/API/
    Telegram moves to `recovering_stop` so a later invocation deliberately
    stops it before a new start. Set observed agent `restarting` and one fixed
    safe reason in the same transaction. One invocation never performs both
    phases.
  - `recovering_stop` makes one accepted Step 6 idempotent Stop/cancel call. A
    confirmed stopped/absent snapshot advances to `recovering_start`; transport
    ambiguity remains in the same state with backoff. `recovering_start` first
    rebuilds the accepted managed v3 spec, proving current active secrets and
    capacity, then calls one Step 6 start convergence. Typed acceptance stores
    the operation and advances to `verifying`; exact compatibility-ready may
    advance to `observing` only through the same final ready helper.
  - `verifying` performs one correlated status observation. Exact ready returns
    to `observing`, sets observed agent running with fixed “Hermes gateway is
    ready.” copy, opens one new usage segment, and emits one recovery-completed
    event for that generation. Starting/transient stays verifying with backoff;
    terminal/mismatch consumes another bounded recovery or opens the circuit.
    Do not rerun the Step 7 model canary for ordinary runtime recovery; preserve
    the already-passed immutable deployment evidence and require exact current
    gateway/API/Telegram readiness instead.
  - Any state seeing desired stopped moves to `stopping`, increments generation,
    clears automatic recovery/circuit fields, and performs no start. `stopping`
    keeps making one bounded idempotent Stop per due claim until a typed absent/
    stopped snapshot is observed, then closes usage and becomes `stopped` with
    observed agent stopped. Runner unavailability slows to five-minute retries
    after the normal backoff but does not change desired state or reopen work.
  - `stopped` plus an explicit authenticated Start/Resume sets desired running,
    increments generation, resets the circuit/recovery window, and becomes
    `recovering_start`. An explicit managed Restart does the same but enters
    `recovering_stop`; it is the only force-recycle path for an exact healthy
    managed target. Existing manual/native lifecycle stays synchronous and
    compatible. A Step 7 latest failed deployment requires its explicit Retry,
    not runtime Start/Restart resurrection.
  - Delete increments generation/clears the runtime lease before Step 6 cleanup
    and leaves no due runtime work. Runner reassignment or managed config/secret
    replacement increments generation and requires a new exact revision before
    automatic start. A revoked/missing/undecryptable required secret opens the
    circuit without a runner call; replacement alone does not silently reset it
    unless the accepted route explicitly schedules an owner-visible Restart.
- bounded restart/recovery circuit breaker:
  - Define `MAX_AUTOMATIC_RUNTIME_RECOVERIES = 3`,
    `RUNTIME_RECOVERY_WINDOW_MS = 15 minutes`, and
    `RUNTIME_STABILITY_RESET_MS = 15 minutes`. Count a recovery exactly once
    when a generation first enters a stop/start recovery, not once per claim or
    transport retry. A fourth required automatic recovery within the same
    window opens `circuit_open` instead of contacting start/restart again.
  - Track Docker `RestartCount` deltas in the same rolling window. Three or more
    daemon-policy restarts observed before 15 stable ready minutes immediately
    open the circuit, even if the latest snapshot happens to be running. A newly
    created replacement container resets the raw count baseline but not the
    control-plane recovery window. Malformed/overflowed restart counts are
    unknown evidence and cannot reset the breaker.
  - Opening the circuit atomically sets observed agent `error`, closes usage,
    clears lease/next attempt, stores only an allowlisted code, timestamps the
    circuit, and emits exactly one circuit/error event for that generation. It
    then makes at most one separately claimed idempotent Stop; if Stop cannot be
    confirmed, keep safe cleanup-required state for operator/cron stop attempts
    without ever auto-starting. No timer or heartbeat resets a circuit.
  - Only authenticated owner Start/Restart, an explicit Step 7 deployment Retry
    when applicable, or deletion changes a circuit. Start/Restart shows fixed
    warning copy that automatic recovery was paused and begins a new generation.
    A fresh generation does not delete historical events/usage or reset Docker
    evidence before a new exact observation.
- Telegram polling, webhook-conflict, and failure hardening:
  - Preserve Step 5's single managed Telegram polling configuration and Step 4's
    stable active-token/subject uniqueness, which prevent two active plingpling
    agents from owning one bot. Do not add webhook mode, a browser Telegram
    probe, `getUpdates`, a second poller, token rotation, or automatic BotFather
    action. Never infer that database uniqueness excludes an external poller.
  - Version the Step 6 runner status contract for an adapter-first rolling
    upgrade and extend only Telegram observation to retain exact safe Hermes
    states `connecting | connected | disconnected | retrying | fatal | paused |
    disabled | unknown`. Add fixed readiness reasons for retrying/fatal/paused;
    raw Hermes error/exit text remains ignored. The new adapter accepts old v2
    snapshots conservatively; old `failed`/`disconnected` is non-ready and
    missing durability evidence is never ready for Step 9 purposes.
  - `connecting|disconnected|retrying|unknown` starts one durable
    `telegram_non_connected_since` timer. Before two continuous minutes it is a
    transient observation. At two minutes, or immediately for `fatal|paused`,
    close usage, surface a fixed safe Telegram-unavailable state, and begin one
    bounded recovery if the breaker allows. A connected observation clears the
    timer only after full exact readiness; it does not erase recovery history.
  - Before the first Telegram-driven recycle in a generation, use a server-only
    injected `getWebhookInfo` diagnostic built on Step 4's fixed Telegram-origin,
    token-encoded, redirect-error, 5-second abort, streamed 16-KiB ceiling and
    strict JSON/plain-record seam. Decrypt the active token outside every DB
    transaction, parse only whether `ok === true` and `result.url` is empty or
    nonempty, then release it. Never retain, return, log, hash, or persist the
    URL, response, token, headers, counts, certificate, IP, or upstream error.
  - A nonempty webhook opens the circuit with exact safe code
    `telegram_webhook_conflict`; never call `deleteWebhook` automatically,
    because that may disrupt another user-owned integration. UI copy tells the
    owner to remove the bot's webhook/other integration and explicitly Restart.
    Diagnostic failure is transient and bounded; it is not evidence that no
    webhook exists and is never permission to recycle repeatedly.
  - If `getWebhookInfo` proves no webhook but Telegram remains fatal/retrying
    after three bounded recoveries, open the circuit with generic
    `telegram_polling_conflict_or_unavailable`. Do not call `getUpdates` to
    distinguish an external long poller, consume an update, expose a bot/user
    identity, or compete with Hermes. A historical ready deployment must never
    keep UI status ready while current Telegram is non-connected/circuit-open.
- runner unavailability, capacity, and terminal exclusions:
  - A fresh authenticated runner heartbeat only schedules observation. A stale/
    offline/degraded runner or failed transport never proves a workload stopped,
    but after the accepted 90-second heartbeat staleness threshold it makes the
    current ready display unavailable/error, closes the observed usage interval
    at control-plane detection time, and retries with bounded backoff. Returning
    heartbeat causes immediate re-observation; it does not itself mark running.
  - Do not start/restart on a deleted or desired-stopped agent; foreign/unowned
    runner; latest terminal-failed or active deployment; revoked/missing secret;
    invalid projection/revision; inactive/unregistered/stale runner; or runner
    whose accepted capacity evidence cannot fit the assignment. Capacity wait
    is a safe non-starting retry state and cannot choose/provision a replacement
    runner in Step 9. Reassignment/provisioning remains an explicit operator or
    future capacity workflow, not silent billable recovery.
  - If an exact managed container remains ready on an over-capacity runner,
    observe it without creating another container. Capacity blocks only a new
    start/replacement. Unknown failure codes become `runtime_internal_failure`
    and consume the bounded circuit policy; they never pass through raw detail.
- usage, events, public status, and UI compatibility:
  - Usage reflects observed ready intervals. Keep the existing open period
    continuous while every collected observation remains exact ready, including
    a runner-service process restart that did not interrupt the workload. Close
    it once at the first control-plane observation of non-ready, restart,
    stopping, stale-runner, circuit, or deletion. Reopen once at the next exact
    ready transaction. Never overlap periods, create a row per healthy poll, or
    rewrite/backdate historical periods.
  - Runtime transitions emit at most one each per generation:
    `agent.runtime_recovery_requested`, `agent.runtime_recovered`, and
    `agent.runtime_circuit_opened`, while preserving accepted start/stop/restart
    request/completion compatibility. Fixed event metadata may contain only
    prior/new observed status, safe reason code, recovery count, desired state,
    and booleans `cleanupRequired`/`telegramRequired`. Exclude runtime row ID,
    generation/lease, runner operation/container/restart count, revision,
    runner/provider IDs, bot/user/webhook data, endpoints, secrets, and raw
    observations.
  - Keep the Step 3/7 deployment DTO and terminal `ready` record unchanged.
    Extend owner-scoped agent/list/detail DTOs only with a closed, safe runtime
    presentation if Step 8 cannot derive it from desired/observed status:
    `healthy | recovering | stopping | intentionally_stopped | attention_required |
    unavailable`, plus fixed safe action. Never expose counters, timestamps that
    reveal runner activity, or internal error detail. Historical deployment
    ready plus current runtime non-ready maps conservatively, never to Ready.
  - Managed Stop returns after desired stopped is durable and runner stop is
    accepted, but UI says “Stopping” until an authoritative stopped/absent
    observation. Managed Start/Restart returns truthful HTTP 202 accepted runtime
    convergence and UI follows owner-scoped persisted state. Preserve manual
    201 agents, native Hermes setup, legacy/local synchronous route unions, and
    Step 8 accessibility/detail-only polling behavior.
- safe errors, redaction, isolation, and external-effect rules:
  - Use a closed runtime code map including only categories such as
    `runtime_runner_unavailable`, `runtime_container_absent`,
    `runtime_container_terminal`, `runtime_revision_mismatch`,
    `runtime_restart_policy_mismatch`, `runtime_gateway_unhealthy`,
    `runtime_api_server_unhealthy`, `runtime_telegram_unhealthy`,
    `telegram_webhook_conflict`, `telegram_polling_conflict_or_unavailable`,
    `runtime_secret_unavailable`, `runtime_capacity_blocked`,
    `runtime_recovery_exhausted`, `runtime_stop_unconfirmed`, and
    `runtime_internal_failure`. Public messages are fixed constants; raw reason,
    stderr, inspect, health, Telegram, fetch, filesystem, or exception text is
    never persisted/interpolated.
  - All claims select composite owner/agent/runner/deployment context from the
    database. Cron, heartbeat callbacks, and runner responses cannot supply a
    user ID or redirect work to another agent/runner. No development-user
    resolver appears in protected routes. Cross-user status, lifecycle, and
    runtime reads remain concealed under accepted route behavior.
  - Apply the shared redaction corpus before bounded operational logs as defense
    in depth, but never pass launch specs, projected env/config, API/OpenRouter/
    Telegram/runner/cron credentials, allowlists/bot IDs, stable/public
    fingerprints, private URLs, webhook values, Docker inspect/names/IDs,
    provider data, model text, idempotency keys, lease/generation, or upstream
    bodies/errors into a formatter, event, route response, UI, progress, or
    changelog in the first place.
  - Step 9 implementation/tests use injected fake Telegram diagnostics and
    local runner/Docker/provider seams only. It does not contact real Telegram,
    OpenRouter, DigitalOcean, GHCR, Vercel, or a hosted database; does not read
    `.env.local`; does not publish/deploy; and does not mutate flags, secrets,
    webhooks, billable resources, or external polling state.
- required semantic and adversarial tests:
  - Real PostgreSQL separate-connection tests cover global/targeted
    `SKIP LOCKED` claim races, one row per agent, generation/lease result discard,
    desired-stop/delete precedence at every external barrier, stale lease,
    heartbeat/cron/manual-trigger collision, one action per call, backoff, and
    terminal-ready deployment immutability.
  - Migration tests cover clean install, accepted Step-8 upgrade twice,
    due-managed-ready backfill, desired-stopped/manual/latest-failed exclusion,
    malformed legacy evidence fail-closed, constraints/indexes, and no events,
    usage, desired-state mutation, or external calls during backfill.
  - Docker/runner tests cover exact `unless-stopped` argv/inspect, zero maximum
    retry count, all wrong/missing policies, old v2 compatibility, adapter-first
    rollout, RestartCount bounds/deltas, duplicate exact containers, pre-Step-9
    replacement, process crash auto-restart, runner process restart, selected
    workload absence/exit/mismatch, and never touching infrastructure/foreign/
    legacy containers.
  - State-machine fake-clock tests cover every state/transition, 60-second
    healthy cadence, transient backoff, one-effect budget, stop then start split,
    accepted/verifying/ready, recovery-count/window/stability resets, fourth-
    recovery circuit, three policy restarts, explicit circuit reset, capacity/
    secret blocks, stale heartbeat recovery, terminal-failed exclusion, and no
    automatic provider provisioning.
  - Usage/event tests prove continuous periods across observation-only and
    runner-service restarts, segmentation across every observed outage/recovery,
    one open period under concurrent finalization, idempotent closure, no
    repeated events on healthy polls/retries, one circuit alert, and no secret/
    internal metadata.
  - Telegram tests cover every exact platform state, two-minute grace, fatal/
    paused immediate handling, timer persistence across process restart,
    connected reset, bounded recycle, strict bounded `getWebhookInfo`, empty/
    nonempty/malformed/oversized/slow/redirect/hostile responses, no automatic
    `deleteWebhook`, no `getUpdates`, external-poller generic circuit, and total
    token/URL/bot/user/body/error redaction. No real Telegram request.
  - Lifecycle/UI/route tests cover managed Stop durable-before-runner and
    “Stopping” until observed, Start/Restart generation reset and truthful 202,
    multiple-tab races, deletion, no historical-ready display during outage/
    Telegram failure/circuit, owner concealment, manual/native compatibility,
    and detail-only bounded observation without browser orchestration.
  - Redaction canaries cover four managed secrets, cron/runner bearer,
    Telegram bot/user/webhook, uniqueness/public fingerprints, config revision,
    runner operation/container/restart data, private endpoints, Docker output,
    provider/model content, lease/generation/idempotency, and exception/body
    text across success, stop, recovery, stale result, circuit, logs, events,
    DTOs, HTML/hydration, errors, progress, and test artifacts.
- smoke scenarios and required gates:
  - Extend `agent:hermes:contract-smoke` with the accepted managed v3 image on
    the private network: assert `unless-stopped`, kill the Hermes process and
    prove Docker policy recovery is observed, restart the local runner service,
    preserve state/revision, force a selected-container absence and prove one
    stop/start recovery, verify no duplicate, then Stop and prove it remains
    stopped across runner/container restart attempts. Keep fake model/Telegram
    state and never claim live Telegram reply.
  - Extend the documented fake-provider `local:cloud:smoke` with simulated
    runner reboot/heartbeat loss and return, duplicate heartbeat/cron triggers,
    one desired-running recovery, one desired-stopped non-recovery, bounded
    Telegram fatal/circuit behavior, correctly segmented usage, and deterministic
    cleanup. Use no real Droplet/provider credential or billable resource.
  - Run `bun run db:generate`; clean and accepted Step-8-upgrade
    `bun run db:migrate` fixtures twice; focused Docker inspect/restart-policy,
    runner status/heartbeat, runtime reconciliation, lifecycle, cron, event,
    usage/cost, UI/isolation, Telegram diagnostic, migration, and redaction
    tests; both local smoke scenarios; and affected Step 6–8 regressions.
  - Run `bun run agent:hermes:contract-smoke`; documented fake
    `bun run local:cloud:smoke`; `bun run format:check`; `bun run lint`;
    `bun run typecheck`; `bun run test`; `bun run build`;
    `bun run test:e2e:ci`; credential-free fail-closed
    `bun run verify:hermes:staging`; and `git diff --check`. Run
    `bun run verify:e2e` only with documented local/fake capabilities. Fix every
    product-caused failure and classify only proven baseline/shared-resource
    failures under the team protocol.
- likely touchpoints:
  - Persistence/controller: `src/server/db/schema.ts`, the next generated
    `drizzle/*.sql`/snapshot/journal, new narrowly scoped
    `src/server/agents/agent-runtime-reconciler.ts` and runtime state/error
    helpers, accepted Step 7 finalization/trigger seams, lifecycle, events, usage
    helpers, and owner-scoped agent presentation DTOs only as required.
  - Runner: `src/runner-service/docker.ts`, runner status contract/parsers,
    `src/runner-service/server.ts`, `src/server/runners/manual-runner-adapter.ts`,
    runner adapter types, and per-agent serialization. Preserve Step 5 managed
    projection and Step 6 private auth/probe/canary boundaries.
  - Triggers/routes: new internal runtime cron route, `vercel.json`, heartbeat/
    registration post-response scheduling, and managed start/restart/stop/delete
    routes through internal lifecycle helpers. Reuse the accepted cron auth
    module rather than duplicating secret parsing.
  - Telegram/UI/smoke/tests: a strict server-only webhook-diagnostic method in
    the accepted Telegram client module, Step 8 runtime presentation/lifecycle
    components, `scripts/smoke-local-hermes-contract.ts`,
    `scripts/smoke-local-cloud.ts`, and focused new runtime/migration/restart/
    Telegram tests plus affected runner/lifecycle/usage/UI/E2E suites.
- non-goals / do not touch:
  - No Step 10 real Telegram message/reply, real OpenRouter model call, real
    DigitalOcean spend/reboot, GHCR publish/scan, Vercel deploy/secret/cron/flag
    mutation, hosted rollout, or production acceptance. Local/fake evidence is
    not recorded as live success.
  - No new deployment stage, reopening/mutating terminal deployment, repeated
    model canary, automatic runner provisioning/reassignment, cross-runner live
    migration, failover, high availability, multi-container replicas, queue/
    Redis/workflow dependency, WebSocket/SSE, browser reconciler, or inventory-
    row polling fan-out.
  - No automatic `deleteWebhook`, BotFather automation, `getUpdates`, Telegram
    send, token rotation/reveal, webhook support, group access, pairing/open
    access, or raw polling-conflict detail. The external Telegram owner resolves
    a webhook/other-poller conflict and explicitly resets the circuit.
  - Do not change Step 4 create/replay/getMe/encryption/uniqueness/API contract,
    Step 5 v3 YAML/secret projection, Step 6 acceptance/status/canary security,
    Step 7 initial deployment/canary/retry/finalization semantics, Step 8 create/
    progress idempotency and accessibility, the pinned Hermes image, manual 201
    compatibility, or cloud runner infrastructure restart policy.
- security/data/compatibility risks:
  - Docker `unless-stopped` alone can both hide a crash loop and revive a
    workload whose desired stop never reached the runner. Database-first Stop,
    restart-count evidence, a durable circuit, and continued stop convergence
    are one acceptance boundary; a run-argument assertion alone is insufficient.
  - Reusing terminal deployment leases or an in-memory retry counter loses work
    and bounds after process restart. A separate persisted generation/lease/
    recovery state with post-result compare-and-set is required.
  - Closing/opening usage from desired state or Docker process state rather than
    exact observed application readiness misbills downtime. Conversely,
    rewriting an old timestamp from a runner clock permits backdating. Use
    control-plane observation transactions and the one-open-period index.
  - Treating any Telegram non-connected state as immediate recycle can create a
    self-amplifying polling conflict. Treating historical ready as current hides
    delivery failure. Durable grace, webhook diagnosis, bounded stop/start, and
    explicit circuit reset balance both risks without consuming updates.
  - A webhook diagnostic URL embeds the bot token and its response may contain
    an arbitrary private URL. The fixed origin, encoded token, redirect refusal,
    bounded stream, boolean-only parser, no transactions/logging, and hostile
    redaction tests are mandatory.
  - Adapter/runner rolling mismatch can falsely accept a container without
    restart-policy/Telegram-state evidence. Ship strict parser compatibility
    first, then the runner contract, then enable the runtime cron; old evidence
    stays unavailable rather than being treated ready.
- progress/changelog/commit:
  - After every required gate, mark Step 9 complete in the Automatic Ready
    ledger with sanitized restart-policy/process/runner-reboot, desired-stop,
    concurrency/generation, circuit, Telegram fake/webhook-conflict, usage-
    segmentation, local-cloud, and redaction evidence. Record the exact commit
    reference if available, set Step 10 next, preserve every historical ledger,
    and never record IDs, policy inspect blobs, restart counts/timestamps,
    credentials, webhook/bot/user data, endpoints, runner/provider evidence,
    model text, raw errors, or billable/live claims.
  - Add newest-first `Unreleased` entries: `Changed` for desired-running managed
    Hermes recovery with bounded observation/circuit behavior, and `Fixed` for
    intentional Stop durability across runner/Docker restart plus truthful
    Telegram runtime regression display. Do not add changelog entries for the
    migration, cron, tests, fakes, refactor, or validation alone, and do not
    duplicate Step 6/7 asynchronous launch behavior.
  - Commit exactly `feat: reconcile durable Hermes gateway state` only after
    committed/independently accepted Steps 4–8 and every Step 9 gate passes.
- exact repository evidence at pre-spec time:
  - Accepted Steps 0–3 provide tracking, fail-closed capability gating, pinned
    readiness, desired state, terminal deployment rows, leases, and concealed
    DTOs. Step 4 candidate `d942270` adds desired-running ready creation, four
    encrypted secrets, stable Telegram uniqueness, a pending deployment, and
    no runner side effect; its checker repair is still active and unaccepted.
  - Current selected Hermes run arguments have no restart policy. Inspect checks
    image/revision/spec/mount/network/security/resources/no-port/no-socket and
    running state but not `RestartPolicy` or `RestartCount`. Current unexpected-
    exit reconciliation marks `starting|running|restarting` agents error and
    logs an event; it does not consider desired state or automatically recover.
  - Existing runner heartbeat persists bounded runner metrics/status and marks
    stale heartbeats offline after 90 seconds. It carries no workload list and
    current list/detail reads opportunistically reconcile Docker exits. The
    Step 6/7 contracts replace that read-side mutation with typed one-probe
    runner observations and durable deployment work; Step 9 must build on the
    final accepted versions, not current private shapes.
  - Current usage rows can represent intervals but lack the Step 7 contracted
    one-open-period index until that migration lands. Current Hermes health
    fixtures include Telegram `retrying` and `fatal`, but the public runner
    readiness union collapses non-connected states. There is no durable runtime
    breaker, webhook diagnostic, periodic ready-agent reconciliation, or
    restart-count evidence.
- blockers:
  - Hard dependency: prescribed product commits plus independent checker
    acceptance for every Step 4–8 predecessor. Step 9 cannot safely implement
    against candidate launch/status/retry/UI schemas or assume migrations that
    have not landed.
  - Local gates require isolated PostgreSQL connections, Docker with restart-
    policy support, the pinned local image, fake clocks, restartable local runner
    service, synthetic keyring, injected fake Telegram/health/model/provider
    seams, free ports, and deterministic cleanup. A missing capability is a
    recorded blocker, not authority to use a developer/global daemon
    destructively, contact a real service, weaken concurrency/security evidence,
    or claim the smoke passed.
  - No real provider key, bot/test user, funded model key, DigitalOcean budget,
    published image, hosted cron secret, deployment permission, or rollout flag
    is required or authorized for Step 9. Those remain Step 10 prerequisites.
- open questions:
  - None behavior-blocking after exact Step 4–8 acceptance. This pre-spec fixes
    the separate runtime-state boundary, `unless-stopped` inspect semantics,
    database-first Stop, one-effect reconciliation, recovery/stability bounds,
    circuit reset authority, Telegram grace/webhook diagnosis/no-delete policy,
    actual-observation usage segmentation, safe public state, rolling order,
    and local-only gates. Any request for automatic webhook deletion, repeated
    canaries, silent runner replacement/provisioning, a different restart policy
    or recovery bound, browser-driven reconciliation, raw error display, or live
    external validation is a product/security/billing compatibility decision
    requiring coordinator/user approval before implementation.
