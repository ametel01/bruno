# Runner Image Rollout Progress

Source plan: `/Users/alexmetelli/source/agentbay/PLAN.md`

Source brief: Inline user-supplied design brief from the 2026-07-07 Codex turn.

## Current Status

Steps 0, 1, 2, and 4 are complete for issues #188, #189, #190, and #192. The runner image rollout now has a dedicated Docker image artifact for the existing runner bootstrap and service, server-side runner image selection for cloud provisioning, and DigitalOcean cloud-init that runs the configured image through Docker instead of host-side source checkout.

Step 3 is complete for issue #191 as a main-branch GitHub Actions workflow that published the runner image to GHCR with both immutable SHA and moving `main` tags.

Next step: Step 5, verify hosted runner registration end to end, after the Step 4 image-based bootstrap changes merge.

## GHCR Pull Policy

Selected zero-setup path: publish the runner image as a public GHCR package and rely on unauthenticated pulls from fresh DigitalOcean Droplets.

Reason: the rollout goal is to remove Droplet-side private repository clone and registry credential requirements. A public image lets cloud-init pull `ghcr.io/ametel01/agentbay-runner:main` without adding GitHub, GHCR, or repository credentials to the Droplet.

Stop condition for downstream work: if public unauthenticated GHCR pulls are rejected, #189, #190, and later runner image rollout work must stop until a private-registry credential design is documented and approved. Do not continue by adding ad hoc registry credentials to provisioning, cloud-init, logs, issue notes, or this progress file.

Secrets policy: this file intentionally contains no tokens, runner credentials, Droplet credentials, registry credentials, provider credentials, or secret values.

## Changelog Status

`CHANGELOG.md` already exists and includes the Keep a Changelog structure required by the plan: `# Changelog`, the Keep a Changelog preamble, and `## [Unreleased]`.

No functional changelog entry was added for Step 0 because this issue is setup-only tracking work and does not ship user-facing or operator-facing runtime behavior.

## Step Checklist

- [x] Step 0: Progress and Changelog Tracking Setup
- [x] Step 1: Package the Cloud Runner Image
- [x] Step 2: Add Configurable Runner Image Selection
- [x] Step 3: Publish Runner Images to GHCR
- [x] Step 4: Run DigitalOcean Bootstrap from the Runner Image
- [ ] Step 5: Verify Hosted Runner Registration End to End
- [ ] Step 6: Close Out the Rollout

## Step Notes

### Step 0: Progress and Changelog Tracking Setup

Status: complete.

Completed for issue #188:

- Created `PROGRESS.md` before runner image, Docker, provisioning, CI, deployment, or runtime work.
- Listed every incremental step from the source plan, Step 0 through Step 6.
- Recorded public unauthenticated GHCR pulls as the selected zero-setup path.
- Recorded the downstream stop condition if public unauthenticated GHCR pulls are rejected.
- Confirmed `CHANGELOG.md` already has the required Keep a Changelog structure.
- Left `CHANGELOG.md` unchanged because this setup-only issue does not add a functional change.

Validation:

- `test -f PROGRESS.md` passed.
- `test -f CHANGELOG.md` passed.
- `rg "Step 0|Step 1|Step 2|Step 3|Step 4|Step 5|Step 6" PROGRESS.md` passed.
- `rg "# Changelog|## \\[Unreleased\\]" CHANGELOG.md` passed.
- `git diff --check` passed.

