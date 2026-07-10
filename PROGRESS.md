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

Milestone 16: Cost Tracking is the active implementation plan.

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
explicit unavailable-price coverage. Steps 4 and 5 can now consume that merged
contract, while Step 6 remains dependent on both UI steps.

Step 4 is implemented for issue #225 on its isolated branch using the merged
Step 3 server-only cost DTOs. The dashboard now renders directly testable daily
and monthly estimate sections with runner monthly cost, current running-agent
counts, per-active-agent allocation, explicit unavailable and zero-agent
states, and safe loader-failure feedback without client-side cost math. This is
branch-level implementation evidence reviewed in PR #246; no merge evidence exists
yet.

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
- [x] Step 4: Add Dashboard Cost Summary and Views (implemented and reviewed; merge pending)
- [ ] Step 5: Add Runner Detail Cost Context
- [ ] Step 6: Final Acceptance and Milestone Closeout

### Completed Evidence

| Step | Issue | Pull request | Merge commit | Evidence |
| --- | --- | --- | --- | --- |
| 0 | #221 | #228 | `147b220` | Tracker and changelog structure guard established. |
| 1 | #222 | #229 | `bffe8ff` | Provider price metadata and focused price tests merged. |
| 2 | #223 | #230 | `54f5546` | Usage-period schema, lifecycle persistence, and focused tests merged. |
| 3 | #224 | #243 | `ebea027` | Daily/monthly infrastructure cost estimates, allocation, and unavailable-price coverage merged. |

### In-Progress Evidence

- Step 4 / issue #225: rebased functional commit `48bad41` adds the concurrent
  server dashboard loader, scoped cost-summary component and styles, focused
  known-price/unavailable/zero-agent/failure/redaction unit coverage, and
  isolated desktop/mobile browser coverage. PR #246 has been reviewed; merge
  evidence is intentionally not recorded before it exists.

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
| 1. Provision the AgentBay Clerk development instance | #232 | Approval-blocked | None | Not opened | Not collected | Not collected | Requires explicit approval for Clerk/provider writes and the key destination. After approval, create a dedicated AgentBay development app, enable verified email code plus development Google/Apple, and collect sanitized `clerk doctor --json` evidence. |
| 2. Replace the Basic-auth shell with Clerk-capable routing and UI | #233 | Implemented; checker pending | None | Draft PR #244 | `c46530f` | Locked Clerk 7.5.16; focused auth/operator/runner tests passed (8 files, 105 tests), including a real-SDK synthetic two-key request with no encryption key; isolated full unit passed (66 files, 556 tests); format, lint, typecheck, and build passed; isolated desktop/mobile auth and CI smoke E2E passed (20 tests). No hosted provider evidence was claimed. | Recheck the standard Clerk environment-key path, explicit `AGENTBAY_AUTH_TRANSITION_MODE` seam, single `proxy.ts`, Clerk UI states, Basic barrier, exact runner bypass, and recorded full-E2E baseline gap. Step 3 should consume the same session boundary; Step 7 replaces the temporary mode policy. |
| 3. Resolve Clerk and development identities to internal users | #234 | Implemented; maintainer fix pushed; re-review pending | None | PR #247 | `555e44b`, `9edfc59`, `767ba87`, `8fbff63` | Migration 0014 adds only nullable unique `users.clerk_user_id`; the request resolver supports shared development identity and typed Clerk `401` results, while the server adapter awaits `auth()` and passes only `userId`. Maintainer review 4667919249's ambiguous-CLI finding is fixed by rejecting duplicate identities, duplicate or conflicting modes, and inline/unknown forms before claim or database access without echo. Isolated migration and focused schema/resolver/claim/adapter/CLI tests passed (4 files, 70 tests); separate-connection race suites previously passed five repeated runs (3 files, 29 tests each); full unit passed (70 files, 607 tests); format, lint, typecheck, build, current `test:e2e:ci` (14 tests), migration-lineage, diff, and secret checks passed. No production claim, real-provider E2E, or provider/secret mutation occurred. | PR #247 is ready with its maintainer fix pushed; coordinator owns exact-head checker and maintainer re-review. Baseline Docker timing is tracked separately by #248; never run the legacy claim against production without separate approval. |
| 4. Isolate agent lifecycle and agent data | #235 | Dependency-blocked | Steps 2 and 3 (#233, #234) | Not opened | Not collected | Not collected | After both dependencies merge, scope agent routes, lifecycle, events, logs, usage, and costs to the resolved internal user with cross-user `404` behavior. |
| 5. Isolate runner provisioning and management | #236 | Dependency-blocked | Steps 2 and 3 (#233, #234) | Not opened | Not collected | Not collected | After both dependencies merge, scope browser runner operations and credentials per user while preserving existing `/runner/v1/*` machine authentication. |
| 6. Isolate approvals, backups, restores, and activity | #237 | Dependency-blocked | Steps 2 and 3 (#233, #234) | Not opened | Not collected | Not collected | After both dependencies merge, enforce user ownership at database and object-storage boundaries and keep cross-user resources concealed. |
| 7. Preserve full registration-free development access | #238 | Dependency-blocked | Steps 2 and 3 (#233, #234) | Not opened | Not collected | Not collected | After both dependencies merge, add explicit development and Clerk modes; local development remains key-free, while production and unprotected previews fail closed. |
| 8. Prove authentication, isolation, and runner compatibility | #239 | Dependency-blocked | Steps 4-7 (#235, #236, #237, #238) | Not opened | Not collected | Not collected | Run the two-user acceptance matrix, signed-out and provider flows, legacy-claim tests, secret-safe diagnostics, and runner-token compatibility after every ownership slice merges. |
| 9. Cut production over and retire Basic auth | #240 | Dependency- and approval-blocked | Steps 1 and 8 (#232, #239) | Not opened | Not collected | Not collected | Requires separate production provider, secret, deployment, legacy-claim, and cutover approval. Retire Basic auth only after hosted Clerk, ownership, runner, rollback, and full-feature evidence passes. |

### Current Blockers and Next Work

- Step 1 has no GitHub dependency but cannot mutate Clerk, providers, Vercel, or
  secret storage until the required human approval is recorded.
- Step 2 is implemented on its isolated builder branch and awaits checker evidence;
  Step 3 is implemented on its rebased builder branch and awaits checker and PR
  evidence.
- Steps 4-7 wait for the merged routing/session contract from Step 2 and the
  merged internal-user resolver contract from Step 3.
- Step 8 waits for all four ownership and development-mode slices.
- Step 9 waits for development-instance evidence and the completed acceptance
  matrix, then requires explicit production-cutover approval.
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
