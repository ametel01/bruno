# Agent Team Status

## Active Work

- issue: [#265](https://github.com/ametel01/plingpling/issues/265)
  owner: maintainer-reviewer (`issue_265_reviewer`)
  branch: `codex/issue-265-runner-sizing`
  worktree: `/Users/alexmetelli/source/plingpling-issue-265`
  pr: [#273](https://github.com/ametel01/plingpling/pull/273)
  phase: changes requested on authorization-independent scope
  cycle: 2/5

## Completion Contract

- issue: [#265](https://github.com/ametel01/plingpling/issues/265), Right-size managed
  runners for Hermes cold start
- readiness: blocked for merge, but ready for authorization-independent implementation. Upstream
  [#263](https://github.com/ametel01/plingpling/issues/263) is closed by merged PR
  [#272](https://github.com/ametel01/plingpling/pull/272) at `7d1cb98`; it supplies the sanitized
  creation-latency evidence and fail-closed provider-trial guard. No #265 comments, linked
  implementation PR, failed required main-branch check, schema dependency, or unresolved review
  thread exists. Main CI run 31131392382 attempt 2 succeeded at merged main `7d1cb98`; exact default
  selection still requires explicit billable authorization.
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
  [run 31131392382](https://github.com/ametel01/plingpling/actions/runs/31131392382) attempt 2
  succeeded on merged main `7d1cb985c06b0007dadcfb0e42c5631c65b7c472`. #263/#272 is complete and
  #270 is downstream. Live provider evidence separately remains authorization-gated; no
  DigitalOcean effect is permitted without explicit authority.
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
- from: builder-agent (`issue_265_builder`)
  to: checker-agent
  timestamp: 2026-08-07T08:10:00+08:00
  request: Verify the authorization-independent #265 implementation and gates. Do not treat it as
    final #265 acceptance because the default-size switch and provider-backed SLO proof remain
    authorization-gated.
  evidence: Canonical resource profiles, pre-provider compatibility rejection, exact Hermes runtime
    propagation, guarded candidate slug benchmark validation, operator docs, and unit/e2e/build/local
    smoke gates are implemented. Hosted default slug remains unchanged without provider evidence.
  next-action: Review diff and gate evidence; if accepted, coordinator may open/refresh the PR but
    should not merge until required main CI is green or accepted upstream-blocked and provider
    evidence/default-selection authorization is resolved.
- from: builder-agent (`issue_265_builder`)
  to: checker-agent
  timestamp: 2026-08-07T08:50:00+08:00
  request: Re-check #265 after the local-smoke harness fix. The previous `No such container:
    agentbay-local-cloud-runner` failure is resolved by avoiding the hard-coded dashboard host port
    collision before provider creation.
  evidence: `compose.yaml` now accepts `AGENTBAY_APP_HOST_PORT`; `scripts/smoke-local-agent-cycle.ts`
    uses dedicated default host app port `55300` and passes the matching `NEXT_PUBLIC_APP_URL` into
    compose while keeping the dashboard container on port 3000. Regression assertions were added in
    `tests/unit/local-agent-cycle-smoke.test.ts`.
  next-action: Verify the narrow diff and gates, especially the serialized local smoke. Do not treat
    local p95 as DigitalOcean evidence and do not merge as complete until provider evidence/default
    selection authorization is resolved.
- from: builder-agent (`issue_265_builder`)
  to: checker-agent
  timestamp: 2026-08-07T09:12:00+08:00
  request: Re-check #265 after fixing the exact-profile local smoke override.
  evidence: `scripts/smoke-local-agent-cycle.ts` now preserves an explicit supported
    `AGENTBAY_DIGITALOCEAN_SIZE_SLUG` and defaults safely to `s-1vcpu-2gb` only when unset. The
    selected slug is passed through compose/app env, provider creation logs, and final smoke summary.
    Cleanup was tightened to reject pre-existing labeled host agent containers and remove all labeled
    leftovers from the owned smoke slot.
  next-action: Verify the narrow diff and gates. Do not treat local p95 as DigitalOcean evidence and
    do not merge as complete until provider evidence/default-selection authorization is resolved.

## Maintainer Review — Cycle 2

- decision: `Request changes` for the authorization-independent PR scope. Submitted as a GitHub
  comment because authenticated reviewer identity and PR author are both `ametel01`, so GitHub cannot
  accept a formal self-review decision.
- review: [PR #273 comment](https://github.com/ametel01/plingpling/pull/273#issuecomment-5211054319)
- timestamp: 2026-08-07T09:41:55+08:00
- blocking findings:
  - `src/server/runners/runner-resource-profiles.ts:116` uses inherited-property membership, so
    `toString`/`constructor` pass as supported profiles; reviewer reproduction returned `ok:true`
    with missing physical resources, and price metadata returned `$NaN`.
  - `src/server/runners/runner-provisioning.ts:829` handles duplicates before compatibility; a
    waiting duplicate can issue `readResource` and be reused under an incompatible manual config.
  - `src/server/runners/runner-provisioning.ts:1079` omits validated custom Hermes CPU, memory, and
    PID values from the manual bootstrap call while the automatic path propagates them.
  - `src/server/runners/local-docker-digitalocean-provider.ts:230` runs the claimed 2 GiB smoke in a
    hard-coded 2-CPU/4-GiB simulated host; slug propagation is not equivalent physical-envelope
    evidence.
  - `src/runner-service/docker.ts:1928` and `:2277` accept unexpected extra added capabilities as long
    as the five required capabilities are also present; inspect verification is not exact.
  - required PR CI run
    [31138264268](https://github.com/ametel01/plingpling/actions/runs/31138264268) failed E2E 25/26 at
    `tests/e2e/automatic-ready.spec.ts:473` / helper `:647`. Current main and the local checker passed
    26/26, so rerun evidence may classify a flake, but the red required check is not mergeable.
- important finding: canonical validation accepts sub-NanoCPU values that round to zero and an
  effectively unbounded safe-integer PID value; define and test representable bounds.
- PR-text fixes: refresh 1,645 to the observed 1,646 full-unit count and reconcile the claimed latest
  local latency with checker evidence (`89443` and later `152276` ms). Neither is provider SLO proof.
- verified boundaries: `closingIssuesReferences` is empty; `Part of #265` is correct; #265 and #270
  remain open; #266 overlap is accurately disclosed; hosted default/max-agents remain unchanged; no
  provider, preprovisioning, warm-pool, cross-user, deployment, release, secret, or migration effect
  occurred. DigitalOcean catalog numeric rows match the current official Basic Droplet pricing table.
- gates: reviewer focused 8-file / 127-test run passed; `git diff --check` passed; GitGuardian,
  Socket, and React Doctor passed. Vercel failed with the known fail-closed
  `clerk_auth_not_configured` preview baseline and is not a #265 regression.
- next-action: builder fixes all blocking findings and tests, updates PR text, reruns focused/full
  gates including an actual equivalent 2-GiB smoke and green remote CI, then hands back to checker.
  Do not merge PR #273 yet. Even after the partial PR is accepted, do not close #265 until authorized
  provider comparison, sanitized cleanup evidence, measured default selection, and final acceptance
  are complete.

## Gates

- command: `AGENTBAY_LOCAL_AGENT_CYCLE_APP_HOST_PORT=55300 AGENTBAY_LOCAL_AGENT_CYCLE_POSTGRES_HOST_PORT=55432 AGENTBAY_DIGITALOCEAN_SIZE_SLUG=s-1vcpu-2gb AGENTBAY_HERMES_DOCKER_CPUS=1 AGENTBAY_HERMES_DOCKER_MEMORY=1536m AGENTBAY_HERMES_DOCKER_PIDS_LIMIT=256 bun run local:agent:smoke`
  result: pass on 2026-08-07 after exact-profile fix and cleanup hardening.
  evidence: provider creation log emitted `sizeSlug:"s-1vcpu-2gb"`; final
    `local_agent_cycle_smoke_passed` summary emitted `sizeSlug:"s-1vcpu-2gb"`,
    `digitalOceanRequests:0`, `cleanupVerified:true`, `simulatedDroplets:1`, `agentCreated:true`,
    `agentDeleted:true`, `nestedDocker:true`, `hermesInstalledInsideDroplet:true`, and
    `hermesGatewayLiveInsideDroplet:true`. Single-run local p95 was `89443` ms. This is local
    behavior evidence only, not DigitalOcean SLO evidence.
- command: `docker ps -a --filter name=agentbay-local-cloud-runner --format '{{.Names}} {{.Status}}'`; `docker ps -a --filter name=agentbay-runner --format '{{.Names}} {{.Status}}'`; `docker ps -a --filter name=agentbay-agent-smoke --format '{{.Names}} {{.Status}}'`; `docker ps -a --filter label=agentbay.agent_id --format '{{.Names}} {{.Status}}'`; `docker compose --project-name agentbay-agent-smoke --profile local-cloud ps`
  result: pass on 2026-08-07 after final smoke.
  evidence: no simulated Droplet, runner, compose, or labeled agent containers were listed; compose
    printed only its empty header.
- command: `bun --conditions react-server scripts/run-unit-tests.ts tests/unit/local-agent-cycle-smoke.test.ts tests/unit/local-docker-digitalocean-provider.test.ts tests/unit/runner-resource-profiles.test.ts tests/unit/server-env.test.ts`
  result: pass on 2026-08-07; 4 files, 28 tests.
- command: `bun run format:check`
  result: pass on 2026-08-07 after formatting the cleanup hardening.
- command: `bun run lint`
  result: pass on 2026-08-07.
- command: `bun run typecheck`
  result: pass on 2026-08-07.
- command: `bun run verify`
  result: pass on 2026-08-07 at `df2575e`.
  evidence: `format:check`, `lint`, `typecheck`, full unit suite with 170 files / 1,646 tests, and
    `next build` passed.

## Checker Result
Status: ALL GREEN

## Commands

- command: `git status --short --branch --untracked-files=all`
  result: clean except checker-owned status update
  evidence: `## codex/issue-265-runner-sizing...origin/main [ahead 6]`; only `M STATUS.md`.
- command: `git rev-parse HEAD`
  result: pass
  evidence: `df2575e7fad2f25f24a575c3c88a3f84b4148ac2`.
- command: `lsof -nP -iTCP:3000 -sTCP:LISTEN || true`
  result: pass
  evidence: port 3000 is occupied by existing `node` PID 80934; checker did not disrupt it and used
    isolated smoke ports instead.
- command: `AGENTBAY_APP_HOST_PORT=55300 NEXT_PUBLIC_APP_URL=http://host.docker.internal:55300 AGENTBAY_POSTGRES_HOST_PORT=55432 docker compose --project-name agentbay-agent-smoke --profile local-cloud config`
  result: pass for port wiring
  evidence: dashboard publishes host `55300` to container target `3000`; `NEXT_PUBLIC_APP_URL` resolves to `http://host.docker.internal:55300`.
- command: source inspection of `scripts/smoke-local-agent-cycle.ts`
  result: pass
  evidence: unset smoke size resolves to `s-1vcpu-2gb`; explicit supported
    `AGENTBAY_DIGITALOCEAN_SIZE_SLUG=s-1vcpu-2gb` is preserved through compose/app env, provider
    creation logs, and the final smoke summary.
- command: `bun --conditions react-server --eval 'import { resolveLocalAgentCycleSizeSlug } from "./scripts/smoke-local-agent-cycle.ts"; ...'`
  result: pass
  evidence: emitted `{"unset":"s-1vcpu-2gb","explicit":"s-1vcpu-2gb"}` and rejected
    `s-2vcpu-4gb` with `Local agent cycle smoke requires a supported managed-runner size slug;
    received s-2vcpu-4gb.`
- command: `gh run view 31131392382 --repo ametel01/plingpling --json status,conclusion,attempt,headSha,url,jobs`
  result: pass
  evidence: attempt 2, status `completed`, conclusion `success`, head SHA `7d1cb985c06b0007dadcfb0e42c5631c65b7c472`; format, lint, typecheck, unit, build, E2E smoke, and cleanup steps succeeded.
- command: `bun --conditions react-server scripts/run-unit-tests.ts tests/unit/local-agent-cycle-smoke.test.ts tests/unit/local-docker-digitalocean-provider.test.ts tests/unit/runner-resource-profiles.test.ts tests/unit/server-env.test.ts`
  result: pass
  evidence: 4 files, 28 tests passed.
- command: `git diff --check`
  result: pass
  evidence: no whitespace errors.
- command: `bun run format:check`
  result: pass
  evidence: Biome checked 401 files; no fixes applied.
- command: `bun run lint`
  result: pass
  evidence: Biome checked 401 files; no fixes applied.
- command: `bun run typecheck`
  result: pass
  evidence: Next route types generated; `tsc --noEmit` passed.
- command: `bun run verify`
  result: pass
  evidence: `format:check`, `lint`, `typecheck`, full unit suite with 170 files / 1,646 tests, and
    `next build` passed at `df2575e`.
- command: `AGENTBAY_LOCAL_AGENT_CYCLE_APP_HOST_PORT=55300 AGENTBAY_LOCAL_AGENT_CYCLE_POSTGRES_HOST_PORT=55432 AGENTBAY_DIGITALOCEAN_SIZE_SLUG=s-1vcpu-2gb AGENTBAY_HERMES_DOCKER_CPUS=1 AGENTBAY_HERMES_DOCKER_MEMORY=1536m AGENTBAY_HERMES_DOCKER_PIDS_LIMIT=256 bun run local:agent:smoke`
  result: pass
  evidence: provider creation log emitted `sizeSlug:"s-1vcpu-2gb"`; final
    `local_agent_cycle_smoke_passed` emitted `sizeSlug:"s-1vcpu-2gb"`,
    `digitalOceanRequests:0`, `cleanupVerified:true`, `simulatedDroplets:1`, `agentCreated:true`,
    `agentDeleted:true`, `nestedDocker:true`, `hermesInstalledInsideDroplet:true`,
    `hermesGatewayLiveInsideDroplet:true`, and local p95 `152276` ms. This is local behavior
    evidence only, not DigitalOcean SLO evidence.
- command: `docker ps -a --filter name=agentbay-local-cloud-runner --format '{{.Names}} {{.Status}}'`; `docker ps -a --filter name=agentbay-runner --format '{{.Names}} {{.Status}}'`; `docker ps -a --filter name=agentbay-agent-smoke --format '{{.Names}} {{.Status}}'`; `docker ps -a --filter label=agentbay.agent_id --format '{{.Names}} {{.Status}}'`; `docker compose --project-name agentbay-agent-smoke --profile local-cloud ps`
  result: pass cleanup verification
  evidence: no retained simulated Droplet, runner, compose, or labeled agent containers were listed; compose printed only its empty header.
- command: checker-created pre-existing labeled-container sentinel followed by local smoke
  result: pass guard behavior
  evidence: smoke rejected `agentbay-checker-preexisting-label-cycle2` with `Local agent cycle
    refuses to replace existing local runner containers`; checker then explicitly removed its own
    sentinel because the guard is intentionally non-destructive.
- command: `gh pr list --repo ametel01/plingpling --head codex/issue-265-runner-sizing --state all --json number,state,title,headRefName,baseRefName,url,mergeStateStatus,isDraft,statusCheckRollup`
  result: pass
  evidence: `[]`; no PR currently exists for this branch.

## Failures

- none for the authorization-independent #265 implementation at `df2575e`.

## Coverage Gaps

- No DigitalOcean provider benchmark, default-size selection, production secret change, deployment, release, Droplet, firewall, SSH-key, or billable effect was run.
- The hosted default slug remains `s-1vcpu-512mb-10gb`; final #265 acceptance still needs explicit
  provider evidence before changing it.
- The exact-profile smoke is a local Docker simulator result; it must not be used as the
  provider-backed one-minute SLO proof.
- `test-workflow-standards` is not installed in this environment; checker used `testing-standards`,
  `ci-quality-gates`, and `ci-security-gates`.

## Next Action

- Coordinator may open/refresh a PR for the authorization-independent scope if desired, but there is
  no current PR for `codex/issue-265-runner-sizing` to merge. Do not merge #265 as complete until
  the provider-evidence/default-selection authorization boundary is resolved.

## Historical Checker Result — Cycle 0
Status: FAILED

## Commands

- command: `git status --short --branch --untracked-files=all`
  result: clean except checker-owned status update
  evidence: `## codex/issue-265-runner-sizing...origin/main [ahead 2]`; only `M STATUS.md`.
- command: `git rev-parse HEAD`
  result: pass
  evidence: `dd12e41c9aa4ca3fac40236cdbfe4780755646fb`.
- command: `gh issue view 265 --json number,title,state,body,labels,comments,url`
  result: pass
  evidence: issue #265 is open, agent-ready, no comments; upstream #263 is the only listed blocker.
- command: `gh pr view 272 --repo ametel01/plingpling --json state,mergedAt,mergeCommit,closingIssuesReferences,statusCheckRollup`
  result: pass
  evidence: PR #272 is `MERGED`, merge commit `7d1cb985c06b0007dadcfb0e42c5631c65b7c472`, closing issue #263.
- command: `gh run view 31131392382 --repo ametel01/plingpling --json status,conclusion,headSha,url,jobs`
  result: pass on attempt 2
  evidence: main CI at `7d1cb985c06b0007dadcfb0e42c5631c65b7c472` is `completed`, conclusion `success`; format, lint, typecheck, unit, build, E2E smoke, and cleanup steps all succeeded.
- command: `git diff --check origin/main...HEAD`
  result: pass
  evidence: no whitespace errors.
- command: `bun --conditions react-server scripts/run-unit-tests.ts tests/unit/runner-resource-profiles.test.ts tests/unit/cost-prices.test.ts tests/unit/server-env.test.ts tests/unit/cloud-runner-bootstrap.test.ts tests/unit/runner-provisioning.test.ts tests/unit/automatic-runner-provisioning.test.ts tests/unit/agent-creation-benchmark.test.ts tests/unit/runner-service.test.ts`
  result: pass
  evidence: 8 files, 127 tests passed.
- command: `bun run verify`
  result: pass
  evidence: `format:check`, `lint`, `typecheck`, 170 unit files / 1,645 tests, and `next build` all passed.
- command: `docker info --format '{{.ServerVersion}}'`
  result: pass
  evidence: Docker server version `29.3.1`.
- command: `AGENTBAY_DIGITALOCEAN_SIZE_SLUG=s-1vcpu-2gb AGENTBAY_HERMES_DOCKER_CPUS=1 AGENTBAY_HERMES_DOCKER_MEMORY=1536m AGENTBAY_HERMES_DOCKER_PIDS_LIMIT=256 bun run repro:cloud-runner`
  result: pass
  evidence: generated user-data, schema valid, 11 runcmd bash script blocks OK.
- command: `bun --conditions react-server scripts/benchmark-agent-creation.ts --mode digitalocean --trials 0 --authorize-provider-costs --candidate-size-slugs s-1vcpu-2gb`
  result: expected fail closed
  evidence: `--trials must be an exact positive integer.` No provider effect.
- command: `AGENTBAY_AGENT_CREATION_BENCHMARK_DIGITALOCEAN_AUTHORIZATION=authorize-digitalocean-agent-creation-benchmark bun --conditions react-server scripts/benchmark-agent-creation.ts --mode digitalocean --trials 1 --authorize-provider-costs --candidate-size-slugs s-1vcpu-2gb,s-1vcpu-2gb`
  result: expected fail closed
  evidence: `--candidate-size-slugs must not include duplicate size slugs.` No provider effect.
- command: `AGENTBAY_AGENT_CREATION_BENCHMARK_DIGITALOCEAN_AUTHORIZATION=authorize-digitalocean-agent-creation-benchmark bun --conditions react-server scripts/benchmark-agent-creation.ts --mode digitalocean --trials 1 --authorize-provider-costs --candidate-size-slugs s-9vcpu-99gb`
  result: expected fail closed
  evidence: `Unsupported candidate DigitalOcean size slug: s-9vcpu-99gb.` No provider effect.
- command: `bun --conditions react-server scripts/benchmark-agent-creation.ts --mode digitalocean --trials 1 --authorize-provider-costs --candidate-size-slugs s-1vcpu-2gb`
  result: expected fail closed
  evidence: missing authorization sentinel rejected with the DigitalOcean benchmark fail-closed message. No provider effect.
- command: `AGENTBAY_AGENT_CREATION_BENCHMARK_DIGITALOCEAN_AUTHORIZATION=authorize-digitalocean-agent-creation-benchmark bun --conditions react-server scripts/benchmark-agent-creation.ts --mode digitalocean --trials 1 --authorize-provider-costs --candidate-size-slugs s-1vcpu-2gb`
  result: expected fail closed
  evidence: stopped at `DigitalOcean trial execution is reserved for the provider-backed SLO proof step and is not implemented by the read-only benchmark.` No provider effect.
- command: `bun --conditions react-server --eval 'readDigitalOceanProviderConfig(...)'` with hosted token, immutable runner image, and no explicit size
  result: expected fail closed
  evidence: `s-1vcpu-512mb-10gb has 512 MiB physical RAM, but 1 Hermes agent(s) require 1920 MiB including the 384 MiB runner/OS reserve. Swap is not counted as compatible memory.`
- command: `bun --conditions react-server --eval 'readDigitalOceanProviderConfig(...)'` with explicit `s-1vcpu-2gb`, `1` CPU, `1536m`, `256` PIDs, max agents `1`
  result: pass
  evidence: parsed config emitted `{"sizeSlug":"s-1vcpu-2gb","cpus":"1","memory":"1536m","pidsLimit":"256","maxAgents":1}`.
- command: `bun run test:e2e:ci`
  result: pass
  evidence: 26 Playwright CI tests passed.
- command: `AGENTBAY_DIGITALOCEAN_SIZE_SLUG=s-1vcpu-2gb AGENTBAY_HERMES_DOCKER_CPUS=1 AGENTBAY_HERMES_DOCKER_MEMORY=1536m AGENTBAY_HERMES_DOCKER_PIDS_LIMIT=256 bun run local:agent:smoke`
  result: failed after serialized rerun
  evidence: latest serialized attempt stopped with `--- simulated Droplet nested Docker diagnostics ---`, `Error response from daemon: No such container: agentbay-local-cloud-runner`, `Error: docker compose failed with exit 1.` Previous checker pass saw the same failure twice. No passing smoke summary was produced, so zero DigitalOcean request count could not be proven from the smoke report.
- command: `docker ps -a --filter name=agentbay-local-cloud-runner --format '{{.Names}} {{.Status}}'`; `docker ps -a --filter name=agentbay-runner --format '{{.Names}} {{.Status}}'`; `docker ps -a --filter label=agentbay.agent_id --format '{{.Names}} {{.Status}}'`; `docker compose --project-name agentbay-agent-smoke --profile local-cloud ps`
  result: cleanup verified after failed smoke
  evidence: no `agentbay-local-cloud-runner`, `agentbay-runner`, or labeled agent containers were listed; compose printed only its empty header.

## Failures

- file: `scripts/smoke-local-agent-cycle.ts`
  check: zero-cloud local smoke gate
  exact error: `Error response from daemon: No such container: agentbay-local-cloud-runner`; `Error: docker compose failed with exit 1.`
  likely owner: builder to fix or coordinator to prove this is a shared local Docker harness failure on main; checker cannot mark the required smoke green.

## Coverage Gaps

- `test-workflow-standards` skill is not installed in this environment; checker used `testing-standards`, `ci-quality-gates`, and `ci-security-gates`.
- Main CI baseline blocker is cleared: run `31131392382` attempt 2 succeeded on merged main.
- No DigitalOcean provider benchmark, default-size selection, production secret change, deployment, release, Droplet, firewall, SSH-key, or billable effect was run.
- The hosted default slug remains `s-1vcpu-512mb-10gb` and correctly fails closed under the current 1536 MiB Hermes plus 384 MiB reserve envelope; final #265 acceptance still needs explicit provider evidence before changing it.

## Next Action

- Checker should verify the dedicated local-smoke host-port fix and rerun or accept the serialized
  `local:agent:smoke` evidence above.
- Do not merge #265 as complete until checker accepts the zero-cloud smoke fix and the
  provider-evidence/default-selection authorization boundary is resolved.

- command: local/GitHub preflight
  result: pass on 2026-08-07
  evidence: branch was clean at merged main `7d1cb98`; #265 is open/agent-ready with no comments or
    PR; #263 is closed by merged #272; #270 is open and explicitly blocked by #265.
- command: `gh run view 31131392382 --repo ametel01/plingpling`
  result: historical stale blocker; superseded by checker evidence above.
  evidence: a later `gh run view 31131392382 --json ...` check shows attempt 2 succeeded on main at
    `7d1cb985c06b0007dadcfb0e42c5631c65b7c472`.
- command: `bun --conditions react-server scripts/run-unit-tests.ts tests/unit/runner-resource-profiles.test.ts tests/unit/cost-prices.test.ts tests/unit/server-env.test.ts tests/unit/cloud-runner-bootstrap.test.ts tests/unit/runner-provisioning.test.ts tests/unit/automatic-runner-provisioning.test.ts tests/unit/agent-creation-benchmark.test.ts`
  result: pass on 2026-08-07; 7 files, 65 tests.
- command: `bun run format:check`
  result: pass on 2026-08-07.
- command: `bun run lint`
  result: pass on 2026-08-07.
- command: `bun run typecheck`
  result: pass on 2026-08-07.
- command: `bun run test`
  result: pass on 2026-08-07; 170 files, 1,645 tests.
- command: `bun run build`
  result: pass on 2026-08-07.
- command: `AGENTBAY_DIGITALOCEAN_SIZE_SLUG=s-1vcpu-2gb AGENTBAY_HERMES_DOCKER_CPUS=1 AGENTBAY_HERMES_DOCKER_MEMORY=1536m AGENTBAY_HERMES_DOCKER_PIDS_LIMIT=256 bun run repro:cloud-runner`
  result: pass on 2026-08-07; generated cloud-init user-data, schema valid, bash syntax OK.
- command: `docker info --format '{{.ServerVersion}}'`
  result: pass on 2026-08-07; Docker server version 29.3.1.
- command: `bun run test:e2e:ci`
  result: pass on 2026-08-07; 26 tests.
- command: `AGENTBAY_DIGITALOCEAN_SIZE_SLUG=s-1vcpu-2gb AGENTBAY_HERMES_DOCKER_CPUS=1 AGENTBAY_HERMES_DOCKER_MEMORY=1536m AGENTBAY_HERMES_DOCKER_PIDS_LIMIT=256 bun run local:agent:smoke`
  result: historical builder-reported pass; superseded by checker evidence above.
  evidence: checker serialized rerun failed with `No such container: agentbay-local-cloud-runner`;
    the latest checker verdict is FAILED.
- command: `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/plingpling NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run agent:creation:benchmark -- --limit 1`
  result: completed on 2026-08-07; passive read-only report returned the latest local DB row as
    incomplete/invalid, so it is not SLO evidence.
- command: `AGENTBAY_AGENT_CREATION_BENCHMARK_DIGITALOCEAN_AUTHORIZATION=authorize-digitalocean-agent-creation-benchmark bun run agent:creation:benchmark -- --mode digitalocean --trials 1 --authorize-provider-costs --candidate-size-slugs s-1vcpu-2gb`
  result: expected fail-closed stop on 2026-08-07; candidate/authorization gate parsed, then provider
    trial execution remained reserved/unimplemented with no provider effects.

## Decisions And Lessons

- 2026-08-07: A 512 MB host cannot physically satisfy the 1536 MiB Hermes limit; never count swap
  as compatibility. Build/test provider guards with fakes, but defer billable selection and the
  default change to explicit authorization.
