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
