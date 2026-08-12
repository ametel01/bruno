# Production application deployments

Production deployments use the manually dispatched `Deploy production application` workflow. It
deploys the full Next.js application and coordinates that deployment with its required runner
image. The workflow never publishes or promotes a mutable `:main` tag. A release builds the exact
selected commit once, pushes only its Git-SHA runner tag, verifies and scans the resulting digest,
and stages the full application against production configuration without assigning any production
domain. A protected credential-free canary pulls the exact selected Snapshot Attestation v2 OCI
artifact, runs the full simulated-Droplet fixture against its immutable runner, default-agent,
Hermes, and boot-contract identities, and proves exact cleanup. It then signs a canonical Verified
Release bundle, publishes it to GHCR, and re-verifies it by immutable OCI manifest digest. Only that
successful dependency allows the production job to promote the exact staged deployment and verify
`/health` plus the authenticated required-release contract.

The linked Git repository does not deploy `main` directly to production. `vercel.json` skips an
automatic production build unless the release workflow supplies its non-secret
`BRUNO_CANARY_VERIFIED_DEPLOY=true` build marker. Preview builds remain enabled. The release and
rollback jobs are the only repository-owned paths that supply that marker, preventing a push from
bypassing image publication, scanning, staging, full-fixture verification, signed bundle
publication, and protected promotion.

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
create zero DigitalOcean Droplets. The canary selects only the `local_docker` simulation with the
literal non-secret `local-docker` token and never maps a DigitalOcean credential into any job.
Another release run cannot enter the workflow until the current run has published or failed and
verified cleanup.

## Protected environments

Configure `runner-release-canary` with required reviewers and these scoped values:

| Kind | Name | Purpose |
| --- | --- | --- |
| Secret | `RUNNER_RELEASE_BEARER_TOKEN` | Dedicated command bearer shared only with simulated release runners. |
| Secret | `BRUNO_RELEASE_SIGNING_KEY_PEM` | Ed25519 private key used only while creating the canonical release bundle. |
| Variable | `BRUNO_RELEASE_SIGNING_KEY_ID` | Identifier carried by the release signature. |
| Variable | `BRUNO_RELEASE_TRUST_SET` | JSON map of current and retained release key IDs to Ed25519 public keys. |
| Variable | `BRUNO_RELEASE_APPROVED_SNAPSHOT_OCI_REFERENCE` | Exact digest-addressed Snapshot Attestation v2 OCI reference selected for the release. |
| Variable | `BRUNO_RELEASE_APPROVED_SNAPSHOT_BUNDLE_DIGEST` | Canonical digest of the selected snapshot bundle. |
| Variable | `BRUNO_SNAPSHOT_TRUST_SET` | JSON map used to verify the selected snapshot signing key. |
| Variable | `BRUNO_RELEASE_PREVIOUS_OCI_REFERENCE` | Retained previous Verified Release OCI reference after the first publication. |
| Variable | `BRUNO_RELEASE_PREVIOUS_BUNDLE_DIGEST` | Canonical digest paired with the retained previous release. |

The canary provisions a job-scoped PostgreSQL service from a digest-pinned image and applies every
repository migration before starting the control plane. The service is destroyed with the GitHub
runner, so the credential-free fixture cannot drift behind the checked-out schema or retain trial
records between releases.

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

Superseded provider snapshots are retired separately through the protected `Retire superseded
runner snapshot` workflow. The workflow requires the exact snapshot ID, its signed snapshot name,
region, and destructive-action sentinel before exposing the `snapshot-build` credential. It reads
and matches that complete identity, deletes only that image, performs an authoritative post-delete
read, and retains an allowlisted absence artifact. Snapshot publication must succeed before this
retirement workflow is dispatched; a failed retirement never retries the billable builder.

The simulation injects `BRUNO_DIGITALOCEAN_SSH_KEY_IDS=disabled`; it neither creates an account
SSH key nor opens SSH ingress.

## Credential-free canary contract

