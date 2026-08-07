# Agent Team Status

## Active Work

- issue: [#266](https://github.com/ametel01/plingpling/issues/266)
  owner: checker-agent (`issue_266_checker`)
  branch: `codex/issue-266-attested-snapshot`
  worktree: `/Users/alexmetelli/source/plingpling-issue-266`
  pr: none
  phase: checker-ready after cycle-4 SSH security fixes
  cycle: 4/5

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
    [31131392382](https://github.com/ametel01/plingpling/actions/runs/31131392382) completed
    successfully at 2026-08-07T00:22:32Z.
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
- from: builder-agent (`issue_266_builder`)
  to: checker-agent
  timestamp: 2026-08-07T08:36:00+08:00
  request: Re-check #266 cycle 2 fixes. Do not dispatch the protected workflow, contact
    DigitalOcean, configure secrets/environments, deploy, release, or run billable effects.
  evidence: Fixed checker gaps by moving temporary-builder Docker/Caddy install ahead of image use,
    adding builder-local preloaded-image boot evidence and sanitation removal/hostile-marker scan
    requirements, polling power-off and snapshot actions through `readAction`, enforcing ordered
    owned firewall-before-Droplet cleanup with absence proof and ambiguous-ownership no-delete
    evidence, adding manifest artifact provenance attestation before upload, and adding adversarial
    manifest/provider/workflow/shell/zero-create tests.
  next-action: Checker should rerun focused snapshot/provisioning tests, inspect the workflow
    evidence/attestation ordering, verify action polling/cleanup order, and leave local smoke for a
    serialized run because the Docker Compose namespace is shared.
- from: builder-agent (`issue_266_builder`)
  to: checker-agent
  timestamp: 2026-08-07T09:00:00+08:00
  request: Re-check the four cycle-2 orchestration blockers only. Do not dispatch the protected
    workflow, contact DigitalOcean, configure secrets/environments, deploy, release, or run
    billable effects.
  evidence: The snapshot build script now validates static inputs before effects, creates an
    ephemeral SSH key, creates the builder, retrieves builder-local
    `/run/agentbay-snapshot-builder/boot-result.json` and `sanitation-result.json` through the
    provider, writes retrieved evidence artifacts, and validates them after the producer step in the
    workflow. The orchestrator validates retrieved evidence before poweroff/snapshot, polls actions,
    resolves the created snapshot image by exact name, rejects action-ID/image-ID conflation, reads
    authoritative image availability by the resolved image ID, and deletes the ephemeral SSH key in
    cleanup. Fake provider action IDs and image IDs are now distinct.
  next-action: Checker should rerun the focused #266 tests and inspect the script/workflow ordering,
    builder evidence retrieval path, image resolution path, and fake action/image ID separation.
    Local smoke remains serialized because the Docker Compose namespace is shared.

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
- checker targeted unit: pass —
  `bun scripts/run-unit-tests.ts tests/unit/runner-snapshot-manifest.test.ts
  tests/unit/runner-snapshot-build.test.ts tests/unit/runner-snapshot-workflow.test.ts
  tests/unit/cloud-runner-bootstrap.test.ts tests/unit/server-env.test.ts
  tests/unit/digitalocean-provider.test.ts` (6 files, 50 tests).
- checker format: pass — `bun run format:check` checked 405 files, no fixes applied.
- checker lint: pass — `bun run lint` checked 405 files, no fixes applied.
- checker typecheck: pass — `bun run typecheck` ran `next typegen && tsc --noEmit`.
- checker full unit: pass — `bun run test` (172 files, 1,646 tests, duration 111.51s).
- checker production build: pass — `bun run build` completed `next build`.
- checker E2E CI: pass — `bun run test:e2e:ci` (26/26 Playwright tests passed).
- checker cloud-runner repro: pass — `bun run repro:cloud-runner` validated stock generated
  user-data; temp-generated snapshot-mode user-data passed `bun run repro:cloud-runner --
  --user-data <temp>/snapshot-user-data.yaml` with valid cloud-init schema and 8 bash script
  blocks checked.
- checker local agent smoke: fail — `bun run local:agent:smoke` exited 1 before smoke assertions:
  `Error response from daemon: No such container: agentbay-local-cloud-runner` and
  `Error: docker compose failed with exit 1.`
- cycle-2 builder focused unit: pass —
  `bun scripts/run-unit-tests.ts tests/unit/runner-snapshot-build.test.ts
  tests/unit/runner-snapshot-manifest.test.ts tests/unit/runner-snapshot-workflow.test.ts
  tests/unit/runner-provisioning.test.ts tests/unit/automatic-runner-provisioning.test.ts
  tests/unit/cloud-runner-bootstrap.test.ts tests/unit/server-env.test.ts
  tests/unit/digitalocean-provider.test.ts` (8 files, 89 tests).
- cycle-2 builder format/lint/typecheck: pass — `bun run format:check`, `bun run lint`,
  `bun run typecheck`.
- cycle-2 builder full unit: pass — `bun run test` (172 files, 1,663 tests).
- cycle-2 builder production build: pass — `bun run build`.
- cycle-2 builder E2E CI: pass — `bun run test:e2e:ci` (26/26 Playwright tests passed).
- cycle-2 builder cloud-runner repro: pass — `bun run repro:cloud-runner` validated generated
  stock user-data schema and 11 bash script blocks.
- cycle-2 builder diff check: pass — `git diff --check`.
- cycle-2 local agent smoke: skipped by coordinator direction because #265/#266 share the
  `agentbay-local-cloud-runner` Docker Compose namespace; leave for serialized checker rerun.
- cycle-2 checker static review: fail — workflow requires
  `snapshot-artifacts/boot-result.json` and `snapshot-artifacts/sanitation-result.json` before the
  build script creates the builder, and the snapshot manifest path uses DigitalOcean action ID as the
  snapshot image ID.
- cycle-2 checker focused unit: pass —
  `bun scripts/run-unit-tests.ts tests/unit/runner-snapshot-build.test.ts
  tests/unit/runner-snapshot-manifest.test.ts tests/unit/runner-snapshot-workflow.test.ts
  tests/unit/runner-provisioning.test.ts tests/unit/automatic-runner-provisioning.test.ts
  tests/unit/cloud-runner-bootstrap.test.ts tests/unit/server-env.test.ts
  tests/unit/digitalocean-provider.test.ts` (8 files, 89 tests).
- cycle-2 checker format/lint/typecheck: pass — `bun run format:check`, `bun run lint`,
  `bun run typecheck`.
- cycle-2 checker production build: pass — `bun run build`.
- cycle-2 checker full unit: fail — `bun run test` failed 2 tests by 5s timeout:
  `tests/unit/create-agent-db.test.ts:3652` and `tests/unit/create-agent-db.test.ts:4469`
  (1 failed file, 171 passed files, 2 failed tests, 1,661 passed tests). Focused rerun
  `bun scripts/run-unit-tests.ts tests/unit/create-agent-db.test.ts` passed (127 tests).
- cycle-2 checker E2E CI: pass — `bun run test:e2e:ci` (26/26 Playwright tests passed).
- cycle-2 checker cloud-runner repro: pass — `bun run repro:cloud-runner` validated generated
  stock user-data schema and 11 bash script blocks; temp-generated snapshot-mode user-data passed
  `bun run repro:cloud-runner -- --user-data <temp>/snapshot-user-data.yaml` with valid cloud-init
  schema and 8 bash script blocks checked.
- cycle-2 checker local agent smoke: skipped by instruction because #265 owns the shared Docker
  Compose namespace.
- cycle-3 builder focused unit: pass —
  `bun scripts/run-unit-tests.ts tests/unit/runner-snapshot-build.test.ts
  tests/unit/runner-snapshot-manifest.test.ts tests/unit/runner-snapshot-workflow.test.ts
  tests/unit/runner-provisioning.test.ts tests/unit/automatic-runner-provisioning.test.ts
  tests/unit/cloud-runner-bootstrap.test.ts tests/unit/server-env.test.ts
  tests/unit/digitalocean-provider.test.ts` (8 files, 92 tests).
- cycle-3 builder format/lint/typecheck: pass — `bun run format:check`, `bun run lint`,
  `bun run typecheck`.
- cycle-3 builder production build: pass — `bun run build`.
- cycle-3 builder full unit: pass — `bun run test` (172 files, 1,666 tests).
- cycle-3 builder E2E CI: pass — `bun run test:e2e:ci` (26/26 Playwright tests passed).
- cycle-3 builder cloud-runner repro: pass — `bun run repro:cloud-runner` validated generated
  stock user-data schema and 11 bash script blocks.
- cycle-3 builder diff check: pass — `git diff --check`.
- cycle-3 local agent smoke: skipped by coordinator direction because #265/#266 share the
  `agentbay-local-cloud-runner` Docker Compose namespace; leave for serialized checker rerun.
- cycle-3 checker prior-blocker review: partial pass — controller now creates an ephemeral key,
  workflow ordering is producer-then-validation, builder evidence is read before poweroff/snapshot,
  and fake action/image IDs are distinct; fail on pre-effect/provider-effect ordering and open SSH
  firewall exposure.
- cycle-3 checker focused unit: pass —
  `bun scripts/run-unit-tests.ts tests/unit/runner-snapshot-build.test.ts
  tests/unit/runner-snapshot-manifest.test.ts tests/unit/runner-snapshot-workflow.test.ts
  tests/unit/runner-provisioning.test.ts tests/unit/automatic-runner-provisioning.test.ts
  tests/unit/cloud-runner-bootstrap.test.ts tests/unit/server-env.test.ts
  tests/unit/digitalocean-provider.test.ts` (8 files, 92 tests).
- cycle-3 checker format/lint/typecheck: pass — `bun run format:check`, `bun run lint`,
  `bun run typecheck`.
- cycle-3 checker full unit: pass — `bun run test` (172 files, 1,666 tests).
- cycle-3 checker production build: pass — `bun run build`.
- cycle-3 checker E2E CI: pass — `bun run test:e2e:ci` (26/26 Playwright tests passed).
- cycle-3 checker cloud-runner repro: pass — `bun run repro:cloud-runner` validated generated
  stock user-data schema and 11 bash script blocks; temp-generated snapshot-mode user-data passed
  `bun run repro:cloud-runner -- --user-data <temp>/snapshot-user-data.yaml` with valid cloud-init
  schema and 8 bash script blocks checked.
- cycle-3 checker local agent smoke: skipped by instruction because #265 owns the shared Docker
  Compose namespace.
- skipped live/billable: protected snapshot workflow dispatch, DigitalOcean resource/snapshot
  creation or deletion, GitHub environment/secret configuration, production deploy/release, and
  provider-backed Step 6 acceptance.

## Checker Result

Status: FAILED

## Commands

- command: `git status --short --branch --untracked-files=all`
  result: pass
  evidence: branch `codex/issue-266-attested-snapshot` is ahead of `origin/main` by 2; only
    `STATUS.md` is modified by checker evidence.
- command: `gh pr list --repo ametel01/plingpling --head codex/issue-266-attested-snapshot --json ...`
  result: blocked
  evidence: returned `[]`; there is no PR to merge.
- command: `bun scripts/run-unit-tests.ts tests/unit/runner-snapshot-manifest.test.ts tests/unit/runner-snapshot-build.test.ts tests/unit/runner-snapshot-workflow.test.ts tests/unit/cloud-runner-bootstrap.test.ts tests/unit/server-env.test.ts tests/unit/digitalocean-provider.test.ts`
  result: pass
  evidence: 6 files, 50 tests passed.
- command: `bun run format:check`
  result: pass
  evidence: 405 files checked, no fixes applied.
- command: `bun run lint`
  result: pass
  evidence: 405 files checked, no fixes applied.
- command: `bun run typecheck`
  result: pass
  evidence: `next typegen && tsc --noEmit` completed.
- command: `bun run test`
  result: pass
  evidence: 172 files, 1,646 tests passed.
- command: `bun run build`
  result: pass
  evidence: `next build` completed successfully.
- command: `bun run test:e2e:ci`
  result: pass
  evidence: 26/26 Playwright tests passed.
- command: `bun run repro:cloud-runner`
  result: pass
  evidence: stock generated user-data passed cloud-init schema and bash syntax validation.
- command: `bun run repro:cloud-runner -- --user-data <temp>/snapshot-user-data.yaml`
  result: pass
  evidence: snapshot-mode user-data passed cloud-init schema and 8 bash script blocks checked.
- command: `bun run local:agent:smoke`
  result: failed
  evidence: exited 1 with `No such container: agentbay-local-cloud-runner`; Docker daemon was
    reachable (`docker info --format '{{.ServerVersion}}'` returned `29.3.1`).

## Failures

- file: `.github/workflows/build-runner-snapshot.yml:86`
  check: full boot fixture must pass against the exact preloaded builder image before sanitation or
    snapshot creation.
  exact error: workflow runs `bun run runner:release:smoke -- --image "${{ inputs.runner_image }}"
    --provider digitalocean` on the GitHub runner before `scripts/build-runner-snapshot.ts` creates
    the builder Droplet, so it does not validate the actual builder, preloaded image set, or snapshot
    candidate.
  likely owner: builder-agent (`issue_266_builder`).
- file: `.github/workflows/build-runner-snapshot.yml:105`
  check: sanitation must remove credentials/identity/logs/state and prove absence with path and
    hostile-marker scans.
  exact error: workflow synthesizes `sanitation-result.json` with `"ok": true`,
    `"forbiddenPathsAbsent": true`, and `"hostileMarkersAbsent": true`; no sanitation command or scan
    is executed.
  likely owner: builder-agent (`issue_266_builder`).
- file: `src/server/runners/runner-snapshot-build.ts:265`
  check: builder bootstrap must install Docker/Caddy and preload exact images.
  exact error: `buildSnapshotBuilderBootstrap` lists `caddy` packages and then executes `docker pull`
    at lines 280-282, but it never installs/enables Docker (`docker-ce`, Docker repo apt source, or
    equivalent) before using `docker`.
  likely owner: builder-agent (`issue_266_builder`).
- file: `src/server/runners/runner-snapshot-build.ts:156`
  check: DigitalOcean power-off/snapshot actions require bounded polling of asynchronous action
    states.
  exact error: implementation directly requires `powerOffResource(...).value.status === "completed"`
    and `snapshotResource(...).value.status === "completed"` and never calls the provider
    `readAction` method required by the contract for `in-progress`, completed, errored, timeout, or
    unknown outcomes.
  likely owner: builder-agent (`issue_266_builder`).
- file: `src/server/runners/runner-snapshot-build.ts:249`
  check: cleanup must be ordered/idempotent and cover SSH/registry credentials, firewall, Droplet,
    partial snapshots, safe absence, ambiguous ownership, abort, and unknown outcomes.
  exact error: finalizer only calls `deleteImage` for a tracked partial snapshot and
    `cleanupResource` for the builder; it has no firewall/key/credential cleanup, absence proof,
    ambiguous ownership guard, or action-outcome reconciliation.
  likely owner: builder-agent (`issue_266_builder`).
- file: `.github/workflows/build-runner-snapshot.yml:150`
  check: manifest artifact must be attested/uploaded only after validation.
  exact error: workflow grants `attestations: write` and `id-token: write` but has no
    `actions/attest-build-provenance` or equivalent attestation step before upload.
  likely owner: builder-agent (`issue_266_builder`).
- file: `tests/unit/runner-snapshot-manifest.test.ts:51`
  check: required negative fixtures must cover wrong key/schema/time/region/base/arch/source/boot
    image/min-disk/unknown-field/provider-unavailable and zero Droplet creates on every manual and
    automatic create path.
  exact error: tests cover only tamper, unknown top-level field, stale evidence, and one runner
    identity mismatch; no tests exercise `createDigitalOceanRunnerForUser` or
    `advanceAutomaticDigitalOceanRunnerProvisioning` with invalid snapshot evidence and assert zero
    `createRunner` calls.
  likely owner: builder-agent (`issue_266_builder`).

## Coverage Gaps

- Protected DigitalOcean workflow was not dispatched; no live Droplet/snapshot/secret/environment
  effects were authorized.
- GitHub protected environment reviewer enforcement cannot be proven from repository YAML alone.
- Current-main CI run `31131392382` was still in progress at 2026-08-07T00:22:38Z.
- `bun run local:agent:smoke` failed in local Docker Compose setup before reaching the snapshot
  equivalence assertions.

## Next Action

- Builder must fix the contract failures above and add adversarial tests for the missing semantic
  cases before coordinator pushes/opens/merges any PR. There is currently no GitHub PR for this
  branch, and checker verdict is not merge-ready.

## Checker Result - Cycle 2

Status: FAILED

## Commands

- command: `git status --short --branch --untracked-files=all`
  result: pass
  evidence: branch `codex/issue-266-attested-snapshot` is ahead of `origin/main` by 4; only
    `STATUS.md` is modified by checker evidence.
- command: `gh pr list --repo ametel01/plingpling --head codex/issue-266-attested-snapshot --json ...`
  result: blocked
  evidence: returned `[]`; there is still no PR to merge.
- command: `gh run view 31131392382 --repo ametel01/plingpling --json status,conclusion,url,updatedAt,jobs`
  result: pass
  evidence: current-main CI run `31131392382` conclusion `success`; job `Verification gates`
    completed successfully.
- command: `git diff --check`
  result: pass
  evidence: no whitespace errors reported.
- command: `bun scripts/run-unit-tests.ts tests/unit/runner-snapshot-build.test.ts tests/unit/runner-snapshot-manifest.test.ts tests/unit/runner-snapshot-workflow.test.ts tests/unit/runner-provisioning.test.ts tests/unit/automatic-runner-provisioning.test.ts tests/unit/cloud-runner-bootstrap.test.ts tests/unit/server-env.test.ts tests/unit/digitalocean-provider.test.ts`
  result: pass
  evidence: 8 files, 89 tests passed.
- command: `bun run format:check`
  result: pass
  evidence: 405 files checked, no fixes applied.
- command: `bun run lint`
  result: pass
  evidence: 405 files checked, no fixes applied.
- command: `bun run typecheck`
  result: pass
  evidence: `next typegen && tsc --noEmit` completed.
- command: `bun run test`
  result: failed
  evidence: 1 failed file, 171 passed files, 2 failed tests, 1,661 passed tests. Timeouts:
    `tests/unit/create-agent-db.test.ts:3652` and `tests/unit/create-agent-db.test.ts:4469`.
- command: `bun scripts/run-unit-tests.ts tests/unit/create-agent-db.test.ts`
  result: pass
  evidence: focused rerun passed 1 file, 127 tests.
- command: `bun run build`
  result: pass
  evidence: `next build` completed successfully.
- command: `bun run test:e2e:ci`
  result: pass
  evidence: 26/26 Playwright tests passed.
- command: `bun run repro:cloud-runner`
  result: pass
  evidence: stock generated user-data passed cloud-init schema and 11 bash script blocks.
- command: `bun run repro:cloud-runner -- --user-data <temp>/snapshot-user-data.yaml`
  result: pass
  evidence: snapshot-mode user-data passed cloud-init schema and 8 bash script blocks.
- command: `bun run local:agent:smoke`
  result: skipped
  evidence: coordinator directed checker not to run local smoke while #265 owns the shared
    `agentbay-local-cloud-runner` Docker Compose namespace.

## Failures

- file: `.github/workflows/build-runner-snapshot.yml:89`
  check: workflow must produce real builder/preloaded boot evidence before snapshot creation.
  exact error: workflow checks `snapshot-artifacts/boot-result.json` at line 96 before
    `scripts/build-runner-snapshot.ts` runs at line 142. No prior step creates, downloads, or
    retrieves that file from the temporary builder, so the protected workflow is not executable.
  likely owner: builder-agent (`issue_266_builder`).
- file: `.github/workflows/build-runner-snapshot.yml:112`
  check: workflow must produce real sanitation/removal/hostile-marker evidence before snapshot
    creation.
  exact error: workflow checks `snapshot-artifacts/sanitation-result.json` at line 115 before the
    build script creates the builder, and no step retrieves `/run/agentbay-snapshot-builder/*` from
    the builder. This fails closed before any manifest can be built.
  likely owner: builder-agent (`issue_266_builder`).
- file: `scripts/build-runner-snapshot.ts:24`
  check: build command should create the builder, collect actual builder-local boot/sanitation
    evidence, then validate it.
  exact error: script reads local `--boot-result` and `--sanitation-result` files before calling
    `buildRunnerSnapshot`; it has no SSH/metadata/provider path to fetch the evidence generated by
    `buildSnapshotBuilderBootstrap`.
  likely owner: builder-agent (`issue_266_builder`).
- file: `src/server/runners/runner-snapshot-build.ts:245`
  check: manifest snapshot ID must be the resulting DigitalOcean image ID, not the action ID.
  exact error: implementation sets `snapshotId = snapshot.action.id`, then reads
    `readImageAvailability({ imageId: snapshotId })` and emits that value in the manifest. The
    DigitalOcean provider returns action IDs from `snapshotResource`/`readAction`; the fake provider
    masks this by accepting any image ID.
  likely owner: builder-agent (`issue_266_builder`).
- file: `tests/unit/runner-snapshot-workflow.test.ts:24`
  check: workflow static tests should prove evidence is produced/retrieved before validation, not
    only that validation strings exist.
  exact error: test asserts the workflow contains `Require builder-produced boot evidence` and
    `Require builder-produced sanitation evidence`, but does not fail when those files have no
    producer step.
  likely owner: builder-agent (`issue_266_builder`).
- file: `tests/unit/runner-snapshot-build.test.ts:51`
  check: fake provider tests should distinguish snapshot action IDs from image IDs.
  exact error: success path expects manifest image `"1102"` because fake `snapshotResource` action
    ID and fake `readImageAvailability` image ID are conflated; no test asserts the manifest uses a
    provider-confirmed snapshot image ID.
  likely owner: builder-agent (`issue_266_builder`).
- file: `tests/unit/create-agent-db.test.ts:3652`
  check: aggregate full unit gate.
  exact error: `bun run test` timed out this test after 5000ms. Focused rerun of
    `tests/unit/create-agent-db.test.ts` passed, so this is likely load/timing-sensitive, but the
    aggregate gate is not green.
  likely owner: shared test/gate stability; coordinator or builder if it repeats after semantic
    fixes.
- file: `tests/unit/create-agent-db.test.ts:4469`
  check: aggregate full unit gate.
  exact error: `bun run test` timed out this test after 5000ms. Focused rerun of
    `tests/unit/create-agent-db.test.ts` passed.
  likely owner: shared test/gate stability; coordinator or builder if it repeats after semantic
    fixes.

## Coverage Gaps

- Protected DigitalOcean workflow was not dispatched; no live Droplet/snapshot/secret/environment
  effects were authorized.
- GitHub protected environment reviewer enforcement cannot be proven from repository YAML alone.
- Local agent smoke was intentionally skipped because #265 owns the shared Docker Compose namespace.
- The current fake provider does not model a separate action ID and snapshot image ID, so snapshot
  image identity selection is not verified.

## Next Action

- Builder must make the snapshot workflow/build script executable end-to-end in repository scope:
  create the builder, retrieve the actual builder-local boot/sanitation evidence, validate it, poll
  the snapshot action, discover/read the resulting image ID, and update tests so fake action IDs and
  image IDs cannot be conflated. Do not open or merge a PR yet.

## Checker Result - Cycle 3

Status: FAILED

## Commands

- command: `git status --short --branch --untracked-files=all`
  result: pass
  evidence: branch `codex/issue-266-attested-snapshot` is ahead of `origin/main` by 6; only
    `STATUS.md` is modified by checker evidence.
- command: `gh pr list --repo ametel01/plingpling --head codex/issue-266-attested-snapshot --json ...`
  result: blocked
  evidence: returned `[]`; there is still no PR to merge.
- command: `git diff --check`
  result: pass
  evidence: no whitespace errors reported.
- command: `bun scripts/run-unit-tests.ts tests/unit/runner-snapshot-build.test.ts tests/unit/runner-snapshot-manifest.test.ts tests/unit/runner-snapshot-workflow.test.ts tests/unit/runner-provisioning.test.ts tests/unit/automatic-runner-provisioning.test.ts tests/unit/cloud-runner-bootstrap.test.ts tests/unit/server-env.test.ts tests/unit/digitalocean-provider.test.ts`
  result: pass
  evidence: 8 files, 92 tests passed.
- command: `bun run format:check`
  result: pass
  evidence: 405 files checked, no fixes applied.
- command: `bun run lint`
  result: pass
  evidence: 405 files checked, no fixes applied.
- command: `bun run typecheck`
  result: pass
  evidence: `next typegen && tsc --noEmit` completed.
- command: `bun run test`
  result: pass
  evidence: 172 files, 1,666 tests passed.
- command: `bun run build`
  result: pass
  evidence: `next build` completed successfully.
- command: `bun run test:e2e:ci`
  result: pass
  evidence: 26/26 Playwright tests passed.
- command: `bun run repro:cloud-runner`
  result: pass
  evidence: stock generated user-data passed cloud-init schema and 11 bash script blocks.
- command: `bun run repro:cloud-runner -- --user-data <temp>/snapshot-user-data.yaml`
  result: pass
  evidence: snapshot-mode user-data passed cloud-init schema and 8 bash script blocks.
- command: `bun run local:agent:smoke`
  result: skipped
  evidence: coordinator directed checker not to run local smoke while #265 owns the shared
    `agentbay-local-cloud-runner` Docker Compose namespace.

## Failures

- file: `scripts/build-runner-snapshot.ts:31`
  check: all pre-effect authorization validation must happen before provider effects, and cleanup
    must cover failure after any created ephemeral credential.
  exact error: script validates the CLI sentinel in `validatePreEffectArgs`, but then creates a
    DigitalOcean SSH key at lines 31-37 before calling `buildRunnerSnapshot`, whose own sentinel and
    provider contract checks run later. If `buildRunnerSnapshot` rejects after this point, the local
    temp key is removed by `rm(tempDir)`, but the provider SSH key created in the controller script is
    not deleted by the controller; cleanup is delegated to a function that may never receive control
    if the controller throws between lines 31 and 43.
  likely owner: builder-agent (`issue_266_builder`).
- file: `src/server/runners/runner-snapshot-build.ts:176`
  check: temporary builder SSH exposure should be least-privilege/bounded for evidence retrieval.
  exact error: builder firewall is opened to `sshSourceAddresses: ["0.0.0.0/0", "::/0"]` for the
    snapshot builder. The contract requires protected/manual/least-privilege behavior and careful
    secret handling; world-open root SSH on a billable snapshot builder is not acceptable without a
    runner-IP restriction or other narrower retrieval channel.
  likely owner: builder-agent (`issue_266_builder`).
- file: `src/server/runners/digitalocean-provider.ts:1253`
  check: SSH evidence retrieval should avoid trust-on-first-use ambiguity where practical for a
    security-sensitive snapshot builder.
  exact error: retrieval uses `StrictHostKeyChecking=accept-new` with a temp known-hosts file. This
    avoids host-key persistence but still accepts the first host key over a world-open SSH path; no
    host key fingerprint/source restriction is asserted.
  likely owner: builder-agent (`issue_266_builder`).
- file: `tests/unit/runner-snapshot-workflow.test.ts:59`
  check: tests should fail on provider SSH key leak and world-open builder SSH exposure.
  exact error: workflow/build tests assert `ssh-keygen`, `provider.createSshKey`, and evidence output
    paths exist, but no test asserts `deleteSshKey` runs if creation succeeds and later validation
    fails, and no test rejects `0.0.0.0/0` / `::/0` in the snapshot-builder firewall path.
  likely owner: builder-agent (`issue_266_builder`).

## Coverage Gaps

- Protected DigitalOcean workflow was not dispatched; no live Droplet/snapshot/secret/environment
  effects were authorized.
- GitHub protected environment reviewer enforcement cannot be proven from repository YAML alone.
- Local agent smoke was intentionally skipped because #265 owns the shared Docker Compose namespace.
- Evidence retrieval over SSH is only statically/fake-provider validated; no live host-key or network
  behavior was exercised.

## Next Action

- Builder should move provider SSH key cleanup responsibility into controller-level `finally` or
  otherwise prove no created key can leak before `buildRunnerSnapshot` takes ownership, restrict the
  snapshot-builder evidence retrieval path to a least-privilege source or non-SSH provider channel,
  and add tests that fail on world-open SSH and leaked provider keys. Do not open or merge a PR yet.

## Builder Handoff - Cycle 4

- request: Re-check the SSH security fixes for #266. Do not dispatch the protected workflow, contact
  DigitalOcean, configure secrets/environments, deploy, release, or run billable effects.
- files changed: `.github/workflows/build-runner-snapshot.yml`,
  `scripts/build-runner-snapshot.ts`, `src/server/runners/runner-snapshot-build.ts`,
  `src/server/runners/digitalocean-provider.ts`, `docs/RUNNER_RELEASES.md`,
  `tests/unit/runner-snapshot-build.test.ts`, `tests/unit/runner-snapshot-workflow.test.ts`, and
  `tests/unit/digitalocean-provider.test.ts`.
- behavior: The protected workflow now resolves the GitHub runner controller egress identity before
  the DigitalOcean-token step and passes only an exact `/32` IPv4 or `/128` IPv6 CIDR to the
  snapshot builder. The build script validates `--controller-cidr` before provider effects, tracks
  the provider-created SSH key immediately, and deletes it in a controller-level `finally` if the
  orchestrator did not record deletion. The snapshot builder firewall uses that controller CIDR for
  SSH and disables public web ingress. Provider evidence retrieval pins an ephemeral host key into a
  temporary `known_hosts`, optionally enforces a `SHA256:` fingerprint, uses
  `StrictHostKeyChecking=yes`, and removes temp known-hosts material. Cleanup evidence now records
  SSH-key deletion success or failure without claiming success on provider cleanup failure.
- tests added: adversarial coverage for controller failure after provider key creation, SSH-key
  deletion failure evidence, world-open/non-exact/invalid/injected CIDRs, host-key mismatch,
  fingerprint injection, no unowned Droplet deletion, strict known-host source assertions, and
  workflow controller-CIDR ordering.
- gates passed: `bun scripts/run-unit-tests.ts tests/unit/runner-snapshot-build.test.ts
  tests/unit/runner-snapshot-workflow.test.ts tests/unit/digitalocean-provider.test.ts` (3 files,
  34 tests); `bun scripts/run-unit-tests.ts tests/unit/runner-snapshot-build.test.ts
  tests/unit/runner-snapshot-manifest.test.ts tests/unit/runner-snapshot-workflow.test.ts
  tests/unit/runner-provisioning.test.ts tests/unit/automatic-runner-provisioning.test.ts
  tests/unit/cloud-runner-bootstrap.test.ts tests/unit/server-env.test.ts
  tests/unit/digitalocean-provider.test.ts` (8 files, 99 tests); `bun run format:check`;
  `bun run lint`; `bun run typecheck`; `bun run test` (172 files, 1,673 tests); `bun run build`;
  `PORT=3118 bun run test:e2e:ci` (26/26); `bun run repro:cloud-runner`; `git diff --check`.
- skipped: `bun run local:agent:smoke`, per coordinator serialization of the shared
  `agentbay-local-cloud-runner` Docker Compose namespace. No live DigitalOcean/provider,
  GitHub-environment, secret, deploy, release, or workflow-dispatch effect was run.
- next-action: Checker should inspect the controller/provider cleanup ownership, CIDR validation and
  firewall inputs, strict host-key evidence retrieval, docs trust chain, and the new adversarial
  tests. Local smoke remains serialized.

## Checker Result - Cycle 4

- status: BLOCKED — no code/security blocker found at `2bdc4ea`; the only remaining unchecked gate is
  the serialized `bun run local:agent:smoke` gate for the shared
  `agentbay-local-cloud-runner` Docker Compose namespace.
- checked at: 2026-08-07 09:28:53 PST.
- PR state: `gh pr list --head codex/issue-266-attested-snapshot --json
  number,title,state,url,headRefName,baseRefName --limit 5` returned `[]`; no PR exists to merge from
  this worktree.
- security evidence:
  - `.github/workflows/build-runner-snapshot.yml:86` resolves controller egress before the
    DigitalOcean-token step at line 112 and passes `--controller-cidr
    "$AGENTBAY_SNAPSHOT_CONTROLLER_CIDR"` at line 130.
  - `scripts/build-runner-snapshot.ts:19` validates static/pre-effect args before reading provider
    token at line 21; `scripts/build-runner-snapshot.ts:129` requires exact `/32` IPv4 or `/128`
    IPv6 controller CIDR; `scripts/build-runner-snapshot.ts:45` records the provider SSH key ID
    immediately after creation and `scripts/build-runner-snapshot.ts:87` retries deletion in the
    controller `finally` if the orchestrator did not record deletion.
  - `src/server/runners/runner-snapshot-build.ts:183` applies the builder firewall with
    `sshSourceAddresses: [input.controllerSshSourceCidr]` and `webSourceAddresses: []`; provider
    web-rule generation at `src/server/runners/digitalocean-provider.ts:2384` returns no web ingress
    for explicit `[]`.
  - `src/server/runners/runner-snapshot-build.ts:362` records SSH-key deletion success/failure in
    cleanup evidence without claiming success on provider cleanup failure.
  - `src/server/runners/digitalocean-provider.ts:1240` pins the observed builder host key into a
    temp `known_hosts`; `src/server/runners/digitalocean-provider.ts:1270` uses
    `StrictHostKeyChecking=yes`; `src/server/runners/digitalocean-provider.ts:1439` fails closed on
    optional `SHA256:` fingerprint mismatch; temp known-host material is removed in the provider
    `finally`.
- adversarial test evidence:
  - `tests/unit/runner-snapshot-build.test.ts:128` rejects world-open, non-exact, invalid, and
    injected controller CIDRs before provider effects.
  - `tests/unit/runner-snapshot-build.test.ts:171` records provider SSH-key deletion failure without
    claiming success.
  - `tests/unit/runner-snapshot-build.test.ts:242` rejects injected host-key fingerprints before
    provider effects, and `tests/unit/runner-snapshot-build.test.ts:306` avoids unowned builder
    deletion.
  - `tests/unit/runner-snapshot-workflow.test.ts:91` checks controller-finally SSH-key cleanup after
    creation, and `tests/unit/digitalocean-provider.test.ts:266` checks strict known-host behavior
    and absence of `StrictHostKeyChecking=accept-new`.
- gates passed:
  - `git diff --check main...HEAD`.
  - `bun scripts/run-unit-tests.ts tests/unit/runner-snapshot-build.test.ts
    tests/unit/runner-snapshot-manifest.test.ts tests/unit/runner-snapshot-workflow.test.ts
    tests/unit/runner-provisioning.test.ts tests/unit/automatic-runner-provisioning.test.ts
    tests/unit/cloud-runner-bootstrap.test.ts tests/unit/server-env.test.ts
    tests/unit/digitalocean-provider.test.ts` — 8 files, 99 tests.
  - `bun run format:check` — checked 405 files, no fixes applied.
  - `bun run lint` — checked 405 files, no fixes applied.
  - `bun run typecheck` — `next typegen && tsc --noEmit`, passed.
  - `bun run test` — 172 files, 1,673 tests.
  - `bun run build` — Next.js 16.2.10 production build passed.
  - `PORT=3118 bun run test:e2e:ci` — 26/26 passed.
  - `bun run repro:cloud-runner` — generated current user-data, schema valid, 11 runcmd bash blocks
    valid.
  - Snapshot-mode `bun run repro:cloud-runner -- --user-data <generated snapshot-user-data.yaml>` —
    schema valid, 8 runcmd bash blocks valid.
- gates not run:
  - `bun run local:agent:smoke` — intentionally skipped until the coordinator releases the shared
    Docker Compose namespace.
  - Protected GitHub workflow dispatch, live DigitalOcean snapshot/Droplet effects,
    secret/environment configuration, deploy, and release were not authorized or run.
- next-action: run the serialized `bun run local:agent:smoke` gate when the shared namespace is
  released; if it passes, this checker has no remaining code/security objection to opening/merging
  the branch.

## Completed

- [#263](https://github.com/ametel01/plingpling/issues/263) / merged
  [PR #272](https://github.com/ametel01/plingpling/pull/272) at `7d1cb98`; prior evidence is in history.
