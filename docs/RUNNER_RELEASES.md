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
`BRUNO_CANARY_VERIFIED_DEPLOY=true` build marker. Preview builds remain enabled. The release and
rollback jobs are the only repository-owned paths that supply that marker, preventing a push from
bypassing the publish, scan, and staging path. The marker name is retained temporarily for
compatibility; it does not imply that the disabled canary ran.

Production builds also fail before migrations or compilation when automatic Agent Deployments are
enabled without a DigitalOcean token, runner command bearer token, and immutable
Git-SHA-plus-digest `BRUNO_RUNNER_IMAGE`. At runtime, Same-Owner Reuse selects only an already-running
runner with fresh authenticated heartbeat evidence, compatible release evidence, and spare capacity
reserved inside the assignment transaction. Capacity is fail-closed to the minimum of computed
CPU/physical-memory/disk limits, heartbeat, configured `BRUNO_RUNNER_MAX_AGENTS`, and an
explicit measured profile cap; current hosted profiles remain capped at one. If no Same-Owner
capacity is available, the Agent Deployment requires provisioning configuration before persistence.
The post-response reconciler then performs one initialization slice and one provisioning slice so
exactly one durable provider attempt starts immediately. Protected cron reconciliation remains the
retry path. Automated and local tests inject fake providers and never create a Droplet.

New production Droplets skip the runner boot model canary so an Owner request is not delayed by a
synthetic model round trip. Boot still verifies Docker, release identity, Hermes fixture startup,
detailed health, Telegram configuration loading, and cleanup. The local runner release smoke keeps
the model canary enabled before an image is selected for production.

Production Agent Deployments do not dispatch the later agent-specific model canary either. After
the real Hermes gateway reports ready, the deployment records the canary as skipped and proceeds to
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

The simulation injects `BRUNO_DIGITALOCEAN_SSH_KEY_IDS=disabled`; it neither creates an account
SSH key nor opens SSH ingress.

## Temporarily disabled canary contract

The reusable smoke command remains available for local or explicitly requested verification, but
the deployment workflow does not currently run it:

```sh
bun run runner:release:smoke -- --image \
  ghcr.io/ametel01/bruno-runner:<40-character-git-sha>@sha256:<64-hex-digest> \
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
BRUNO_RUNNER_IMAGE=<tested immutable Git-SHA-plus-digest reference>
BRUNO_RUNNER_ROLLOUT_BATCH_SIZE=1
```

The staged deployment URL is never assigned a production domain during staging. While the canary is
temporarily disabled, the production job promotes that URL immediately after publish, scan, and
staging succeed, then verifies `/health` plus the authenticated
`/api/internal/runner-release/required` contract. Infrastructure reconciliation processes at most
one managed runner per invocation. Set the batch size to `0` to halt automatic fleet work.

For emergency rollback, dispatch the same workflow with `action=rollback`, the immutable image, and
the prior successful workflow run ID. The job downloads that run's `verified-runner-release`
artifact and refuses any image that does not match it exactly. Rollback deploys with batch size `0`,
verifies the required digest, and leaves rollout halted for operator review. Runs created while the
canary bypass is active do not contain this artifact and therefore are not valid rollback sources.

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
one snapshot, emits an allowlisted signed Snapshot Attestation v2 bundle, and deletes temporary
builder resources. It must
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
BRUNO_DIGITALOCEAN_IMAGE_MODE=snapshot
BRUNO_DIGITALOCEAN_SNAPSHOT_BUNDLE=<canonical Snapshot Attestation v2 bundle JSON>
BRUNO_DIGITALOCEAN_APPROVED_SNAPSHOT_DIGEST=<exact sha256 bundle digest>
BRUNO_DIGITALOCEAN_SNAPSHOT_TRUST_SET=<JSON object mapping key IDs to Ed25519 public keys>
BRUNO_DIGITALOCEAN_SNAPSHOT_BASE_IMAGE_ID=<exact provider base image ID>
BRUNO_DOCKER_RUNNER_IMAGE=<immutable default-agent image reference>
```

The `snapshot-build` protected environment also defines the non-secret
`BRUNO_SNAPSHOT_SIGNING_KEY_ID` variable for the Ed25519 private key held in
`BRUNO_SNAPSHOT_SIGNING_KEY_PEM`. The bundle carries that key ID, and production resolves it only
through the operator-managed trust set. Keep the current and previous public keys in the set during
rotation so retained rollback evidence remains independently verifiable.

The same protected environment must define `BRUNO_SNAPSHOT_TRUST_SET` as the JSON map of trusted
Ed25519 public keys used for publication verification. When an earlier candidate exists, set both
`BRUNO_SNAPSHOT_PREVIOUS_OCI_REFERENCE` and `BRUNO_SNAPSHOT_PREVIOUS_BUNDLE_DIGEST` to its exact
digest-addressed GHCR reference and canonical bundle digest. The pair is fail-closed: setting only
one value stops publication. On the first publication, the new candidate fills both retention roles;
before the next publication, move that candidate's two identities into the previous-candidate
variables.

After provider cleanup, the workflow publishes three allowlisted OCI layers to
`ghcr.io/<owner>/bruno-runner-snapshot-bundles`: the canonical bundle JSON, its `sha256:` bundle
digest, and the identified Ed25519 public key. It then pulls the artifact by its returned OCI
manifest digest and re-verifies the artifact type, exact file allowlist, bundle bytes, bundle digest,
signature, signing key, and active/previous retention pair. The sanitized
`runner-snapshot-oci-publication.json` convenience copy records both identities:

```json
{
  "schemaVersion": "bruno.runner.snapshot.oci-publication.v1",
  "artifactType": "application/vnd.bruno.runner.snapshot.bundle.v2",
  "active": {
    "ociReference": "ghcr.io/example/bruno-runner-snapshot-bundles@sha256:<oci-manifest-digest>",
    "bundleDigest": "sha256:<canonical-bundle-digest>",
    "signingKeyId": "<trusted-key-id>"
  },
  "previous": {
    "ociReference": "ghcr.io/example/bruno-runner-snapshot-bundles@sha256:<oci-manifest-digest>",
    "bundleDigest": "sha256:<canonical-bundle-digest>",
    "signingKeyId": "<trusted-key-id>"
  }
}
```

Use `active.ociReference` for retrieval and require `active.bundleDigest` when configuring approval.
The GitHub Actions artifact is retained for operator convenience only; its run ID and artifact name
are never production identity. Do not delete either digest-addressed active or previous OCI artifact,
and do not remove either signing key from the trust set while rollback may select it.

Every hosted create path requires the configured approval digest to match the exact canonical
bundle, resolves its identified signing key from the trust set, verifies its signature, rejects v1,
and checks exact runner profile, disk, base OS, architecture, region,
runner/default-agent/Hermes/boot-contract, and authoritative provider image-availability identities
before a Droplet-create call. Source repository, revision, workflow identity, and timestamps remain
signed provenance; they do not expire an otherwise compatible bundle and do not couple snapshot
compatibility to a control-plane revision.

Promotion atomically selects a new retained bundle and its exact digest. Removing the approved
digest revokes snapshot selection and makes snapshot-mode configuration fail closed. Rollback
restores a retained compatible bundle and digest without rewriting the attestation; its signing key
must still be present in the trust set. Set `BRUNO_DIGITALOCEAN_IMAGE_MODE=stock` to use the existing
complete Ubuntu bootstrap rollback path.
