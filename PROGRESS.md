# Milestone 13 Cloud Runner Completion Progress

## Sources

- `/Users/alexmetelli/source/agentbay/docs/MILESTONES.md`
- `/Users/alexmetelli/source/agentbay/PLAN.md`
- Inline user brief from 2026-07-06

## Current Status

- Status: Step 5 complete; Step 6 is next.
- Active step: Step 6 - Command Authentication for Cloud Runner Lifecycle Calls.
- Last updated: 2026-07-06 17:57:41 PST.

## Step Checklist

- [x] Step 0: Progress and Changelog Tracking Setup
- [x] Step 1: Baseline Characterization and Failing Tests
- [x] Step 2: Public Droplet Endpoint and HTTPS Proxy Bootstrap
- [x] Step 3: Reliable Cheap-Droplet Bootstrap Runtime
- [x] Step 4: Durable Registration Credential Persistence
- [x] Step 5: Continuous Runner Heartbeat and Capacity Metrics
- [ ] Step 6: Command Authentication for Cloud Runner Lifecycle Calls
- [ ] Step 7: Bootstrap Timeout, Failure State, and Cleanup Guidance
- [ ] Step 8: Production No-Runner Behavior and Agent Assignment UX
- [ ] Step 9: End-to-End Cloud Provisioning Smoke and Operator Docs

## Update Rules

- Update this file after every completed step with validation results, the current status, the next step, and the commit reference when available.
- Update `CHANGELOG.md` only for validated functional changes shipped by a step.
- Keep validation failures factual and identify whether they are new, pre-existing, or environment-blocked.

## Update Log

### 2026-07-06 17:32:16 PST - Step 0 complete

- Created the root progress tracker with source references, step checklist, update rules, and current status.
- Confirmed `CHANGELOG.md` already exists and contains `# Changelog` plus `## [Unreleased]`.
- Validation:
  - Passed: `rg -n "Step Checklist|Step 0:|Step 9:" PROGRESS.md`
  - Passed: `rg -n "^# Changelog$|^## \\[Unreleased\\]$" CHANGELOG.md`
- Changelog: no entry added because this step is tracking-only and ships no functional behavior.
- Commit: this step commit.
- Next step: Step 1 - Baseline Characterization and Failing Tests.

### 2026-07-06 17:38:14 PST - Step 1 complete

- Added failing characterization coverage for Milestone 13 cloud-runner gaps:
  - cloud bootstrap must reject loopback public endpoints and configure a public HTTPS reverse proxy.
  - provisioning must inject a public `sslip.io` runner endpoint instead of `http://127.0.0.1:3045`.
  - stale `waiting_for_runner` rows must reconcile to a safe failed state with operator cleanup guidance.
  - production start with no online runner must not fall back to local Docker.
  - start route must return a safe `no_online_runner` error.
  - runner bootstrap must persist exchanged runner ID and credential for restarts.
  - runner service startup must start a continuous heartbeat loop when runner identity is configured.
- Validation:
  - Passed: `bun run format:check`
  - Passed: `bun run lint`
  - Passed: `bun run typecheck`
  - Expected failure: `bun run test -- tests/unit/cloud-runner-bootstrap.test.ts tests/unit/runner-provisioning.test.ts tests/unit/runner-service-bootstrap.test.ts tests/unit/runner-service.test.ts tests/unit/runner-placement.test.ts tests/unit/start-agent-route.test.ts tests/unit/create-agent-db.test.ts tests/unit/cloud-runner-provisioning.test.ts`
  - Expected red result: 8 failed assertions, 147 passed tests. Failures cover loopback endpoint acceptance, missing Caddy reverse proxy, stale bootstrap not failing, production Docker fallback, loopback provisioning user-data, missing credential env persistence, missing continuous heartbeat startup, and missing route mapping for `no_online_runner`.
- Changelog: no entry added because characterization tests alone ship no functional behavior.
- Commit: this step commit.
- Next step: Step 2 - Public Droplet Endpoint and HTTPS Proxy Bootstrap.

### 2026-07-06 17:44:20 PST - Step 2 complete

