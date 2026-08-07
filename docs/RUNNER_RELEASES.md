# Production application deployments

Production deployments use the manually dispatched `Deploy production application` workflow. It
deploys the full Next.js application and coordinates that deployment with its required runner
image. The workflow never publishes or promotes a mutable `:main` tag. A release builds the exact
selected commit once, pushes only its Git-SHA runner tag, verifies and scans the resulting digest,
and stages the full application against production configuration without assigning any production
domain. The production job promotes that exact staged deployment, then verifies `/health` and the
authenticated required-release contract without rebuilding or substituting another commit or
image.

> **Temporary development mode:** The simulated-Droplet canary is disabled in the deployment
> workflow to shorten iteration time. Image provenance, vulnerability scanning, staging, protected
> production approval, and post-deploy health/digest verification still run. Releases created while
> this bypass is active do not produce a `verified-runner-release` artifact and cannot be selected as
> verified rollback sources. Re-enable the canary before treating this workflow as a hardened
> production release gate.

The linked Git repository does not deploy `main` directly to production. `vercel.json` skips an
automatic production build unless the release workflow supplies its non-secret
`AGENTBAY_CANARY_VERIFIED_DEPLOY=true` build marker. Preview builds remain enabled. The release and
rollback jobs are the only repository-owned paths that supply that marker, preventing a push from
bypassing the publish, scan, and staging path. The marker name is retained temporarily for
compatibility; it does not imply that the disabled canary ran.

Production builds also fail before migrations or compilation when ready agent creation is enabled
without a DigitalOcean token, runner command bearer token, and immutable Git-SHA-plus-digest
`AGENTBAY_RUNNER_IMAGE`. At runtime, agent creation reuses only an already-running same-user runner
with fresh authenticated heartbeat evidence, compatible release evidence, and spare capacity
reserved inside the assignment transaction. Capacity is fail-closed to the minimum of computed
CPU/physical-memory/disk limits, heartbeat, configured `AGENTBAY_RUNNER_MAX_AGENTS`, and an
explicit measured profile cap; current hosted profiles remain capped at one. If no same-user
capacity is available, creation requires provisioning configuration before persistence, then the
post-response reconciler performs one initialization slice and one provisioning slice so exactly one
durable provider attempt starts immediately. Protected cron reconciliation remains the retry path.
Automated and local tests inject fake providers and never create a Droplet.

New production Droplets skip the runner boot model canary so user creation is not delayed by a
synthetic model round trip. Boot still verifies Docker, release identity, Hermes fixture startup,
detailed health, Telegram configuration loading, and cleanup. The local runner release smoke keeps
the model canary enabled before an image is selected for production.

Production agent creation does not dispatch the later agent-specific model canary either. After the
real Hermes gateway reports ready, the deployment records the canary as skipped and proceeds to
Telegram verification. Local release and contract smoke paths retain model-path coverage.

Release workflow runs share one non-cancelling concurrency group. Automated tests and release runs
create zero DigitalOcean Droplets. The release workflow does not configure a DigitalOcean provider
or map the DigitalOcean release secret into any job. Another release run cannot enter the workflow
until the current run has completed.

## Protected environments

The currently disabled `runner-release-canary` environment retains these scoped values for when the
gate is restored; they are not required by release runs while the bypass is active:

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

## Temporarily disabled canary contract

The reusable smoke command remains available for local or explicitly requested verification, but
the deployment workflow does not currently run it:

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

When invoked, cleanup runs in a `finally` path. It removes the simulated Droplet and runner
containers, confirms
the tagged local-provider set is absent, revokes runner credentials, and tombstones the runner
record. A failed cleanup fails the job and blocks promotion. Failure output contains only capability
names and closed error codes; it does not include tokens, database URLs, or cloud-init output.

When enabled, this gate proves the runner image, generated bootstrap commands, local
candidate-control-plane
registration flow, release identity, readiness contract, and cleanup on an Ubuntu/Docker host. It
does not prove Vercel deployment-protection behavior, DigitalOcean API availability, regional
capacity, public-IP assignment, cloud firewall behavior, or external network routing. A real
provider acceptance is therefore a separate, explicitly approved operation for provider/bootstrap
changes, never an automatic release retry.

## Promotion and rollback

The workflow stages the exact published commit using Vercel's production
configuration and `--prod --skip-domain`, with:

```text
AGENTBAY_RUNNER_IMAGE=<tested immutable Git-SHA-plus-digest reference>
AGENTBAY_RUNNER_ROLLOUT_BATCH_SIZE=1
```

The staged deployment URL is never assigned a production domain during staging. The production job
promotes that URL only after the published immutable image passes the full simulated-Droplet fixture,
including authenticated heartbeat, release identity, the complete Hermes fixture, and cleanup. It
then verifies `/health` plus the authenticated
`/api/internal/runner-release/required` contract. Infrastructure reconciliation processes at most
one managed runner per invocation. Set the batch size to `0` to halt automatic fleet work.