The workflow runs the same reusable smoke command available for local verification:

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

Cleanup runs in a `finally` path. It removes the simulated Droplet and runner containers, confirms
the tagged local-provider set is absent, revokes runner credentials, and tombstones the runner
record. A failed cleanup fails the job and blocks promotion. Failure output contains only capability
names and closed error codes; it does not include tokens, database URLs, or cloud-init output.
Persisted allowlisted boot-self-test reasons remain authoritative; provider diagnostics are used
only when no authoritative closed failure code exists.

This gate proves the runner image, generated bootstrap commands, local candidate-control-plane
registration flow, release identity, readiness contract, and cleanup on an Ubuntu/Docker host. It
does not prove Vercel deployment-protection behavior, DigitalOcean API availability, regional
capacity, public-IP assignment, cloud firewall behavior, or external network routing. A real
provider acceptance is therefore a separate, explicitly approved operation for provider/bootstrap
changes, never an automatic release retry.

Before the bounded full fixture starts, the workflow pulls and inspects the exact digest-qualified
runner, default-agent, and Hermes images selected by the Approved Snapshot. This keeps cold registry
transfer time outside the readiness deadline without changing the images or relaxing that deadline.
The fixture also creates the Hermes bridge before provisioning and verifies that a nested container
can reach the candidate control plane through that bridge's concrete Linux gateway. The local
provider applies the same gateway to the runner callback while preserving Docker Desktop's native
host routing. The workflow makes at most three full-fixture attempts and retries only after the
failed attempt proves that side effects began and cleanup is authoritative. A capability failure or
an unverified cleanup stops the gate immediately. The first passing result becomes the canonical
smoke evidence. Each attempt retains its sanitized smoke result for 90 days; failed results contain
only the closed failure code, cleanup verdict, and an allowlisted runner-ingress event summary,
never credentials, runner IDs, database details, or raw bootstrap and control-plane output.

The canary retrieves the Approved Snapshot only as a signed OCI artifact. It does not receive a
DigitalOcean credential, inspect live provider state, or claim to boot that provider snapshot. The
Verified Release joins snapshot and release evidence only when the snapshot signature, approved
bundle digest, runner image, default-agent image, Hermes image, and boot contract all match exactly.
The workflow verifies that signature, digest, trust set, and exact runner-image join before it reads
or executes either workload image reference from the Snapshot bundle.
The bundle retains the current-machine full-fixture checks separately from the historical Snapshot
Attestation identity.

The workflow publishes three allowlisted OCI layers to
`ghcr.io/<owner>/bruno-runner-release-bundles`: the canonical bundle JSON, its `sha256:` digest, and
the identified Ed25519 public key. It pulls the result by OCI manifest digest and verifies the exact
file allowlist, canonical bytes, digest, signature, signing key, and active/previous retention pair.
The `verified-runner-release` GitHub artifact is a 90-day operational convenience; the durable
release identity is the OCI reference plus canonical bundle digest recorded in
`runner-release-oci-publication.json`.

## Promotion and rollback

The workflow stages the exact published commit using Vercel's production
configuration and `--prod --skip-domain`, with:

```text
BRUNO_RUNNER_IMAGE=<tested immutable Git-SHA-plus-digest reference>
BRUNO_RUNNER_ROLLOUT_BATCH_SIZE=1
```

The staged deployment URL is never assigned a production domain during staging. The production job
promotes it only after image publication, scanning, the full fixture, cleanup, and signed OCI bundle
verification succeed, then verifies `/health` plus the authenticated
`/api/internal/runner-release/required` contract. Infrastructure reconciliation processes at most
one managed runner per invocation. Set the batch size to `0` to halt automatic fleet work.

For artifact publication without any Vercel deployment, dispatch the workflow with
`action=verified-release` or run `bun run runner:release:publish-verified`. That path publishes and
verifies the runner image already retained by the signed Approved Snapshot, scans that exact image,
and publishes the signed OCI release bundle while the candidate-build, staging, and production jobs
stay skipped. `action=release` instead builds a new candidate and fails closed unless its immutable
identity matches the selected Approved Snapshot; use it only when the separate production
deployment is authorized.

