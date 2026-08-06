# Agent Team Status

## Active Work

- issue: [#265](https://github.com/ametel01/plingpling/issues/265)
  owner: issue-spec-agent (`issue_265_spec`), ready for coordinator reassignment
  branch: `codex/issue-265-runner-sizing`
  worktree: `/Users/alexmetelli/source/plingpling-issue-265`
  pr: none
  phase: specified; code-ready; merge dependency-blocked on main CI; provider evidence unauthorized
  cycle: 0/5

## Completion Contract

- issue: [#265](https://github.com/ametel01/plingpling/issues/265), Right-size managed
  runners for Hermes cold start
- readiness: blocked for merge, but ready for authorization-independent implementation. Upstream
  [#263](https://github.com/ametel01/plingpling/issues/263) is closed by merged PR
  [#272](https://github.com/ametel01/plingpling/pull/272) at `7d1cb98`; it supplies the sanitized
  creation-latency evidence and fail-closed provider-trial guard. No #265 comments, linked
  implementation PR, failed required main-branch check, schema dependency, or unresolved review
  thread exists. Main CI run 31131392382 now fails because its required real-Docker fixture cannot
  reach the Docker daemon. Exact default selection also requires explicit billable authorization.
- outcome: Define one canonical managed-runner resource-profile contract, reject unsupported or
  known-incompatible size/capacity/Hermes-runtime combinations before any provider call, add a
  sanitized and fail-closed size-comparison benchmark, and—only after authorized evidence selects
  it—replace the 512 MB default with the measured supported 2 GB-or-larger slug. One default Hermes
  workload must fit in physical memory with an explicit runner/OS reserve instead of depending on
  sustained swap, while its Docker CPU, memory, PID, privilege, and capability limits remain exact.
- acceptance criteria:
  - A repository-owned profile catalog is the single source for every DigitalOcean slug accepted
    for managed cold runners. Each profile exposes only non-secret size identity, vCPU, physical
    memory, and current cost metadata; cost and resource views cannot silently disagree.
  - Compatibility is calculated from the configured host profile, requested max-agent capacity,
    canonical per-Hermes CPU/memory limits, and an explicit documented host reserve. It fails closed
    for unknown profiles, malformed or unbounded resource values, insufficient CPU, insufficient
    physical memory, and capacity above the profile's proven limit.
  - Hosted configuration defaults to `AGENTBAY_RUNNER_MAX_AGENTS=1`. This issue must not raise that
    default. The one-agent selected profile has at least the 1536 MiB default Hermes memory limit
    plus the documented runner/OS memory reserve inside physical RAM.
  - The same validated Hermes CPU, memory, PID, and capacity values used by compatibility checking
    are emitted into cloud bootstrap runner configuration; the runner service uses those exact
    values when constructing and verifying the Hermes container. Configuration cannot validate one
    limit and launch with a different implicit default.
  - Both manual and automatic provisioning reject an incompatible configuration before provider
    effects. Tests must prove zero calls to SSH-key discovery/creation, Droplet creation/read,
    firewall mutation, tagging, or cleanup for rejected input; no pre-request provider capacity is
    created.
  - Swap is absent from the selected normal default path. It is generated only for an explicitly
    named, supported low-memory resilience profile and is never counted as physical memory by the
    compatibility check. An incompatible legacy 512 MB/1536 MiB combination cannot be made valid by
    enabling swap.
  - The size-profile benchmark compares an explicit bounded candidate set while holding region,
    base image or snapshot identity, runner digest, Hermes digest, capacity, and runtime limits
    fixed. Its stable sanitized report separates each size's count, successes/failures,
    success-rate, ready-latency distribution, and resource/cost profile; failures and cleanup
    outcomes remain visible.
  - DigitalOcean benchmark execution remains fail closed behind exact positive bounded trial
    counts, the existing affirmative CLI flag, the exact authorization sentinel, and explicit
    candidate slugs. Ordinary CI, read-only reporting, local smoke, malformed arguments, or a
    partially configured environment cannot create provider resources. Every owned trial uses the
    existing safe terminal cleanup path.
  - Before the default changes, attach sanitized authorized evidence naming the tested exact slug,
    immutable runner/Hermes identities, fixed region/image identity, trial count, success/failure
    and latency results, physical resource profile, cleanup result, and absence of credential or
    provider-resource identifiers. Without that evidence, leave the 512 MB default unchanged and
    hand the stream back as awaiting authorization; do not claim #265 complete.
  - After evidence selection, update the server default, example environment, README/operator
    guidance, price/resource metadata, `PROGRESS.md`, and the existing `Unreleased` changelog without
    erasing upstream history. Document the price impact and why swap is not the sizing mechanism.
  - Existing Hermes container enforcement remains: `--cpus`, `--memory`, `--pids-limit`,
    `no-new-privileges`, `--cap-drop ALL`, only the current five required added capabilities, no
    published port, no Docker-socket mount, and exact inspect-time verification.
- non-goals:
  - Do not create Droplets before a user's create request; add warm pools, ready capacity,
    onboarding-time or predictive provisioning; or share runners across users.
  - Do not implement dispatch/drain work owned by #264/#267/#268, snapshot construction or
    selection owned by #266/#269, same-user capacity reuse or concurrency increases owned by #270,
    or the 30-trial end-to-end SLO proof owned by #271.
  - Do not raise the default above one agent, redefine durable `ready`, weaken container isolation,
    execute a production deployment/release, change production secrets, or make provider-backed SLO
    claims.
  - Do not use swap, an unpublished provider size, or a cost-only price row as evidence that a host
    is compatible. Do not bake credentials or mutable image tags into evidence.
- likely touchpoints:
  - `src/server/env.ts`, `src/runner-service/constants.ts`, a focused profile/compatibility module
    under `src/server/runners/`, and `src/server/costs/provider-prices.ts` for canonical defaults,
    strict parsing, physical resources, supported slugs, and cost identity.
  - `src/server/runners/runner-provisioning.ts` and `cloud-runner-bootstrap.ts` for pre-provider
    manual/automatic validation, swap selection, exact runtime propagation, and safe summaries.
  - `src/runner-service/docker.ts`, `index.ts`, and `local-agent-smoke.ts` only as needed to consume
    and prove the same CPU/memory/PID profile without weakening hardening.
  - `scripts/benchmark-agent-creation.ts`; `scripts/repro-cloud-runner-bootstrap.ts` if its current
    hard-coded 512 MB harness must represent the selected profile; focused env, cost, provisioning,
    bootstrap, runner-service, benchmark, placement, and local-smoke unit tests.
  - `.env.example`, `README.md`, `docs/E2E_VALIDATION.md`, `PROGRESS.md`, and `CHANGELOG.md`; preserve
    coordinator-sensitive entries and update only #265/Step 5 material.
- required tests / gates:
  - Unit profile matrices cover every supported slug, default one-agent compatibility, 512 MB and
    1 GB rejection for a 1536 MiB Hermes limit plus reserve, CPU/memory/capacity boundaries,
    malformed values, unknown slugs, and proof that swap never contributes compatible bytes.
  - Manual and automatic provisioning tests inject rejecting configurations and assert that every
    provider spy/call list is empty. Valid-profile tests assert the exact selected slug and validated
    runtime values reach the create/bootstrap boundary.
  - Bootstrap/runtime tests assert swap is absent from the selected default, explicit legacy
    resilience behavior is bounded, cloud env values match compatibility inputs, Docker run args
    retain all limits/hardening, and inspect verification rejects CPU, memory, PID, privilege, or
    capability drift.
  - Benchmark tests cover deterministic candidate ordering, fixed comparison identities, failures,
    cleanup failures, secret/provider-ID redaction, duplicate/unknown slugs, malformed/fractional/
    zero/oversized trial counts, missing authorization, and zero provider calls in every rejected
    or ordinary-CI path. Use fakes only until provider execution is explicitly authorized.
  - Run focused environment, resource-profile, cost, bootstrap, provisioning, placement,
    runner-service runtime-limit, benchmark, and local-smoke contract tests through
    `scripts/run-unit-tests.ts`.
  - Run `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`,
    `bun run test:e2e:ci`, `bun run repro:cloud-runner` with the selected profile envelope, and
    `bun run local:agent:smoke` with equivalent CPU/memory/capacity limits. Record the sanitized local
    latency report; do not describe it as DigitalOcean evidence.
  - With explicit user authorization only, run the minimum bounded size-profile provider sample,
    prove all owned Droplets/firewalls/keys and other trial state are cleaned, retain only sanitized
    evidence, then rerun impacted focused/full gates after selecting the default.
- risks:
  - DigitalOcean slug names are not sufficient resource truth; a stale or duplicated catalog can
    validate the wrong host. Keep resource and price identity centralized and require exact
    supported profiles.
  - Docker memory strings use binary units while provider marketing names may be read as decimal;
    compare normalized integer bytes/MiB and reserve conservatively.
  - Runner-service runtime options currently default internally to `1` CPU, `1536m`, and 256 PIDs,
    while cloud bootstrap only propagates max agents. Failing to carry one canonical profile through
    both processes would create a time-of-check/time-of-use mismatch.
  - Restricting previously accepted arbitrary slugs is a compatibility change. The error must be
    safe and actionable, and docs must identify the supported escape/migration path without silently
    allowing unmeasured resources.
  - Provider comparisons incur cost and may leave resources on uncertain outcomes. Authorization,
    ownership tags, bounded trials, outcome reconciliation, cleanup evidence, and redacted output
    are mandatory before any live call.
  - #266 may concurrently touch provider/env/bootstrap/documentation surfaces. Rebase before shared
    edits and preserve the snapshot stream's identities and authorization guards.
- do-not-touch:
  - Preserve `/Users/alexmetelli/source/plingpling-step7-base`, unrelated PR #262, merged #263/#272
    latency semantics, the existing valid 15-stage evidence sequence, deployment readiness meaning,
    user ownership predicates, leases/idempotency, provider ownership tags, cleanup fencing,
    immutable image requirements, and all prior changelog/progress history.
  - Avoid a database migration. Resource compatibility is configuration/profile validation unless
    the builder proves durable schema is necessary and escalates before adding one.
- dependency blockers: required main CI
  [run 31131392382](https://github.com/ametel01/plingpling/actions/runs/31131392382) fails in
  `tests/unit/create-agent-db.test.ts` (`start route real Docker fixture`) because `docker info`
  cannot reach the daemon. Implementation may proceed, but checker/merge needs a green rerun or an
  upstream fix. #263/#272 is complete and #270 is downstream. Live provider evidence separately
  remains authorization-gated; no DigitalOcean effect is permitted without explicit authority.
- open questions:
  - Blocking final acceptance only: which explicitly authorized candidate set and minimum trial
    count should select the default? Until authorization is granted, implement and test the bounded
    mechanism with fakes, keep the current default, and stop before provider execution.
  - Non-blocking implementation choice: the builder may choose module names and a conservative
    explicit host memory reserve, but the reserve must be centralized, documented in bytes/MiB,
    leave the selected one-agent Hermes limit fully inside physical RAM, and be exercised at exact
    boundary values.

## Handoffs

- from: coordinator
  to: issue-spec-agent (`issue_265_spec`)
  timestamp: 2026-08-07T07:35:00+08:00
  request: Produce a bounded #265 completion contract without editing implementation files.
  evidence: Root status assigns #265 after merged #263/#272; no provider execution is authorized.
  next-action: Update this worktree's `STATUS.md` and stop.
- from: issue-spec-agent (`issue_265_spec`)
  to: coordinator, then builder-agent
  timestamp: 2026-08-07T07:41:00+08:00
  request: Implement the authorization-independent #265 contract, beginning with the canonical
    resource-profile compatibility matrix and provider-zero rejection tests, then propagate exact
    limits and add the guarded benchmark mode. Do not run DigitalOcean or change the default without
    sanitized authorized evidence.
  evidence: Issue #265/body/labels/comments/links, upstream #263/PR #272, downstream #270, `PLAN.md`
    Step 5, merged latency benchmark, env/bootstrap/provisioning/provider/cost/runtime/placement
    paths, focused tests, README/example env, and live main CI were inspected. No repo-local blocker
    or linked #265 PR exists.
  next-action: Coordinator records/assigns the main-CI blocker, commits this contract, and may assign
    a builder for code/fake-provider gates. Stop at provider authorization and before merge until CI
    is green or independently classified with an accepted upstream fix.

## Gates

- command: local/GitHub preflight
  result: pass on 2026-08-07
  evidence: branch was clean at merged main `7d1cb98`; #265 is open/agent-ready with no comments or
    PR; #263 is closed by merged #272; #270 is open and explicitly blocked by #265.
- command: `gh run view 31131392382 --repo ametel01/plingpling`
  result: fail; unit tests report 168 files/1,637 tests passed, then the required real-Docker fixture
    fails because `docker info` cannot reach the daemon. This is the exact current merge blocker.

## Decisions And Lessons

- 2026-08-07: A 512 MB host cannot physically satisfy the 1536 MiB Hermes limit; never count swap
  as compatibility. Build/test provider guards with fakes, but defer billable selection and the
  default change to explicit authorization.
