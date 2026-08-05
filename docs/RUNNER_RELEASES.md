# Production application deployments

Production deployments use the manually dispatched `Deploy production application` workflow. It
deploys the full Next.js application and coordinates that deployment with its required runner
image. The workflow never publishes or promotes a mutable `:main` tag. A release builds the exact
selected commit once, pushes only its Git-SHA runner tag, verifies and scans the resulting digest,
and stages the full application against production configuration without assigning any production
domain. A simulated
AMD64 Ubuntu Droplet in the GitHub runner executes the generated cloud-init and boots the published
linux/amd64 image through Docker. The same job builds and starts the candidate control plane on an
isolated host-only URL for registration, heartbeat, release identity, and boot-contract
verification; this avoids both production traffic and Vercel deployment-protection credentials.
That process uses development auth only inside the ephemeral GitHub VM; it is not deployed or
assigned a public domain.
Docker Desktop uses AMD64 emulation on ARM developer machines. Only a successful simulation may
promote the exact separately staged deployment to the production domains; promotion does not
rebuild or substitute another commit or image.

The linked Git repository does not deploy `main` directly to production. `vercel.json` skips an
automatic production build unless the release workflow supplies its non-secret
`AGENTBAY_CANARY_VERIFIED_DEPLOY=true` build marker. Preview builds remain enabled. The release and
rollback jobs are the only repository-owned paths that supply that marker, preventing a push from
bypassing image verification and the simulated-Droplet gate.

Production builds also fail before migrations or compilation when ready agent creation is enabled
without a DigitalOcean token, runner command bearer token, and immutable Git-SHA-plus-digest
`AGENTBAY_RUNNER_IMAGE`. At runtime, agent creation reuses an eligible runner when one exists. If
none is available, creation requires that provisioning configuration before persistence, then the
post-response reconciler performs one initialization slice and one provisioning slice so exactly
one durable provider attempt starts immediately. Protected cron reconciliation remains the retry
path. Automated and local tests inject fake providers and never create a Droplet.

Release workflow runs share one non-cancelling concurrency group. Automated tests and release runs
create zero DigitalOcean Droplets. The release job explicitly selects `local_docker`, supplies only
the literal non-secret provider token `local-docker`, and never maps the DigitalOcean release secret
into the job. The smoke command rejects any other token in local mode, preventing an accidental
cloud-provider fallback. Another release run cannot enter the workflow until the current run has
completed its container and database cleanup.

## Protected environments

Configure `runner-release-canary` with required reviewers and these scoped values:

| Kind | Name | Purpose |
| --- | --- | --- |
| Secret | `RUNNER_RELEASE_DATABASE_URL` | Database used by the staged control plane for the simulated runner registration record. |
| Secret | `RUNNER_RELEASE_BEARER_TOKEN` | Dedicated command bearer shared only with simulated release runners. |

Configure `production` with required reviewers and the existing Vercel project credentials:

| Kind | Name | Purpose |
| --- | --- | --- |
| Secret | `VERCEL_ORG_ID` | Production Vercel organization. |
| Secret | `VERCEL_PROJECT_ID` | Production Vercel project. |
| Secret | `VERCEL_TOKEN` | Scoped deployment token. |
| Secret | `CRON_SECRET` | Authenticates the post-deploy required-release check. |
| Variable | `PRODUCTION_URL` | Canonical HTTPS production origin. |

If the repository's GitHub plan cannot enforce required environment reviewers, do not dispatch a
release. Upgrade the plan or add an equivalently protected approval boundary first; a plain manual
dispatch is not a substitute for the required review.

The simulation injects `AGENTBAY_DIGITALOCEAN_SSH_KEY_IDS=disabled`; it neither creates an account
SSH key nor opens SSH ingress.

## Canary contract

The workflow runs:

```sh
bun run runner:release:smoke -- --image \
  ghcr.io/ametel01/agentbay-runner:<40-character-git-sha>@sha256:<64-hex-digest> \
  --provider local_docker
```

The command fails before side effects unless the immutable image, isolated local control plane,
database, local provider configuration, and bearer token are valid. It creates one
simulated Ubuntu Droplet container, runs the production cloud-init commands, boots the exact
published image, and requires its image digest, OCI release version, boot contract, authenticated
ready heartbeat, and all boot components. Those boot components exercise an isolated synthetic
start, status/readiness probe, model canary, stop, and cleanup without Telegram, a paid model
request, or a DigitalOcean API call.

Cleanup runs in a `finally` path. It removes the simulated Droplet and runner containers, confirms
the tagged local-provider set is absent, revokes runner credentials, and tombstones the runner
record. A failed cleanup fails the job and blocks promotion. Failure output contains only capability
names and closed error codes; it does not include tokens, database URLs, or cloud-init output.

This gate proves the runner image, generated bootstrap commands, local candidate-control-plane
registration flow, release identity, readiness contract, and cleanup on an Ubuntu/Docker host. It
does not prove Vercel deployment-protection behavior, DigitalOcean API availability, regional
capacity, public-IP assignment, cloud firewall behavior, or external network routing. A real
provider acceptance is therefore a separate, explicitly approved operation for provider/bootstrap
changes, never an automatic release retry.

## Promotion and rollback

Before the canary, the workflow stages the exact tested commit using Vercel's production
configuration and `--prod --skip-domain`, with:

```text
AGENTBAY_RUNNER_IMAGE=<tested immutable Git-SHA-plus-digest reference>
AGENTBAY_RUNNER_ROLLOUT_BATCH_SIZE=1
```

The staged deployment URL is passed directly to the canary and is never assigned a production
domain before the canary succeeds. The production job then promotes that exact URL and verifies
`/health` plus the authenticated
`/api/internal/runner-release/required` contract. Infrastructure reconciliation processes at most
one managed runner per invocation. Set the batch size to `0` to halt automatic fleet work.

For emergency rollback, dispatch the same workflow with `action=rollback`, the immutable image, and
the prior successful workflow run ID. The job downloads that run's `verified-runner-release`
artifact and refuses any image that does not match it exactly. Rollback deploys with batch size `0`,
verifies the required digest, and leaves rollout halted for operator review.

Do not switch the release workflow to `digitalocean` or add a cloud token to its environment.
Credential-free runs are expected to exit with `capability_unavailable` and
`sideEffectsAttempted: false`.
