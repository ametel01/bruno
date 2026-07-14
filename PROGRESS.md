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
