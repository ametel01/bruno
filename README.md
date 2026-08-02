# plingpling

plingpling is the web control plane for AgentBay: a supervised way to create, configure, run,
observe, approve, back up, and recover persistent Hermes agents. The Next.js application owns the
user-facing dashboard and control APIs; PostgreSQL stores durable state; separate runner services
execute each agent in an isolated Docker container.

The project is under active development. See [delivery progress](./PROGRESS.md) for the current
implementation status and [milestones](./docs/MILESTONES.md) for the product roadmap.

## What is implemented

- Agent creation from Research, Inbox Triage, GitHub Issue, and Social Content templates.
- Start, stop, restart, delete, configuration, encrypted BYOK secrets, and Hermes setup flows.
- Per-agent logs and event timelines, dashboard activity, operational alerts, and approvals.
- Local Docker execution, manually registered runners, and automated DigitalOcean provisioning.
- Runner registration, scoped credentials, heartbeat health, capacity-aware placement, and
  user-isolated operations.
- Manual backup and restore through S3-compatible object storage.
- Daily and monthly infrastructure cost estimates.
- Development, shared-operator, and Clerk authentication modes.

Billing, the final production Clerk cutover, and full private-beta acceptance remain roadmap work.

## Architecture

```mermaid
flowchart LR
    User["Browser"] --> App["Next.js control plane<br/>Vercel or local Docker"]
    App --> Auth["Operator gate / Clerk"]
    App --> DB["PostgreSQL"]
    App --> DO["DigitalOcean API"]
    DO --> Runner["Runner VM<br/>Bun service + Docker"]
    App --> Runner
    Runner --> Hermes["One isolated Hermes container<br/>per running agent"]
    App --> Storage["Optional S3-compatible<br/>backup storage"]
```

The control plane does not run agent containers inside Vercel. In a hosted deployment it provisions
or connects to runner machines, then sends authenticated lifecycle requests to those runners.

## Technology

- Next.js 16, React 19, and TypeScript 6
- Bun for package management and scripts
- PostgreSQL 17 with Drizzle ORM and migrations
- Docker for local and remote agent isolation
- Clerk for user authentication, with a pre-cutover Basic-auth operator gate
- DigitalOcean Droplets for the first cloud-runner provider
- Vitest, Playwright, and Biome for verification

## Run the complete stack locally

### Prerequisites

