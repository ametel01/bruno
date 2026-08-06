# Runner Resilience Brief

The user should never have to diagnose or replace a runner. Prevention needs to be built into the deployment system.

## Version-aware runners

Every heartbeat reports the runner version and exact image digest. The control plane refuses to assign an agent to an outdated runner.

## Automatic runner replacement

When a runner is stale or unhealthy, the app should:

- Provision a replacement DigitalOcean Droplet.
- Validate it.
- Reassign the agent.
- Retry setup.
- Delete the old Droplet and database record.

## Boot-time readiness contract

A runner becomes assignable only after it proves:

- Docker works.
- Hermes can start.
- The internal health endpoint responds.
- Telegram configuration can be loaded.

Production Droplet boot does not run a model canary. The synthetic model path remains covered by
the local runner release smoke gate, outside the user creation path.

Production agent creation also skips the later deployment model canary. Model latency or provider
availability must not turn an otherwise healthy runner, gateway, and Telegram setup into a terminal
creation failure. The deployment ledger records this decision explicitly as `canary_state =
'skipped'`.

## Strict stage deadlines

“Starting gateway” should complete within seconds. If it does not, capture sanitized logs and replace the runner. Never repeat the same action 64 times.

## Safe release ordering

Releases should automatically:

- Publish an immutable runner image.
- Verify the image exists in GHCR.
- Boot the actual immutable image in a simulated Ubuntu Droplet with zero cloud-provider access.
- Reserve real provider acceptance for separately approved provider/bootstrap changes.
- Deploy the control plane pinned to that tested digest.
- Gradually replace outdated runners.

## Infrastructure reconciliation

Regularly compare DigitalOcean resources with database records, automatically repairing orphaned records, missing Droplets, and stale assignments.

## User-facing abstraction

The UI should only show stages such as “Preparing your agent” and “Connecting Telegram.” Runner warnings should appear only when automatic recovery has genuinely failed.

The specific gateway loop is fixed already. The most important remaining protection is automatic version detection and runner replacement, so future deployments do not leave existing users running old code.
