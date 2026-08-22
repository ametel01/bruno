# Bruno.Ai

Bruno.Ai is the 24/7, always-running AI agent for a one-person company. It learns from the founder's
interactions, corrections, approvals, policies, and verified outcomes so it can improve how it
handles recurring work without silently expanding its authority.

This repository currently provides the web control plane for creating, configuring, running,
observing, approving, backing up, and recovering persistent Hermes agents—the infrastructure
foundation for that product direction. The Next.js application owns the user-facing dashboard and
control APIs; PostgreSQL stores durable state; separate runner services execute each agent in an
isolated Docker container.

The project is under active development. See [milestones](./docs/MILESTONES.md) for the product
roadmap.

## What is implemented

- A one-click agent setup that asks nontechnical users only for a name, ChatGPT or Claude, and the
  unavoidable first-time provider and Telegram credentials. Models, templates, runners, launch,
  deployment, and health checks are selected and managed by the app.
- Owner-scoped encrypted OpenAI and Anthropic API-key connections that are reused for later agents
  without redisplaying credential material.
- Durable deployment and runtime reconciliation, including Start, Stop, Restart, Delete, bounded
  recovery, and circuit-breaker status.
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

To exercise the complete ready-agent lifecycle without any DigitalOcean request, run:

```sh
bun run local:agent:smoke
```

This command refuses non-local provider configuration and existing harness containers, creates
exactly one Docker-based Droplet simulator with an isolated nested Docker daemon, and drives the
production create, deployment, model canary, restart, stop, delete, and cleanup services against a
fresh local database. The runner, pinned Hermes workload, and fake model all run inside the
simulator rather than as host sibling containers. Success proves that the Hermes image is installed
in the simulated Droplet, the expected Hermes executable is present, and the gateway returns an
authenticated detailed-health response from inside its workload container before persisted and
container cleanup checks run. The OpenAI model route and Telegram network health remain synthetic
local boundaries, so this is a zero-cloud regression gate, not DigitalOcean API, firewall, routing,
or real Telegram acceptance.

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
DATABASE_URL=postgres://bruno:bruno@127.0.0.1:54329/bruno
NEXT_PUBLIC_APP_URL=http://localhost:3000
BRUNO_AUTH_MODE=development
```

Then run:

```sh
bun run local:up
```

`local:up` starts PostgreSQL, applies migrations, and launches `next dev`. It does not configure a
cloud provider, so create-agent flows that need automatic provisioning fail closed. The Compose
database is named `bruno`; if you copy `.env.example`, change its database path from
`/bruno` to `/bruno` for this local Compose path.

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
| `BRUNO_LOG_LEVEL` | No | Minimum structured server-log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal`, or `silent`; defaults to `info`. |
| `BRUNO_AUTH_MODE` | Hosted deployments | `operator` or `clerk` normally; `development` is allowed on loopback, protected previews, or an explicitly public development deployment. |
| `BRUNO_ALLOW_PUBLIC_DEVELOPMENT` | Public Vercel development only | Must be exactly `true` with development mode to expose a production-target deployment without browser authentication. |
| `BRUNO_OPERATOR_PASSWORD` | Operator deployments | Password for the Basic-auth gate in front of product pages and browser APIs. |
| `BRUNO_OPERATOR_USERNAME` | No | Basic-auth username; defaults to `bruno`. |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk mode | Clerk publishable key. |
| `CLERK_SECRET_KEY` | Clerk mode | Clerk server key. |
| `BRUNO_PREVIEW_PROTECTION_VERIFIED` | Development-mode Vercel previews only | Must be exactly `true`, and only after Deployment Protection has been independently verified. |

See [Authentication modes](./docs/AUTHENTICATION.md) and the
[Clerk development runbook](./docs/CLERK_DEVELOPMENT.md) before changing hosted authentication.

### Runner and Hermes execution