Commit reference: `4a8167c` (`docs: add runner image rollout tracking`, PR #195).

### Step 1: Package the Cloud Runner Image

Status: complete.

Owner issue: #189.

Completed for issue #189:

- Added `Dockerfile.runner` using the Bun Alpine runtime and Docker CLI for the existing manual-runner Docker operations.
- Added `.dockerignore` as a Docker-specific build-context contract with a default-deny allowlist for runner runtime inputs.
- Packaged `package.json`, `bun.lock`, `tsconfig.json`, `src/runner-service/*`, and the imported shared `src/server/agents/agent-id.ts` module into the image.
- Set the container default command to run `bun run runner:bootstrap` before `bun run runner:service`.
- Kept `AGENTBAY_RUNNER_IMAGE`, GHCR publishing, DigitalOcean cloud-init pull/run changes, and provisioning config out of this slice.

Validation:

- `bun install --frozen-lockfile` passed after the fresh worktree initially lacked local toolchain binaries.
- `bun run format:check` passed.
- `bun run lint` passed.
- `bun run typecheck` passed.
- `bun run test tests/unit/runner-service-bootstrap.test.ts tests/unit/runner-heartbeat.test.ts` passed with 2 files and 15 tests.
- `docker build -f Dockerfile.runner -t agentbay-runner:test .` passed on Docker Desktop 29.3.1.
- `docker run --rm --entrypoint sh agentbay-runner:test -c 'find /app -maxdepth 5 -type f | sort && printf "--- docker cli ---\n" && docker --version'` showed only runner runtime inputs under `/app` and Docker CLI 28.3.3 in the image.
- Targeted Docker context and changed-file checks confirmed `.dockerignore` excludes `.env*`, `.vercel`, `.git`, `node_modules`, `.next`, coverage, test output, Playwright reports, logs, local database dump patterns, and private key file patterns.
- `git diff --check` passed.

Commit reference: `1ee49e5` (`build: add runner Docker image`).

### Step 2: Add Configurable Runner Image Selection

Status: complete.

Owner issue: #190.

Expected outcome: add server-side `AGENTBAY_RUNNER_IMAGE` selection with default `ghcr.io/ametel01/agentbay-runner:main`, non-empty validation, safe metadata, and redaction coverage.

Completed for issue #190:

- Added server-side `AGENTBAY_RUNNER_IMAGE` selection to the DigitalOcean provider config, defaulting to `ghcr.io/ametel01/agentbay-runner:main` when unset.
- Trimmed non-empty overrides and rejected blank overrides with a safe `EnvValidationError` naming `AGENTBAY_RUNNER_IMAGE`.
- Threaded the selected runner image into cloud bootstrap safe summaries, the injected runner env file, and provisioning event metadata using the non-secret `runnerImage` field.
- Preserved existing DigitalOcean OS image, registration token, heartbeat, command bearer-token, Caddy, provisioning phase, and redaction behavior without adding Docker image build, GHCR publishing, or Docker pull/run changes.

Validation:

- `bun run format:check` passed.
- `bun run lint` passed.
- `bun run typecheck` passed.
- `bun run test tests/unit/server-env.test.ts tests/unit/cloud-runner-bootstrap.test.ts tests/unit/runner-provisioning.test.ts tests/unit/cloud-runner-provisioning.test.ts` passed after adding `runnerImage` to create-start event metadata.
- `git diff --check` passed.
- Targeted secret scan over changed files and diff text passed; matches were limited to env var names, redaction patterns, changelog wildcard mentions, and deterministic fake test fixtures.

Commit reference: `ae96054` (PR #196 merge commit).

### Step 3: Publish Runner Images to GHCR

Status: complete.

Owner issue: #191.

Completed for issue #191:

- Added `.github/workflows/publish-runner-image.yml` with a `push` trigger scoped to the `main` branch.
- Granted the workflow minimum practical permissions for this publish path: `contents: read` and `packages: write`.
- Configured GHCR login through GitHub Actions' built-in `GITHUB_TOKEN` via `${{ github.token }}`; no PAT, repository secret, Droplet-side credential, or custom registry credential was added.
- Configured Docker Buildx to build `Dockerfile.runner` from the repository root and push both `ghcr.io/ametel01/agentbay-runner:${{ github.sha }}` and `ghcr.io/ametel01/agentbay-runner:main`.
- Left feature-branch publishing disabled by omitting pull request, workflow dispatch, tag, and non-main branch triggers.
- Left `CHANGELOG.md` unchanged because this slice adds CI publishing only and does not change operator-facing runtime behavior before merge.

Pre-merge validation:

- `bun run format:check` passed.
- `bun run lint` passed.
- `bun run typecheck` passed.
- `docker build -f Dockerfile.runner -t agentbay-runner:test .` passed.
- `git diff --check` passed.
- Workflow YAML inspection passed for main-only publishing, `ghcr.io/ametel01/agentbay-runner:${{ github.sha }}`, `ghcr.io/ametel01/agentbay-runner:main`, built-in `GITHUB_TOKEN` login, and explicit `contents: read` / `packages: write` permissions.
- Stale-placeholder scan over `PROGRESS.md`, `CHANGELOG.md`, and `.github/workflows` passed.
- Targeted secret scan over changed files passed; matches are limited to expected GitHub Actions token expression names and public GHCR image references.

Post-merge validation:

- GitHub Actions run `28833694825` (`Publish runner image`) passed on `main` for merge commit `61ff9478bdf499378e7c24e32c2ec9a37e376613`.
- Workflow logs show both `ghcr.io/ametel01/agentbay-runner:61ff9478bdf499378e7c24e32c2ec9a37e376613` and `ghcr.io/ametel01/agentbay-runner:main` were pushed with digest `sha256:80b008fef310cee2e66f341aaf156402519f0761049b4021e6cf7ff648c62b9f`.
- Public unauthenticated pullability passed with an empty temporary Docker config for the target DigitalOcean platform: `DOCKER_CONFIG="$tmp" docker pull --platform linux/amd64 ghcr.io/ametel01/agentbay-runner:main`.
- Local Apple Silicon Docker without `--platform linux/amd64` fails because the published image is currently `linux/amd64` only; that does not block DigitalOcean bootstrap validation.

Commit reference: `61ff9478bdf499378e7c24e32c2ec9a37e376613` (PR #198 merge commit).

### Step 4: Run DigitalOcean Bootstrap from the Runner Image

Status: complete.

Owner issue: #192.

Expected outcome: replace Droplet-side private repo clone, host Bun install, and host `bun install` with Docker pull/run of the selected runner image while preserving Caddy, registration, heartbeat, and secret redaction behavior.

Completed for issue #192:

- Replaced DigitalOcean cloud-init source checkout and host Bun service setup with Docker pull/run of the selected `AGENTBAY_RUNNER_IMAGE`.
- Preserved Docker and Caddy installation/enabling, sslip.io endpoint discovery, low-memory swap setup, `/etc/agentbay/runner.env`, and reverse proxying to `127.0.0.1:3045`.
- Started the configured image as a detached Docker container named `agentbay-runner` with restart policy, env-file loading, and loopback-only `127.0.0.1:3045:3045` binding.
- Kept `runnerImage` visible in safe bootstrap/provisioning metadata while preserving registration token and bearer-token redaction.
- Left GHCR workflow publishing, hosted pullability, package settings, production resources, secrets, and hosted smoke validation to #191/#193.

Validation:

- `bun install --frozen-lockfile` passed after the fresh worktree initially lacked local toolchain binaries.
- `bun run format:check` passed.
- `bun run lint` passed.
- `bun run typecheck` passed.
- `bun run test tests/unit/cloud-runner-bootstrap.test.ts tests/unit/cloud-runner-provisioning.test.ts tests/unit/runner-provisioning.test.ts tests/unit/runner-registration.test.ts tests/unit/runner-heartbeat.test.ts` passed with 5 files and 39 tests.
- `bun run build` passed.
- Targeted generated-bootstrap and changed-test checks confirmed no legacy host checkout/bootstrap tokens are present.
- Targeted secret scan over changed files and diff text passed; matches were limited to env var names, redaction patterns, public GHCR image names, and deterministic fake test fixtures.
- Stale status wording scan passed.

### Step 5: Verify Hosted Runner Registration End to End

Status: pending downstream implementation.

Owner issue: #193.

Expected outcome: verify a fresh hosted cloud runner registers, heartbeats, reaches online/ready, and can start an agent without exposing secret material.

### Step 6: Close Out the Rollout

Status: pending downstream closeout.

Owner issue: #194.

Expected outcome: all rollout steps have validation evidence, `PROGRESS.md` and `CHANGELOG.md` are current, stale private-clone guidance is removed or superseded, and any public-GHCR rejection is tracked as an explicit future private-registry credential design task.

## Update Log

- 2026-07-07 Asia/Manila: Step 0 completed for #188 with public unauthenticated GHCR pulls selected as the zero-setup path and private-registry credential design recorded as the stop condition if that policy is rejected.
- 2026-07-07 Asia/Manila: Step 1 completed for #189 with a dedicated runner Docker image artifact, Docker-specific build-context allowlist, local Docker build proof, and non-Docker runner gates passing.
- 2026-07-07 Asia/Manila: Step 2 completed for #190 with configurable runner image selection, safe bootstrap/provisioning metadata, and focused unit coverage.
- 2026-07-07 Asia/Manila: Step 3 completed for #191 with a main-branch-only GHCR publish workflow, successful SHA and `main` tag push, public GHCR visibility, and unauthenticated `linux/amd64` pull validation.
- 2026-07-07 Asia/Manila: Step 4 completed for #192 with DigitalOcean cloud-init now pulling and running the configured runner image via Docker while preserving Caddy, registration, heartbeat compatibility, and redacted metadata.