- [Bun](https://bun.sh/) available as `bun`
- Docker Desktop or another Docker Engine with Compose support
- Ports `3000`, `3045`, and `55432` available

Install the locked dependencies:

```sh
bun install --frozen-lockfile
```

Start the control plane and PostgreSQL, build the runner image, and enable the local DigitalOcean
simulation:

```sh
bun run local:cloud:up
```

This command builds the application before serving it, so the first start can take several
minutes. Leave it running and open <http://localhost:3000>. Local cloud mode uses registration-free
development authentication and non-production runner credentials defined only inside
`compose.yaml`.

To exercise provisioning from another terminal, run:

```sh
bun run local:cloud:smoke
```

The smoke check creates a persisted test agent and runner. A successful result either starts the
agent or reaches the expected Hermes-setup gate.

Stop the stack and its agent containers with:

```sh
bun run local:cloud:down
```

The named PostgreSQL volume is retained. Use Docker Compose volume removal only when you
intentionally want to erase local data.

## Run only the app and database

Use this faster path for dashboard, API, and database work that does not require automatic runner
provisioning.

Create an ignored `.env.local`:

```dotenv
DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/plingpling
NEXT_PUBLIC_APP_URL=http://localhost:3000
AGENTBAY_AUTH_MODE=development
```

Then run:

```sh
bun run local:up
```

`local:up` starts PostgreSQL, applies migrations, and launches `next dev`. It does not configure a
cloud provider, so create-agent flows that need automatic provisioning fail closed. The Compose
database is named `plingpling`; if you copy `.env.example`, change its database path from
`/agentbay` to `/plingpling` for this local Compose path.

Useful database commands:

```sh
bun run db:migrate
bun run db:health
bun run db:generate
```

Stop the local database with `bun run local:down`.

## Environment variables

Keep real values in `.env.local`, the deployment platform, or an approved secret manager. Never
commit tokens, encryption keys, runner credentials, Clerk keys, or database credentials.

### Core application

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Yes | PostgreSQL connection URL used by the app and Drizzle migrations. |
| `NEXT_PUBLIC_APP_URL` | Yes | Canonical absolute application URL. |
| `AGENTBAY_AUTH_MODE` | Hosted deployments | `operator` or `clerk` normally; `development` is allowed on loopback, protected previews, or an explicitly public development deployment. |
| `AGENTBAY_ALLOW_PUBLIC_DEVELOPMENT` | Public Vercel development only | Must be exactly `true` with development mode to expose a production-target deployment without browser authentication. |
| `AGENTBAY_OPERATOR_PASSWORD` | Operator deployments | Password for the Basic-auth gate in front of product pages and browser APIs. |
| `AGENTBAY_OPERATOR_USERNAME` | No | Basic-auth username; defaults to `agentbay`. |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk mode | Clerk publishable key. |
| `CLERK_SECRET_KEY` | Clerk mode | Clerk server key. |
| `AGENTBAY_PREVIEW_PROTECTION_VERIFIED` | Development-mode Vercel previews only | Must be exactly `true`, and only after Deployment Protection has been independently verified. |

See [Authentication modes](./docs/AUTHENTICATION.md) and the
[Clerk development runbook](./docs/CLERK_DEVELOPMENT.md) before changing hosted authentication.

### Runner and Hermes execution

| Variable | Required | Purpose |
| --- | --- | --- |
| `AGENTBAY_DIGITALOCEAN_TOKEN` | Automated cloud runners | DigitalOcean API token. If omitted, cloud provisioning is unavailable. |
| `AGENTBAY_RUNNER_BEARER_TOKEN` | DigitalOcean or manual runner control | Shared server-side command token used between the control plane and runner service. |
| `AGENTBAY_RUNNER_IMAGE` | No | Runner image; defaults to `ghcr.io/ametel01/agentbay-runner:main`. |
| `AGENTBAY_HERMES_WORKLOAD_IMAGE` | No | Hermes workload image; defaults to the source-pinned Hermes image and digest. |
| `AGENTBAY_RUNNER_MAX_AGENTS` | No | Positive per-runner agent capacity; defaults to `1`. |
| `AGENTBAY_DIGITALOCEAN_REGION` | No | Droplet region; defaults to `sfo3`. |
| `AGENTBAY_DIGITALOCEAN_SIZE_SLUG` | No | Droplet size; defaults to `s-1vcpu-512mb-10gb`. |
| `AGENTBAY_DIGITALOCEAN_IMAGE` | No | Droplet image; defaults to `ubuntu-24-04-x64`. |
| `AGENTBAY_DIGITALOCEAN_SSH_KEY_IDS` | No | `auto`, `none`, or a comma-separated key-ID list. Omitted values auto-discover account keys. |
| `AGENTBAY_DIGITALOCEAN_SSH_SOURCE_CIDRS` | No | Comma-separated IPs/CIDRs allowed to reach SSH. SSH ingress is closed when this is omitted. |
| `AGENTBAY_AGENT_SECRET_ACTIVE_KEY_VERSION` | Hermes BYOK setup | Active encryption-key label, for example `v1`. |
| `AGENTBAY_AGENT_SECRET_KEYS_JSON` | Hermes BYOK setup | JSON object mapping key versions to 32-byte base64url keys. Keep old keys during rotation so existing secrets remain decryptable. |

Additional validated tuning variables are documented inline in `.env.example` and
`src/server/env.ts`. Production runner bootstrap pulls the configured runner and Hermes images;
ensure those images are available to the Droplet without relying on credentials that bootstrap
does not install.

### Backups

All five variables are required together to enable S3-compatible backup and restore:

- `AGENTBAY_BACKUP_STORAGE_ENDPOINT_URL`
- `AGENTBAY_BACKUP_STORAGE_BUCKET`
- `AGENTBAY_BACKUP_STORAGE_REGION`
- `AGENTBAY_BACKUP_STORAGE_ACCESS_KEY_ID`
- `AGENTBAY_BACKUP_STORAGE_SECRET_ACCESS_KEY`

Leaving all five unset disables object-backed backups without preventing the rest of the app from
starting.

## Deploy the control plane and runners

The repository's supported hosted topology is a Vercel control plane, an external PostgreSQL
database, and DigitalOcean runner VMs. The steps below deploy production state and may create
billable resources.

### 1. Prepare external services

1. Provision a PostgreSQL database reachable from Vercel. Keep its production URL private.
2. Create or select a Vercel project and install/authenticate the
   [Vercel CLI](https://vercel.com/docs/cli).
3. For cloud runners, create a DigitalOcean API token with the access needed to create, inspect,
   tag, and delete Droplets and to manage firewalls. Confirm the runner image is published and
   pullable by a fresh Ubuntu Droplet.
4. If backups are required, create the S3-compatible bucket and a least-privilege credential.
5. Choose `operator` or `clerk` authentication. For a temporary public development deployment,
   explicitly choose `development` and set `AGENTBAY_ALLOW_PUBLIC_DEVELOPMENT=true`; this exposes
   all browser pages and app-side APIs.

### 2. Link the Vercel project

From the repository root:

```sh
vercel link --scope ametel01s-projects
```

The generated `.vercel/` directory is ignored by Git.

### 3. Configure production variables

Add the core values through Vercel's encrypted prompts rather than placing secrets in command
arguments:

```sh
vercel env add DATABASE_URL production
vercel env add NEXT_PUBLIC_APP_URL production
vercel env add AGENTBAY_AUTH_MODE production
vercel env add AGENTBAY_OPERATOR_PASSWORD production
```

Add `AGENTBAY_OPERATOR_USERNAME` only when you do not want the default `agentbay` username.
For public development testing, set `AGENTBAY_AUTH_MODE` to `development`, add
`AGENTBAY_ALLOW_PUBLIC_DEVELOPMENT=true`, and omit the operator password prompt.

For Clerk mode, also add:

```sh
vercel env add NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY production
vercel env add CLERK_SECRET_KEY production
```

For DigitalOcean-backed execution, add:

```sh
vercel env add AGENTBAY_DIGITALOCEAN_TOKEN production
vercel env add AGENTBAY_RUNNER_BEARER_TOKEN production
```

For Hermes BYOK and Telegram setup, generate one 32-byte base64url key, store it as a versioned
JSON value, and add both keyring variables:

```sh
vercel env add AGENTBAY_AGENT_SECRET_ACTIVE_KEY_VERSION production
vercel env add AGENTBAY_AGENT_SECRET_KEYS_JSON production
```

Add any runner overrides or all five backup-storage variables from the reference above. Use
separate preview values if you deploy previews. An unset Vercel preview defaults to Clerk and fails
closed without both Clerk keys; do not bypass that policy by copying production secrets casually.

### 4. Validate before deployment

The credential-free CI-equivalent checks are:

```sh
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
bun run test:e2e:ci
```

`bun run verify` finishes with the full provider-backed E2E suite. It requires approved runner or
DigitalOcean credentials and may create and delete billable resources; do not use it as a casual
local check.

### 5. Deploy production

```sh
bun run deploy:prod
```

This runs `vercel deploy --prod --scope ametel01s-projects`. Vercel uses `bun run vercel-build`
from `vercel.json`; on production deployments that script validates the authentication mode,
requires `DATABASE_URL`, applies every pending Drizzle migration, and only then runs the Next.js
build. A migration failure stops the deployment.

To create a preview first, configure the preview environment and run `vercel deploy`. Preview auth
rules are stricter than local development; see [Authentication modes](./docs/AUTHENTICATION.md).

### 6. Verify the deployment

Check the public health route and Vercel logs:

```sh
curl -fsS https://your-domain.example/health
vercel logs --environment production --level error --since 5m
```

The health response should report `status: "ok"` and `database: "reachable"`. Then authenticate,
open Settings, provision a cloud runner, and wait for registration plus the first heartbeat before
assigning or starting an agent. Production start requests fail closed when no online runner is
available.

## Commands

| Command | Purpose |
| --- | --- |
| `bun run dev` | Start the Next.js development server using the current environment. |
| `bun run build` / `bun run start` | Build and serve the production Next.js application. |
| `bun run local:up` / `bun run local:down` | Start or stop PostgreSQL plus the direct local app path. |
| `bun run local:cloud:up` / `bun run local:cloud:down` | Start or stop the complete local cloud simulation. |
| `bun run local:cloud:smoke` | Create an agent and exercise local runner provisioning. |
| `bun run db:migrate` | Apply committed Drizzle migrations. |
| `bun run db:generate` | Generate a migration from schema changes. |
| `bun run db:health` | Check database connectivity. |
| `bun run format:check` / `bun run format` | Check or write Biome formatting. |
| `bun run lint` | Run Biome lint rules. |
| `bun run typecheck` | Run TypeScript without emitting files. |
| `bun run test` | Run the serial Vitest unit suite. |
| `bun run test:e2e:ci` | Run the credential-free Playwright smoke surface. |
| `bun run test:e2e` | Run the full provider-backed Playwright suite. |
| `bun run test:e2e:clerk` | Run the opt-in hosted Clerk development smoke. |
| `bun run verify` | Run every repository gate, ending with provider-backed E2E. |
| `bun run deploy:prod` | Deploy production to the configured Vercel scope. |

See [E2E validation](./docs/E2E_VALIDATION.md) for capability gates and safe test modes.

## Repository layout

| Path | Responsibility |
| --- | --- |
| `app/` | Next.js pages, server-rendered product surfaces, and HTTP routes. |
| `src/auth/` | Authentication policy and operator-access decisions. |
| `src/server/agents/` | Agent creation, lifecycle, configuration, secrets, and Hermes launch logic. |
| `src/server/runners/` | Runner placement, credentials, provisioning, heartbeat, and adapters. |
| `src/runner-service/` | Standalone runner HTTP service and Docker execution contract. |
| `src/server/db/` and `drizzle/` | Database schema, connection layer, and committed migrations. |
| `src/server/backups/` | Backup manifests and S3-compatible artifact storage. |
| `tests/unit/` | Service, route, security-boundary, and component tests. |
| `tests/e2e/` | Credential-free and provider-backed Playwright coverage. |
| `scripts/` | Database, local-cloud, image, reconciliation, E2E, and build entrypoints. |
| `.github/workflows/` | CI plus runner and Hermes image publication. |

## Further documentation

- [Product requirements](./docs/PRD.md)
- [Milestones](./docs/MILESTONES.md)
- [Delivery progress](./PROGRESS.md)
- [Authentication modes](./docs/AUTHENTICATION.md)
- [Two-user isolation acceptance](./docs/TWO_USER_ACCEPTANCE.md)
- [E2E validation](./docs/E2E_VALIDATION.md)
- [Changelog](./CHANGELOG.md)