| Variable | Required | Purpose |
| --- | --- | --- |
| `BRUNO_DIGITALOCEAN_TOKEN` | Automated cloud runners | DigitalOcean API token. If omitted, cloud provisioning is unavailable. |
| `BRUNO_RUNNER_BEARER_TOKEN` | DigitalOcean or manual runner control | Shared server-side command token used between the control plane and runner service. |
| `BRUNO_RUNNER_IMAGE` | Hosted cloud runners | Immutable runner reference in `registry/path:version@sha256:digest` form. Hosted DigitalOcean configuration rejects mutable or tag-only references; `local_docker` may use a tagged development image. |
| `BRUNO_HERMES_WORKLOAD_IMAGE` | No | Exact Hermes workload image used by deployment and runtime reconciliation. The full legacy v2026.7.7.2 image remains the default; the separately published `optimized-hermes-v2026.8.3` gateway candidate omits browser and local-media toolchains and is opt-in by immutable digest. Controlled staging requires the attested untagged GHCR amd64 manifest digest. |
| `BRUNO_HERMES_WORKLOAD_AMD64_MANIFEST_DIGEST` | Snapshot mode | Exact linux/amd64 manifest nested under `BRUNO_HERMES_WORKLOAD_IMAGE`; required for an optimized Snapshot Attestation and derived from the signed Approved Snapshot during Verified Release. |
| `BRUNO_HERMES_DOCKER_CPUS` | No | Docker CPU limit for each managed Hermes container; defaults to `1` and is validated against the selected runner profile before provider calls. |
| `BRUNO_HERMES_DOCKER_MEMORY` | No | Docker memory limit for each managed Hermes container; defaults to `1536m`. Compatibility counts physical RAM plus the documented runner/OS reserve, never swap. |
| `BRUNO_HERMES_DOCKER_PIDS_LIMIT` | No | Docker PID limit for each managed Hermes container; defaults to `256` and is propagated into runner bootstrap. |
| `BRUNO_RUNNER_MAX_AGENTS` | No | Positive per-runner agent capacity; defaults to `1`. A value above one is accepted only when the exact runner/runtime profile also has approved measured capacity and sufficient CPU, physical memory, and disk evidence; current hosted profiles remain fail-closed to one. |
| `BRUNO_DIGITALOCEAN_REGION` | No | Droplet region; defaults to `sfo3`. |
| `BRUNO_DIGITALOCEAN_SIZE_SLUG` | No | Droplet size; defaults to the provisional `s-1vcpu-2gb` managed-runner profile. Hosted provisioning rejects unsupported profiles and combinations that cannot fit the configured Hermes CPU and memory limits plus the runner/OS reserve in physical resources. Explicit supported overrides remain available for separately authorized resizing. |
| `BRUNO_DIGITALOCEAN_IMAGE` | No | Droplet image; defaults to `ubuntu-24-04-x64`. |
| `BRUNO_DIGITALOCEAN_SSH_KEY_IDS` | No | `auto`, `none`, or a comma-separated key-ID list. Omitted values auto-discover account keys. |
| `BRUNO_DIGITALOCEAN_SSH_SOURCE_CIDRS` | No | Comma-separated IPs/CIDRs allowed to reach SSH. SSH ingress is closed when this is omitted. |
| `BRUNO_AGENT_SECRET_ACTIVE_KEY_VERSION` | Hermes BYOK setup | Active encryption-key label, for example `v1`. |
| `BRUNO_AGENT_SECRET_KEYS_JSON` | Hermes BYOK setup | JSON object mapping key versions to 32-byte base64url keys. Keep old keys during rotation so existing secrets remain decryptable. |
| `BRUNO_READY_AGENT_CREATION_ENABLED` | Controlled ready-mode rollout | Must be exactly `true` to offer common one-click creation. Unset, blank, or `false` makes new setup unavailable; any other value fails closed. |
| `BRUNO_ROLLOUT_CONFIGURATION_GENERATION` | Protected rollout changes | Positive generation pinned with every new Agent Deployment; defaults to `1`. Increment it whenever protected defaults or rollback choices change. |
| `BRUNO_COLD_PROVISIONING_HALT_REASON` | Safety or rollback exercises | Unset permits new cold provisioning. An allowlisted safety reason or `rollout_exercise` halts before credential validation, persistence, or provider effects while active deployments retain pinned choices. |
| `CRON_SECRET` | Hosted reconciliation and wakeup operations | A 32–256 character bearer-safe secret used by Vercel to authorize deployment/runtime reconciliation and operator-only exhausted-wakeup inspection/replay routes. |
| `BRUNO_DEPLOYMENT_DISPATCH_MODE` | No | `cron` by default; set exactly `qstash` only with the complete dedicated QStash configuration. PostgreSQL remains authoritative. |
| `BRUNO_DEPLOYMENT_WAKEUP_MAX_PUBLISH_ATTEMPTS` | No | Atomic retryable QStash publication bound from 1 through 100; defaults to `12`. Authentication and payload rejections exhaust immediately. |
| `QSTASH_TOKEN` | QStash dispatch | Dedicated publication token; must not reuse Bruno.Ai operator, cron, or runner credentials. |
| `QSTASH_CURRENT_SIGNING_KEY` | QStash dispatch | Current callback verification key. |
| `QSTASH_NEXT_SIGNING_KEY` | QStash dispatch | Distinct next callback verification key for rotation. |