Before a protected snapshot build, dispatch `action=runner-image` or run
`bun run runner:image:publish`. This path builds, publishes, verifies, and scans only the current
commit's immutable runner candidate. The Vercel staging, Verified Release, production, and rollback
jobs remain skipped; use the resulting Git-SHA-plus-digest reference as the snapshot's exact runner
identity.

For emergency rollback, dispatch the same workflow with `action=rollback`, the immutable image, and
the prior successful workflow run ID. The job downloads that run's `verified-runner-release`
artifact and refuses any image that does not match it exactly. Rollback deploys with batch size `0`,
verifies the required digest, and leaves rollout halted for operator review. The artifact retains
the signed bundle and its immutable OCI publication identity so the rollback source remains
independently verifiable.

Do not switch the release workflow to `digitalocean` or add a cloud token to its environment.
Provider-backed release acceptance is a separate action requiring exact authorization.

## Release-attested admission and pinned recovery

Stock runners always use `BRUNO_RUNNER_BOOT_VALIDATION_MODE=full` and execute the current-machine
fixture. Protected Rollout Configuration may select `release_attested` only when it also supplies
the exact canonical Verified Release bundle and approved digest, overlapping release trust set,
digest-addressed Approved Snapshot OCI reference, and approved Snapshot bundle digest. Server
configuration verifies the complete Snapshot and release join before any provider effect.

On a release-attested runner, boot observes current Docker access, required services, the injected
bundle identities, and each exact digest-qualified preloaded image. Historical full-fixture,
detailed-health, model-canary, Telegram-configuration, and cleanup evidence remains under
`attestedChecks`; it cannot be reported as a current-machine observation. Admission additionally
requires authenticated registration, heartbeat, readiness, exact runner release identity, and the
same release/snapshot evidence expected by the control plane. The release-attested path does not
start a duplicate synthetic Hermes fixture on an Owner cold deployment.

At Agent Deployment acceptance, Bruno persists the exact dispatch mode, provider mode and region,
runner size and images, Snapshot bundle and trust inputs, Verified Release bundle and trust inputs,
validation mode, and Rollout Configuration generation. Retry, reconciler crash recovery, and runner
replacement combine those immutable non-secret choices with the credentials currently authorized
for the provider. A rollback changes defaults only for new deployments; existing deployments keep
their pinned interpretation. If a pinned choice becomes unsafe, the explicit safety-quarantine
operation terminalizes that deployment without rewriting its evidence.

## Protected runner snapshot builds

Runner snapshots are built only through `.github/workflows/build-runner-snapshot.yml`. The workflow
is `workflow_dispatch` only, uses the protected `snapshot-build` environment, and requires the exact
cost-authorization sentinel before any DigitalOcean token is exposed to a step. Do not dispatch it
unless required reviewers are enforced on that environment; an unprotected manual dispatch is
forbidden.

The dispatch identifies Hermes with two immutable values: `hermes_image` is the exact OCI index
reference ending in `@sha256:...`, and `hermes_amd64_manifest_digest` is the single linux/amd64
manifest nested under that index. The published workload-image workflow prints both values in its
summary after smoking and scanning the exact pushed digest. The legacy default retains its pinned
upstream identity; optimized candidates are accepted only from `ghcr.io/ametel01/bruno-hermes` and
remain opt-in until their signed snapshot and Verified Release pass.

