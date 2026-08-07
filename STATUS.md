# Agent Team Status

## Active Work

- issue: [#266](https://github.com/ametel01/plingpling/issues/266)
  owner: checker-agent pending coordinator assignment
  branch: `codex/issue-266-attested-snapshot`
  worktree: `/Users/alexmetelli/source/plingpling-issue-266`
  pr: none
  phase: checker-ready for repository-only scope; final acceptance dependency-blocked
  cycle: 1/5

## Completion Contract

- issue: [#266](https://github.com/ametel01/plingpling/issues/266), “Publish an attested
  DigitalOcean runner snapshot.”
- readiness: Repository-only implementation is ready. Final acceptance is dependency-blocked by the
  failing current-main CI run and by explicit authorization for the one live, billable snapshot
  workflow validation. Neither blocker prevents scripts, workflow, provider boundaries, or local
  tests from being implemented and reviewed now.
- outcome: Add a protected, manually dispatched, repository-owned snapshot pipeline that creates a
  temporary non-user builder only after approval, installs Docker/Caddy and immutable images, runs
  the existing full runner boot contract, removes all credentials and instance identity, powers the
  builder off, publishes an attested region-available snapshot manifest, and verifies cleanup.
  Hosted provisioning may select the snapshot only when its evidence exactly matches the requested
  release; the stock Ubuntu path remains an explicit rollback mode.
- acceptance criteria:
  - The build command and narrow snapshot-provider contract are deterministic under a fake provider,
    accept an `AbortSignal`, use bounded polling/timeouts, and model asynchronous DigitalOcean
    action states (`in-progress`, `completed`, `errored`, timeout, and outcome unknown).
  - Inputs require exact source commit, Ubuntu base image identity, `amd64` architecture, target
    region, runner image digest, default-agent image digest, Hermes index/platform digest, boot
    contract version, and an affirmative cost-authorization sentinel. Mutable/tag-only image input,
    malformed IDs, unsupported architecture, or an absent sentinel fails before provider effects.
  - The builder is uniquely owned by an operation name/tag and is never a user runner or ready
    capacity. It installs Docker and Caddy, preloads all three exact images, installs generic
    systemd/bootstrap assets, and contains no user/agent registration or endpoint state.
  - The existing full boot fixture must pass against the exact preloaded images before sanitation or
    snapshot creation. A missing, failed, expired, or identity-mismatched fixture result blocks the
    snapshot action. Do not weaken or replace the full fixture in #266.
  - Sanitation removes registration and bearer credentials, registry/SSH credentials, agent and
    fixture state, containers and temporary networks, Docker auth, logs/journal and shell history,
    cloud-init instance data, SSH host keys, machine/dbus identity, builder metadata, and temporary
    files. A path scan plus hostile-marker content scan must pass before clean shutdown.
  - Snapshotting starts only after sanitation evidence and authoritative power-off completion.
    DigitalOcean snapshot/action completion alone is insufficient: the resulting image must be read
    back as the expected snapshot and shown available in the configured target region.
  - The canonical, versioned manifest contains only allowlisted evidence: snapshot ID/name, target
    region(s), base image ID/slug, architecture/minimum disk data, exact runner/default-agent/Hermes
    identities, boot contract, source repository/revision, workflow/run identity, validation,
    sanitation, creation and availability timestamps, and an explicit expiry/staleness boundary.
  - The manifest is tamper-evident and immutable at consumption time through a documented,
    offline-verifiable signature/attestation plus canonical digest. Missing signature, unknown key,
    changed bytes, unsupported schema, future/reversed timestamps, or stale evidence fails closed.
  - Production snapshot mode validates manifest authenticity, freshness, source/release identities,
    base image, architecture, region, minimum disk compatibility, and authoritative provider
    availability before every manual or automatic `createRunner` call. Invalid evidence produces
    zero Droplet-create calls. A valid selection passes the numeric snapshot ID as the image.
  - Snapshot first-boot data injects only per-instance endpoint, registration/bearer token, runner
    name, and runtime configuration, then starts the exact preloaded images. It omits apt repository
    setup, package installation, and image pulls while retaining current full readiness semantics.
  - Stock-image mode keeps the current complete bootstrap as a configuration-only rollback. Local
    `local_docker` mode accepts only its existing exact zero-cloud sentinels and can exercise a
    snapshot-equivalent image without any DigitalOcean request.
  - Cleanup is idempotent and ordered. On every safely attributable success, failure, timeout,
    cancellation, and retry path, revoke/delete ephemeral registration tokens, SSH/registry
    credentials and keys, firewall, builder Droplet, and failed/partial snapshot artifacts, then
    prove absence. On ambiguous ownership, do not guess or delete; fail closed with sanitized
    reconciliation evidence and never claim cleanup succeeded.
  - `.github/workflows/build-runner-snapshot.yml` has only `workflow_dispatch`, a non-cancelling
    concurrency group, least-privilege permissions, strict inputs, a protected snapshot-build
    environment, pre-effect authorization validation, bounded execution, `always()` cleanup, and
    artifact attestation/upload only after validation. No push, pull-request, schedule, ordinary CI,
    image-publication, release, or production-deploy trigger may invoke it.
  - The workflow and logs never expose the DigitalOcean token, registration/bearer token, private
    key, registry credential, cloud-init output, environment dump, builder IDs, or arbitrary provider
    responses. Snapshot ID is allowed only in the final manifest/allowlisted summary.
  - `README.md` and `docs/RUNNER_RELEASES.md` document protected-environment setup, token scope,
    inputs, manifest/signature promotion, stock rollback, cleanup/reconciliation, and the rule that a
    manual dispatch without enforceable reviewer protection is forbidden.
  - `PROGRESS.md` and `CHANGELOG.md` preserve existing history. Repository implementation evidence
    may be recorded without claiming a live snapshot. Step 6, snapshot identity, cleanup evidence,
    and issue closure remain pending until an explicitly authorized workflow run succeeds.
- non-goals:
  - No user Droplet, warm pool, spare/ready capacity, onboarding/predictive provisioning,
    cross-user reuse, or builder reuse. A short-lived approved snapshot builder is the only
    pre-request infrastructure in scope and is never assignable to an agent.
  - Do not dispatch the workflow, create/read/delete provider resources, configure GitHub
    environments/secrets, deploy, release, promote production config, or incur provider cost.
  - Do not implement #265 runner-size/default/capacity/swap policy or #269 `release_attested`
    lightweight readiness/release-canary restoration. Per-Droplet full readiness remains active.
  - Do not change QStash/reconciliation cadence, deployment stages, same-user reuse, the one-minute
    SLO benchmark/rollout, public UI/API contracts, or add a database migration.
- likely touchpoints:
  - New snapshot manifest/attestation and build orchestration modules under `src/server/runners/`,
    `scripts/build-runner-snapshot.ts`, `.github/workflows/build-runner-snapshot.yml`, and focused
    provider/manifest/workflow/sanitation tests.
  - `src/server/runners/digitalocean-provider.ts`, `digitalocean-sdk-runtime.js` and `.d.ts` for the
    narrow droplet actions, action polling, snapshot/image read/transfer/delete, and ephemeral-key
    cleanup surface; preserve existing runner-provider behavior.
  - `src/server/env.ts`, `src/server/runners/runner-provisioning.ts`, and
    `src/server/agents/agent-deployment-reconciler.ts` for pure manifest parsing plus async
    pre-create availability checks shared by every hosted create path.
  - `src/server/runners/cloud-runner-bootstrap.ts` for explicit stock versus snapshot-first-boot
    generation; existing boot-self-test/release-identity modules should be reused, not redesigned.
  - `src/server/runners/local-docker-digitalocean-provider.ts`, `scripts/repro-cloud-runner-bootstrap.ts`,
    `scripts/smoke-local-agent-cycle.ts`, `package.json`, `README.md`, `docs/RUNNER_RELEASES.md`,
    `PROGRESS.md`, and `CHANGELOG.md`.
- required tests / gates:
  - Manifest fixtures: stable canonical bytes/digest; valid signature; tamper, wrong key/schema,
    missing fields, wrong region/base/arch/source/boot/image identity, future/reversed/expired times,
    minimum-disk mismatch, and hostile unknown fields all fail closed without echoing values.
  - Provider/build fixtures: success; boot failure; sanitation failure; shutdown/action error;
    timeout/abort; unavailable/wrong-region image; safe retry; duplicate ownership; ambiguous create or
    delete outcome; partial snapshot removal; ordered token/key/firewall/Droplet cleanup; verified
    absence. Assert exact effect order and zero unowned deletion.
  - Provisioning fixtures cover every manual/automatic create entry: invalid or unavailable evidence
    never calls `createRunner`; valid snapshot uses its numeric ID; stock rollback and exact local
    sentinels still work; no config path logs secrets or manifest source payloads.
  - Workflow static tests parse YAML and prove dispatch-only triggering, protected environment,
    authorization-before-secret/provider work, least privilege, bounded timeouts, non-cancelling
    concurrency, unconditional cleanup, attested allowlisted artifact, and no DigitalOcean secret in
    `.github/workflows/ci.yml`, `publish-agent-image.yml`, or `deploy-production.yml`.
  - Bootstrap/sanitation tests prove snapshot first boot has no apt/package/image-pull work, starts
    exact preloaded identities, still runs full readiness, and forbids every credential/identity path;
    stock bootstrap remains covered. Add adversarial secret and shell-injection fixtures.
  - Focused gate through `bun scripts/run-unit-tests.ts` for new tests plus `server-env`,
    `digitalocean-provider`, `digitalocean-sdk-runtime`, `cloud-runner-bootstrap`, runner provisioning,
    automatic provisioning, runner-release workflow/smoke, local-agent smoke, and secret redaction.
  - Then run `bun run format:check`, `bun run lint`, `bun run typecheck`, `bun run test`,
    `bun run build`, `bun run test:e2e:ci`, `bun run repro:cloud-runner` with snapshot-mode first-boot
    data, and `bun run local:agent:smoke` with a local snapshot-equivalent image.
  - Do not run the protected DigitalOcean workflow. After separate explicit approval, one authorized
    run must prove manifest/artifact attestation and absence of builder/firewall/credential leftovers
    before Step 6 or #266 can be marked complete.
- security / data / migration risks:
  - Current stock cloud-init contains registration/bearer tokens and instance endpoint data; none may
    enter the reusable image. Docker auth, cloud-init state, machine identity, SSH keys, logs, and the
    boot fixture are additional persistence surfaces.
  - DigitalOcean actions are asynchronous; action completion, snapshot existence, target-region
    availability, and minimum disk compatibility are separate facts. Outcome-unknown handling must
    prefer orphan evidence over deleting a possibly unowned resource.
  - Multi-architecture index digests are not the selected `amd64` manifest digest. The snapshot must
    attest both where applicable and cannot silently accept a different platform image.
  - #265 may change size selection in parallel; #266 consumes the selected size/minimum-disk result
    but must not choose it. Rebase and preserve whichever #265 contract merges first.
  - External GitHub environment reviewer enforcement cannot be proven by repository YAML alone;
    docs and live validation must verify it before dispatch. No schema/data migration is expected.
- do not touch:
  - Preserve unrelated PR #262, `/Users/alexmetelli/source/plingpling-step7-base`, existing changelog
    history, provider operation tags/idempotency, fail-closed cleanup ownership, current full boot
    fixture, production canary bypass state, and ordinary CI/release secret boundaries.
  - Do not put a DigitalOcean token into CI, `publish-agent-image.yml`, or
    `deploy-production.yml`; do not make snapshot publication automatic; do not weaken immutable
    runner/Hermes release checks or leak arbitrary manifest/provider objects into logs.
- dependency blockers:
  - Resolved upstream: #263 closed through merged PR #272 at
    `7d1cb985c06b0007dadcfb0e42c5631c65b7c472`; #266 is based exactly on that `origin/main` commit.
  - Merge-gate dependency: current-main CI run
    [31131392382](https://github.com/ametel01/plingpling/actions/runs/31131392382) fails because the
    real-Docker unit fixture could not reach the GitHub runner Docker daemon. No tracking issue or
    successful rerun exists. The builder may proceed, but checker/coordinator must reproduce or rerun
    and resolve/explicitly classify this baseline before merge acceptance.
  - Live-acceptance dependency: explicit user authorization, cost budget, protected environment,
    scoped DigitalOcean credentials, and signing/attestation key configuration are absent by design.
    Stop before provider execution; repository implementation is still agent-actionable.
  - #265 is a parallel coordination stream, not a blocker. #269 and #271 are downstream issues
    blocked by #266 and must not be pulled into this PR. No open linked PR or review thread exists.
- open questions:
  - No blocker for repository implementation. The builder may select the versioned canonical JSON
    and offline verification mechanism, protected environment name, and bounded snapshot maximum age,
    but must document them and satisfy every fail-closed/tamper/staleness fixture above.
  - Before live dispatch, the coordinator must obtain explicit answers for cost ceiling/region,
    protected reviewers, scoped token/key owners, manifest promotion destination, and orphan-response
    ownership. Do not infer those operational decisions from merge permission.

## Handoffs

- from: issue-spec-agent (`issue_266_spec`)
  to: coordinator, then builder-agent
  timestamp: 2026-08-07T07:42:22+08:00
  request: Implement only the repository-owned #266 snapshot/manifest/workflow/local-test contract;
    stop before all provider, secret, environment, deployment, and billable effects.
  evidence: Issue/dependency graph, PLAN Step 6, merged PR #272, relevant implementation/tests/docs,
    current-main CI, and provider semantics were inspected at clean `origin/main` `7d1cb98`.
  next-action: Coordinator assigns one builder. Builder begins with manifest/provider interfaces and
    fake fail-closed tests, then snapshot first-boot/preflight/workflow. Checker tests the real
    config-to-preflight-to-create sequence and cleanup effect ordering, not isolated parsers.
- from: builder-agent (`issue_266_builder`)
  to: checker-agent
  timestamp: 2026-08-07T08:10:00+08:00
  request: Verify repository-only #266 implementation against the completion contract. Do not run the
    protected DigitalOcean workflow or any billable/provider-backed operation.
  evidence: Implemented signed canonical snapshot manifests, fail-closed snapshot manifest/provider
    availability selection, protected manual workflow, snapshot build script/orchestrator, fake
    provider image/action/cleanup tracing, snapshot first-boot mode without apt/package/image pulls,
    stock rollback, env config, docs, and local gate evidence.
  next-action: Checker should rerun format/lint/typecheck, focused snapshot tests, full unit/build as
    needed, inspect workflow static guarantees, and confirm invalid snapshot evidence creates zero
    Droplet-create calls. Live snapshot acceptance remains authorization-gated.

## Gates

- baseline/branch: pass — clean #266 branch and `origin/main` at `7d1cb985c06b0007dadcfb0e42c5631c65b7c472`.
- issue graph: pass — #263/#272 resolved; #265 parallel; #269/#271 downstream; no #266 review thread.
- current-main CI: fail — run `31131392382` lost Docker at `create-agent-db.test.ts:3627`;
  168/169 files and 1,637/1,638 tests otherwise passed.
- builder targeted unit: pass —
  `bun scripts/run-unit-tests.ts tests/unit/runner-snapshot-manifest.test.ts
  tests/unit/runner-snapshot-build.test.ts tests/unit/runner-snapshot-workflow.test.ts
  tests/unit/cloud-runner-bootstrap.test.ts tests/unit/server-env.test.ts
  tests/unit/digitalocean-provider.test.ts` (6 files, 50 tests).
- builder format/lint/typecheck: pass — `bun run format:check`, `bun run lint`,
  `bun run typecheck`.
- builder full unit: pass — `bun run test` (172 files, 1,646 tests).
- builder production build: pass — `bun run build`.
- skipped live/billable: protected snapshot workflow dispatch, DigitalOcean resource/snapshot
  creation or deletion, GitHub environment/secret configuration, production deploy/release, and
  provider-backed Step 6 acceptance.

## Completed

- [#263](https://github.com/ametel01/plingpling/issues/263) / merged
  [PR #272](https://github.com/ametel01/plingpling/pull/272) at `7d1cb98`; prior evidence is in history.
