# Runner releases

Runner releases use the manually dispatched `Release runner image` workflow. The workflow never
publishes or promotes a mutable `:main` tag. A release builds the exact selected commit once, pushes
only its Git-SHA tag, verifies and scans the resulting digest, proves that immutable image on a
disposable DigitalOcean Droplet, and only then deploys that same commit and image reference to
Vercel.

The linked Git repository does not deploy `main` directly to production. `vercel.json` skips an
automatic production build unless the release workflow supplies its non-secret
`AGENTBAY_CANARY_VERIFIED_DEPLOY=true` build marker. Preview builds remain enabled. The release and
rollback jobs are the only repository-owned paths that supply that marker, preventing a push from
bypassing image verification and the Droplet canary.

Production builds also fail before migrations or compilation when ready agent creation is enabled
without a DigitalOcean token, runner command bearer token, and immutable Git-SHA-plus-digest
`AGENTBAY_RUNNER_IMAGE`. At runtime, agent creation reuses an eligible runner when one exists. If
none is available, creation requires that provisioning configuration before persistence, then the
post-response reconciler performs one initialization slice and one provisioning slice so exactly
one durable provider attempt starts immediately. Protected cron reconciliation remains the retry
path. Automated and local tests inject fake providers and never create a Droplet.

Release workflow runs share one non-cancelling concurrency group. Automated and local tests create
zero Droplets: the DigitalOcean provider rejects network-client construction in test processes, and
provider tests must inject fake clients. A release run can provision exactly one
canary Droplet only when the operator types `authorize-disposable-runner-release-smoke` into the
`billable_canary_authorization` dispatch input. Another release run cannot enter the workflow until
the current run has completed its canary cleanup.

## Protected environments

Configure `runner-release-canary` with required reviewers and these scoped values:

| Kind | Name | Purpose |
| --- | --- | --- |
| Secret | `RUNNER_RELEASE_DATABASE_URL` | Database used by the current public control plane for the disposable runner registration record. |
| Secret | `RUNNER_RELEASE_DIGITALOCEAN_TOKEN` | Token limited to the Droplet, tag, firewall, and read operations required by the canary. |
| Secret | `RUNNER_RELEASE_BEARER_TOKEN` | Dedicated command bearer shared only with disposable release runners. |
| Variable | `RUNNER_RELEASE_CONTROL_PLANE_URL` | Current HTTPS production control-plane origin used for runner registration and heartbeat callbacks. |
| Variable | `RUNNER_RELEASE_DIGITALOCEAN_REGION` | Region for the disposable basic-size canary. |

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

The canary injects `AGENTBAY_DIGITALOCEAN_SSH_KEY_IDS=disabled`; it neither creates an account SSH
key nor opens SSH ingress. `AGENTBAY_RUNNER_RELEASE_DIGITALOCEAN_AUTHORIZATION` is set to the exact
workflow sentinel only inside the reviewed canary job.

## Canary contract

The workflow runs:

```sh
bun run runner:release:smoke -- --image \
  ghcr.io/ametel01/agentbay-runner:<40-character-git-sha>@sha256:<64-hex-digest>
```

The command fails before side effects unless the immutable image, public HTTPS control plane,
database, dedicated DigitalOcean configuration, bearer token, and explicit budget authorization
are valid. It creates exactly one uniquely tagged disposable runner, requires the exact image
digest, OCI release version, boot contract, authenticated ready heartbeat, and all boot components.
Those boot components exercise an isolated synthetic start, status/readiness probe, model canary,
stop, and cleanup without Telegram or a paid model request.

Cleanup runs in a `finally` path. It verifies exact operation-tag ownership, deletes the firewall
before the Droplet, confirms the tagged provider set is absent, revokes runner credentials, and
tombstones the runner record. A failed or ambiguous cleanup fails the job and blocks promotion.
Failure output contains only capability names and closed error codes; it does not include tokens,
database URLs, or cloud-init output.

## Promotion and rollback

After the canary succeeds, the production job deploys the exact tested commit with:

```text
AGENTBAY_RUNNER_IMAGE=<tested immutable Git-SHA-plus-digest reference>
AGENTBAY_RUNNER_ROLLOUT_BATCH_SIZE=1
```

It then verifies `/health` and the authenticated
`/api/internal/runner-release/required` contract. Infrastructure reconciliation processes at most
one managed runner per invocation. Set the batch size to `0` to halt automatic fleet work.

For emergency rollback, dispatch the same workflow with `action=rollback`, the immutable image, and
the prior successful workflow run ID. The job downloads that run's `verified-runner-release`
artifact and refuses any image that does not match it exactly. Rollback deploys with batch size `0`,
verifies the required digest, and leaves rollout halted for operator review.

Do not run the live smoke from a developer shell or as part of an automated test. Only the manually
dispatched production release workflow may supply the exact billable authorization. Credential-free
runs are expected to exit with `capability_unavailable` and `sideEffectsAttempted: false`.
