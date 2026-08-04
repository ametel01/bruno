# AgentBay Delivery Progress

## Milestone 16 Cost Tracking

Source roadmap: `docs/MILESTONES.md`

GitHub issue wave:

- #221: Progress and changelog tracking setup
- #222: Provider price metadata
- #223: Agent usage periods
- #224: Daily and monthly cost estimate service
- #225: Dashboard cost summary and views
- #226: Runner detail cost context
- #227: Final acceptance and milestone closeout

### Current Status

Milestone 16: Cost Tracking is complete at this closeout head. The product
implementation through Step 5 merged through PR #250 at `29cc588`, which is
contained in current `origin/main`. The Step 6 acceptance audit for issue #227
found no undocumented exception or missing product/test criterion.

Step 0 is complete for issue #221. The tracker lists every Milestone 16
incremental step, records the functional-change-only changelog rule, and
confirms the existing changelog structure remains valid.

Step 1 is complete for issue #222 on current `origin/main`. PR #229 added
server-only deterministic DigitalOcean runner price metadata and targeted unit
tests for supported and unavailable runner sizes.

Step 2 is complete for issue #223 on current `origin/main`. PR #230 added
durable `agent_usage_periods` records: successful starts open periods,
successful stops close only the latest open period, successful restarts retain
one continuous running period, and missing stops remain open intervals.

Step 3 is complete for issue #224 on current `origin/main`. PR #243 merged the
server-only daily and monthly runner infrastructure cost estimate service at
`ebea027`, including deterministic uptime, multiple-agent allocation, and
explicit unavailable-price coverage. The merged dashboard and runner-detail
slices consume that contract without duplicating cost math in the browser.

Step 4 is complete for issue #225 on current `origin/main`. PR #246 merged the
server-rendered dashboard daily and monthly estimate sections at `833bd0c`,
including runner monthly cost, current running-agent counts, per-active-agent
allocation, explicit unavailable and zero-agent states, and safe loader-failure
feedback without client-side cost math.

Step 5 is complete for issue #226 on current `origin/main`. PR #250 merged the
runner-detail and settings cost context at `29cc588`, using the Step 3 DTOs for
labeled raw-infrastructure estimates and per-active-agent allocation with
explicit unavailable and safe loader-failure states. Existing runner health,
capacity, and readiness context remains visible, and no client-side cost math
or credential-bearing fields were introduced.

Step 6 is complete for issue #227 at this closeout head. The final audit below
maps every Milestone 16 acceptance criterion and test requirement to direct
merged implementation and test evidence. The audit required no product source
or changelog change and stays bounded to the cost-tracking milestone.

### Changelog Status

`CHANGELOG.md` retains the Keep a Changelog structure required by the plan:
`# Changelog`, the standard preamble, and `## [Unreleased]`.

No changelog entry was added for Step 0 because progress tracking setup,
planning confirmation, test-guard alignment, and validation-only work are not
functional product changes. Future Milestone 16 changelog entries should be
added only for user-facing or operator-facing cost-tracking behavior.

### Step Checklist

- [x] Step 0: Progress and Changelog Tracking Setup
- [x] Step 1: Add Provider Price Metadata
- [x] Step 2: Persist Agent Usage Periods
- [x] Step 3: Build Daily and Monthly Cost Estimate Service
- [x] Step 4: Add Dashboard Cost Summary and Views
- [x] Step 5: Add Runner Detail Cost Context
- [x] Step 6: Final Acceptance and Milestone Closeout

### Completed Evidence

| Step | Issue | Pull request | Merge commit | Evidence |
| --- | --- | --- | --- | --- |
| 0 | #221 | #228 | `147b220` | Tracker and changelog structure guard established. |
| 1 | #222 | #229 | `bffe8ff` | Provider price metadata and focused price tests merged. |
| 2 | #223 | #230 | `54f5546` | Usage-period schema, lifecycle persistence, and focused tests merged. |
| 3 | #224 | #243 | `ebea027` | Daily/monthly infrastructure cost estimates, allocation, and unavailable-price coverage merged. |
| 4 | #225 | #246 | `833bd0c` | Dashboard daily/monthly estimates, allocation, unavailable/zero-agent states, and safe failure handling merged. |
| 5 | #226 | #250 | `29cc588` | Runner-detail and settings cost context, active-agent allocation, unavailable/failure states, and secret redaction merged. |

### Final Acceptance Evidence

No exception is required. Every roadmap criterion and named test requirement
maps to merged behavior and direct regression evidence:

| Roadmap requirement | Direct merged and test evidence |
| --- | --- |
| Acceptance: dashboard displays runner monthly cost. | Dashboard integration merged in PR #246 (`833bd0c`) and runner context merged in PR #250 (`29cc588`); `tests/unit/root-page.test.tsx`, `tests/e2e/root-route.spec.ts`, `tests/unit/runner-cost-context.test.tsx`, and `tests/e2e/runner-cost-context.spec.ts` assert the labeled monthly values. |
| Acceptance: dashboard displays estimated cost per running agent. | PR #243 (`ebea027`) calculates current running counts and reproducible per-window-active-agent allocation; the dashboard unit/browser suites assert the displayed count and per-agent estimate, while the runner-context suites assert running-now and active-in-window context. |
| Acceptance: daily and monthly views exist. | PR #246 (`833bd0c`) renders trailing 24-hour and 30-day sections; `tests/unit/root-page.test.tsx` and `tests/e2e/root-route.spec.ts` assert both accessible view headings and their labeled estimates. |
| Acceptance: start and stop times affect estimates. | PR #230 (`54f5546`) persists lifecycle usage periods; the focused start, stop, and restart cases in `tests/unit/create-agent-db.test.ts` prove successful starts open periods, successful stops close them, and successful restarts preserve one continuous period. `tests/unit/cost-estimates.test.ts` consumes those timestamps deterministically. |
| Acceptance: users can understand why a plan costs more than raw compute. | The dashboard and runner-detail copy merged in PRs #246/#250 explains orchestration, monitoring, backups, support, and margin; all four focused unit/browser UI suites assert the raw-compute/plan explanation. |
| Test: cost calculations cover uptime and multiple agents. | `tests/unit/cost-estimates.test.ts` asserts deterministic daily/monthly uptime, overlapping interval union, multiple-agent allocation, and rounding at the DTO boundary. |
| Test: UI covers the cost summary. | `tests/unit/root-page.test.tsx` and `tests/e2e/root-route.spec.ts` cover the dashboard summary; `tests/unit/runner-cost-context.test.tsx` and `tests/e2e/runner-cost-context.spec.ts` cover assigned-agent and settings runner context, labeled estimates, unavailable-not-zero states, safe failures, and redaction. |
| Test: edge cases cover stopped agents, partial days, and missing stop events. | `tests/unit/cost-estimates.test.ts` covers stopped historical agents, partial-window clipping, open periods with missing stop times, future-ended intervals, deleted runners, and out-of-window history. |

