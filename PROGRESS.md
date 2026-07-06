# Milestone 13 Cloud Runner Completion Progress

## Sources

- `/Users/alexmetelli/source/agentbay/docs/MILESTONES.md`
- `/Users/alexmetelli/source/agentbay/PLAN.md`
- Inline user brief from 2026-07-06

## Current Status

- Status: Step 1 complete; Step 2 is next.
- Active step: Step 2 - Public Droplet Endpoint and HTTPS Proxy Bootstrap.
- Last updated: 2026-07-06 17:38:14 PST.

## Step Checklist

- [x] Step 0: Progress and Changelog Tracking Setup
- [x] Step 1: Baseline Characterization and Failing Tests
- [ ] Step 2: Public Droplet Endpoint and HTTPS Proxy Bootstrap
- [ ] Step 3: Reliable Cheap-Droplet Bootstrap Runtime
- [ ] Step 4: Durable Registration Credential Persistence
- [ ] Step 5: Continuous Runner Heartbeat and Capacity Metrics
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
