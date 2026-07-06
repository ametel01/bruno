# Runner Image Rollout Progress

Source plan: `/Users/alexmetelli/source/agentbay/PLAN.md`

Source brief: Inline user-supplied design brief from the 2026-07-07 Codex turn.

## Current Status

Step 0 is complete for issue #188. The runner image rollout now has durable tracking before implementation starts.

Next step: Step 1, package the cloud runner image, owned by downstream implementation issue #189.

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
- [ ] Step 1: Package the Cloud Runner Image
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

Commit reference: none yet.

### Step 1: Package the Cloud Runner Image

Status: pending downstream implementation.

Owner issue: #189.

Expected outcome: add `Dockerfile.runner` and package the existing runner bootstrap and service runtime without Droplet-side repository checkout or GitHub credentials.

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