Snapshot mode is not a warm pool. The workflow creates a short-lived builder Droplet only after
approval. The generated user-data is a directly executable Bash script, so bootstrap does not depend
on cloud-config `runcmd` serialization or the distribution `/bin/sh`. Before metadata or network
access, it writes an allowlisted local `user_data_started` stage and records each later allowlisted
boundary locally. It records `bootstrap_started` before package installation, then runs the immutable
runner image's Docker, Hermes fixture, detailed-health, synthetic model canary,
Telegram-configuration, and fixture-cleanup checks, and requires every component to pass. An empty
set of Bruno Docker networks is a successful cleanup condition. After cloud-init completes, the
controller invokes a one-shot finalizer over the already-established SSH session. The finalizer
removes cloud-init state and the temporary authorized SSH key, verifies the machine identity is
empty, and only then returns boot and sanitation evidence over that same connection for snapshot
creation.

The protected snapshot fixture attempts the synthetic model canary at most six times, five seconds
apart, within the existing 180-second full-fixture deadline. Its boot evidence retains only one
allowlisted outcome per attempt: `passed`, `canary_unauthorized`, `canary_unreachable`,
`canary_timeout`, `canary_invalid_response`, `canary_model_failed`, `canary_not_ready`, or
`canary_exception`. It never retains response bodies, model output, URLs, headers, keys, or exception
text. Snapshot creation requires between one and six outcomes with `passed` last; missing, malformed,
oversized, or non-passing evidence fails closed.

Publication fails closed unless the firewall, Droplet, and provider SSH key are authoritatively absent;
the sanitized cleanup result is retained for 30 days with GitHub build provenance alongside the signed
bundle. The workflow then powers the builder off, creates one snapshot, emits an allowlisted signed
Snapshot Attestation v2 bundle, and deletes temporary builder resources. It must
not create user runners, ready capacity, spare Droplets, cross-user capacity, schedules, release
triggers, or production deployments.

After the snapshot action completes, the builder polls the image lookup and availability contract for
up to two minutes. Publication requires the image ID and name to remain stable, the selected region to
be available, and the snapshot minimum disk size to fit the selected runner profile. Pending or
not-yet-region-visible images are retried; deleted, mismatched, or oversized images fail closed. Any
failure after valid boot and sanitation evidence preserves those two allowlisted results in the
sanitized builder-diagnostics artifact so operators can distinguish snapshot-provider failures from
fixture failures.

The protected workflow retrieves builder evidence directly through its short-lived,
firewall-restricted SSH connection. It pins the builder host key, keeps the connection alive while
`cloud-init status --wait` completes, runs sanitation, and reads the two allowlisted evidence files
before the connection closes. Removing `authorized_keys` does not terminate that established session.
The build job grants only `contents: read`; it does not grant issue-write permission, place a GitHub
token or callback secret in user-data, create an asynchronous finalizer service, or depend on an issue
comment for authority.

If completed evidence does not arrive within the builder deadline, the build reports
`builder_evidence_timeout` instead of classifying the absence as a boot-fixture assertion. It retains
one separate diagnostics artifact containing only the diagnostics contract version, allowlisted
local bootstrap stage, and normalized cloud-init status; it never retrieves user-data, cloud-init
output, arbitrary logs, or credentials. Local diagnostics distinguish user-data startup, metadata,
package, image, and fixture boundaries. Callback status is `unavailable` because the protected path
has no callback channel. This artifact is diagnostic only and cannot authorize snapshot creation.

The workflow still creates and immediately tracks one provider SSH key as a cleanup and sanitation
proof target. Its firewall accepts SSH only from the controller's observed `/32` IPv4 or `/128` IPv6
CIDR, never a world-open range, and every terminal path must prove that the provider SSH key,
firewall, and builder are absent. An exact provider `404` while deleting the exact ephemeral SSH key
is authoritative absence, making deletion retries idempotent without masking the original build
failure. The provider's pinned-host-key SSH evidence reader is authoritative for the protected build,
and its diagnostic-only subset supplements failure artifacts. `accept-new` and world-open SSH ingress
are forbidden.

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
the workflow permits that bootstrap case only while the dedicated OCI repository has no tags.
Before the next publication, move that candidate's two identities into the previous-candidate
variables. Once any bundle tag exists, a missing or identical previous candidate fails before the
next publication.

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
