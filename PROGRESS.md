# Milestone 13 Cloud Runner Completion Progress

## Sources

- `/Users/alexmetelli/source/agentbay/docs/MILESTONES.md`
- `/Users/alexmetelli/source/agentbay/PLAN.md`
- Inline user brief from 2026-07-06

## Current Status

- Status: Step 9 complete locally; live Vercel/DigitalOcean smoke is environment-blocked by missing secrets.
- Active step: Milestone 13 local implementation complete; external smoke pending authorized deployment credentials.
- Last updated: 2026-07-06 18:16:10 PST.

## Step Checklist

- [x] Step 0: Progress and Changelog Tracking Setup
- [x] Step 1: Baseline Characterization and Failing Tests
- [x] Step 2: Public Droplet Endpoint and HTTPS Proxy Bootstrap
- [x] Step 3: Reliable Cheap-Droplet Bootstrap Runtime
- [x] Step 4: Durable Registration Credential Persistence
- [x] Step 5: Continuous Runner Heartbeat and Capacity Metrics
- [x] Step 6: Command Authentication for Cloud Runner Lifecycle Calls
- [x] Step 7: Bootstrap Timeout, Failure State, and Cleanup Guidance
- [x] Step 8: Production No-Runner Behavior and Agent Assignment UX
- [x] Step 9: End-to-End Cloud Provisioning Smoke and Operator Docs

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

### 2026-07-06 18:02:20 PST - Step 6 complete

- Made `AGENTBAY_RUNNER_BEARER_TOKEN` required when DigitalOcean provisioning is configured on the server.
- Injected the command bearer token into Droplet-local cloud-init env content without adding it to safe bootstrap summaries.
- Extended bootstrap redaction to remove `AGENTBAY_RUNNER_BEARER_TOKEN` from unsafe bootstrap output.
- Documented the DigitalOcean cloud runner command-auth requirement in `README.md`.
- Validation:
  - Passed: `bun run format:check`
  - Passed: `bun run lint`
  - Passed: `bun run typecheck`
  - Passed: `bun run test -- tests/unit/server-env.test.ts tests/unit/cloud-runner-bootstrap.test.ts tests/unit/manual-runner-adapter.test.ts tests/unit/runner-service.test.ts tests/unit/runner-provisioning.test.ts`
  - Expected pending Step 8 failure: adding `tests/unit/start-agent-route.test.ts` to the command still fails only on the `no_online_runner` route mapping.
  - Passed: `bun run build`
- Changelog: added one `Changed` entry for cloud runner command-auth requirements.
- Commit: this step commit.
- Next step: Step 7 - Bootstrap Timeout, Failure State, and Cleanup Guidance.

### 2026-07-06 18:05:23 PST - Step 7 complete

- Added read-path reconciliation for stale DigitalOcean runners stuck in `waiting_for_runner` longer than 60 minutes.
- Reconciliation now marks stale runners `provision_failed` / `failed`, stores a safe actionable error message with Droplet cleanup guidance, and records a `failed` provisioning event.
- The summary read path preserves safe/truncated UI text while the persisted failure and event retain the full operator message.
- Validation:
  - Passed: `bun run format:check`
  - Passed: `bun run lint`
  - Passed: `bun run typecheck`
  - Passed: `bun run test -- tests/unit/runner-provisioning.test.ts tests/unit/cloud-runner-provisioning.test.ts tests/unit/root-page.test.tsx tests/unit/cloud-runner-route.test.ts`
  - Passed: `bun run build`
- Changelog: added one `Fixed` entry for stalled cloud runner provisioning becoming actionable.
- Commit: this step commit.
- Next step: Step 8 - Production No-Runner Behavior and Agent Assignment UX.

### 2026-07-06 18:11:04 PST - Step 8 complete

- Changed production start placement so Vercel deployments return a distinct `no_online_runner` result when no cloud runner is online instead of falling back to local Docker.
- Updated the start API route to return a safe 409 `no_online_runner` response.
- Updated the start button failure copy for no-online-runner and runner-capacity blockers.
- Validation:
  - Passed: `bun run format`
  - Passed: `bun run typecheck`
  - Passed: `bun run test -- tests/unit/start-agent-route.test.ts tests/unit/create-agent-db.test.ts tests/unit/runner-placement.test.ts tests/unit/root-page.test.tsx`
  - Passed: `bun run format:check`
  - Passed: `bun run lint`
  - Passed: `bun run build`
  - Passed: `PLAYWRIGHT_REUSE_EXISTING_SERVER=0 PORT=3100 bun run test:e2e -- --grep "cloud runner|agent.*start" --project=chromium-desktop`
- Changelog: added one `Fixed` entry for production agent starts without online cloud runners.
- Commit: this step commit.
- Next step: Step 9 - End-to-End Cloud Provisioning Smoke and Operator Docs.

### 2026-07-06 18:16:10 PST - Step 9 complete locally

- Added DigitalOcean cloud runner operator documentation covering required Vercel env vars, optional provider defaults, provisioning phases, public HTTPS runner endpoint behavior, live smoke steps, and cleanup/failure triage.
- Added commented DigitalOcean provisioning placeholders to `.env.example` without committing secrets.
- Confirmed the existing Playwright cloud runner UI smoke covers non-mutating routine validation and does not create real Droplets in CI.
- Validation:
  - Passed: `bun run format:check`
  - Passed: `bun run lint`
  - Passed: `bun run typecheck`
  - Passed: `bun run test -- tests/unit/digitalocean-provider.test.ts tests/unit/runner-provisioning.test.ts tests/unit/cloud-runner-bootstrap.test.ts tests/unit/runner-registration.test.ts tests/unit/runner-heartbeat.test.ts tests/unit/runner-service-bootstrap.test.ts tests/unit/runner-service.test.ts tests/unit/runner-placement.test.ts tests/unit/start-agent-route.test.ts tests/unit/create-agent-db.test.ts` (10 files, 174 tests)
  - Passed: `bun run build`
  - Passed: `bun run verify` (52 unit test files / 410 tests, production build, 44 Playwright tests passed with 20 expected skips)
- Live smoke: environment-blocked. This shell is authenticated to Vercel as `ametel01`, but `VERCEL_TOKEN`, `AGENTBAY_DIGITALOCEAN_TOKEN`, `AGENTBAY_RUNNER_BEARER_TOKEN`, `DATABASE_URL`, and `NEXT_PUBLIC_APP_URL` are not set in the local environment, so the real Vercel/DigitalOcean smoke was not run from this checkout.
- Smoke resource IDs: none. No DigitalOcean Droplet was created and no cleanup was required.
- Changelog: no new entry added because this step changed operator documentation and env examples only; functional Milestone 13 behavior is already represented by the earlier `Added`, `Changed`, and `Fixed` entries.
- Commit: this step commit.
- Next step: provide authorized deployment secrets and run the documented live Vercel/DigitalOcean smoke, or accept the local implementation evidence as the Milestone 13 handoff gate.