Validation evidence for the accepted product slices is preserved in green CI
runs 29057487580 (PR #243), 29063443834 (PR #246), and 29065321307 (PR #250).
At this closeout head, the non-conflicting focused unit command covering
`tests/unit/root-page.test.tsx`, `tests/unit/runner-cost-context.test.tsx`, and
`tests/unit/progress-status.test.ts` passes 42 tests, and the database-free cost
interval filter passes 2 tests. Format and lint pass across 215 files; typecheck,
production build, diff, conflict-marker, auth-row preservation, and two-file
scope checks also pass. Database-backed cost and lifecycle tests plus isolated
browser coverage remain assigned to the independent checker because #237 owns
the shared database/Docker/E2E lane. Provider-backed `bun run verify` remains a
fail-closed capability gate and is not represented as hosted acceptance without
approved provider resources.

## Clerk Authentication and User Isolation Rollout

This rollout is a separate execution ledger for the authentication plan. It
does not replace, merge with, or imply completion of the active Milestone 16
Cost Tracking checklist above.

### Tracking Setup Decision

Authentication tracking Step 0 is issue #231. It restores this durable ledger
and records dependency and evidence fields before authentication implementation
starts. No changelog entry was added for Authentication Step 0 because this
slice changes tracking only; `CHANGELOG.md` remains unchanged. User-visible or
operator-visible authentication behavior must be recorded under `Unreleased`
when it lands.

Validation evidence recorded on 2026-07-10:

- `bun run test tests/unit/progress-status.test.ts` passed (1 test).
- `bun run format:check`, `bun run lint`, and `bun run typecheck` passed.
- `bun run test` passed (61 files, 496 tests).
- `bun run build` passed.
- The GitHub CI E2E selector passed (14 tests across desktop and mobile).
- The unfiltered local `bun run test:e2e` gate remains blocked on the unchanged
  `origin/main` runtime contract: agent-creation scenarios return `503`
  `provider_not_configured` without cloud-runner credentials. No provider
  credentials or external resources were introduced for this tracking-only
  issue.

### Steps 1-9 Ledger

Evidence is recorded only after the relevant acceptance criteria and gates
pass. “Not collected” means the implementation has not started; it is not
completion evidence.

| Step | Issue | State | Depends on | PR | Commit | Validation or deployment evidence | Blocker and next work |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1. Provision the AgentBay Clerk development instance | #232 | Closed; development setup complete | None | PR #257 (merged, non-closing) | `d518f0b` | Approval `de322ae8-c258-440e-a679-b74bafb61048` permitted one dedicated AgentBay development app, verified email-code setup, development Google/Apple provider configuration, explicit linking, and keys only in ignored local `.env.local`. The dedicated app/link/provider configuration passed with required local variable names present and a sanitized `clerk doctor --json` gate green; no raw app IDs, keys, account identity, provider profile data, or PII were retained. This is not hosted browser email-code, Google, Apple, current-user, sign-out, or full provider-backed verify success. | Complete through merged PR #257. Issue #239 still owns hosted browser/provider smoke and the safely isolated runner-backed full E2E gate; production, Vercel, Ask Siargao, billing, deployment, deletion, and #240 remain excluded. |
| 2. Replace the Basic-auth shell with Clerk-capable routing and UI | #233 | Merged | None | PR #244 (merged) | `711ee48` | Locked Clerk 7.5.16; focused auth/operator/runner tests passed (8 files, 105 tests), including a real-SDK synthetic two-key request with no encryption key; isolated full unit passed (66 files, 556 tests); format, lint, typecheck, build, and isolated desktop/mobile auth and CI smoke E2E passed. No hosted provider evidence was claimed. | Complete through merged PR #244. Steps 4-7 consume the merged routing/session contract; no Step 2 review action remains. |
| 3. Resolve Clerk and development identities to internal users | #234 | Merged | None | PR #247 (merged) | `e5b09fb` | Migration 0014 adds only nullable unique `users.clerk_user_id`; the request resolver supports shared development identity and typed Clerk `401` results, while the server adapter awaits `auth()` and passes only `userId`. The operator claim CLI rejects ambiguous arguments before database access without echo. Isolated migration, focused schema/resolver/claim/adapter/CLI, concurrency, full-unit, format, lint, typecheck, build, `test:e2e:ci`, migration-lineage, diff, and secret checks passed. No production claim or provider/secret mutation occurred. | Complete through merged PR #247. Production legacy claim remains separately approval-gated; no Step 3 review action remains. |
| 4. Isolate agent lifecycle and agent data | #235 | Merged | Steps 2 and 3 (merged #233/PR #244 and #234/PR #247) | PR #255 (merged) | `b93a70f` | User ownership is enforced across agents, lifecycle, events, logs, usage, costs, and configuration; exact-head checker, CI, security, and maintainer-agent review passed. | Complete through merged PR #255; no Step 4 review action remains. |
| 5. Isolate runner provisioning and management | #236 | Merged | Steps 2 and 3 (merged #233/PR #244 and #234/PR #247) | PR #254 (merged) | `ecc1d57` | Browser runner reads, placement, provisioning, registration, and credential operations are user-scoped while machine authentication remains separate; exact-head checker, CI, security, and maintainer-agent review passed. | Complete through merged PR #254; no Step 5 review action remains. |
| 6. Isolate approvals, backups, restores, and activity | #237 | Merged | Steps 2 and 3 (merged #233/PR #244 and #234/PR #247) | PR #253 (merged) | `4a9b70a` | Approval decisions, backups, restores, activity, and object-storage boundaries are user-scoped with concealed foreign resources; exact-head checker, CI, security, and maintainer-agent review passed. | Complete through merged PR #253; no Step 6 review action remains. |
| 7. Preserve full registration-free development access | #238 | Merged | Steps 2 and 3 (merged #233/PR #244 and #234/PR #247) | PR #251 (merged) | `3317b9d` | A server-only `AGENTBAY_AUTH_MODE` policy gives non-Vercel loopback environments registration-free shared-user access, requires complete Clerk configuration for production/custom hosts, permits preview development only with an explicit exact protection attestation, ignores caller-controlled request hosts, preserves the Basic barrier and exact runner-machine bypasses, and validates Vercel builds before spawning commands. Final PR head `9441cc2` preserved all 19 product/auth blobs from reviewed implementation head `d077a83`; the independent checker passed 9 focused files / 143 tests and all static/diff checks. Exact-head CI run 29084008081 passed migration, 73 files / 669 unit tests, build, and `test:e2e:ci` 14/14, with GitGuardian and Socket checks green. | Complete through merged PR #251. The optional Vercel preview remained fail-closed as `clerk_auth_not_configured` because #232 provider/key state is unavailable; no hosted Clerk/protected-preview/provider success is claimed, and no provider, environment, secret, deployment, or production state was changed. |
| 8. Prove authentication, isolation, and runner compatibility | #239 | Repository proof merged; hosted acceptance blocked | Steps 4-7 (#235, #236, #237, #238; merged) and completed development setup Step 1 (#232) | PR #256 (merged, non-closing); PR #260 (merged); follow-up PR pending | `10c246d` | Credential-free two-user ownership, machine-token, legacy-claim, signed-out, auth-surface, and artifact-redaction evidence passed checker cycle 2, exact-head CI (776 unit and 14 E2E tests), security review, and maintainer-agent approval. The linked development Clerk setup and sanitized doctor gate from #232 are complete. The opt-in `bun run test:e2e:clerk` harness bootstraps Clerk setup in the launcher process, requires distinct `+clerk_test` identities, supplies the existing Basic shell credentials only in memory, binds each context to its resolved primary email, and now passes both hosted Playwright tests when the script's `localhost` loopback alignment is used. | Issue #239 remains open for hosted Google/Apple operator evidence and safely isolated runner-backed full `bun run verify` evidence; the deterministic email-code/current-user/sign-out/two-context lane passes. |
| 9. Cut production over and retire Basic auth | #240 | Dependency- and approval-blocked | Steps 1 and 8 (#232, #239) | Not opened | Not collected | Not collected | Requires separate production provider, secret, deployment, legacy-claim, and cutover approval. Retire Basic auth only after hosted Clerk, ownership, runner, rollback, and full-feature evidence passes. |

### Current Blockers and Next Work

- Step 1 development-only setup is complete through #232/PR #257 under
  approval `de322ae8-c258-440e-a679-b74bafb61048`: dedicated development app,
  explicit link, verified email-code configuration, development Google/Apple
  provider configuration, ignored local `.env.local` variable-name presence, and
  sanitized `clerk doctor --json` all passed without retaining raw IDs, keys,
  account identity, provider profile data, or PII. No hosted provider-flow
  success is claimed.
- Steps 2 and 3 are merged: #233 through PR #244 and #234 through PR #247.
- Their routing/session and internal-user resolver contracts are available;
  Steps 4-6 are complete through merged PRs #255, #254, and #253.
- Step 7 is complete through #238/PR #251 at `3317b9d`; its registration-free
  development and fail-closed hosted policy is available to downstream work.
- Step 8's credential-free repository slice is complete through merged,
  non-closing PR #256. Hosted browser/provider smoke still waits for a
  supported browser backend and approved isolated identities, and full
  provider-backed verification still waits for a safely isolated runner-backed
  E2E lane. The optional Clerk harness is implemented but not hosted acceptance
  evidence until it runs against the linked development instance.
- Step 9 waits for the completed #239 acceptance matrix, then requires explicit
  production-cutover approval.
- Never record Clerk keys, session values, provider credentials, runner tokens,
  user PII, or raw secret-bearing diagnostic output in this ledger.

## Update Log

- 2026-07-09: Milestone 16 Step 0 merged through PR #228, Step 1 through PR
  #229, and Step 2 through PR #230.
- 2026-07-10: Issue #231 restored the Milestone 16 tracker and added the
  separate authentication Steps 1-9 dependency and evidence ledger without a
  changelog change.
- 2026-07-10: Issue #233 implemented the Clerk-capable shell and proxy matrix
  without provisioning or linking a Clerk instance. Deterministic tests cover
  Clerk loading, failure, user, sign-out, redirect, API `401`, public-route,
  Basic-barrier, runner-bypass behavior, and a real Clerk SDK request using the
  standard publishable/secret environment path without a third encryption
  secret. The isolated focused E2E matrix passed 20 tests; the unfiltered suite
  retained the documented unchanged `provider_not_configured` agent-creation
  blocker and therefore is not claimed as green.
- 2026-07-10: Issue #234 implemented the nullable unique Clerk identity,
  request-scoped Clerk/development resolver, concurrency-safe lazy link/create,
  count-only dry-run legacy claim, and narrow awaited Clerk `auth()` adapter.
  Independent checker evidence passed after the option-like claim-ID parser fix.
  PR #247 was rebased onto merged #242 and its maintainer-requested ambiguous-CLI
  fix now rejects duplicate identities, repeated or conflicting modes, and
  inline/unknown forms without claim/database access or value echo. Current
  isolated database, full unit, build, and `test:e2e:ci` gates passed; #248 owns
  the separate baseline Docker timing flake. No production claim was executed.
- 2026-07-10: Issue #238 replaced the temporary auth transition decision with
  a server-only development/Clerk environment policy. Local loopback use is
  registration-free, production and custom hosts require complete Clerk
  configuration, protected-preview bypass is explicit and attested, and request
  hosts cannot select the mode. Focused and full unit gates plus no-key desktop
  and mobile smoke/runner-boundary E2E passed; hosted preview verification and
  provider-backed full E2E remain unclaimed. PR #251 merged the policy at
  `3317b9d` after exact-head checker, CI, and maintainer approval passed.
- 2026-07-12: Issues #235, #236, and #237 completed the user-ownership slices
  through PRs #255, #254, and #253. PR #256 merged the credential-free #239
  acceptance matrix without closing the issue. At that point, development-only
  #232 setup was approved with `.env.local` as the sole key destination, but the
  expired Clerk CLI session still required host reauthentication before external
  work could continue; the later #232 completion entry below supersedes that
  blocker.
- 2026-07-12: Issue #232 completed the dedicated development Clerk setup through
  PR #257 with explicit link, development email-code/Google/Apple provider
  configuration, ignored local `.env.local` variable-name presence, and a
  passing sanitized doctor gate. Issue #239 remains open for hosted
  browser/provider smoke and safely isolated runner-backed full E2E; no hosted
  provider-flow or full verify success is claimed.
- 2026-07-12: Issue #239 added an opt-in `@clerk/testing` Playwright harness for
  deterministic development email-code/current-user/sign-out/two-context smoke.
  The harness is not hosted acceptance evidence until it runs with approved
  development identities; Google/Apple and runner-backed full verify remain
  separate acceptance gates.
- 2026-07-12: The harness follow-up moved Clerk setup into the launcher process so
  worker processes inherit the testing environment, added distinct `+clerk_test`
  preflight validation, and bound each context to its resolved primary email without
  retaining PII. Hosted execution remains unrun and approval-gated.

## Milestone 18: Real Hermes Integration

Source plan: `PLAN.md`

This ledger tracks the native Hermes subscription setup plus Telegram path from
the Milestone 18 implementation plan. It preserves prior Milestone 16 and Clerk
history above and is the active progress record for the current `/goal`.

### Current Status

Step 9 is complete. The agent detail page now opens the pinned image's real
`hermes setup` wizard in a short-lived runner PTY. Hermes owns subscription
OAuth, model selection, optional messaging configuration, and persisted
`/opt/data` state; AgentBay does not collect a provider API key. One-time
WebSocket authorization, owner-scoped placement, stopped-workload gating, and
Hermes-state-preserving launch projection protect the setup path.

Next executable step: Step 10, run live Telegram acceptance after the user
authorizes only the basic `$4` DigitalOcean Droplet tier, the reviewed workload
image is published/scanned, Telegram smoke access is available, and the user can
interactively complete their subscription OAuth in Hermes.

### Changelog Policy

`CHANGELOG.md` retains the required Keep a Changelog structure with
`# Changelog` and `## [Unreleased]`. Milestone 18 changelog entries are added
only for validated user-facing or operator-facing functional changes under the
appropriate `Added`, `Changed`, `Fixed`, or `Security` category. Tracking-only,
tests-only, CI-only, formatting, validation-only, and non-functional refactor
work do not receive changelog entries.

Never record credential values, encrypted blobs, nonces, auth tags, master-key
material, raw Hermes errors, raw provider responses, Droplet IPs, private
endpoint details, or other secret-bearing diagnostic output in this ledger or
in `CHANGELOG.md`.

### Step Checklist

- [x] Step 0: Initialize Milestone 18 Tracking
- [x] Step 1: Add the Pinned Hermes Workload Artifact
- [x] Step 2: Make Cloud Capacity and Bootstrap Hermes-Aware
- [x] Step 3: Add Encrypted Per-Agent Secret Storage
- [x] Step 4: Add Hermes and Telegram Setup UX
- [x] Step 5: Add the Versioned Launch Contract and Hermes Home Projection
- [x] Step 6: Replace BusyBox with the Real Private Hermes Lifecycle
- [x] Step 7: Integrate Durable Logs, Failure Diagnostics, and State Cleanup
- [x] Step 8: Prove the Local End-to-End Hermes Contract
- [x] Step 9: Expose Native Hermes Subscription Setup
- [ ] Step 10: Run Live Telegram Acceptance and Controlled Rollout

### Step Ledger

| Step | State | Depends on | Commit | Validation or deployment evidence | Blocker and next work |
| --- | --- | --- | --- | --- | --- |
| 0. Initialize Milestone 18 Tracking | Complete | None | `9d6f6e1` | `test -f PROGRESS.md && test -f CHANGELOG.md`; `rg "Milestone 18|Real Hermes|Step 0|Step 9" PROGRESS.md`; `rg "^# Changelog$|^## \[Unreleased\]$" CHANGELOG.md`; `bun run test tests/unit/progress-status.test.ts`; `git diff --check`. | Complete. |
| 1. Add the Pinned Hermes Workload Artifact | Complete | Step 0 | `c2f27d5` | Upstream index `sha256:9c841866021c54c4596849f6135717e8a4d52ba510b7f52c50aef1de1a283973`; AMD64 manifest `sha256:3db34ce19adfa080736a2a3feb0316dbcccc588faa9afe7fd8ae1c03b4f1a53a`; local image `agentbay-hermes@sha256:281344814c90ee6e91b40b5dab91526f3da04325e4c31834019f422e1551da6b`; `docker buildx build --platform linux/amd64 --load -f Dockerfile.agent -t agentbay-hermes:local .`; `bun run agent:image:smoke`; `docker history --no-trunc agentbay-hermes:local`; `bun run test tests/unit/hermes-agent-image.test.ts`; `bun run format:check`; `bun run lint`; `bun run typecheck`; `git diff --check`. | Complete. |
| 2. Make Cloud Capacity and Bootstrap Hermes-Aware | Complete | Step 1 | `c0b376f` | Focused Step 2 tests passed across server env, cloud bootstrap, cost prices, runner provisioning, cloud provisioning summaries, placement, heartbeat, runner service, and local Docker DigitalOcean provider; `bun run local:cloud:prepare` returned `local_cloud_prepare_skipped` with `provider_mode_not_local_docker`; `bun run format:check`; `bun run lint`; `bun run typecheck`; `bun run test` passed 85 files / 815 tests; `bun run build`; `git diff --check`. | Complete. |
| 3. Add Encrypted Per-Agent Secret Storage | Complete | Step 0 | `cf111a7` | `bun run db:generate`; `bun run db:migrate`; focused non-DB route/schema tests passed 39 tests; focused DB-backed secret/backup/restore/lifecycle tests passed 139 tests; `bun run format:check`; `bun run lint`; `bun run typecheck`; `bun run test` passed 87 files / 824 tests; `bun run build`; `git diff --check`; `bun run test tests/unit/progress-status.test.ts` passed 2 tests; credential-free browser smoke passed 14 tests with `PLAYWRIGHT_REUSE_EXISTING_SERVER=1 PORT=3001` because a Next dev server was already running for this repo. | Complete. |
| 4. Add Hermes and Telegram Setup UX | Complete | Step 3 | This commit | Focused Step 4 tests passed 17 tests across readiness DTO, setup component, lifecycle DB blocking, and start/restart route mapping; existing lifecycle/detail-page regression set passed 187 tests; `bun run format:check`; `bun run lint`; `bun run typecheck`; `bun run test` passed 90 files / 834 tests; `bun run build`; `bun run test tests/unit/progress-status.test.ts` passed 2 tests; `git diff --check`; credential-free browser smoke passed 14 tests with `PLAYWRIGHT_REUSE_EXISTING_SERVER=1 PORT=3001` because a Next dev server was already running for this repo. | Complete; Step 5 is next. |
| 5. Add the Versioned Launch Contract and Hermes Home Projection | Complete | Steps 2, 3, and 4 | This commit | Focused Step 5 tests passed 152 tests across launch schema/redaction, server-side builder/decryption, Hermes projection/path safety, manual-runner JSON transport, runner-service contract, and affected lifecycle coverage; containerized `hermes doctor` against the projected fake fixture exited 0 with expected setup warnings; `bun run format:check`; `bun run lint`; `bun run typecheck`; `bun run test` passed 93 files / 841 tests; `bun run build`; `bun run test tests/unit/progress-status.test.ts` passed 2 tests; `git diff --check`. | Complete; Step 6 is next. |
| 6. Replace BusyBox with the Real Private Hermes Lifecycle | Complete | Steps 1, 2, and 5 | This commit | Focused Step 6 tests passed 150 tests across runner-service Docker argv/inspect/readiness, manual-runner adapter mapping, lifecycle readiness failure handling, and existing create-agent coverage; local private-network smoke launched `agentbay-hermes:local` with `gateway run`, `networkMode=agentbay-hermes`, `portBindings={}`, `hostPort8642Listening=false`, `/opt/data` and `/workspace` bind mounts, `no-new-privileges`, `capDrop=["ALL"]`, minimal `CAP_CHOWN`, `CAP_DAC_OVERRIDE`, `CAP_FOWNER`, `CAP_SETGID`, and `CAP_SETUID`, `pidsLimit=256`, `memory=1610612736`, and `nanoCpus=1000000000`; `bun run format:check`; `bun run lint`; `bun run typecheck`; `bun run test` passed 93 files / 845 tests; `bun run build`; `bun run test:e2e:ci` passed 14 tests; `bun run test tests/unit/progress-status.test.ts` passed 2 tests; `git diff --check`. | Complete; Step 7 is next. |
| 7. Integrate Durable Logs, Failure Diagnostics, and State Cleanup | Complete | Step 6 | This commit | Focused Step 7 tests passed 29 tests across runner-service log parsing, redaction, dedupe, cleanup idempotency, symlink-safety, manual-runner app-side redaction/persistence, assigned-runner delete cleanup, and progress guards; local restart persistence smoke launched the real `agentbay-hermes:local` image twice with the same mounts and verified `firstStatus=running`, `secondStatus=running`, workspace sentinel retained, gateway log sentinel retained, and `hostPort8642Listening=false`; generated artifact scan found no fixed raw Step 7 canaries (`sk-or-v1-contract`, `123456:abcdefghijklmnopqrstuvwxyz`, or `agb_agent_secret123456789`); `bun run format:check`; `bun run lint`; `bun run typecheck`; `bun run test` passed 93 files / 849 tests; `bun run build`; `bun run test:e2e:ci` passed 14 tests; `bun run test tests/unit/progress-status.test.ts` passed 2 tests; `git diff --check`. | Complete; Step 8 is next. |
| 8. Prove the Local End-to-End Hermes Contract | Complete | Step 7 | This commit | `bun run agent:hermes:contract-smoke` passed with image `agentbay-hermes:local`, config revision `cfg-1784003380225`, private API auth enforced, no public `8642`, model response `agentbay fake model response provider=openai-compatible model=openai/gpt-4.1-mini`, log sources `container_bootstrap` and `hermes_gateway`, state persistence, backup/restore safety, exact agent-root cleanup, and Telegram boundary `local-smoke-disabled`; `AGENTBAY_LOCAL_CLOUD_SMOKE_TIMEOUT_MS=480000 bun run local:cloud:smoke` passed with `startResult=blocked_by_hermes_setup`; local Trivy command was unavailable (`trivy_not_installed`) so the Step 1 scanned publish workflow remains the defined image scan path; `docker compose up -d postgres && bun run db:migrate`; `bun run format:check`; `bun run lint`; `bun run typecheck`; `bun run test` passed 96 files / 852 tests; `bun run build`; `bun run test:e2e:ci` passed 14 tests; `bun run test tests/unit/progress-status.test.ts`; `git diff --check`; labeled local smoke containers and Hermes smoke networks were removed. | Complete; Step 9 is next. |
| 9. Expose Native Hermes Subscription Setup | Complete | Step 8 | This commit | Official quickstart/provider/remote-host/Docker contracts reviewed; the pinned official image reached its native Quick Setup, Full Setup, and Blank Slate menu in a local PTY; focused setup-session, route, launch/projection, readiness/lifecycle, and UI coverage passed 9 files / 40 tests; `bun run format:check`; `bun run lint`; `bun run typecheck`; the full suite passed 210 suites / 859 tests; `bun run build`; `bun run test:e2e:ci` passed 14 desktop/mobile tests; `bun run test tests/unit/progress-status.test.ts`; `git diff --check`. | Complete; Step 10 is externally blocked pending approved basic `$4` live work, published/scanned image, Telegram smoke access, and interactive Hermes subscription OAuth. |
| 10. Run Live Telegram Acceptance and Controlled Rollout | Blocked on external live acceptance prerequisites | Step 9, published image workflow, authorized basic `$4` DigitalOcean, user's interactive Hermes subscription OAuth, Telegram bot, and Telegram test-user access | Not collected | Not collected | Requires approved basic `$4` DigitalOcean Droplet use, the scanned/published GHCR image digest, Telegram smoke access, and the user to complete subscription OAuth in Hermes. AgentBay does not request a provider API key. |

### Completed Evidence

- 2026-07-14: Step 0 appended this Milestone 18 ledger, confirmed
  `CHANGELOG.md` keeps the required structure, and deliberately added no
  changelog entry because tracking setup is not a functional product change.
- 2026-07-14: Step 1 added `Dockerfile.agent` pinned to Hermes Agent
  `v2026.7.7.2`, confirmed upstream index digest
  `sha256:9c841866021c54c4596849f6135717e8a4d52ba510b7f52c50aef1de1a283973`,
  confirmed Linux AMD64 manifest
  `sha256:3db34ce19adfa080736a2a3feb0316dbcccc588faa9afe7fd8ae1c03b4f1a53a`,
  built local image
  `agentbay-hermes@sha256:281344814c90ee6e91b40b5dab91526f3da04325e4c31834019f422e1551da6b`,
  added `bun run agent:image:smoke`, and added a separate scanned
  `publish-agent-image` GHCR workflow.
- 2026-07-14: Step 2 initially changed the default DigitalOcean size to
  `s-1vcpu-2gb`; the later requirement correction restored the live/default tier
  to basic `$4` `s-1vcpu-512mb-10gb`. Step 2 also added server-only Hermes
  image/state/network/readiness/capacity settings and generated cloud-init that
  prepares `/var/lib/agentbay/agents` plus the
  `agentbay-hermes` private Docker network, pre-pulls the pinned Hermes image,
  mounts the state root into `agentbay-runner`, and sets
  `AGENTBAY_RUNNER_MAX_AGENTS=1`.
- 2026-07-14: Step 3 added the additive `agent_secrets` schema and Drizzle
  migration, server-only AES-256-GCM encryption with versioned keyring parsing
  and authenticated associated data, owner-scoped secret status/update/revoke
  APIs, server-generated agent API-server keys, safe backup vault references,
  restore behavior that does not copy credentials, and delete-time active
  secret revocation.
- 2026-07-14: Step 4 added the agent-detail Hermes setup panel with OpenRouter
  model selection, masked OpenRouter and Telegram secret configured/missing
  states, replacement and revocation controls, generated agent API-server keys,
  server-derived readiness requirements, and Start/Restart blocking for ready
  assigned DigitalOcean Hermes runners until required setup is complete.
- 2026-07-14: Step 5 added the bounded versioned Hermes launch-spec contract,
  server-side owner-scoped launch-spec building with just-in-time decrypted
  secrets, authenticated runner JSON transport for start/restart, and
  symlink-checked managed projection of config, `.env`, `SOUL.md`, revision
  marker, and workspace directories under the Hermes state root.
- 2026-07-14: Step 6 replaced the BusyBox placeholder on the Hermes launch-spec
  path with the pinned `gateway run` workload, projected private state and
  workspace mounts, label and inspect validation, bounded Docker stop, private
  authenticated readiness polling for config and Telegram health, a smoke-proven
  minimal capability set, and lifecycle `agent.error` handling when readiness
  fails before start/restart completion.
- 2026-07-14: Step 7 added runner-side durable Hermes gateway log ingestion,
  bootstrap/gateway source classification, runner and app redaction passes,
  stable app persistence for Hermes log sources, idempotent cleanup of selected
  containers plus exact non-symlink agent roots, assigned-runner delete cleanup,
  and a local restart smoke proving workspace and gateway-log sentinels survive
  container replacement.
- 2026-07-14: Step 8 added the credential-free real-image Hermes contract
  smoke with a local OpenAI-compatible fake model provider, private authenticated
  API checks, no public gateway port, config revision evidence
  `cfg-1784003380225`, durable `container_bootstrap` and `hermes_gateway` log
  ingestion, restart state persistence, managed-state backup/restore safety,
  exact cleanup assertions, and the explicit `local-smoke-disabled` Telegram
  boundary. It also made the local cloud smoke accept fresh Hermes setup
  blocking as a safe setup-gate result, bridged the local runner env file for
  Docker-socket simulation, packaged the runner-service runtime imports in the
  runner image, and extended the runner Docker CLI timeout to cover the bounded
  Hermes stop grace.
- 2026-07-14: After Step 8, the then-live Step 9 acceptance constraint (now Step
  10) changed to basic `$4` DigitalOcean Droplets only. The server-side
  DigitalOcean default is `s-1vcpu-512mb-10gb`; live validation must not
  provision the prior 2 GB default. The user also clarified that model access
  must use the user's current subscription only, with no provider API key
  requirement.
- 2026-07-14: Step 9 replaced the AgentBay-owned OpenRouter/Telegram form with
  the real interactive `hermes setup` wizard. The owner-scoped app route assigns
  an eligible runner and creates a short-lived PTY session; the runner launches
  the pinned image with persistent `/opt/data` and `/workspace`, private
  networking, no published port or Docker socket, one-time WebSocket-subprotocol
  authorization, stopped-workload/single-session gating, and no terminal-output
  persistence. The launch contract now carries only AgentBay metadata and its
  generated private API-server key, while projection preserves Hermes-owned
  `config.yaml`, `.env`, `auth.json`, subscription, provider, model, and messaging
  state. A local PTY reached the official Quick Setup, Full Setup, and Blank
  Slate menu without a provider API key. Focused coverage passed 9 files / 40
  tests; format, lint, and typecheck passed; the full suite passed 210 suites /
  859 tests; the production build passed; and credential-free desktop/mobile
  Playwright passed 14 tests.

### Current Blockers and Next Work

- Step 10 is externally blocked until the user authorizes billable DigitalOcean
  work on only the basic `$4` `s-1vcpu-512mb-10gb` Droplet tier and supplies or
  approves Telegram smoke access. The user must also complete their own
  subscription OAuth interactively inside native Hermes setup; AgentBay does not
  request or receive a provider API key.
- Step 10 also needs the scanned/published GHCR image digest from the
  `publish-agent-image` workflow before live rollout evidence can be closed.

## Automatic Ready Hermes + Telegram Creation

Source plan: `PLAN.md`

This execution ledger tracks the automatic-ready Hermes deployment plan. It
preserves the prior Milestone 16, Clerk, and native Hermes setup ledgers above.
The new plan supersedes the earlier native-only Milestone 18 product decision
only for the opt-in automatic-ready path.

### Source Documents

- `/Users/alexmetelli/.codex/attachments/35e0153c-dd3a-4cae-9e45-6382c1ef17af/pasted-text.txt`
  is the primary implementation brief for automatic Hermes gateway creation,
  verified model readiness, and connected Telegram.
- `docs/MILESTONES.md` supplies the Milestone 18 acceptance constraints for a
  narrow Hermes plus Telegram path with safe secret handling and live reply
  evidence.
- `docs/PRD.md` supplies the product constraint that a user should get a working
  Telegram-connected agent without founder help.
- The existing Milestone 18 ledger above records the native `hermes setup` path
  that remains available as advanced and recovery flow.

### Assumptions and Conflicts

- The automatic-ready path collects or references OpenRouter BYOK credentials
  and a Telegram bot token before creation, which supersedes the prior
  native-OAuth-only decision only for this new opt-in path.
- OpenRouter is the first supported provider for automatic readiness. If
  subscription-only OAuth remains mandatory, implementation must stop before
  Step 4 for a separate approved design.
- Each automatically running agent requires a unique Telegram bot token and at
  least one numeric allowed-user ID.
- Live acceptance requires an approved scanned/published workload image,
  authorized DigitalOcean test budget, dedicated staging Telegram bot/user, and
  valid funded OpenRouter key. Missing capabilities are blockers, not success.
- The plan must not provision billable infrastructure, mutate hosted secrets,
  publish images, or contact a real Telegram user until the relevant step and
  explicit authorization prerequisites are satisfied.

### Changelog Policy

`CHANGELOG.md` retains the required Keep a Changelog structure: `# Changelog`,
the standard preamble, and top-level `## [Unreleased]`. Step 0 deliberately
adds no changelog entry because it changes tracking only. Later steps update
`CHANGELOG.md` only when they ship validated functional product behavior, using
the existing `Added`, `Changed`, `Fixed`, or `Security` sections as applicable.

### Current Status

Step 9 is independently accepted after checker cycle 1 at `b41e969`. The
default-disabled Step 10 repository executor is now implemented: a dedicated
staging owner and 90-second leased ledger fence one 45-second effect per
invocation; exact GHCR source/workflow/amd64 and runner-host evidence gates
progress; two explicit interactive-human Telegram reply attestations surround
Restart; and Stop, rollback, redaction, plus workload → secret → firewall →
Droplet → runner cleanup are durably observed. Disabling the acceptance flag
prevents forward work while cron continues compensation.

Migration clean/upgrade/idempotency and no-drift gates, 67 focused staging
tests, 148 files / 1,424 full tests, production build, 26/26 desktop/mobile CI
E2E, fake-cloud recovery, local pinned-image restart/Stop, and credential-free
15-capability fail-closed staging are green. An independent checker found no
repository blocker and reproduced the static/build, 106 focused, full-unit,
fail-closed, semantic, redaction, and diff gates; the isolated browser rerun
cleared its only shared-database coverage gap. Step 10 remains incomplete until
authorized image publication and provider-safe E2E/image smoke, the real hosted
Telegram acceptance, final cleanup evidence, controlled flag enablement, and
the exact final commit pass.

### Step Checklist

- [x] Step 0: Progress and Changelog Tracking Setup
- [x] Step 1: Quality Gates Setup and Baseline Evidence
- [x] Step 2: Align Readiness With the Pinned Hermes Contract
- [x] Step 3: Persist Desired State and Deployment Operations
- [x] Step 4: Add Managed Creation Configuration and Encrypted Credentials
- [x] Step 5: Project a Complete Managed Hermes Configuration
- [x] Step 6: Split Runner Launch Acceptance From Observed Readiness
- [x] Step 7: Reconcile Creation Through Ready
- [x] Step 8: Add One-Click Creation and Persisted Progress UI
- [x] Step 9: Make Desired-Running Gateways Durable
- [ ] Step 10: Final Acceptance, Documentation, and Controlled Rollout

### Step Ledger

| Step | State | Depends on | Commit | Validation or deployment evidence | Blocker and next work |
| --- | --- | --- | --- | --- | --- |
| 0. Progress and Changelog Tracking Setup | Complete | None | This commit | `bun run format:check` passed after formatting the new progress guard; `bun run lint` passed; `bun run typecheck` passed; `bun run test` passed 98 files / 863 tests; `bun run build` passed; `bun run test:e2e:ci` passed 14 tests; `git diff --check` passed; changelog structure verified without a tracking-only entry. | Complete; Step 1 is next. |
| 1. Quality Gates Setup and Baseline Evidence | Complete | Step 0 | This commit | Pre-edit baseline at `807e401`: `bun run verify` passed (`format:check`, `lint`, `typecheck`, 98 test files / 863 tests, and production build) and `bun run test:e2e:ci` passed 14 browser tests. Added `verify:hermes:staging`, a pure fail-closed preflight, placeholder-only docs/env entries, and 7 focused staging-gate tests. Final gates passed: `bun run format:check`; `bun run lint`; `bun run typecheck`; `bun run test` passed 99 files / 870 tests; `bun run build`; `bun run test:e2e:ci` passed 14 tests; `bun run verify:hermes:staging` exited nonzero with `capability_unavailable` and `sideEffectsAttempted: false`; `git diff --check`; `CHANGELOG.md` unchanged. | Complete; Step 2 is next. |
| 2. Align Readiness With the Pinned Hermes Contract | Complete | Steps 0-1 | This commit | Focused Step 2 tests passed 6 files / 43 tests across runner-service, Docker adapter, lifecycle readiness, manual-runner adapter, projection, and local-smoke guards. `bun run agent:hermes:contract-smoke` passed against local pinned-image behavior with `telegramBoundary: "local-smoke-disabled"`, private API auth, no public Hermes port, production waiter reuse, fake model response, state persistence, backup/restore, log-source evidence, and cleanup. Full gates passed: `bun run format:check`; `bun run lint`; `bun run typecheck`; `bun run test` passed 99 files / 879 tests; `bun run build`; `bun run test:e2e:ci` passed 14 tests; `git diff --check`. | Complete; Step 3 is next. |
| 3. Persist Desired State and Deployment Operations | Complete | Steps 0-2 | This commit | Generated `drizzle/0016_motionless_fantastic_four.sql` plus snapshot/journal with `agent_desired_status`, `agents.desired_status DEFAULT 'stopped'`, `agent_deployment_stage`, owner-bound `agent_deployments`, composite owner FK, idempotency/active/owner/claim indexes, and check constraints; reordered generated SQL only so the referenced agent-owner unique key exists before the FK while leaving generated metadata untouched. Focused Step 3 tests passed 7 files / 72 tests across schema/migration source assertions, state/DTO invariants, real separate-connection idempotency/active-operation/lease/expiry/release/renewal/CAS concurrency, owner-concealed route behavior, request-user boundaries, two-user route isolation, and clean/upgrade disposable loopback migration fixtures through `0015_dear_leader`. Migration gates passed: `bun run db:generate` reported no drift after generation; `bun run db:migrate` passed and reran idempotently on local loopback Postgres. Full gates passed: `bun run format:check`; `bun run lint`; `bun run typecheck`; `bun run test` passed 103 files / 905 tests; `bun run build`; `bun run test:e2e:ci` passed 14 tests; `git diff --check`. | Complete; Step 4 is next. |
| 4. Add Managed Creation Configuration and Encrypted Credentials | Complete | Steps 0-3 | This commit | Generated `drizzle/0017_ambitious_tyrannus.sql` plus snapshot/journal with three nullable Telegram secret metadata columns, metadata checks, and two active-Telegram partial unique indexes. Clean disposable loopback migration passed; upgrade `bun run db:migrate` passed and reran idempotently; `bun run db:generate` reported no schema drift. Focused Step 4 tests passed 8 files / 78 tests across model catalog, Telegram client, create validation/route, ready-create DB transaction/replay/rollback/runner-precheck, secret uniqueness/backfill, schema, and flag parsing. Full gates passed: `bun run format:check`; `bun run lint`; `bun run typecheck`; `bun run test` passed 106 files / 927 tests; `bun run build`; `bun run test:e2e:ci` passed 14 tests; credential-free `bun run verify:hermes:staging` exited nonzero with `capability_unavailable` and `sideEffectsAttempted: false`; `git diff --check`. | Complete; Step 5 is next. |
| 5. Project a Complete Managed Hermes Configuration | Complete and independently accepted after cycle 3 | Steps 0-4 | `fe13ab9`, `d50cc4e`, `4f8312d` | Added exact launch-spec v3 parsing/redaction/serialization with strict key and secret validation; owner-scoped newest-deployment launch building with required active OpenRouter, Telegram, allowlist, and API-server secrets; strict YAML 1.2 managed projection with no-follow/path-escape defenses, marker-last atomic writes, `0600` env handling, v2/manual compatibility, fresh managed setup bypass, and local fake Telegram/model contract smoke coverage. Cycle 2 rejects explicit/custom YAML tags and anchors, secret-like null/map/array/boolean/number values, non-exact env references such as shell defaults, malformed multiline env constructs, all four hard-linked/nonregular projected targets, broken active secret metadata, restored-agent auto-managed conversion, and Docker inspect Telegram allowlist leaks without false positives from unrelated `=1` env. Cycle 3 preserves safe YAML scalar punctuation while rejecting real YAML tags, anchors, aliases, and merge keys; the injected filesystem transaction seam covers temp collision/symlink handling, UID/GID ownership calls, write/chmod/chown/fsync/rename failures, marker-last repair, temp cleanup, exact modes, no workspace deletion, and nonregular FIFO/socket projected targets. Independent acceptance passed 17 files / 102 focused tests; `bun run agent:hermes:contract-smoke` passed with local fake model, private API auth, state persistence, backup/restore, no public Hermes port, cleanup, and `telegramBoundary: "local-fake-platform-state"`. Full gates passed: `bun run format:check`; `bun run lint`; `bun run typecheck`; `bun run test` passed 107 files / 961 tests; `bun run build`; `bun run test:e2e:ci` passed 14 tests; credential-free `bun run verify:hermes:staging` exited nonzero with `capability_unavailable` and `sideEffectsAttempted: false`; `git diff --check`. | Complete; Step 6 is active. |
| 6. Split Runner Launch Acceptance From Observed Readiness | Complete and independently accepted after cycle 2 | Steps 0-5 | `4e2897a`, `fa677fb` | Product commit added strict runner launch/status/canary contracts; one request-scoped 30-second launch budget; cancellation-safe cleanup; deterministic exact reuse/replacement; bounded private health/canary seams; stopped/cancelled snapshots; accepted/ready compatibility DTOs; and stale-result lifecycle guards. Initial combined focused coverage passed 11 files / 216 tests. Checker cycle 1 reproduced a FIFO `.env` blocking open. Cycle 2 added pre/post file identity validation plus nonblocking no-follow reads and a bounded FIFO status/canary regression. Independent acceptance verified missing/FIFO/symlink/hardlink/oversize/malformed/regular credential files, 4 files / 77 focused tests, 108 files / 996 full tests, local fake-boundary smoke, build, 14 E2E tests, and fail-closed staging with no external effects. | Complete; Step 7 remains active. |
| 7. Reconcile Creation Through Ready | Complete and independently accepted after cycle 1 | Steps 0-6 | `798cbf3` | Added migration `0018_first_polaris` with runner-operation/canary evidence, exact provisioning keys, strong stage checks, and fail-closed one-open-usage uniqueness. Added a 90-second leased, 45-second abort-bounded one-item reconciler; owner-safe provisioning discovery/adoption; exact runner/canary correlation; deterministic backoff and attempt-64 failure; post-response create/heartbeat triggers; exact-secret cron; owner-concealed idempotent retry; stop/delete cancellation precedence; redacted failure logs and cleanup ownership; and atomic ready/running/usage/events. Focused Step 7 gates passed 22 files / 311 tests, including clean/upgrade migrations and real separate-connection claim/retry/cancellation/finalization/capacity races. Full tests passed 116 files / 1,065 tests. Independent checker cycle 1 passed a 21-file / 306-test changed-unit suite, the 116-file / 1,065-test full suite, repeated migrations, format, lint, typecheck, build, 14 CI E2E tests, both local smokes, and fail-closed staging with no external effects. `bun run local:cloud:smoke` passed and proved simultaneous create-kick/heartbeat/cron/manual triggers produce exactly one fake resource, container, canary, running transition, and open usage period. `bun run agent:hermes:contract-smoke` passed persisted controller finalization against the local pinned image with private API auth, no public Hermes port, backup/restore, cleanup, and `telegramBoundary: "local-fake-platform-state"`. | Complete; Step 8 is active. |
| 8. Add One-Click Creation and Persisted Progress UI | Complete and independently accepted after cycle 2 | Steps 0-7 | `ef9b7fc`, `bc38dd0` | Added credential-complete ready/manual creation, server-owned rollout/model boundaries, synchronous duplicate-submit latches, safe ambiguous retry semantics, owner-scoped bounded latest-deployment reads, code-only public errors, exact persisted-stage presentation, detail-only single-flight polling, deployment-aware lifecycle controls, and secondary advanced Hermes recovery. Focused coverage passed 34 create/poll/presentation tests, 31 lifecycle/route tests, 107 server/UI isolation and projection tests, and 22 responsive/accessibility CSS tests. Checker cycle 1 reproduced all automated gates and found one same-turn progress-card Retry race; cycle 2 accepted the pre-UUID/pre-fetch synchronous latch and duplicate-activation regression with 4 focused files / 66 tests, format, lint, typecheck, 123 test files / 1,144 tests, production build, and 24/24 desktop/mobile CI E2E. Credential-free staging exited with `capability_unavailable` and `sideEffectsAttempted: false`; provider-backed `verify:e2e` was not run without an authorized provider-safe environment. | Complete; Step 9 is active. |
| 9. Make Desired-Running Gateways Durable | Complete and independently accepted after cycle 1 | Steps 0-8 | `b41e969` | Added generated migration `0019_tough_tinkerer` and a separate leased runtime ledger; exact managed-v3 `unless-stopped` runner evidence; bounded one-effect recovery, restart backoff, circuit, Telegram diagnostic, usage, and event handling; DB-first Start/Restart/Stop/Delete intent; post-commit runtime triggers; and passive owner-scoped runtime UI/API projection. Coordinator gates passed clean and upgrade migrations, no drift, 8 files / 38 focused DB tests, 11 files / 177 focused controller/runner/UI tests, 137 files / 1,297 full tests, production build, 26 desktop/mobile CI E2E tests, fake-cloud recovery/circuit smoke, pinned-image restart/Stop smoke, and fail-closed staging. The read-only checker independently passed clean/idempotent migration and no-drift gates; 8 files / 162 focused DB tests; 17 files / 209 focused runtime, runner, UI, and Telegram tests; 137 files / 1,297 full tests; format, lint, typecheck, build, 26/26 CI E2E, both local smokes, diff and manual secret review, and credential-free staging with `capability_unavailable` and `sideEffectsAttempted: false`. No external request or image pull occurred, and smoke resources were cleaned up. | Complete; Step 10 is next and remains authorization- and capability-blocked for live/provider work. |
| 10. Final Acceptance, Documentation, and Controlled Rollout | Default-disabled repository implementation independently accepted; live acceptance pending | Steps 0-9, published image, authorized DigitalOcean budget, staging Telegram bot/user, funded OpenRouter key | `abe1208` (preparatory docs), `This commit` (durable executor) | Added migration `0020_serious_sauron`, a dedicated staging owner, immutable provenance/evidence ledger, SKIP LOCKED leases and generation/attempt CAS, production effects, exact runner image identity, GHCR/GitHub publication attestation, exact DigitalOcean owned-set/firewall cleanup, cleanup-only disabled cron, dedicated bearer routes, 15-capability preflight, and an interactive-human-attested CLI with cleanup on failure/interruption. Clean/upgrade/idempotent migration and no drift passed; focused coordinator staging passed 9 files / 67 tests; full tests passed 148 files / 1,424 tests plus build; CI E2E passed 26/26; fake-cloud and local Hermes restart/Stop smokes passed; credential-free staging failed closed with all 15 capabilities missing and `sideEffectsAttempted: false`. The independent checker found no semantic or secret blocker and passed 9 files / 106 focused tests, full units, format/lint/typecheck/build/diff, fail-closed staging, and accepted the isolated 26/26 browser rerun. No live/provider action occurred and no live success is claimed. | Explicit authorization and all capabilities are required for published-image/provider-safe gates, the real hosted two-reply acceptance, cleanup proof, controlled flag enablement, and final Step 10 commit. |

### Evidence Fields

- Step validation commands and results.
- Focused test or smoke names and result summaries.
- Migration commands and database fixture notes for schema steps.
- Commit reference or `This commit` for the just-completed step.
- Safe blocker codes, missing capabilities, and next action.
- Live acceptance artifacts with only safe fingerprints and no raw credentials,
  provider responses, Telegram tokens, user identifiers, private endpoints,
  Droplet IPs, or secret-bearing diagnostics.

### Current Blockers and Next Work

- Step 9 is independently accepted at `b41e969`; the default-disabled Step 10
  repository implementation is independently green and ready to commit.
- Step 10 live completion requires an approved published image, explicitly authorized
  DigitalOcean budget, a dedicated staging Telegram bot/user, and a funded direct
  OpenAI or Anthropic API key selected through the ChatGPT/Claude staging profile.
  No live or provider-backed action is authorized yet.
- The implemented proof is explicitly interactive-human-attested. It does not
  automate or retain an MTProto user session. Exact image attestation and
  workload/secret/firewall/Droplet/runner cleanup are durable and fail closed;
  they still require an authorized hosted run to produce acceptance evidence.

## ChatGPT and Claude Provider Correction

Source plan: `PLAN.md`

This ledger supersedes the unreleased OpenRouter-first product direction above
without rewriting its historical implementation evidence. OpenRouter remains a
legacy compatibility concern only; new-agent onboarding supports direct OpenAI
and direct Anthropic under the user-facing choices ChatGPT and Claude.

### Product and Authorization Decisions

- The common flow asks users to choose ChatGPT or Claude. It never asks for a
  provider ID, model ID, runner, launch mode, environment variable, or Hermes
  configuration.
- The first release uses official direct API keys. ChatGPT uses an OpenAI
  Platform API key and Claude uses an Anthropic API key; both are billed
  separately from consumer subscriptions.
- Claude.ai subscription OAuth is excluded from this third-party product based
  on Anthropic's published authentication policy. Unsupported cookies,
  passwords, browser sessions, and subscription artifacts are never accepted.
- Owner-scoped healthy model connections are reused for later agents. Future
  official OAuth/device methods may be added behind the same connection state
  contract without changing ordinary callers.
- The app automates provider/model selection, capacity, configuration,
  deployment, canary, Telegram connection verification, retries, and recovery.
  BotFather bot creation and initial provider-key creation remain unavoidable
  user actions.
- Existing OpenRouter agents are never silently converted and remain available
  only through an explicit legacy runtime compatibility branch.
- No live provider, billable infrastructure, image publication, or Telegram
  effect is authorized by this correction.

### Correction Checklist

- [x] Step 1: Correct the Product Contract
- [x] Step 2: Add Direct ChatGPT and Claude Runtime Support
- [x] Step 3: Ship the One-Click Common Flow
- [x] Step 4: Correct Acceptance, Documentation, and Release Evidence

### Correction Ledger

| Step | State | Commit | Evidence | Next work |
| --- | --- | --- | --- | --- |
| 1. Correct the Product Contract | Complete | This commit | Replaced the active OpenRouter-first plan with a ChatGPT/Claude model-connection contract; documented direct API-key billing, Anthropic's third-party subscription-auth restriction, the one-click automation boundary, legacy compatibility, strict quality gates, and per-step commits. Historical ledgers remain intact and `CHANGELOG.md` receives no planning-only entry. | Implement the provider-neutral catalog, reusable connections, encrypted credentials, strict launch/projection support, and legacy compatibility in Step 2. |
| 2. Add Direct ChatGPT and Claude Runtime Support | Complete | This commit | Added server-owned ChatGPT/OpenAI and Claude/Anthropic profiles, provider-specific encrypted secret kinds, strict direct managed launch parsing/redaction/canonicalization, exact `openai-api`/`anthropic` Hermes config and environment projection, direct lifecycle/deployment/launch-builder eligibility, and legacy-only OpenRouter compatibility. Generated migration `0021_careful_praxagora`; clean migration and idempotent rerun passed in isolated `plingpling_provider_step2`, and the fixture database was removed. Format, lint, typecheck, diff hygiene, 10 focused files / 140 tests, fake-cloud smoke, and the 82-second pinned local Hermes contract smoke passed without external provider or Telegram effects. | Replace the wide OpenRouter create UI with the reusable nontechnical ChatGPT/Claude common flow in Step 3. |
| 3. Ship the One-Click Common Flow | Complete | This commit | Replaced the OpenRouter/model/template/runner/mode form with two recognizable ChatGPT and Claude choices, first-connection-only direct API-key entry, plain-language Telegram inputs, fixed safe server-owned defaults, and one “Create my agent” action. Added owner-scoped encrypted connection discovery/reuse without returning credential material, cross-owner rejection, responsive assistant cards, and nontechnical setup copy. Format, lint, typecheck, 5 controller tests, and 13 real-database ready-create tests passed; the database suite includes encrypted credential copying, safe connection views, and tenant isolation. | Correct staging contracts, remaining regression fixtures, docs, release notes, and full gates in Step 4. |
| 4. Correct Acceptance, Documentation, and Release Evidence | Complete | This commit | Replaced active staging with a 16-capability ChatGPT-or-Claude contract that requires exactly one matching direct OpenAI/Anthropic key, rejects the unselected key, and keeps live effects authorization-gated. Updated the fake-cloud and pinned-image smokes to direct `openai-api`; both passed, with the pinned Hermes image completing its OpenAI Responses API turn on `gpt-5.4` in 82 seconds. Updated desktop/mobile browser fixtures, product/operator docs, env examples, milestones, and changelog; active onboarding and staging docs contain no OpenRouter instruction. `bun run db:generate` reported no drift. `bun run verify` passed format, lint, typecheck, 149 files / 1,438 tests, and production build. `bun run test:e2e:ci` passed 26/26 after a clean rerun; an intervening rerun encountered and then cleared a stale local dev-server/advisory-lock condition. Credential-free staging failed closed with all 16 capabilities missing and `sideEffectsAttempted: false`. No live provider, Telegram, billable infrastructure, or publication effect occurred. | Product correction complete; live hosted acceptance remains separately gated on explicit authorization and credentials. |

## Runner Resilience and Automatic Replacement

Source plan: `PLAN.md`

Primary brief: `docs/RUNNER_RESILIENCE.md`

### Definition of Done Summary

Managed DigitalOcean runners must prove an immutable image digest and a
versioned, capability-backed boot contract before assignment. A durable,
leased replacement workflow must provision and validate replacement capacity,
fence the source, preserve agent ownership and desired state during handover,
converge workloads, and delete only exactly owned obsolete resources.
Infrastructure reconciliation must repair missing, interrupted, stale, and
provably orphaned resources. Gateway startup must have a strict 30-second
deadline and a two-replacements-per-deployment daily budget. The common UI must
show only Preparing, Connecting Telegram, Ready, or a terminal recovery
failure. Production rollout must publish and verify an immutable runner image,
pass a disposable-Droplet canary, pin the control plane to that exact digest,
and replace the fleet in bounded batches.

### Execution Rules

- Complete Steps 0-12 in dependency order and make one focused commit after
  each completed step.
- Update this ledger with exact validation evidence, safe blockers, current
  status, and the next step before each step commit.
- Update `CHANGELOG.md` only for functional behavior under a non-empty Added,
  Changed, Fixed, or Security heading. Do not add entries for plans, progress,
  tests, validation-only work, CI-only work, or documentation-only changes.
- Keep external/provider-backed gates authorization- and credential-aware. A
  blocked live gate is recorded precisely and is never reported as passed.
- Preserve historical progress sections and existing changelog history.

### Step Checklist

- [x] Step 0: Progress and Changelog Tracking Setup
- [x] Step 1: Baseline Gates and Failure Characterization
- [x] Step 2: Report Immutable Runner Release Identity
- [x] Step 3: Persist Compatibility and Fail Closed During Assignment
- [x] Step 4: Enforce a Real Boot-Readiness Contract
- [x] Step 5: Persist a Durable Runner Replacement Workflow
- [x] Step 6: Provision and Validate Replacement Runners
- [x] Step 7: Hand Over Agents and Clean Up the Source Runner
- [x] Step 8: Reconcile DigitalOcean and Database Ownership
- [x] Step 9: Replace Runners After Strict Deployment Deadlines
- [x] Step 10: Present One Automatic Recovery Experience
- [ ] Step 11: Release Through an Immutable Disposable-Droplet Canary
- [ ] Step 12: Migration, Rollout, and Final Acceptance

### Current Status

Step 11's repository implementation is complete across `b471e77` and this
follow-up commit, but Step 11 is not accepted because its required live release
has not run. Test processes cannot construct a live DigitalOcean client. Release runs are
serialized, require an exact typed billable authorization before creating their
single disposable canary, and always request exact cleanup. Git-triggered Vercel
production builds are skipped unless the canary-verified release or rollback job
supplies its build marker. Production rollout is limited to one runner per
invocation and can be halted at zero. Live publication, reviewed canary, deploy,
and post-deploy checks remain required before Step 12.

### Step Ledger

| Step | State | Commit | Validation or acceptance evidence | Next work or blocker |
| --- | --- | --- | --- | --- |
| 0. Progress and Changelog Tracking Setup | Complete | `e892330` | Restored all 574 historical lines from `9f45d89^:PROGRESS.md`; appended the complete Step 0-12 tracker; verified the Keep a Changelog header, preamble, and Unreleased section; 1 focused file / 3 progress tests passed; format and lint checked 356 files; typecheck, 149 files / 1,449 tests, production build, and diff hygiene passed. No changelog entry was added for this tracking-only step. | Complete; Step 1 is next. |
| 1. Baseline Gates and Failure Characterization | Complete | `ae39387` | Frozen install made no changes; clean isolated PostgreSQL migration passed; pre-change `bun run verify` passed 149 files / 1,449 tests and production build; pre-change E2E passed 26/26. Added legacy authenticated heartbeat allowlisting, provider verification after selection, secret-safe in-container probing, exact selected-agent cleanup, operation-tag replay idempotency, and single-shot timeout cleanup coverage. Five focused files / 126 tests passed. Post-change format, lint, typecheck, 149 files / 1,452 tests, production build, 26/26 E2E, and diff hygiene passed. No changelog entry was added for test-only work. | Complete; Step 2 is next. |
| 2. Report Immutable Runner Release Identity | Complete | `71fc024` | Added the bounded `plingpling.runner.boot.v1` release contract, strict immutable image/reference parsing, Docker container/image inspection through argv-only bounded calls, OCI version/revision reading, canonical unique repository-digest derivation, expected-versus-observed comparison, and an explicit image-ID development seam. Bootstrap and service heartbeats report the observed release; malformed release fields fail validation and legacy payloads remain parseable with explicit missing evidence. Cloud bootstrap injects expected identity only for immutable references. Runner images now carry OCI labels and the publication workflow emits linux/amd64 Git-SHA and transition `main` tags with SBOM, max provenance, digest verification, and digest/image outputs. Eight focused files / 122 tests and the full 150-file / 1,462-test suite passed. The built runner container inspected itself through the mounted Docker socket and returned only `development`, its canonical local image digest, `plingpling.runner.boot.v1`, and `expectedMatch: null`. Runner Docker build, 83-second Hermes contract smoke, format, lint, typecheck, production build, and diff hygiene passed. | Complete; Step 3 is next. |
| 3. Persist Compatibility and Fail Closed During Assignment | Complete | `813c8cb` | Added six backward-safe runner compatibility fields, canonical release constraints, assignment indexes, and additive migration `0022_unknown_ma_gnuci`. Authenticated heartbeats now persist normalized observed identity and a server-owned `compatible`, `unknown`, `outdated`, or `invalid` decision in one transaction. Hosted provider configuration rejects mutable runner tags; provisioning records the required digest; placement, explicit assignment, create/start/lifecycle/deployment selection, and pre/post live verification use one exact-release predicate. Legacy managed rows stay unknown and unassignable, concurrent verification cannot bypass a downgrade, and incompatible manual rows are excluded without deletion. Nine focused files / 262 tests and the full 151-file / 1,472-test suite passed. Clean migration, upgraded migration fixture, schema drift check, format, lint, typecheck, production build, database health, and local cloud reconciler smoke passed. | Complete; Step 4 is next. |
| 4. Enforce a Real Boot-Readiness Contract | Complete | `cc27fa2` | Added the exact `plingpling.runner.boot-snapshot.v1` persisted snapshot with deterministic testing/ready/failed timestamps and six closed component states. Runner boot now performs bounded Docker/self-image verification, creates a UUID-scoped private network and pinned Hermes fixture with a local fake model, loads real-shaped synthetic Telegram configuration without traffic, probes container-local detailed health, runs a fixed no-tools canary, and cleans up exact labeled resources on success, failure, timeout, and restart. The authenticated no-store route returns 200 only for exact ready evidence; app parsing rejects legacy, malformed, incomplete, incompatible, or non-ready evidence before assignment. Eight focused files / 123 tests and the full 152-file / 1,480-test suite passed. Format, lint, typecheck, production build, runner Docker build, a production-path all-six-component ready smoke with zero remaining labeled fixtures, local-cloud smoke, and the 82,866 ms pinned Hermes contract smoke passed. | Complete; Step 5 is next. |
| 5. Persist a Durable Runner Replacement Workflow | Complete | `44c5e92` | Added additive migration `0023_stiff_masque` with the exact nine replacement states, six trigger reasons, closed terminal codes, source/target/deployment relationships, unique active source and deployment guards, operation idempotency, due-work indexes, generation/lease fields, and a deployment budget ledger. Pure transitions reject skips, missing or cross-source targets, stale generations, terminal replay, and unsafe retry dates. Store claims use `FOR UPDATE SKIP LOCKED`, exact-expiry takeover, and lease/generation/source/target CAS fences; concurrent cron/heartbeat/deployment/user-shaped operation keys converge on one active workflow. Billable reservations are transactionally separate from claims and capped at two per deployment/24 hours under concurrency. Four focused files / 52 tests and the full 155-file / 1,498-test suite passed. Clean and pre-0023 upgrade migrations passed twice with existing evidence unchanged; schema drift, format, lint, typecheck, production build, and diff hygiene passed. No external/provider effect or operator surface was added, so the Step 5 changelog entry is deferred per the plan. | Complete; Step 6 is next. |
| 6. Provision and Validate Replacement Runners | Complete | `b235136` | Added a leased one-slice reconciler that creates and associates one managed target, derives its provisioning operation key from the durable replacement key, pins the configured immutable digest and boot contract, reserves the billable deployment budget before create, and reuses authoritative DigitalOcean discovery/create/tag/firewall/bootstrap. Validation requires exact release compatibility, capability-backed boot readiness, a fresh online heartbeat, and capacity for every source assignment before advancing to fencing. Failed targets use exact operation-tag discovery and the owned-set firewall-before-Droplet cleanup protocol, then atomically revoke target access, tombstone the target, and persist closed terminal evidence while leaving the source untouched. Ten focused real-database/fake-provider tests cover successful create, rediscovery, duplicate ambiguity, known create failure, release and boot incompatibility, capacity, budget exhaustion, timeouts, cleanup, and concurrent claimers. Full format, lint, typecheck, 156-file / 1,508-test suite, production build, local cloud smoke, runner image build, and diff hygiene passed. | Complete; Step 7 is next. |
| 7. Hand Over Agents and Clean Up the Source Runner | Complete | `4265875` | Extended the leased reconciler through source fencing, reassignment, convergence, cleanup, and completion. The source becomes nonassignable before best-effort exact workload stops and credential/token revocation. Source/target advisory capacity locks, owner/heartbeat/release checks, and one transaction now preserve agent configuration, encrypted secrets, deployment history, and usage accounting while assigning all active agents to the target and creating deterministic fresh deployments only for desired-running agents. Convergence requires each moved running agent's newest deployment and runtime to be ready; stopped agents stay stopped and failed deployments use the existing retry path. Exact owned-set firewall-before-Droplet deletion is crash-resumable, ambiguity stays in durable cleanup without rollback, and completion atomically revokes old access, clears residual deleted-agent assignments, tombstones the source, and records bounded events. Six handover scenarios plus the Step 6 matrix and deployment/runtime suites passed. Full format, lint, typecheck, 157-file / 1,514-test suite, production build, local cloud smoke, 84,106 ms Hermes contract smoke, 26/26 E2E, and diff hygiene passed. | Complete; Step 8 is next. |
| 8. Reconcile DigitalOcean and Database Ownership | Complete | `166ac75` | Added additive leased reconciliation and orphan-evidence tables, authoritative stable-tag inventory with completeness/timestamp/firewall evidence, and a bounded one-result reconciler shared by a protected cron route and operator script. Exact matches remain unchanged; assigned missing or unhealthy runners start the durable replacement saga; unassigned missing rows are ownership-checked and tombstoned; stale deleted-runner assignments are cleared without changing desired state; exact interrupted operation-tag creates are adopted; duplicates and ambiguity never mutate or delete. Provably owned unassigned orphans require two authoritative observations separated by ten minutes before exact owned-set firewall-first cleanup, and active ownership outside the current database batch is rechecked before orphan handling. Focused provider, route, schema, migration, provisioning, reconciliation, orphan, race, and redaction coverage passed. Full format, lint, typecheck, 159-file / 1,533-test suite, production build, additive clean/upgrade/idempotent migrations, schema drift check, 440 ms local cloud smoke, 26/26 E2E, and diff hygiene passed. | Complete; Step 9 is next. |
| 9. Replace Runners After Strict Deployment Deadlines | Complete | `19a3e8a` | Replaced same-runner launch retries with a strict accepted-at plus 30-second gateway deadline. Before expiry the controller polls only the accepted operation; at expiry it creates or reuses one deployment-linked replacement, pauses the deployment, captures at most one bounded redacted log batch, and stops once. Repeated missing endpoint, stale heartbeat, failed boot, release mismatch, and missing provider resource evidence enter the same durable saga. Active replacement work blocks deployment claims until Step 7 handover assigns the validated target and creates a fresh correlated deployment. Model and Telegram failures remain agent-specific, stage transitions reset independent retry budgets, and two replacement workflows in 24 hours produce one safe terminal result. Protected per-minute reconciliation and a post-response targeted kick provide durable progress. Exact 29,999/30,000 ms, classification, budget, no-relaunch, trigger, cron redaction, handover resume, and duplicate behavior passed. Full format, lint, typecheck, 161-file / 1,548-test suite, production build, 444 ms local cloud smoke, 81,907 ms Hermes contract smoke, 26/26 E2E, and diff hygiene passed. | Complete; Step 10 is next. |
| 10. Present One Automatic Recovery Experience | Complete | `8830a1f` | Collapsed every pre-Telegram automatic deployment and live runner replacement into a safe Preparing your agent presentation, retained Connecting Telegram and Ready, and added a public replacement-capacity signal that strips private error evidence. Inventory, detail, root/dashboard summaries, live regions, and refresh/browser reopen preserve the same three-stage experience. Offline/degraded and assigned-runner alerts are suppressed during live replacement; technical runner, endpoint, release, and cost evidence remains closed in an advanced disclosure. Terminal recovery now uses one generic message with functional Retry and Stop actions, including persisted desired-stopped intent from error. Eleven focused presentation/projection/accessibility/lifecycle files passed 140 tests; terminal lifecycle coverage passed 148 focused tests. Full format/lint checked 379 files, typecheck passed, 161 files / 1,554 tests passed, production build passed, and 28/28 desktop/mobile E2E passed including refresh, reopen, 320px overflow, live-region, and private-identifier non-disclosure coverage. | Complete; Step 11 is next and external registry/provider effects require configured credentials and authorization. |
| 11. Release Through an Immutable Disposable-Droplet Canary | Repository implementation complete; live acceptance pending | `b471e77` + This commit | Replaced automatic mutable-main publication with a manually dispatched release/rollback workflow. One linux/amd64 Git-SHA build carries SBOM/max provenance, publishes only the SHA tag, emits and inspects the tag-plus-digest reference, and passes the same critical-fixable Trivy/SARIF gate as the Hermes image. Test processes cannot construct a live DigitalOcean client; provider tests must inject fakes and create zero Droplets. Release runs are serialized and require the exact typed billable authorization before their single disposable canary can run; the 12-minute smoke requires exact release heartbeat, compatible boot contract, all six synthetic boot actions, firewall-before-Droplet deletion, authoritative operation-tag absence, credential revocation, and runner tombstoning in a finally path. Git-linked production builds are skipped unless the release workflow supplies its canary marker. Vercel promotion depends on publish plus canary, pins the exact commit/digest, sets rollout batch 1, and verifies health plus an authenticated required-release route. Rollback must match a prior 90-day canary artifact and deploys batch 0. Follow-up release/provider/smoke coverage passed 3 files / 28 tests; full format/lint checked 384 files, typecheck passed, 164 files / 1,572 tests passed on a clean migrated temporary database, and the production build passed. | Blocked pending a reviewer-protected approval boundary (unsupported by the current GitHub plan), GHCR publication, explicit billable release authorization, a real immutable digest, one disposable release-canary cleanup proof, and successful Vercel post-deploy checks. Step 12 must not begin before those gates pass. |
| 12. Migration, Rollout, and Final Acceptance | Pending | Pending | Not started. | Waits for Steps 0-11. |

### Validation Ledger

| Step | Command or gate | Result |
| --- | --- | --- |
| 0 | `test -f PROGRESS.md && test -f CHANGELOG.md` | Passed; both files exist. |
| 0 | Changelog structure inspection | Passed; `# Changelog`, Keep a Changelog preamble, and `## [Unreleased]` retained. |
| 0 | `bun run test tests/unit/progress-status.test.ts` | Passed; 1 file / 3 tests. |
| 0 | `bun run format:check` | Passed; 356 files checked. |
| 0 | `bun run lint` | Passed; 356 files checked. |
| 0 | `bun run test` | Passed; 149 files / 1,449 tests. |
| 0 | `bun run typecheck` | Passed. |
| 0 | `bun run build` | Passed; Next.js production build completed. |
| 0 | `git diff --check` | Passed. |
| 1 | `bun install --frozen-lockfile` | Passed; 173 installs across 308 packages checked with no changes. |
| 1 | `bun run db:migrate` on isolated local PostgreSQL | Passed cleanly through migration 0021; the exact validation database was removed afterward. |
| 1 | Pre-change `bun run verify` | Passed; format, lint, typecheck, 149 files / 1,449 tests, and production build. |
| 1 | Pre-change `bun run test:e2e:ci` | Passed; 26/26 desktop and mobile tests. |
| 1 | Five focused characterization files | Passed; 126/126 tests. |
| 1 | Post-change `bun run format:check` | Passed; 356 files checked. |
| 1 | Post-change `bun run lint` | Passed; 356 files checked. |
| 1 | Post-change `bun run typecheck` | Passed. |
| 1 | Post-change `bun run test` | Passed; 149 files / 1,452 tests. |
| 1 | Post-change `bun run build` | Passed; Next.js production build completed. |
| 1 | Post-change `bun run test:e2e:ci` | Passed; 26/26 desktop and mobile tests. |
| 1 | `git diff --check` | Passed. |
| 2 | Eight focused release/bootstrap/heartbeat/image files | Passed; 122/122 tests. |
| 2 | `bun run format:check` | Passed; 358 files checked. |
| 2 | `bun run lint` | Passed; 358 files checked with no warnings. |
| 2 | `bun run typecheck` | Passed. |
| 2 | `bun run test` | Passed; 150 files / 1,462 tests. |
| 2 | `bun run build` | Passed; Next.js production build completed. |
| 2 | `docker build -f Dockerfile.runner -t plingpling-runner:resilience .` | Passed; local runner image built successfully. |
| 2 | Ephemeral built-runner self-inspection through mounted Docker socket | Passed; derived the local image digest and OCI `development` version with `plingpling.runner.boot.v1` and no expected identity. |
| 2 | `bun run agent:hermes:contract-smoke` | Passed in 83,252 ms with fake OpenAI-compatible model, private API auth, canary, restart/Stop persistence, backup/restore, exact cleanup, and `telegramBoundary: "local-fake-platform-state"`. |
| 2 | `git diff --check` | Passed. |
| 3 | `bun run db:generate` and migration review | Generated additive `0022_unknown_ma_gnuci`; a second generation reported no schema drift. The SQL contains only new nullable/defaulted columns, checks, and indexes, with no data inference, update, drop, or alter-column operation. |
| 3 | Clean isolated `bun run db:migrate` | Passed through migration 0022 on `plingpling_runner_resilience_step3`. |
| 3 | Upgraded migration fixture | Passed from the pre-compatibility schema through current migrations twice; legacy runners gained null evidence fields and `compatibility_state = 'unknown'` without ownership or lifecycle mutation. |
| 3 | Nine focused schema/env/policy/heartbeat/placement/provisioning/deployment/create files | Passed; 262/262 tests. |
| 3 | `bun run format:check` | Passed; 360 files checked. |
| 3 | `bun run lint` | Passed; 360 files checked with no warnings. |
| 3 | `bun run typecheck` | Passed. |
| 3 | `bun run test` | Passed; 151 files / 1,472 tests. |
| 3 | `bun run build` | Passed; Next.js production build completed. |
| 3 | Database health with the repository's `react-server` condition | Passed against the isolated Step 3 database. |
| 3 | Local cloud reconciler smoke | Passed in 402 ms through pending, provisioning, Hermes configuration, gateway start, model verification, Telegram connection, Ready, runtime recovery, Stop, and deterministic cleanup using exact persisted compatibility evidence. |
| 4 | Eight focused readiness/bootstrap/heartbeat/placement/provisioning/progress files | Passed; 123/123 tests. |
| 4 | `bun run format:check` and `bun run lint` | Passed; 363 files checked with no fixes or warnings. |
| 4 | `bun run typecheck` | Passed. |
| 4 | `bun run test` | Passed serially against the isolated migrated database; 152 files / 1,480 tests. |
| 4 | `bun run build` | Passed; Next.js production build completed. |
| 4 | `docker build -f Dockerfile.runner -t plingpling-runner:resilience .` | Passed; final runner image built successfully. |
| 4 | Ephemeral built-runner boot-readiness smoke through the mounted Docker socket | Passed with exact `ready` status and all six components passed; no labeled fixture container or network remained. |
| 4 | `bun run local:cloud:smoke` | Passed in 435 ms against the isolated migrated database through Ready, runtime fault recovery, Stop, and deterministic cleanup. |
| 4 | `bun run agent:hermes:contract-smoke` | Passed in 82,866 ms with fake model, private API auth, canary, restart/Stop persistence, backup/restore, and cleanup without external Telegram traffic. |
| 5 | `bun run db:generate` and migration review | Generated additive `0023_stiff_masque`; a second generation reported no schema drift. SQL adds only enums, tables, foreign keys, checks, and indexes, with no update, drop, or alter-column operation. |
| 5 | Clean and upgraded `bun run db:migrate` fixtures | Passed twice on a clean Step 5 database and from the exact pre-0023 schema; existing runner, agent, and deployment rows remained byte-for-byte equivalent and both new ledgers started empty. |
| 5 | Four focused schema/state/store/migration files | Passed; 52/52 tests, including concurrent duplicate creation, SKIP LOCKED claiming, exact lease expiry, stale CAS, resume after every state, concurrent budget reservations, terminal constraints, and safe DTOs. |
| 5 | `bun run format:check` and `bun run lint` | Passed; 368 files checked with no fixes or warnings. |
| 5 | `bun run typecheck` | Passed. |
| 5 | `bun run test` | Passed serially against the clean Step 5 database; 155 files / 1,498 tests. |
| 5 | `bun run build` | Passed; Next.js production build completed. |
| 5 | `git diff --check` | Passed. |
| 6 | Ten focused replacement reconciler tests | Passed against a disposable migrated PostgreSQL database with fake-provider create, rediscovery, duplicate ambiguity, failure cleanup, release/boot rejection, capacity, budget, timeout, and concurrency evidence. |
| 6 | `bun run format:check` and `bun run lint` | Passed; 370 files checked with no fixes or warnings. |
| 6 | `bun run typecheck` | Passed. |
| 6 | `bun run test` | Passed serially against the isolated migrated database; 156 files / 1,508 tests. |
| 6 | `bun run build` | Passed; Next.js production build completed. |
| 6 | `bun run local:cloud:smoke` | Passed in 398 ms through Ready, runtime fault recovery, Stop, and deterministic cleanup. |
| 6 | `docker build --no-cache -f Dockerfile.runner -t plingpling-runner:resilience .` | Passed after bypassing a stale Docker Desktop extraction snapshot; the clean image export and unpack completed. |
| 6 | `git diff --check` | Passed. |
| 7 | Six focused replacement handover tests | Passed against disposable migrated PostgreSQL with multi-agent/stopped intent, credential fencing, atomic reassignment, partial convergence, deterministic deployment retry, concurrent resume, owner isolation, usage closure, exact provider cleanup, cleanup ambiguity, and post-delete process-death recovery. |
| 7 | Four focused replacement/deployment/runtime files | Passed; 61/61 tests. |
| 7 | `bun run format:check` and `bun run lint` | Passed; 371 files checked with no fixes or warnings. |
| 7 | `bun run typecheck` | Passed. |
| 7 | `bun run test` | Passed serially against the isolated migrated database; 157 files / 1,514 tests. |
| 7 | `bun run build` | Passed; Next.js production build completed. |
| 7 | `bun run local:cloud:smoke` | Passed in 401 ms through Ready, runtime fault recovery, Stop, and deterministic cleanup. |
| 7 | `bun run agent:hermes:contract-smoke` | Passed in 84,106 ms with fake model, private API auth, canary, restart/Stop persistence, backup/restore, and exact cleanup. |
| 7 | `bun run test:e2e:ci` | Passed; 26/26 desktop and mobile tests. |
| 7 | `git diff --check` | Passed. |
| 8 | `bun run db:generate` and migration review | Generated additive `0024_absurd_chamber`; a second generation reported no schema drift. SQL adds only leased reconciliation/orphan-evidence tables, checks, and indexes with no update, drop, alter-column, or ownership inference. |
| 8 | Clean and upgraded migration fixtures plus `bun run db:migrate` | Passed clean and idempotent migration through 0024 and upgrade from the exact pre-0024 schema; existing runner, agent, and deployment rows remained unchanged and both infrastructure ledgers began empty. |
| 8 | Focused provider/route/schema/migration/provisioning/reconciler coverage | Passed 6 files / 82 tests, including complete stable inventory/firewall evidence, missing/unhealthy replacement, unassigned tombstoning, exact adoption, duplicate refusal, stale assignment repair, orphan grace/deletion, out-of-batch ownership protection, ambiguity, lease races, authorization, and redaction. |
| 8 | `bun run format:check` and `bun run lint` | Passed; 375 files checked with no fixes or warnings. |
| 8 | `bun run typecheck` | Passed. |
| 8 | `bun run test` | Passed serially against the isolated migrated database; 159 files / 1,533 tests. |
| 8 | `bun run build` | Passed; Next.js production build included the protected runner-infrastructure cron route. |
| 8 | `bun run local:cloud:smoke` | Passed in 440 ms through Ready, runtime fault recovery, Stop, and deterministic cleanup. |
| 8 | `bun run test:e2e:ci` | Passed; 26/26 desktop and mobile tests. |
| 8 | `git diff --check` | Passed. |
| 9 | Focused deployment/replacement/cron/trigger coverage | Passed 6 files / 71 tests, including exact 29,999/30,000 ms behavior, one diagnostic capture and stop, no same-runner relaunch, endpoint escalation, provider/boot/release/heartbeat classification, model/Telegram isolation, replacement-budget exhaustion, protected summaries, callback containment, duplicate creation, and successful handover resume. |
| 9 | `bun run format:check` and `bun run lint` | Passed; 379 files checked with no fixes or warnings. |
| 9 | `bun run typecheck` | Passed. |
| 9 | `bun run test` | Passed serially against the isolated migrated database; 161 files / 1,548 tests. |
| 9 | `bun run build` | Passed; Next.js production build included the protected runner-replacement cron route. |
| 9 | `bun run local:cloud:smoke` | Passed in 444 ms through Ready, runtime fault recovery, Stop, and deterministic cleanup with gateway polls inside the strict deadline. |
| 9 | `bun run agent:hermes:contract-smoke` | Passed in 81,907 ms with accepted/starting/ready evidence, fake model, private API auth, canary, restart/Stop persistence, backup/restore, and exact cleanup. |
| 9 | `bun run test:e2e:ci` | Passed; 26/26 desktop and mobile tests. |
| 9 | `git diff --check` | Passed. |
| 10 | Focused deployment presentation, controller, lifecycle, operational summary/page, root-page, advanced-disclosure, server projection, and cancellation coverage | Passed; 11 files / 140 tests, with the terminal Stop contract included in a broader 3-file / 148-test lifecycle run. |
| 10 | `bun run format:check` and `bun run lint` | Passed; 379 files checked with no fixes or warnings. |
| 10 | `bun run typecheck` | Passed. |
| 10 | `bun run test` | Passed serially against the isolated migrated database; 161 files / 1,554 tests. |
| 10 | `bun run build` | Passed; Next.js production build completed. |
| 10 | `bun run test:e2e:ci` | Passed; 28/28 desktop and mobile tests, including recovery refresh/reopen, inventory/detail/dashboard continuity, 320px overflow, live-region, and private-identifier non-disclosure checks. |
| 10 | Prohibited common-copy and diff inspection | Passed; common app/shared presentation contains no cloud-init, endpoint repair, Droplet deletion, database-record repair, or new-runner instructions; technical evidence remains in the closed advanced disclosure and server/operator records. `git diff --check` passed. |
| 11 | Workflow YAML parse and five focused smoke/workflow/required-release/rollout/env files | Passed; 36/36 tests. SHA-only build, digest verification, Trivy/SARIF, publish-canary-deploy dependencies, artifact-backed rollback, exact cleanup ordering, no-side-effect preflight, authenticated release projection, and 0/1 rollout contracts were asserted. |
| 11 | `bun install --frozen-lockfile` | Passed; 173 installs across 308 packages checked with no changes. |
| 11 | `bun run format:check` and `bun run lint` | Passed; 384 files checked with no fixes or warnings. |
| 11 | `bun run typecheck` | Passed. |
| 11 | `bun run test` | Passed serially against the isolated migrated database; 164 files / 1,570 tests. |
| 11 | `bun run build` | Passed; production build includes `/api/internal/runner-release/required`. |
| 11 | `docker build -f Dockerfile.runner -t plingpling-runner:resilience .` | Initial cached build failed during Docker Desktop extraction of `@next/swc-linux-arm64-musl`; the clean `--no-cache` build then passed and exported/unpacked `plingpling-runner:resilience`. |
| 11 | Credential-free `runner:release:smoke` preflight | Failed closed as designed with `capability_unavailable`, four missing capability names, `sideEffectsAttempted: false`, and no secret values. |
| 11 | Follow-up provider, workflow, and smoke contracts | Passed 3 files / 28 tests. Test processes cannot construct the real DigitalOcean network client, release runs are serialized, a typed exact authorization is required before the one-Droplet release canary, Git-linked production builds fail closed, previews remain enabled, and only verified release/rollback commands carry the Vercel marker. |
| 11 | Follow-up clean migration, full suite, and build | Passed all migrations through 0024 on an isolated temporary local database, 164 files / 1,572 tests, format/lint across 384 files, typecheck, production build, and diff hygiene. The temporary database was removed; no provider or cloud effect occurred. |
| 11 | Live GHCR publish, Trivy scan of published digest, disposable DigitalOcean release canary, Vercel production deploy, `/health`, and required-release verification | Not run. Environment values are configured, but required reviewer protection is unsupported by the current GitHub plan and no explicit billable release authorization was given; no live acceptance is claimed. |

### Step 1 Gap Matrix

| Required capability | Baseline evidence | Status entering Step 2 |
| --- | --- | --- |
| Exact immutable runner identity | Authenticated heartbeat parsing allowlists legacy version and metrics but ignores an untrusted release object; no observed image digest or boot-contract identity is derived or persisted. | Not implemented; Step 2. |
| Capability-backed boot readiness | Authenticated `/runner/v1/readiness` reads an atomically persisted exact contract only after bounded Docker/self-image, isolated pinned Hermes fixture, private detailed health, fixed model canary, synthetic no-traffic Telegram configuration, and exact cleanup checks. App parsing requires all six passed components before managed assignment. | Complete; Step 4. |
| Automatic replacement | The durable saga provisions and immutably validates replacement capacity, fences source authority, atomically moves agents, preserves stopped intent, converges fresh deployments/runtimes, and retires only the exact obsolete owned set. Authoritative inventory and strict deployment deadlines now trigger that saga through protected durable reconcilers. | Complete through Step 9. |
| Infrastructure inventory reconciliation | A protected per-minute cron now leases one bounded authoritative stable-tag inventory comparison, adopts exact interrupted creates, starts replacement for assigned missing/unhealthy runners, clears stale assignments, tombstones exact unassigned missing rows, refuses duplicates/ambiguity, and deletes only exact owned orphans after two observations and grace. | Complete; Step 8. |
| Smoke-before-deploy release ordering | The runner workflow pushes Git-SHA and mutable `main` tags directly on main; it has no digest output, SBOM/provenance configuration, disposable-Droplet canary, control-plane dependency, or fleet rollout. | Not implemented; Steps 2 and 11-12. |

### Update Log

- 2026-08-04: Began Step 0, restored the 574-line historical ledger from
  `9f45d89^:PROGRESS.md`, appended the complete Step 0-12 tracker, and confirmed
  that `CHANGELOG.md` retains `# Changelog`, the Keep a Changelog preamble, and
  `## [Unreleased]` without adding a tracking-only category or entry.
- 2026-08-04: Completed Step 0 after the focused progress test, format, lint,
  typecheck, 149-file / 1,449-test unit suite, production build, and diff hygiene
  all passed. The focused commit is `docs: initialize runner resilience
  tracking` (`e892330`).
- 2026-08-04: Completed Step 1 on a disposable local PostgreSQL database. The
  default development database was not modified because its historical Drizzle
  journal records migration 0020 with an older timestamp and attempts a replay;
  a clean database migrated successfully, proving the repository migration path
  is green. Added three new characterization tests and strengthened two existing
  tests across the five required files. The focused commit is `test:
  characterize runner resilience contracts` (`ae39387`).
- 2026-08-04: Completed Step 2 with Docker-observed release identity,
  canonical heartbeat validation, non-secret expected bootstrap comparison,
  OCI-labeled runner images, and an amd64 SBOM/provenance publication workflow
  that returns and verifies the pushed digest. Local image and Hermes contract
  gates passed; no registry publication or live provider action was performed
  or claimed. The focused commit is `feat: report immutable runner release
  identity` (`71fc024`).
- 2026-08-04: Completed Step 3 with additive compatibility persistence,
  transactional heartbeat assessment, immutable hosted image validation, and a
  shared exact-release predicate across placement, explicit assignment,
  create/start, deployment, and live verification boundaries. Clean and
  upgraded migration gates, 1,472 tests, build, and the local cloud reconciler
  smoke passed. No registry publication, provider resource, or other live
  external effect was performed. The focused commit is `feat: enforce runner
  release compatibility` (`813c8cb`).
- 2026-08-04: Completed Step 4 with an atomically persisted boot-readiness
  snapshot, bounded isolated Docker/Hermes self-test, fixed private fake-model
  canary, no-traffic Telegram configuration proof, strict app-side contract
  parsing, and exact cleanup/restart recovery. All repository, image, and local
  smoke gates passed; no registry publication, provider resource, Telegram
  request, or paid model request was performed. The focused commit is `feat:
  require runner boot readiness contract` (`cc27fa2`).
- 2026-08-04: Completed Step 5 with additive replacement and deployment-budget
  ledgers, a closed pure transition model, idempotent creation, SKIP LOCKED
  leases, generation/source/target CAS fences, exact-expiry takeover, safe
  terminal evidence, and concurrency-safe two-per-deployment/24-hour billable
  limits. Clean and upgraded migration fixtures plus all repository gates
  passed. No provider call, Droplet effect, or new operator surface occurred,
  so the Step 5 changelog entry is deferred as required. The focused commit is
  `feat: persist runner replacement workflows` (`44c5e92`).
- 2026-08-04: Completed Step 6 with one-claim target creation and reused
  DigitalOcean provisioning, exact immutable release/boot validation, fresh
  heartbeat and capacity gates, crash rediscovery, deployment-budget
  reservation, and exact owned-set failure cleanup that preserves the source.
  Ten focused scenarios and all repository/image/local-smoke gates passed. No
  live provider call or Droplet effect was performed. The focused commit is
  `feat: provision validated replacement runners` (`b235136`).
- 2026-08-04: Completed Step 7 with source fencing, command-credential
  revocation, capacity-locked owner-safe reassignment, deterministic fresh
  deployments, stopped-intent preservation, runtime convergence, usage-period
  closure, and crash-resumable exact firewall/Droplet cleanup. Six handover
  scenarios, the full suite/build, both local smokes, and 26/26 E2E passed. No
  live provider call or Droplet effect was performed. The focused commit is
  `feat: hand over agents to replacement runners` (`4265875`).
- 2026-08-04: Completed Step 8 with additive lease/orphan evidence,
  authoritative stable-tag inventory, exact interrupted-create adoption,
  missing/unhealthy replacement triggers, stale assignment and stale row
  repair, duplicate/ambiguity refusal, and two-observation exact-owned orphan
  cleanup behind a protected per-minute cron and shared operator command.
  Provider, route, migration, reconciliation, race, redaction, full repository,
  local-cloud, and 26/26 E2E gates passed. No live provider call or Droplet
  effect was performed. The focused commit is `feat: reconcile managed runner
  infrastructure` (`166ac75`).
- 2026-08-04: Completed Step 9 with a deterministic accepted-launch deadline,
  single-shot bounded diagnostics and stop, durable replacement creation,
  managed infrastructure failure classification, independent stage budgets,
  a two-workflow daily recovery ceiling, and protected post-response/cron
  progress. The smoke clocks now explicitly poll inside the production SLA.
  Focused recovery tests, the full suite/build, both local smokes, and 26/26 E2E
  passed. No live provider call, Droplet effect, Telegram request, or paid model
  request was performed. The focused commit is `fix: replace runners after
  bounded gateway failure` (`19a3e8a`).
- 2026-08-04: Completed Step 10 with one public three-stage setup experience,
  safe replacement-capacity projection, misleading runner-alert suppression,
  closed advanced operational evidence, generic terminal recovery, and working
  Retry/Stop actions that persist stopped intent from error. Focused UI,
  projection, isolation, accessibility, and lifecycle coverage plus the full
  1,554-test suite, production build, and 28/28 desktop/mobile E2E passed. No
  registry publication, provider resource, Telegram request, or paid model
  request was performed. The focused commit is `feat: simplify automatic
  runner recovery status` (`8830a1f`).
- 2026-08-04: Completed the repository implementation for Step 11 with SHA-only
  runner publication, digest verification and scanning, a protected disposable
  Droplet smoke with exact finally cleanup, canary-dependent pinned production
  deploy, gradual/halted rollout controls, an authenticated required-release
  contract, artifact-backed rollback, and an operator runbook. Local source,
  preflight, full-suite, build, and runner-image gates passed. The live GHCR,
  DigitalOcean, and Vercel gates were not authorized or run, so Step 11 remains
  pending and Step 12 remains blocked. The focused commit is `ci: release
  runners through droplet canary` (`b471e77`).
- 2026-08-05: Hardened Step 11 so test processes cannot construct a live
  DigitalOcean client and therefore create zero Droplets,
  release runs serialize globally, the single disposable release canary requires
  an exact typed billable authorization, and Git-linked Vercel production builds
  cannot bypass the canary. Focused workflow/smoke tests passed 12/12; the full
  1,572-test suite, production build, format, lint, typecheck, and diff hygiene
  passed without any provider effect. Step 11 remains pending live reviewed
  acceptance. The focused commit is `ci: require explicit runner canary
  authorization` (`This commit`).

### Next Step

Run the protected Step 11 workflow from an approved `runner-release-canary`
environment, record the immutable digest, workflow/deployment links, exact
cleanup proof, and post-deploy required-release evidence, then mark Step 11
complete and begin Step 12. No Step 12 rollout work is safe before that gate.
