# Milestone 13 Cloud Provisioning Smoke Checklist

This checklist is for the required pre-beta smoke against a real small DigitalOcean Droplet. It is intentionally opt-in because it creates and deletes cloud resources.

## Preconditions

- Use a staging AgentBay deployment or a local tunnel that can receive runner registration and heartbeat requests.
- Use a temporary DigitalOcean token with the minimum permissions needed to create, tag, firewall, and delete one test Droplet.
- Confirm the operator running the smoke is authorized to create and delete the test Droplet.
- Keep real tokens out of committed files, shell history captures, screenshots, and issue comments.

## Required Server Environment

Set these only in the server-side environment:

```sh
DATABASE_URL=postgres://...
NEXT_PUBLIC_APP_URL=https://staging.example.invalid
AGENTBAY_DIGITALOCEAN_TOKEN=<temporary-token>
AGENTBAY_DIGITALOCEAN_REGION=sfo3
AGENTBAY_DIGITALOCEAN_SIZE_SLUG=s-1vcpu-512mb-10gb
AGENTBAY_DIGITALOCEAN_IMAGE=ubuntu-24-04-x64
AGENTBAY_DIGITALOCEAN_TAGS=agentbay,agentbay-runner,pre-beta-smoke
# Optional SSH access for troubleshooting. Prefer your current operator IP CIDR.
AGENTBAY_DIGITALOCEAN_SSH_SOURCE_CIDRS=203.0.113.5/32
```

Do not set `AGENTBAY_DIGITALOCEAN_TOKEN` in browser-visible or `NEXT_PUBLIC_*` configuration.
If temporary public SSH is required for a smoke test, set
`AGENTBAY_DIGITALOCEAN_ALLOW_PUBLIC_SSH=true` only for that run and disable it
afterward.

## Smoke Steps

1. Run database migrations against the smoke database.
2. Open Settings and click Create Runner.
3. Confirm the UI shows persisted provisioning progress after a page reload.
4. In DigitalOcean, confirm exactly one small Droplet exists with the configured AgentBay tags.
5. Confirm the Droplet user-data bootstraps the runner service and the runner exchanges the one-time registration token.
6. Wait for a heartbeat and confirm the dashboard shows the runner `online`.
7. Create or select one development agent, assign it to the cloud runner, and start it.
8. Confirm lifecycle actions use the assigned runner path and agent logs remain scoped to that agent.
9. Stop the agent and verify the runner remains online.

## Expected Evidence

- Screenshot or text capture of Settings showing provisioning phases and the final online runner state.
- Redacted DigitalOcean Droplet id, region, size, image, and AgentBay tags.
- Redacted runner registration evidence showing hash-only token persistence and no raw `agb_reg_*` or `agb_run_*` value in durable storage.
- Agent assignment/start evidence showing the cloud runner kind, endpoint host, and online status without raw runner credentials.
- Confirmation that API responses and page HTML do not expose `AGENTBAY_DIGITALOCEAN_TOKEN`, registration tokens, runner credentials, credential hashes, or token hashes.

## Cleanup

1. Stop any smoke agent assigned to the Droplet.
2. Delete only the Droplet whose provider id and AgentBay tags match the smoke evidence.
3. Confirm the Droplet is gone in DigitalOcean.
4. Revoke or delete the temporary DigitalOcean token.
5. Remove the smoke runner row or mark it deleted in the staging database if automatic cleanup did not update it.
6. Attach cleanup evidence to the release checklist before beta.