For emergency rollback, dispatch the same workflow with `action=rollback`, the immutable image, and
the prior successful workflow run ID. The job downloads that run's `verified-runner-release`
artifact and refuses any image that does not match it exactly. Rollback deploys with batch size `0`,
verifies the required digest, and leaves rollout halted for operator review.

Do not switch the release workflow to `digitalocean` or add a cloud token to its environment.
Credential-free runs are expected to exit with `capability_unavailable` and
`sideEffectsAttempted: false`.

## Protected runner snapshot builds

Runner snapshots are built only through `.github/workflows/build-runner-snapshot.yml`. The workflow
is `workflow_dispatch` only, uses the protected `snapshot-build` environment, and requires the exact
cost-authorization sentinel before any DigitalOcean token is exposed to a step. Do not dispatch it
unless required reviewers are enforced on that environment; an unprotected manual dispatch is
forbidden.

Snapshot mode is not a warm pool. The workflow creates a short-lived builder Droplet only after
approval, validates the full boot contract, sanitizes instance state, powers the builder off, creates
one snapshot, emits an allowlisted signed manifest, and deletes temporary builder resources. It must
not create user runners, ready capacity, spare Droplets, cross-user capacity, schedules, release
triggers, or production deployments.

The builder SSH trust chain is intentionally narrow. The workflow resolves the GitHub runner
controller's public egress identity before any DigitalOcean step and the builder firewall accepts SSH
only from that exact `/32` IPv4 or `/128` IPv6 CIDR. The build command creates one provider SSH key,
tracks ownership immediately, and deletes it from both orchestrator and controller cleanup paths. To
retrieve builder evidence, the provider pins the observed ephemeral SSH host key into a temporary
`known_hosts` file, optionally compares a supplied `SHA256:` fingerprint, uses
`StrictHostKeyChecking=yes`, then removes the temporary known-hosts file and private key material.
`accept-new` and world-open SSH ingress are forbidden.

Production snapshot consumption is configured with:

```text
AGENTBAY_DIGITALOCEAN_IMAGE_MODE=snapshot
AGENTBAY_DIGITALOCEAN_SNAPSHOT_MANIFEST=<canonical manifest JSON>
AGENTBAY_DIGITALOCEAN_SNAPSHOT_SIGNATURE=<base64url Ed25519 signature>
AGENTBAY_DIGITALOCEAN_SNAPSHOT_PUBLIC_KEY=<public verification key>
AGENTBAY_RELEASE_SOURCE_REVISION=<exact 40-character release commit>
AGENTBAY_DOCKER_RUNNER_IMAGE=<immutable default-agent image reference>
```

Every hosted create path verifies the manifest signature, staleness, source revision, base image,
architecture, region, minimum disk compatibility, runner/default-agent/Hermes identities, and
authoritative provider image availability before a Droplet-create call. Invalid or unavailable
evidence fails closed. Set `AGENTBAY_DIGITALOCEAN_IMAGE_MODE=stock` or remove the snapshot variables
to use the existing complete Ubuntu bootstrap rollback path.

## Release-attested lightweight readiness

`full` remains the default boot-validation mode and the configuration-only rollback:

```text
AGENTBAY_RUNNER_BOOT_VALIDATION_MODE=full
```

After a release has passed the full simulated-Droplet fixture, create its signed release attestation
with `bun run runner:release:attest`. The command verifies the exact signed snapshot manifest before
binding the immutable runner digest, boot-contract version, snapshot ID and manifest digest, source
revision, workflow identity, validation timestamps, and expiry into a canonical Ed25519-signed
artifact. Keep private signing keys outside repository artifacts.

Lightweight snapshot boot requires all of the following validated production settings:

```text
AGENTBAY_RUNNER_BOOT_VALIDATION_MODE=release_attested
AGENTBAY_RUNNER_RELEASE_ATTESTATION=<canonical release attestation JSON>
AGENTBAY_RUNNER_RELEASE_ATTESTATION_SIGNATURE=<base64url Ed25519 signature>
AGENTBAY_RUNNER_RELEASE_ATTESTATION_PUBLIC_KEY=<public verification key>
```

The control plane verifies this evidence against the configured snapshot and immutable runner before
provisioning. Bootstrap transports the attestation and public key as base64url single-line values.
The runner verifies its Docker-observed release identity and the exact unexpired attestation before it
skips the duplicate Hermes fixture. Docker access, authenticated online heartbeat, HTTPS endpoint
readiness, and exact boot-attestation compatibility remain mandatory. Missing, stale, tampered, or
mismatched evidence is unassignable.
