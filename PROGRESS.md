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

Step 4 is complete. Ready-mode creation remains default-off behind the exact
server flag, but accepted replays return before flag or credential validation.
First writes validate the sole approved OpenRouter model and a bounded injected
Telegram `getMe`, then atomically persist the stopped desired-running agent,
managed config, four encrypted secret rows, stable Telegram uniqueness metadata,
pending deployment, and one safe creation event. Step 5 is next: project the
complete managed Hermes configuration from the persisted contract.

### Step Checklist

- [x] Step 0: Progress and Changelog Tracking Setup
- [x] Step 1: Quality Gates Setup and Baseline Evidence
- [x] Step 2: Align Readiness With the Pinned Hermes Contract
- [x] Step 3: Persist Desired State and Deployment Operations
- [x] Step 4: Add Managed Creation Configuration and Encrypted Credentials
- [ ] Step 5: Project a Complete Managed Hermes Configuration
- [ ] Step 6: Split Runner Launch Acceptance From Observed Readiness
- [ ] Step 7: Reconcile Creation Through Ready
- [ ] Step 8: Add One-Click Creation and Persisted Progress UI
- [ ] Step 9: Make Desired-Running Gateways Durable
- [ ] Step 10: Final Acceptance, Documentation, and Controlled Rollout

### Step Ledger

| Step | State | Depends on | Commit | Validation or deployment evidence | Blocker and next work |
| --- | --- | --- | --- | --- | --- |
| 0. Progress and Changelog Tracking Setup | Complete | None | This commit | `bun run format:check` passed after formatting the new progress guard; `bun run lint` passed; `bun run typecheck` passed; `bun run test` passed 98 files / 863 tests; `bun run build` passed; `bun run test:e2e:ci` passed 14 tests; `git diff --check` passed; changelog structure verified without a tracking-only entry. | Complete; Step 1 is next. |
| 1. Quality Gates Setup and Baseline Evidence | Complete | Step 0 | This commit | Pre-edit baseline at `807e401`: `bun run verify` passed (`format:check`, `lint`, `typecheck`, 98 test files / 863 tests, and production build) and `bun run test:e2e:ci` passed 14 browser tests. Added `verify:hermes:staging`, a pure fail-closed preflight, placeholder-only docs/env entries, and 7 focused staging-gate tests. Final gates passed: `bun run format:check`; `bun run lint`; `bun run typecheck`; `bun run test` passed 99 files / 870 tests; `bun run build`; `bun run test:e2e:ci` passed 14 tests; `bun run verify:hermes:staging` exited nonzero with `capability_unavailable` and `sideEffectsAttempted: false`; `git diff --check`; `CHANGELOG.md` unchanged. | Complete; Step 2 is next. |
| 2. Align Readiness With the Pinned Hermes Contract | Complete | Steps 0-1 | This commit | Focused Step 2 tests passed 6 files / 43 tests across runner-service, Docker adapter, lifecycle readiness, manual-runner adapter, projection, and local-smoke guards. `bun run agent:hermes:contract-smoke` passed against local pinned-image behavior with `telegramBoundary: "local-smoke-disabled"`, private API auth, no public Hermes port, production waiter reuse, fake model response, state persistence, backup/restore, log-source evidence, and cleanup. Full gates passed: `bun run format:check`; `bun run lint`; `bun run typecheck`; `bun run test` passed 99 files / 879 tests; `bun run build`; `bun run test:e2e:ci` passed 14 tests; `git diff --check`. | Complete; Step 3 is next. |
| 3. Persist Desired State and Deployment Operations | Complete | Steps 0-2 | This commit | Generated `drizzle/0016_motionless_fantastic_four.sql` plus snapshot/journal with `agent_desired_status`, `agents.desired_status DEFAULT 'stopped'`, `agent_deployment_stage`, owner-bound `agent_deployments`, composite owner FK, idempotency/active/owner/claim indexes, and check constraints; reordered generated SQL only so the referenced agent-owner unique key exists before the FK while leaving generated metadata untouched. Focused Step 3 tests passed 7 files / 72 tests across schema/migration source assertions, state/DTO invariants, real separate-connection idempotency/active-operation/lease/expiry/release/renewal/CAS concurrency, owner-concealed route behavior, request-user boundaries, two-user route isolation, and clean/upgrade disposable loopback migration fixtures through `0015_dear_leader`. Migration gates passed: `bun run db:generate` reported no drift after generation; `bun run db:migrate` passed and reran idempotently on local loopback Postgres. Full gates passed: `bun run format:check`; `bun run lint`; `bun run typecheck`; `bun run test` passed 103 files / 905 tests; `bun run build`; `bun run test:e2e:ci` passed 14 tests; `git diff --check`. | Complete; Step 4 is next. |
| 4. Add Managed Creation Configuration and Encrypted Credentials | Complete | Steps 0-3 | This commit | Generated `drizzle/0017_ambitious_tyrannus.sql` plus snapshot/journal with three nullable Telegram secret metadata columns, metadata checks, and two active-Telegram partial unique indexes. Clean disposable loopback migration passed; upgrade `bun run db:migrate` passed and reran idempotently; `bun run db:generate` reported no schema drift. Focused Step 4 tests passed 8 files / 78 tests across model catalog, Telegram client, create validation/route, ready-create DB transaction/replay/rollback/runner-precheck, secret uniqueness/backfill, schema, and flag parsing. Full gates passed: `bun run format:check`; `bun run lint`; `bun run typecheck`; `bun run test` passed 106 files / 927 tests; `bun run build`; `bun run test:e2e:ci` passed 14 tests; credential-free `bun run verify:hermes:staging` exited nonzero with `capability_unavailable` and `sideEffectsAttempted: false`; `git diff --check`. | Complete; Step 5 is next. |
| 5. Project a Complete Managed Hermes Configuration | Not started | Steps 0-4 | Not collected | Not collected | Requires the accepted Step 4 commit and independent check before projection work starts. |
| 6. Split Runner Launch Acceptance From Observed Readiness | Not started | Steps 0-5 | Not collected | Not collected | Requires managed launch spec and projection. |
| 7. Reconcile Creation Through Ready | Not started | Steps 0-6 | Not collected | Not collected | Requires durable deployment records and runner acceptance. |
| 8. Add One-Click Creation and Persisted Progress UI | Not started | Steps 0-7 | Not collected | Not collected | Requires reconciler and readiness snapshot. |
| 9. Make Desired-Running Gateways Durable | Not started | Steps 0-8 | Not collected | Not collected | Requires verified ready/failed state handling. |
| 10. Final Acceptance, Documentation, and Controlled Rollout | Not started | Steps 0-9, published image, authorized DigitalOcean budget, staging Telegram bot/user, funded OpenRouter key | Not collected | Not collected | External live acceptance prerequisites must be explicit before contacting external services. |

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

- No blocker remains for Step 4.
- Step 5 should project managed Hermes/OpenRouter/Telegram configuration from
  the persisted Step 4 contract after independent Step 4 acceptance.
