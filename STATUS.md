# Agent Team Status

## Active Work

- issue: [#263](https://github.com/ametel01/plingpling/issues/263)
  owner: builder-agent (`issue_263_builder`)
  branch: `codex/issue-263-creation-latency-evidence`
  worktree: `/Users/alexmetelli/source/plingpling`
  pr: none
  phase: checker-ready
  cycle: 0/5

## Completion Contract

- issue: [#263](https://github.com/ametel01/plingpling/issues/263)
- readiness: ready. The issue has no comments, linked PR, upstream issue, failed required main-branch
  check, credential dependency, schema dependency, or unresolved product decision. Main CI passed at
  `55a9731e4e1c8149f1f5f928c8dc5f2aae346307` in
  [run 31127582633](https://github.com/ametel01/plingpling/actions/runs/31127582633).
- outcome: Add a sanitized, deterministic evidence contract and repository-owned benchmark command
  for cold agent creation. It measures each persisted deployment from `agent_deployments.created_at`
  to `completed_at` (`ready`) or `failed_at` (`failed`), correlates deployment-stage and managed-runner
  provisioning/bootstrap evidence, and makes the existing local simulated-Droplet lifecycle emit a
  complete report before its database volume is removed.
- acceptance criteria:
  - The report has a stable machine-readable shape with total count, ready successes, terminal
    failures, incomplete/nonterminal rows, success rate, p50, p95, maximum, and per-stage sample,
    missing-evidence, duplicate-evidence, and duration summaries. Stable ordering is by deployment
    creation timestamp then deployment ID; percentile calculation is deterministic and tested.
  - Ready-run SLO latency is `completed_at - created_at`; failed-run terminal latency is
    `failed_at - created_at`. Failures remain in count, success-rate, per-run, and failure-duration
    evidence instead of being filtered from the report. Nonterminal rows are explicit and never
    treated as successes.
  - Each measurable stage is based on persisted timestamps. Agent stages come from durable
    `agent.deployment_stage_changed` events; provider phases come from paired
    `runner_provisioning_events`; bootstrap adds paired started/completed/failed boundaries for the
    package/bootstrap work, each image pull, runner-container start, registration, boot validation,
    and authenticated readiness. The existing runner boot snapshot's `startedAt`/`completedAt` may
    supply boot-validation source timing only after validation and safe persistence.
  - A missing pair, repeated started/completed/failed event, reversed timestamp, ambiguous runner
    correlation, or unknown terminal timestamp is surfaced as invalid/missing/duplicate evidence.
    It must not become a zero duration or a successful stage.
  - Automatic runner evidence is correlated through the deployment-derived provisioning operation
    key/assigned runner and owner-safe database joins. It does not depend on provider resource IDs,
    endpoint URLs, or current mutable runner assignment alone.
  - Exactly one sanitized structured terminal-completion log is emitted for a successful persisted
    terminal transition, containing only deployment ID, runner ID when present, outcome, total
    duration, and bounded stage durations/evidence status. It excludes user/agent identity, tokens,
    secrets, endpoints, provider responses/resource IDs, cloud-init output, and arbitrary metadata.
  - The benchmark's default existing-run mode is read-only. Local trial mode accepts only the
    repository's exact zero-cloud `local_docker` sentinels. Any DigitalOcean-driving mode fails
    closed unless it has an explicit positive trial count plus affirmative cost/provider
    authorization, never runs from ordinary CI, and cleans each owned trial through existing safe
    cleanup paths. No billable mode is executed as part of #263 verification.
  - `bun run local:agent:smoke` produces and prints/returns a complete sanitized timing record before
    `compose down --volumes`; its persisted cleanup and zero-DigitalOcean guarantees remain intact.
  - `docs/E2E_VALIDATION.md` documents the SLO boundary, report schema, nearest-rank or otherwise
    explicitly selected percentile rule, local/read-only/provider command usage, authorization,
    redaction, retention, and cleanup. `package.json` exposes the benchmark command.
  - `PROGRESS.md` records Step 1 evidence, gates, a real implementation commit or PR-head reference,
    and Step 2 as next; stale placeholder wording is absent at final handoff. `CHANGELOG.md` preserves
    all existing history and adds one operator-visible `Added` entry under `Unreleased`.
- non-goals:
  - Do not improve scheduler cadence, drain multiple reconcile stages, change retry/backoff or lease
    behavior, alter readiness semantics, remove the full boot fixture, change Droplet image/size, or
    implement any work owned by #264-#271.
  - Do not create Droplets before an agent request, add warm/pre-provisioned/shared capacity, redefine
    `202 Accepted` as ready, add UI, or make provider-backed SLO claims in this issue.
- likely touchpoints:
  - New `src/server/agents/agent-creation-latency.ts` and
    `scripts/benchmark-agent-creation.ts`; `package.json`.
  - `src/server/agents/agent-deployment-reconciler.ts`,
    `src/server/runners/cloud-runner-bootstrap.ts`,
    `src/server/runners/runner-bootstrap-events.ts`,
    `src/server/runners/runner-provisioning-events.ts`, and read-only joins against
    `src/server/db/schema.ts`/`src/server/events/agent-events.ts`.
  - `scripts/smoke-local-agent-cycle.ts`, `docs/E2E_VALIDATION.md`, `PROGRESS.md`, and `CHANGELOG.md`.
  - New focused latency/benchmark tests plus existing cloud-bootstrap, bootstrap-event,
    deployment-reconciler, local-agent-smoke, and redaction tests.
- required tests / gates:
  - Unit fixtures cover ready, failed, nonterminal, empty, missing, duplicate, reversed, ambiguous,
    and deterministically out-of-order evidence; nearest-rank percentile edge cases; stable JSON;
    and hostile secret/endpoint/provider/cloud-init values.
  - Bootstrap tests prove every required boundary has terminal completion/failure evidence and that
    retries/duplicate ingress remain visible without leaking the registration token or log detail.
  - Run the focused latency, benchmark, bootstrap-event, deployment, local-smoke contract, and
    redaction tests through the repository's `scripts/run-unit-tests.ts` harness.
  - Run `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun run test`,
    `bun run build`, `bun run test:e2e:ci`, and `bun run local:agent:smoke`; generate the sanitized
    benchmark summary from that exact local smoke run.
- risks:
  - Bootstrap events use control-plane ingestion `created_at`; if source timestamps are added, clock
    skew and validation must be explicit rather than silently mixing clocks.
  - The local smoke destroys its database volume during cleanup, so report derivation must happen
    before teardown without weakening cleanup-on-error.
  - A later same-user reuse path can make mutable agent-to-runner joins ambiguous; correlation must
    be tied to this deployment's operation evidence now.
  - Free-form metadata and cloud-init failure detail are hostile secret surfaces; summaries and logs
    must project allowlisted fields rather than serialize source objects.
- do-not-touch:
  - Preserve `/Users/alexmetelli/source/plingpling-step7-base`, unrelated PR #262, existing changelog
    history, protected cron behavior, create/provision idempotency, leases, provider tags, and cleanup
    ownership. Avoid a database migration unless the builder proves existing durable events cannot
    satisfy an acceptance criterion and escalates before adding one.
- dependency blockers: none. Issues #264, #265, and #266 depend on #263; they do not block it.
- open questions: none blocking. The builder may choose ergonomic CLI flag names and the exact
  allowlisted stage labels, but must keep the report contract stable, documented, deterministic,
  read-only by default, and fail-closed at every provider-effect boundary.

## Dependency Graph

- ready: #263
- blocked by #263: #264, #265, #266
- blocked by #264: #267, #268
- blocked by #266: #269
- blocked by #265: #270
- blocked by #264-#270: #271

## Handoffs

- from: coordinator
  to: issue-spec-agent (`issue_263_spec`)
  timestamp: 2026-08-07T04:43:50+08:00
  request: Produce the issue #263 completion contract without editing implementation files.
  evidence: `PLAN.md`, `PROGRESS.md`, issue #263, and the repository are available.
  next-action: Update this file with the bounded contract and stop.
- from: issue-spec-agent (`issue_263_spec`)
  to: coordinator, then builder-agent
  timestamp: 2026-08-07T04:47:27+08:00
  request: Implement only the #263 completion contract; begin with the latency derivation/report
    module and deterministic fixtures, then instrument bootstrap pairs and integrate local smoke.
  evidence: Issue/comments/links, `PLAN.md` Step 1, schema, deployment and provisioning state
    machines, bootstrap ingress/redaction, smoke teardown, package scripts, docs, tests, and live
    main CI were inspected. No upstream blocker or linked implementation PR exists.
  next-action: Coordinator assigns branch ownership to one builder. Builder must stop before any
    DigitalOcean effect, preserve shared trackers, and hand focused/full gate evidence to checker.
- from: coordinator
  to: builder-agent (`issue_263_builder`)
  timestamp: 2026-08-07T04:49:03+08:00
  request: Implement only the issue #263 completion contract in this worktree and branch.
  evidence: Contract committed at `d8c6b7a`; Step 0 committed at `3d435fc`; main CI evidence is in
    the contract; no DigitalOcean verification is authorized.
  next-action: Implement test-first where practical, run focused gates, update `STATUS.md`, and stop
    with a complete checker handoff. Do not create or access provider resources.
- from: builder-agent (`issue_263_builder`)
  to: checker-agent
  timestamp: 2026-08-07T05:14:00+08:00
  request: Verify issue #263 implementation against the completion contract. Do not edit code.
  evidence: Implemented deterministic creation-latency reporting, read-only benchmark CLI,
    sanitized terminal-completion logging, local smoke timing output before cleanup, E2E docs, and
    changelog/progress updates. Final implementation also normalizes PostgreSQL timestamp strings
    and correlates runner evidence through the deployment-derived `agentbay-deploy-*` operation key
    with owner-safe joins, using current assignment only as fallback. DigitalOcean/provider execution
    was not run or authorized. Implementation commit: this checker-ready branch commit.
  next-action: Check diff, issue contract, gates, and redaction/provider guardrails. If accepted,
    hand back for PR creation/review.

## Gates

- command: `test -f PROGRESS.md && test -f CHANGELOG.md`
  result: pass on 2026-08-07
  evidence: Both files exist; `CHANGELOG.md` retains `# Changelog` and `## [Unreleased]`, and
  `PROGRESS.md` lists Steps 0–9 with Step 0 complete.
- command: `bun scripts/run-unit-tests.ts tests/unit/agent-creation-latency.test.ts tests/unit/agent-creation-benchmark.test.ts tests/unit/local-agent-cycle-smoke.test.ts tests/unit/runner-bootstrap-events.test.ts`
  result: pass on 2026-08-07
  evidence: 4 files, 17 tests passed after PostgreSQL timestamp normalization and operation-key
    correlation fixes.
- command: `bun run format:check`
  result: pass on 2026-08-07
  evidence: Biome checked 399 files with no fixes applied.
- command: `bun run lint`
  result: pass on 2026-08-07
  evidence: Biome checked 399 files with no fixes applied.
- command: `bun run typecheck`
  result: pass on 2026-08-07
  evidence: `next typegen && tsc --noEmit` completed successfully.
- command: `bun run test`
  result: pass on 2026-08-07
  evidence: 169 files and 1628 tests passed after all fixes in isolated unit-test database
    `plingpling_test_81485_2ff5ae0a25f9`.
- command: `bun run build`
  result: pass on 2026-08-07
  evidence: Next.js production build completed successfully after the operation-key correlation fix.
- command: `bun run test:e2e:ci`
  result: pass on 2026-08-07
  evidence: 26 Playwright CI tests passed after the operation-key correlation fix.
- command: `bun run local:agent:smoke`
  result: pass on 2026-08-07
  evidence: Zero-cloud local Docker smoke passed after the operation-key correlation fix. Timing
    report emitted before cleanup with `ready=1`, `successRate=1`, `readyLatency.p95Ms=88223`,
    `digitalOceanRequests=0`, and invalid runner/bootstrap pair evidence surfaced for later steps.
- command: `bun run agent:creation:benchmark -- --limit 1`
  result: pass on 2026-08-07
  evidence: Read-only default DB query returned a valid empty report without provider effects.

## Review Threads

- none

## Decisions And Lessons

- 2026-08-07:
  signal: The one-minute target cannot rely on capacity created before the user request.
  rule: Preserve cold on-demand provisioning and optimize dispatch, orchestration, size, images,
  readiness, and same-user reuse only.
- 2026-08-07:
  signal: Provider trials and snapshot builds can incur cost and touch external infrastructure.
  rule: Stop for explicit authorization before any billable provider execution.

## Worktrees

- `/Users/alexmetelli/source/plingpling`: issue #263 branch, coordinator-owned until handoff.
- `/Users/alexmetelli/source/plingpling-step7-base`: pre-existing detached user-owned worktree;
  preserve and do not modify.

## Completed

- planning: `PLAN.md`; issues [#263](https://github.com/ametel01/plingpling/issues/263) through
  [#271](https://github.com/ametel01/plingpling/issues/271) published on 2026-08-07.
