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
- The model canary path works.
- Telegram configuration can be loaded.

## Strict stage deadlines

“Starting gateway” should complete within seconds. If it does not, capture sanitized logs and replace the runner. Never repeat the same action 64 times.

## Safe release ordering

Releases should automatically:

- Publish an immutable runner image.
- Verify the image exists in GHCR.
- Run an actual disposable-Droplet smoke test.
- Deploy the control plane pinned to that tested digest.
- Gradually replace outdated runners.

## Infrastructure reconciliation

Regularly compare DigitalOcean resources with database records, automatically repairing orphaned records, missing Droplets, and stale assignments.

## User-facing abstraction

The UI should only show stages such as “Preparing your agent” and “Connecting Telegram.” Runner warnings should appear only when automatic recovery has genuinely failed.

The specific gateway loop is fixed already. The most important remaining protection is automatic version detection and runner replacement, so future deployments do not leave existing users running old code.