- Added public endpoint support to the DigitalOcean provider contract, including fake-provider public IPv4s and API-provider Droplet reads when the SDK exposes them.
- Updated DigitalOcean firewall creation to expose only ports 80 and 443 for cloud runner traffic.
- Changed provisioning to record `https://<public-ip>.sslip.io` on the runner after Droplet creation/read resolves a public IPv4.
- Changed cloud-init bootstrap to compute the runner endpoint from DigitalOcean metadata on the Droplet, install Caddy, and reverse proxy public HTTPS traffic to the loopback runner service on `127.0.0.1:3045`.
- Validation:
  - Passed: `bun run format:check`
  - Passed: `bun run lint`
  - Passed: `bun run typecheck`
  - Passed: `bun run test -- tests/unit/digitalocean-provider.test.ts tests/unit/runner-provisioning.test.ts tests/unit/cloud-runner-bootstrap.test.ts`
  - Passed: `bun run build`
- Changelog: added one `Fixed` entry for public HTTPS cloud runner endpoint registration.
- Commit: this step commit.
- Next step: Step 3 - Reliable Cheap-Droplet Bootstrap Runtime.

### 2026-07-06 17:48:50 PST - Step 3 complete

- Kept the default DigitalOcean size at `s-1vcpu-512mb-10gb` and added bootstrap swap setup for that low-memory size.
- Added bootstrap logging to `/var/log/agentbay-bootstrap.log` and fail-fast shell settings for bootstrap setup blocks.
- Extended cloud-provisioned one-time registration tokens to 60 minutes while leaving manual registration tokens on their existing 15-minute window.
- Validation:
  - Passed: `bun run format:check`
  - Passed: `bun run lint`
  - Passed: `bun run typecheck`
  - Passed: `bun run test -- tests/unit/cloud-runner-bootstrap.test.ts tests/unit/runner-provisioning.test.ts tests/unit/runner-registration.test.ts tests/unit/server-env.test.ts`
  - Passed: `bun run build`
- Changelog: added one `Changed` entry for low-memory Droplet bootstrap reliability.
- Commit: this step commit.
- Next step: Step 4 - Durable Registration Credential Persistence.

### 2026-07-06 17:54:19 PST - Step 4 complete

- Updated runner bootstrap so the first successful registration exchange persists `AGENTBAY_RUNNER_ID` and `AGENTBAY_RUNNER_CREDENTIAL` into the configured Droplet env file with `0600` permissions.
- Kept bootstrap idempotent: if runner ID and credential are already present, registration is skipped and heartbeat uses the existing credential.
- Updated cloud-init env generation to include `AGENTBAY_RUNNER_ENV_FILE=/etc/agentbay/runner.env` so the bootstrap process can persist restart-safe credentials.
- Validation:
  - Passed: `bun run format:check`
  - Passed: `bun run lint`
  - Passed: `bun run typecheck`
  - Passed: `bun run test -- tests/unit/runner-service-bootstrap.test.ts tests/unit/cloud-runner-bootstrap.test.ts tests/unit/runner-registration.test.ts tests/unit/runner-heartbeat.test.ts`
  - Passed: `bun run build`
- Changelog: added one `Fixed` entry for cloud runner registration surviving restarts.
- Commit: this step commit.
- Next step: Step 5 - Continuous Runner Heartbeat and Capacity Metrics.

### 2026-07-06 17:57:41 PST - Step 5 complete

- Added a runner-service heartbeat loop that sends an immediate startup heartbeat and interval heartbeats to `/runner/v1/heartbeat`.
- Wired the Bun runner service entrypoint to start the heartbeat loop when `AGENTBAY_APP_URL`, `AGENTBAY_RUNNER_ID`, and `AGENTBAY_RUNNER_CREDENTIAL` are present in the env file environment.
- Heartbeat payloads include `online` status, `agentbay-runner/service` version, and capacity metrics compatible with existing placement normalization.
- Validation:
  - Passed: `bun run format:check`
  - Passed: `bun run lint`
  - Passed: `bun run typecheck`
  - Passed: `bun run test -- tests/unit/runner-service.test.ts tests/unit/runner-heartbeat.test.ts tests/unit/runner-placement.test.ts`
  - Expected pending Step 7 failure: `bun run test -- tests/unit/runner-service.test.ts tests/unit/runner-heartbeat.test.ts tests/unit/runner-placement.test.ts tests/unit/cloud-runner-provisioning.test.ts` still fails only on stale `waiting_for_runner` timeout reconciliation.
  - Passed: `bun run build`
- Changelog: added one `Added` entry for continuous runner heartbeat and capacity metrics.
- Commit: this step commit.
- Next step: Step 6 - Command Authentication for Cloud Runner Lifecycle Calls.
