# Runner Image Rollout Progress

Source plan: `/Users/alexmetelli/source/agentbay/PLAN.md`

Source brief: Inline user-supplied design brief from the 2026-07-07 Codex turn.

## Current Status

Step 1 is complete for issue #189. The runner image rollout now has a dedicated Docker image artifact for the existing runner bootstrap and service.

Next step: Step 2, add configurable runner image selection, owned by downstream implementation issue #190.

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
- [ ] Step 2: Add Configurable Runner Image Selection
- [ ] Step 3: Publish Runner Images to GHCR
- [ ] Step 4: Run DigitalOcean Bootstrap from the Runner Image
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

Commit reference: branch `codex/issue-189-runner-image` commit recorded in the #189 `STATUS.md` handoff after local commit creation.

### Step 2: Add Configurable Runner Image Selection

Status: pending downstream implementation.

Owner issue: #190.

Expected outcome: add server-side `AGENTBAY_RUNNER_IMAGE` selection with default `ghcr.io/ametel01/agentbay-runner:main`, non-empty validation, safe metadata, and redaction coverage.

### Step 3: Publish Runner Images to GHCR

Status: pending downstream implementation.

Owner issue: #191.

Expected outcome: publish `ghcr.io/ametel01/agentbay-runner:<git-sha>` and `ghcr.io/ametel01/agentbay-runner:main` from `main`, then confirm public unauthenticated pullability.

### Step 4: Run DigitalOcean Bootstrap from the Runner Image

Status: pending downstream implementation.

Owner issue: #192.

Expected outcome: replace Droplet-side private repo clone, host Bun install, and host `bun install` with Docker pull/run of the selected runner image while preserving Caddy, registration, heartbeat, and secret redaction behavior.

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