The default-disabled staging acceptance controller additionally requires the
16 exact capabilities documented in [E2E validation](./docs/E2E_VALIDATION.md),
including its dedicated bearer authority, published-image provenance, explicit
DigitalOcean budget and live-effect sentinels, and isolated Telegram plus direct
OpenAI-or-Anthropic credentials. Disabling the acceptance flag prevents forward work while cron
continues durable cleanup for an existing run.

The issue #299 DigitalOcean Provider Trial has a separate fail-closed operator command and
credential wizard. See [Run the authorized issue #299 Provider Trial](./docs/E2E_VALIDATION.md#run-the-authorized-issue-299-provider-trial).

The protected issue #300 workflow exercises each rollback with zero authorized provider spend and
publishes sanitized configuration-generation evidence. See [Exercise the guarded production
rollout](./docs/E2E_VALIDATION.md#exercise-the-guarded-production-rollout).

Additional validated tuning variables are documented inline in `.env.example` and
`src/server/env.ts`. Production runner bootstrap pulls the configured runner and Hermes images;
ensure those images are available to the Droplet without relying on credentials that bootstrap
does not install.

### Object storage and Recovery Archives

All five variables are required together to enable S3-compatible object storage:

- `BRUNO_BACKUP_STORAGE_ENDPOINT_URL`
- `BRUNO_BACKUP_STORAGE_BUCKET`
- `BRUNO_BACKUP_STORAGE_REGION`
- `BRUNO_BACKUP_STORAGE_ACCESS_KEY_ID`
- `BRUNO_BACKUP_STORAGE_SECRET_ACCESS_KEY`

Leaving all five unset disables object-backed manual backups without preventing the rest of the app
from starting. Owner Preview and later Release Stages additionally require:

- `BRUNO_RECOVERY_ARCHIVE_MASTER_KEY` — a dedicated, base64-encoded 32-byte key used only to wrap
  per-archive recovery credentials.
- `BRUNO_OWNER_PREVIEW_QUALIFICATIONS` — the current
  `bruno.owner-preview-qualifications.v1` JSON bundle containing separate OpenAI and Calendar
  `bruno.preview-qualification.v1` records. Each record is independently scoped to the exact Owner,
  Operator, `owner_preview` stage, application revision, runtime revision, capability,
  qualification window, evidence digest, and required safety gates.

Configure the storage variables and master key together before admitting Owner Preview. Partial
configuration fails closed. Do not reuse an Agent Secret, Connection Secret, cron secret, runner
credential, or provider credential as this key.

Recovery Archive buckets must have object versioning disabled. Bruno checks the live bucket
versioning response before both creation and deletion and fails closed when permanent deletion
cannot be proved; a delete marker over retained object versions does not satisfy the contract.

Recovery Archives use the object store only as an off-Droplet transport. Their encrypted payload,
separate wrapped recovery credential, authenticated restore check, 24-hour refresh boundary, and
30-day deletion receipt are distinct from the manual backup manifest and from DigitalOcean
snapshots. The protected `/api/internal/operator/recovery-archives` cron runs hourly, creates a new
archive two hourly schedule intervals before the current verified copy reaches 24 hours, and
processes expiry even after a
Release Hold or denied admission. Object identities are persisted before upload, so an interrupted
or partially failed creation remains discoverable for bounded cleanup. A completed Infrastructure
Retirement stops new daily copies while the final retained archive continues to its 30-day expiry;
a later `resume` Release Decision can start protection again for a restored Operator. Production
Operator preparation grants Owner Preview admission only after current OpenAI and Calendar Preview
Qualification and the initial archive's isolated rebuild check all pass. Founder workspace reads
require a prior exact-revision Owner Preview admission. New work and effect-starting transactions
additionally require a verified archive observed within the last 24 hours and every capability named
by that boundary to remain available. A Release Hold keeps the complete admitted manifest while
persisting the affected capability subset, so unrelated qualified work and all safe reads remain
available. A stale archive or non-Ready runtime pauses new work without hiding saved checkpoints.
Runtime failure records that Hold through the canonical exact-revision writer. Owner Preview remains
Calendar-only Limited Operation: Core Operation and Gmail effects stay unavailable even if retained
Mail state exists. Read endpoints project existing operation state without reconciling new rows.
Infrastructure Retirement marks the destroyed runtime as needing attention before
its receipt completes, so only newly provisioned and verified infrastructure can become Ready
again. The encrypted durable state preserves an external-action pause as the complete boolean,
reason, and timestamp tuple required to rebuild it safely. Every S3-compatible
request, including response-body reads, uses a 10-second abort deadline so unavailable storage
cannot indefinitely hold recovery, expiry, or retirement work.

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
   explicitly choose `development` and set `BRUNO_ALLOW_PUBLIC_DEVELOPMENT=true`; this exposes
   all browser pages and app-side APIs.
6. Before ready-mode rollout, choose ChatGPT or Claude and obtain the matching funded OpenAI
   Platform or Anthropic API key. API usage is billed separately from ChatGPT and Claude consumer
   subscriptions. Create a dedicated Telegram bot with [BotFather](https://t.me/BotFather), record
   at least one positive decimal Telegram user ID, and do not share its token between active agents.

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
vercel env add BRUNO_AUTH_MODE production
vercel env add BRUNO_OPERATOR_PASSWORD production
```

Add `BRUNO_OPERATOR_USERNAME` only when you do not want the default `bruno` username.
For public development testing, set `BRUNO_AUTH_MODE` to `development`, add
`BRUNO_ALLOW_PUBLIC_DEVELOPMENT=true`, and omit the operator password prompt.

For Clerk mode, also add:

```sh
vercel env add NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY production
vercel env add CLERK_SECRET_KEY production
```

For DigitalOcean-backed execution, add:

```sh
vercel env add BRUNO_DIGITALOCEAN_TOKEN production
vercel env add BRUNO_RUNNER_BEARER_TOKEN production
```

For Hermes BYOK and Telegram setup, generate one 32-byte base64url key, store it as a versioned
JSON value, and add both keyring variables:

```sh
vercel env add BRUNO_AGENT_SECRET_ACTIVE_KEY_VERSION production
vercel env add BRUNO_AGENT_SECRET_KEYS_JSON production
vercel env add CRON_SECRET production
```

Before any Owner Preview admission, add all five object-storage variables, the dedicated Recovery
Archive master key, and the exact current Preview Qualification through encrypted prompts:

```sh
vercel env add BRUNO_BACKUP_STORAGE_ENDPOINT_URL production
vercel env add BRUNO_BACKUP_STORAGE_BUCKET production
vercel env add BRUNO_BACKUP_STORAGE_REGION production
vercel env add BRUNO_BACKUP_STORAGE_ACCESS_KEY_ID production
vercel env add BRUNO_BACKUP_STORAGE_SECRET_ACCESS_KEY production
vercel env add BRUNO_RECOVERY_ARCHIVE_MASTER_KEY production
vercel env add BRUNO_OWNER_PREVIEW_QUALIFICATIONS production
```

`vercel.json` schedules deployment and runtime reconciliation every minute and Recovery Archive
reconciliation hourly. Each request must carry the exact cron secret as a bearer credential.
Deployment recovery processes at most 25 due items under one shared 40-second deadline; runtime
convergence continues to claim at most one due row. Keep the value in Vercel; do not place it in a
URL, log, or committed file.

Leave `BRUNO_READY_AGENT_CREATION_ENABLED` unset during initial deployment. Add it with the exact
value `true` only to the controlled environment after the authorized staging acceptance passes.

Add any runner overrides or all five backup-storage variables from the reference above. Use
separate preview values if you deploy previews. An unset Vercel preview defaults to Clerk and fails
closed without both Clerk keys; do not bypass that policy by copying production secrets casually.

### 4. Validate before deployment

Run the deterministic local verification gate with:

```sh
bun run verify
```

GitHub CI additionally runs the credential-free browser smoke surface:

```sh
bun run test:e2e:ci
```

Use `bun run verify:e2e` when full provider-backed acceptance is explicitly required. It runs the
base verification gate and then the complete E2E suite. This requires approved runner or
DigitalOcean credentials and may create and delete billable resources.

### 5. Deploy production

```sh
bun run deploy:prod
```

To publish and verify the signed release artifacts without staging or promoting a Vercel
deployment, run:

```sh
bun run runner:release:publish-verified
```

To publish and scan only the current commit's immutable runner candidate for a protected snapshot
build, without staging a control plane or promoting production, run:

```sh
bun run runner:image:publish
```

The `verified-release` action retrieves the immutable runner image from the signed Approved
Snapshot, verifies that exact identity, scans it, exercises the credential-free full fixture,
verifies cleanup, and publishes the signed digest-addressed OCI bundle. It does not build a new
runner candidate or run the Vercel staging or production jobs. The production `release` action
uses that same snapshot-retained runner identity for the fixture, staged control plane, and
production promotion. Build and scan a new candidate separately with `runner:image:publish` before
creating its protected snapshot.

Run this only from a clean `main` branch after pushing the intended release commit. It dispatches the
protected `Deploy production application` workflow, which retrieves and scans the immutable runner
already retained by the Approved Snapshot, stages the full application without production traffic,
and runs the credential-free full runner fixture against the exact approved Snapshot Attestation v2
identities. The workflow signs
and publishes that Verified Release by immutable GHCR OCI digest before it promotes the exact staged
deployment and verifies the production health and required-release contract. The canary creates no
DigitalOcean resource. Follow the returned GitHub Actions URL and approve the protected environments
when prompted. See
[Production application deployments](./docs/RUNNER_RELEASES.md) for the release and rollback
contract.

Do not run `vercel deploy --prod` directly when ready agent creation is enabled. Direct deployment
does not supply the Verified Release `BRUNO_RUNNER_IMAGE` digest and build marker, so
the production build fails closed before migrations.

To create a preview first, configure the preview environment and run `vercel deploy`. Preview auth
rules are stricter than local development; see [Authentication modes](./docs/AUTHENTICATION.md).

### 6. Verify the deployment

Check the public health route and Vercel logs:

```sh
curl -fsS https://your-domain.example/health
vercel logs --environment production --level error --since 5m
```

The health response should report `status: "ok"`, `database: "reachable"`, and the sanitized active
`deploymentDispatch` mode (`cron` or `qstash`). An incomplete selected QStash configuration reports
`deploymentDispatch: "invalid"` and returns `503`. Then authenticate, open Settings, provision a
cloud runner, and wait for registration plus the first heartbeat before assigning or starting an
agent. Production start requests fail closed when no online runner is available.

### 7. Operate and roll back ready-mode creation

Ready mode presents only ChatGPT and Claude. The first agent for a choice requires the matching
OpenAI Platform or Anthropic API key; later agents reuse that encrypted owner-scoped connection.
It also requires one dedicated BotFather token and one to 100 positive decimal Telegram user IDs
entered one per line. Usernames, groups, CSV input, wildcards, and automatic BotFather account
management are not supported. The server validates the bot token, rejects a token already used by
another active agent, and never redisplays submitted secrets.

Initial setup persists its progress rather than tying it to one browser request:

| Deployment stage | Meaning |
| --- | --- |
| `pending` | The committed request is waiting to be claimed. |
| `provisioning_runner` | Runner capacity is being selected, created, or awaited. |
| `configuring_hermes` | The revisioned managed Hermes configuration is being projected. |
| `starting_gateway` | The runner accepted or is converging the selected container. |
| `verifying_model` | Legacy or non-production model verification is being resolved; production creation skips this stage. |
| `connecting_telegram` | Private API/gateway readiness and the dedicated bot connection are being verified. |
| `ready` | The expected revision, private API, gateway, and Telegram connection passed. |
| `failed` | Setup ended with a safe error code; Retry, Stop, and Delete are available as applicable. |

Transient runner/start conditions use persisted backoff. A terminal failure attempts safe workload
cleanup. Production creation does not dispatch a model canary: once the configured Hermes gateway
is ready, reconciliation records the model check as skipped and continues to Telegram. Local and
release acceptance paths retain synthetic model coverage outside the user creation path. An
explicit Retry creates a new persisted deployment attempt without a model call during production
creation.

After `ready`, the runtime view separates ongoing health from initial deployment:

| Runtime state | Meaning |
| --- | --- |
| Ready | The expected managed gateway revision is healthy. |
| Recovering | Bounded stop/start or readiness verification is in progress; wait. |
| Stopping | Desired state is stopped and workload removal is being verified. |
| Intentionally stopped | Durable Stop is complete; only an explicit Start changes desired state. |
| Attention required | Automatic recovery opened its circuit; inspect the safe message and Restart explicitly. |
| Unavailable | Persisted or observed state could not be trusted; the UI fails closed. |

Managed containers use Docker `unless-stopped`. The runtime controller observes desired-running
agents after runner or Docker restarts, performs bounded recovery, and opens a circuit after repeated
failures. Stop first persists desired state as stopped and then removes the workload, so a runner
process or Docker restart must not resurrect it.

To roll back, remove or set `BRUNO_READY_AGENT_CREATION_ENABLED=false` in the affected environment
and redeploy. This disables common new-agent setup. The stopped-create API remains only as a legacy
operator compatibility path; it is not offered in ordinary onboarding. Existing running agents
retain their persisted desired state, so stop them explicitly when containment is required.
Disabling the flag alone is not a bulk-stop operation.

The credential-free, database, browser, and pinned-image paths are locally verified. The final
provider-backed DigitalOcean plus real Telegram reply acceptance has not been run and remains gated
on explicit authorization and the capabilities in [E2E validation](./docs/E2E_VALIDATION.md). Do not
enable ready mode by treating mock or local evidence as live acceptance.

## Commands

| Command | Purpose |
| --- | --- |
| `bun run dev` | Start the Next.js development server using the current environment. |
| `bun run build` / `bun run start` | Build and serve the production Next.js application. |
| `bun run local:up` / `bun run local:down` | Start or stop PostgreSQL plus the direct local app path. |
| `bun run local:cloud:up` / `bun run local:cloud:down` | Start or stop the complete local cloud simulation. |
| `bun run local:cloud:smoke` | Create an agent and exercise local runner provisioning. |
| `bun run local:agent:smoke` | Run the full ready-agent lifecycle on exactly one local simulated Droplet with zero provider requests. |
| `bun run db:migrate` | Apply committed Drizzle migrations. |
| `bun run db:generate` | Generate a migration from schema changes. |
| `bun run db:health` | Check database connectivity. |
| `bun run format:check` / `bun run format` | Check or write Biome formatting. |
| `bun run lint` | Run Biome lint rules. |
| `bun run typecheck` | Run TypeScript without emitting files. |
| `bun run test` | Run the serial Vitest unit suite in a temporary PostgreSQL database. |
| `bun run test:e2e:ci` | Run the credential-free Playwright smoke surface. |
| `bun run test:e2e` | Run the full provider-backed Playwright suite. |
| `bun run test:e2e:clerk` | Run the opt-in hosted Clerk development smoke. |
| `bun run verify` | Run formatting, lint, type checking, unit tests, and the production build. |
| `bun run verify:e2e` | Run the base verification gate followed by provider-backed E2E. |
| `bun run agent:image:smoke` | Verify the selected Hermes image contract locally. |
| `bun run agent:hermes:contract-smoke` | Exercise the pinned Hermes runner/readiness/restart contract locally. |
| `bun run runner:snapshot:build` | Protected manual runner-snapshot build entrypoint; requires explicit authorization and provider credentials. |
| `bun run runner:snapshot:retire` | Protected exact-ID snapshot retirement entrypoint; requires the dedicated workflow and authoritative absence verification. |
| `bun run runner:image:publish` | Publish and scan the current commit's immutable runner candidate without a Vercel deployment. |
| `bun run runner:release:publish-verified` | Publish the credential-free Verified Release without staging or promoting production. |
| `bun run verify:hermes:staging` | Run the capability-gated, interactive-human-attested live Hermes/Telegram acceptance and durable cleanup workflow. |
| `bun run deploy:prod` | Dispatch the protected full-application production deployment workflow. |

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
- [Authentication modes](./docs/AUTHENTICATION.md)
- [Two-user isolation acceptance](./docs/TWO_USER_ACCEPTANCE.md)
- [E2E validation](./docs/E2E_VALIDATION.md)
- [Changelog](./CHANGELOG.md)
