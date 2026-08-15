# End-to-end validation

Runner-image publication, disposable-Droplet canary requirements, gradual promotion, and
artifact-backed rollback are documented in [Runner releases](RUNNER_RELEASES.md).

Bruno keeps two distinct Playwright gates. Both use the unchanged desktop and mobile projects in `playwright.config.ts`.

## Agent Deployment latency benchmark

Run the read-only benchmark against already persisted deployments:

```bash
bun run agent:deployment:benchmark
```

Report one exact Provider Trial Cohort ledger by its durable cohort ID:

```bash
bun run agent:deployment:benchmark -- \
  --provider-trial-cohort-id 00000000-0000-4000-8000-000000000288
```

Creating a Provider Trial Cohort atomically creates all 30 numbered slots before the cohort can
start. Starting a slot assigns one immutable request-attempt identity. The slot then retains exactly
one `committed` outcome linked to its exact operator-trial Agent Deployment, or one
`pre_commit_failure` outcome with no invented deployment. Once the first request starts, database
constraints prevent slot insertion, deletion, renumbering, request-outcome replacement, deployment
relinking, and terminal-outcome replacement.

The versioned `bruno.provider-trial-cohort.v2` report selects slots only by the supplied cohort ID
and orders them by their original number. `apiAcceptance` counts committed requests, pre-commit
failures, pending slots, and availability across all 30 slots. `readiness` separately counts
the explicit `objectiveSeconds: 300`, ready-within-objective outcomes, all-slot misses, pending
outcomes, and the committed-deployment pass rate.
The gate remains false until every slot has a terminal outcome, at least 29 requests committed, at
least 29 of all 30 slots reached ready within 300 seconds, and at least 95 percent of committed
deployments did so. Reports expose only cohort configuration, numbered outcomes, a closed vocabulary
of mapped safe codes, and exact deployment IDs; request-attempt IDs, raw deployment errors, Owner
identity, Telegram data, credentials, tokens, endpoints, and arbitrary provider metadata are omitted.
The server report boundary supports
canonical SHA-256 digesting and Ed25519 signing with an identified key, and verification rejects
tampered or internally inconsistent summaries.

The resumable driver in `src/server/agents/provider-trial-driver.ts` advances at most one original
slot per call. A fenced lease prevents concurrent resumes, and a durable phase checkpoint preserves
the original request-attempt identity, execution result, spend, terminal evidence, and cleanup
boundary across interruption. A request deadline never relabels an unresolved operation as a
pre-commit failure: the run pauses without cleanup or slot advancement and requires renewed
authorization plus reconciliation through the same deployment idempotency key. Resume derives the
request deadline from the slot's original durable `request_started_at`; reconciliation has its own
bounded recovery window and cannot grant the provider request a fresh slot timeout. The provider
boundary receives its reserved per-slot spend, quota, region/profile, pinned-choice digest, and
sanitized dedicated benchmark-identity hashes. Every provider result must include its current
resource count; missing evidence fails closed as an unresolved request instead of being interpreted
as zero resources. A committed deployment is rechecked against all three durable commitments before
observation, and the run row and configuration cannot be reset or deleted after initialization.
Cleanup has a separately reserved deadline, including when timeout evidence is too early to
classify. Any unsafe result or non-empty authoritative cleanup pauses the ledger. Every
cleanup attempt is retained in an append-only per-slot ledger as Boolean
authority, resource-count, and spend evidence, so a failed cleanup followed by a successful resume
cannot erase the earlier failure. Finalization is available only after all 30 slots are terminal and an
authoritative absence check succeeds; its canonical signed report combines the immutable cohort
result, scope-matched pinned configuration, allowlisted stage outcomes, p50/p95/maximum stage
distributions queried only from the exact deployments linked to the ledger, and the complete
sanitized per-slot cleanup history without retaining the raw authorization, credentials, tokens,
Owner identity, Telegram identity, raw stage events, or provider responses.

The driver API is repository machinery, not provider authority. A DigitalOcean run still requires
the separate authorization described by issue #299: exact region and profile, 30 slots, maximum
spend, dedicated benchmark Owner and Telegram bot, cleanup policy, and retained-artifact policy.

### Run the authorized issue #299 Provider Trial

The operator command is intentionally split into three gates. Its default `preflight` command is
zero-effect. `initialize` creates only the dedicated non-Clerk Bruno Owner, immutable cohort, slots,
and driver row in PostgreSQL. `run` is the sole live command and consumes the original 30 slots
sequentially until the run completes or pauses.

Create the ignored credential file with the ephemeral wizard:

```bash
./.vercel/provider-trial-credentials-wizard.sh
```

The wizard stores credentials in `.env.provider-trial.local`, generates an ignored Ed25519 keypair,
and checks the release-attested runtime configuration already held in `.env.local`. It does not
write Provider Trial secrets to GitHub. After the protected Verified Release is bound to the current
commit, run the prerequisite gates and then the zero-effect preflight:

```bash
bun --env-file=.env.local --env-file=.env.provider-trial.local \
  --conditions react-server scripts/run-provider-trial.ts verify-gates
bun --env-file=.env.local --env-file=.env.provider-trial.local \
  --conditions react-server scripts/run-provider-trial.ts preflight
```

`verify-gates` runs the repository verification, desktop/mobile browser gate, cloud bootstrap
reproduction, and full local Agent lifecycle smoke. It writes a signed, sanitized gate manifest
bound to the current Git revision, exact Verified Release digest, authorization generation, and
hashed DigitalOcean account, Telegram bot, Telegram chat, and Telegram user identities. Credential
fingerprints prevent a different DigitalOcean, model, or Telegram credential from being substituted
after the gates. The gate manifest also binds the exact provider snapshot, and `preflight`,
`initialize`, and `run` independently re-read that image before allowing a slot to start; a deleted,
unavailable, wrong-region, or different-account snapshot therefore fails with zero slot effects.
Those identity hashes and the gate-evidence digest are also bound into the canonical signed cohort
report. The active commands reject a dirty working tree or a missing, tampered, stale-revision,
wrong-release, or credential-mismatched manifest.

Only after preflight succeeds, create the database-only ledger and start the authorized live run:

```bash
bun --env-file=.env.local --env-file=.env.provider-trial.local \
  --conditions react-server scripts/run-provider-trial.ts initialize
bun --env-file=.env.local --env-file=.env.provider-trial.local \
  --conditions react-server scripts/run-provider-trial.ts run
```

The issue #299 scope is compiled into the command: `sfo3`, `s-1vcpu-2gb`, 30 slots, at most one
billable Droplet at a time, 16 cents reserved per slot, and 500 cents total. The Bruno benchmark
Owner is an isolated application principal, not the DigitalOcean account owner. Cleanup can act
only on the exact runner, Droplet, and firewall tuple linked to the cohort. Missing or ambiguous
ownership evidence pauses the ledger. Successful cleanup deletes every trial workload, active
secret, firewall, Droplet, runner credential, and runner record; no trial provider resource or
credential is intentionally retained. A provisioning attempt that terminates before DigitalOcean
returns any resource identity can be cleaned only when its durable terminal evidence says provider
cleanup was unnecessary and an authoritative lookup finds zero Droplets for its unique operation
tag; all other missing-ID cases remain fail-closed.

The database retains the sanitized signed report and append-only cleanup ledger. Detailed evidence
has a 90-day minimum retention commitment; the signed canonical report is retained without a
scheduled deletion. Each authorization generation uses generation-scoped gate-evidence and Ed25519
key paths, so creating a fresh trial cannot overwrite an earlier cohort's retained public
verification key. The private key is removed during credential cleanup while its public key remains
available to verify exported evidence independently. A paused run needs fresh authorization before
any provider request can be reconciled or resumed. A `cleanup_failed` pause is the exception: retry
its already authorized teardown with the cleanup-only command below. It accepts only the exact
active authorization and signed prerequisite evidence, cannot issue a provider request, appends
another cleanup attempt, and stops as `gate_impossible` when the remaining original slots cannot
satisfy the cohort gate. Never create a replacement slot or manually relink a deployment.

```bash
bun --env-file=.env.local --env-file=.env.provider-trial.local \
  --conditions react-server scripts/run-provider-trial.ts reconcile-cleanup
```

If the exact authorized snapshot becomes unavailable between original slots, move the clean,
between-slot ledger to a zero-slot safety pause before preparing a replacement snapshot and renewed
authorization. The command refuses to pause while the snapshot is available or while a slot is
active:

```bash
bun --env-file=.env.local --env-file=.env.provider-trial.local \
  --conditions react-server scripts/run-provider-trial.ts pause-unavailable-snapshot
```

After `run` stops, revoke the short-lived DigitalOcean PAT and dedicated model key, then regenerate
or revoke the benchmark Telegram token in BotFather. Do this even when the performance gate failed.
Once the run is complete, or paused with authoritative provider-cleanup evidence, finish with:

```bash
bun --env-file=.env.local --env-file=.env.provider-trial.local \
  --conditions react-server scripts/run-provider-trial.ts verify-credential-cleanup
```

The final command proves all three remote credentials are rejected, signs a sanitized companion
record bound to the cohort-report digest when one exists, and deletes `.env.provider-trial.local`
plus the signing private key. Keep only the signed gate/cohort/credential-cleanup evidence and public
verification key. A truthful signed `.pending` record is retained if local deletion or final evidence
publication cannot finish. Until credential cleanup succeeds, `run` deliberately returns a non-zero
credential-cleanup-required status regardless of whether the 30-slot performance gate passed.

### Exercise the guarded production rollout

Use the protected `rollout-production.yml` workflow only after issue #299's signed cohort report is
retained and the exact revision has both a live Approved Snapshot and a successful Verified Release.
The snapshot build has its own authorization and provider budget. The rollout exercises authorize
zero provider spend, retain the Approved Snapshot intentionally, and supersede only Vercel
configuration deployments.

Configure these dedicated secrets on the protected `production` GitHub environment:

- `BRUNO_AGENT_SECRET_KEYS_JSON`
- `BRUNO_DIGITALOCEAN_TOKEN`
- `BRUNO_RUNNER_BEARER_TOKEN`
- `QSTASH_TOKEN`
- `QSTASH_CURRENT_SIGNING_KEY`
- `QSTASH_NEXT_SIGNING_KEY`

Set the non-secret `BRUNO_AGENT_SECRET_ACTIVE_KEY_VERSION` environment variable and keep the
existing `CRON_SECRET`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`, and `VERCEL_TOKEN` secrets.
Configure matching `BRUNO_AGENT_SECRET_KEYS_JSON`, `BRUNO_DIGITALOCEAN_TOKEN`,
`BRUNO_RUNNER_BEARER_TOKEN`, `CRON_SECRET`, `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, and
`QSTASH_NEXT_SIGNING_KEY` secrets directly in the Vercel production environment. The workflow uses
the GitHub copies for protected operator checks and lets staged deployments inherit the Vercel
copies; credential values are never forwarded in Vercel command arguments.
The QStash token must not equal the cron, runner, or operator credential, and the current and next
signing keys must differ. GitHub supplies every credential only after the protected environment
review, and the workflow neither prints nor retains their values.

Before dispatch, inspect the zero-effect plan:

```bash
bun run agent:production-rollout plan
```

Dispatch the protected run with the successful Verified Release workflow run ID for the exact main
revision:

```bash
gh workflow run rollout-production.yml --ref main \
  --raw-field authorization_confirmation=authorize-issue-300-protected-production-rollout \
  --raw-field verified_release_run_id=123456789 \
  --raw-field maximum_exercise_spend_cents=0
```

The required environment review is the separate live authorization. After approval, the workflow
verifies the GitHub attestation, exact source revision, release and snapshot digests, live snapshot
availability in `sfo3`, and QStash authentication. It then applies these generations in order:

1. Cron, stock, full validation, and the compatible rollback size.
2. QStash, followed by QStash-to-cron rollback and restoration.
3. The Approved Snapshot with full validation, followed by Snapshot-to-stock rollback and
   restoration.
4. Release-attested validation, followed by release-attested-to-full rollback and restoration.
5. The measured `s-1vcpu-2gb` size, followed by compatible `s-2vcpu-2gb` stock/full rollback.
6. The final QStash, Approved Snapshot, release-attested, measured-size generation with cold
   provisioning enabled.

Every exercise generation carries `BRUNO_COLD_PROVISIONING_HALT_REASON=rollout_exercise`, so no new
request can reach Telegram validation, persistence, or a provider effect. Each staged deployment
must report its exact generation and `pinnedChoicesValid: true` from the bearer-protected
`GET /api/internal/production-rollout/status` endpoint before promotion. A failed staged deployment
is never promoted, leaving the most recent promoted exercise generation halted. Ownership,
authentication, artifact-identity, duplicate-billable-effect, and cleanup violations use the same
halt boundary. The workflow feeds controlled repeated functional failures into the same policy gate
that selects each live rollback candidate, and it proves that an isolated latency miss produces an
investigation decision without changing configuration. If a later evidence attestation or upload
fails after the enabling generation is promoted, the failure handler promotes the most recent
verified halted generation again.

The successful run uploads and provenance-attests only the authorization identifier and scope,
allowlisted status fields, signal-policy outcomes, provider trial report digest, cleanup
classification, retained snapshot ID/status/regions and signed artifact identity, and checksums. It
retains no credentials, raw provider responses, Owner or Agent identity, deployment IDs, or
endpoints. Keep the artifact for at least 90 days and link its run and digests in issue #300 before
closing the issue.

Version 5 of the benchmark uses the immutable database-clock
`agent_deployments.accepted_at` boundary. New Agent Deployments capture this timestamp inside the
request transaction after the earlier persistence work, so transaction commit latency remains in
the measurement. `created_at` remains audit and ordering metadata, and `runner_accepted_at` keeps
its runner-operation meaning. The migration does not backfill historical rows: a null boundary is
reported as `legacy_boundary` and remains available only as a `created_at`-based diagnostic. After
the column is added, its database-clock default covers future inserts that omit the field; a trigger
rejects an explicit null and later mutation, so missing-boundary regressions fail at persistence
instead of being mislabeled as historical data.

The binary Cold-Deployment gate is failure-inclusive. A Ready Deployment at or before 300 seconds
is `ready_within_objective`; every deployment that does not meet that objective is `slo_miss`. The separate
allowlisted `sloMissCause` distinguishes `slow_ready`, `terminal_failure`, and
`not_ready_at_boundary` evidence without renaming the domain outcome. A deployment observed before
its deadline is `pending`. Missing boundaries and invalid event ordering fail visibly as diagnostic
evidence instead of being assigned a zero duration or silently admitted to the SLO cohort.

Each new Agent Deployment also persists immutable origin, initial cohort, deployment environment,
and rollout-configuration generation evidence. Explicit retries and runner-replacement recovery
inherit the triggering deployment's generation instead of reading a later default. Only production
Owner requests in the `cold_deployment` cohort are eligible. Operator trials, non-production
deployments, Same-Owner Reuse, runner-replacement work, and explicit Owner cancellation before the
300-second boundary are excluded. Historical rows without immutable identity remain diagnostic. A
missing rollout generation and cancellation timestamp before durable acceptance are reported as
invalid evidence,
not silently excluded. The default query applies the durable eligibility rules before selecting the
latest observations by `accepted_at` and deployment ID.

The JSON report is versioned and deterministic. It contains:

- `slo.objectiveSeconds`, `sampleSize`, `requiredSampleSize`,
  `requiredReadyWithinObjective`, `eligible`, `readyWithinObjective`,
  `misses`, `pending`, `passRate`, and `passesGate` for the `cold_deployment` cohort; `passesGate`
  remains false until all 100 observations are decided and at least 95 are ready within 300 seconds;
- `summary.total`, `ready`, `failed`, `incomplete`, and diagnostic `successRate`;
- ready and failed terminal latency `p50Ms`, `p95Ms`, and `maxMs`;
- `cohorts.cold_deployment`, `cohorts.same_owner_reuse`, and `cohorts.unknown` with
  separate counts, success rates, ready/failed p50/p95/max latency, invalid-evidence counts, and
  stage summaries;
- ordered per-deployment runs with deployment ID, runner ID when known, accepted and terminal
  timing, immutable cohort and rollout-configuration generation, eligibility reason, duration
  boundary, SLO classification/status and miss cause, total duration, stage timings, and issue
  counts; and
- per-stage summaries for agent deployment-stage events and runner provisioning/bootstrap events.

Percentiles use nearest-rank ordering. The default SLO cohort is ordered by immutable acceptance
timestamp and then deployment ID. Stage evidence is derived only from persisted timestamps: durable
`agent.deployment_stage_changed` events, paired `runner_provisioning_events`, and bootstrapping
events that carry an allowlisted `metadata.step`. Missing starts, missing terminal events, duplicate
boundaries, reversed timestamps, ambiguous terminal rows, and invalid timestamps are surfaced as
invalid evidence; they never become zero-duration successful stages.

Cold-Deployment evidence requires the exact deployment operation-key runner correlation. Existing
Same-Owner Reuse is reported as a separate cohort and never borrows historical runner
provisioning stages. Unknown or ambiguous correlation is invalid evidence. Cold-path SLO decisions
must read the `slo` counts for the `cold_deployment` cohort; faster reuse samples and
successful-only latency percentiles cannot improve the binary gate.

## Rolling production SLO evidence

Production schedules `GET /api/internal/cold-deployment-slo/evaluate` once per minute through the
same `CRON_SECRET` authorization boundary as the other protected reconcilers. The endpoint requires
`BRUNO_COLD_DEPLOYMENT_SLO_SIGNING_KEY_ID` and
`BRUNO_COLD_DEPLOYMENT_SLO_SIGNING_KEY_PEM`, and an operator-managed
`BRUNO_COLD_DEPLOYMENT_SLO_TRUST_SET` mapping the active key ID to its Ed25519 public key. Incomplete
or mismatched signing configuration fails closed. Its
response publishes only the canonical report digest, objective seconds, eligible and
ready-within-objective counts, pending count, the latest-100 API-acceptance summary, current proof
state, and whether this evaluation opened a regression incident.

Each invocation queries the latest 100 production Owner-request Cold Deployments using the
immutable accepted boundary, cohort, origin, cancellation, and Rollout Configuration generation
fields. Operator trials, Same-Owner Reuse, runner-replacement work, non-production rows, and an
explicit Owner cancellation before 300 seconds remain excluded. Provider failures, internal
failures, retries, timeouts, pending observations at the boundary, and slow successes remain in the
failure-inclusive sample. Fewer than 100 observations is unproven; proof requires all 100 decided
and at least 95 ready within 300 seconds.

The `cold_deployment_slo_evaluations` ledger is append-only. It stores canonical sanitized report
bytes, SHA-256 digest, Ed25519 signature and key ID, active Rollout Configuration generations, the
previous report digest, and the proof/incident transition. Database triggers reject update and
delete, so a regression removes current proven status without rewriting earlier signed evidence.
Production ready-create and Start routes also append a sanitized `started` event and one
`accepted`, `rejected`, or `outcome_unknown` event to
`agent_deployment_api_attempt_events`. The signed evaluation reports accepted, rejected, unknown,
pending, and availability counts for the latest 100 attempts separately from readiness; it stores
no Owner, Agent, Telegram, token, credential, request body, or endpoint identity. Those events are
append-only, so pre-commit failures cannot disappear merely because no Agent Deployment row exists.
Detailed deployment and stage records remain in their existing durable stores; retention policy
must keep immutable boundaries, cohorts, choices, and terminal outcomes indefinitely and detailed
stages for at least 90 days.

This evaluator provides the production-proof mechanism but cannot manufacture production traffic.
The objective remains operationally incomplete until a separately authorized rollout exists and
100 real eligible observations contain at least 95 ready-within-objective outcomes.

Default mode is read-only and does not create, mutate, clean up, or contact provider resources.
Local Docker mode requires the exact zero-cloud sentinels used by `local:agent:smoke`:

```bash
BRUNO_DIGITALOCEAN_PROVIDER_MODE=local_docker \
BRUNO_DIGITALOCEAN_TOKEN=local-docker \
BRUNO_LOCAL_AGENT_SMOKE_MODE=synthetic-external-boundaries \
bun run agent:deployment:benchmark -- --mode local_docker
```

DigitalOcean-driving benchmark mode is fail-closed. It requires an explicit positive trial count,
the `--authorize-provider-costs` flag, explicit `--candidate-size-slugs` values, and
`BRUNO_AGENT_DEPLOYMENT_BENCHMARK_DIGITALOCEAN_AUTHORIZATION=authorize-digitalocean-agent-deployment-benchmark`.
Ordinary CI must not run that mode. Provider-backed ready-within-objective acceptance is owned by the
final SLO proof step after operator authorization; this read-only benchmark records evidence but
does not claim live provider acceptance by itself.

The local full-cycle smoke emits a sanitized `local_agent_cycle_deployment_latency` report after the
deployment reaches durable ready and before its database volume is removed. The smoke fails unless
the report contains `acceptedAt`, uses `accepted_at` as its duration boundary, and produces a
non-diagnostic SLO result. The report exposes the sanitized ready-within-objective result. Reports and
terminal completion logs project allowlisted fields only: deployment ID, runner ID when present,
accepted timestamp, duration boundary, outcome, SLO classification/status, total duration, bounded
stage timing/status, and issue names. They must not retain user identity,
agent identity, raw credentials, tokens, endpoint URLs, provider resource IDs, provider responses,
cloud-init output, arbitrary metadata, or serialized environment objects.

## Deployment dispatch recovery

PostgreSQL deployment and wakeup rows remain authoritative in both dispatch modes. The protected
deployment cron reconciler processes the oldest due work first and stops after at most 25 items or
one shared 40-second deadline. Its abort signal and remaining timeout propagate to runner/provider
boundaries. QStash mode reserves one of those 25 item slots for its outbox sweep. The reconciler
performs PostgreSQL recovery before that sweep, so a QStash outage cannot starve durable recovery or
create a second Droplet effect. A timed-out publication keeps its leased delivery generation fenced
until ordinary lease recovery.

QStash publication uses the persisted `due_at` value as `notBefore`, one-second provider retry
delays, and a `deploymentId:generation` deduplication identity. Duplicate, reordered, early, stale,
and already claimed deliveries cannot advance deployment state twice. The signed callback drains
only the claimed deployment and publishes the exact next persisted generation when more delayed
work is due.

`BRUNO_DEPLOYMENT_DISPATCH_MODE` defaults to `cron`. Selecting `qstash` requires the token, distinct
current and next signing keys, and a valid public HTTPS application URL; partial configuration
fails closed. The public `/health` response reports only `deploymentDispatch: "cron"`, `"qstash"`,
or `"invalid"` and never includes QStash tokens, signing keys, callback URLs, or delivery details.

## Exhausted deployment wakeups

QStash publication is a bounded hint over PostgreSQL state. Known authentication (`401`, `403`) or
payload (`400`, `413`, `422`) rejection exhausts the delivery generation after its first atomic
attempt. Other publication failures consume
`BRUNO_DEPLOYMENT_WAKEUP_MAX_PUBLISH_ATTEMPTS`, which defaults to 12 and accepts only integers from
1 through 100. Expired publication leases at the bound become exhausted without another provider
effect. Exhausted generations are absent from normal publication and delivery claims, and ordinary
deployment reconciliation cannot silently replace them.

An operator with the dedicated `CRON_SECRET` bearer authority can list sanitized evidence:

```bash
curl --fail-with-body \
  --header "Authorization: Bearer ${CRON_SECRET}" \
  "${BRUNO_APP_URL}/api/internal/agent-deployments/wakeups/exhausted"
```

Inspect or replay one returned wakeup ID through its exact resource path:

```bash
curl --fail-with-body \
  --header "Authorization: Bearer ${CRON_SECRET}" \
  "${BRUNO_APP_URL}/api/internal/agent-deployments/wakeups/exhausted/${WAKEUP_ID}"

curl --fail-with-body --request POST \
  --header "Authorization: Bearer ${CRON_SECRET}" \
  "${BRUNO_APP_URL}/api/internal/agent-deployments/wakeups/exhausted/${WAKEUP_ID}"
```

The evidence contains only wakeup and deployment IDs, generation, due/exhausted timestamps,
attempt count, terminal state, and a closed safe reason. It omits Owner and Agent identity, provider
message bodies/details, tokens, endpoints, and credentials. Replay succeeds only while the Agent
Deployment is active and the exhausted identity is still its latest generation. The transaction
terminalizes that identity and inserts exactly one new pending generation before publication is
attempted. Duplicate or concurrent replay, terminal deployments, and superseded generations fail
closed.

## Credential-free CI gate

Run:

```bash
bun run test:e2e:ci
```

This is the repository-owned GitHub CI command. It runs only the health route, shell routes, browser health response, and invalid create-input selectors that do not require a configured cloud-runner provider. The selector list is single-sourced in `scripts/run-e2e.ts`; CI calls the package command rather than duplicating it.

The package command pins `BRUNO_AUTH_MODE=development`, so operator or Clerk settings in a local
`.env.local` cannot put the credential-free browser suite behind an unrelated authentication gate.

The command still requires the normal test database and application URL. Package defaults target the local PostgreSQL service on port `54329` and the Next.js test server on port `3100`; parallel runs should override `DATABASE_URL`, `NEXT_PUBLIC_APP_URL`, and `PORT` with isolated values.

## Optional hosted Clerk development smoke

Run this separately from the credential-free and runner-backed gates:

```bash
bun run test:e2e:clerk
```

The launcher bootstraps `clerkSetup()` in its own process before spawning Playwright, so the
Clerk testing environment is inherited by the browser worker. The isolated `tests/e2e-hosted`
suite exercises the deterministic development email-code path with two distinct, pre-created
`+clerk_test` identities, verifies each context's resolved current-user identity in memory, checks
the current-user and sign-out surfaces, and proves that signing out one browser context does not
sign out the other. Clerk's supported test OTP is used by the helper; no real email delivery is
expected.

The optional gate requires these capability names, supplied only through the local environment:

- `CLERK_PUBLISHABLE_KEY` and `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`;
- `CLERK_SECRET_KEY` for the app and Clerk setup; an optional pre-created
  `CLERK_TESTING_TOKEN` may be supplied to reuse a testing token; and
- `BRUNO_OPERATOR_USERNAME` and `BRUNO_OPERATOR_PASSWORD` for the
  development Basic-auth shell, which remains enabled until production cutover; and
- `E2E_CLERK_TEST_USER_A_EMAIL` and `E2E_CLERK_TEST_USER_B_EMAIL`, both approved development
  `+clerk_test` identities.

Its sanitized preflight reports missing capability names and exits before starting the app or
browser. Playwright supplies the operator credentials only as in-memory HTTP credentials scoped
to the local Bruno origin, so the test can reach the protected development pages without
sending Basic credentials to Clerk's cross-origin requests; they are never printed or persisted.
The package script pins both Playwright and Next.js to the same `localhost` port because Next.js
16's development render proxy resolves that hostname internally; keep the script's loopback
hostname alignment when overriding the port.
Screenshots, traces, and videos are disabled; browser contexts are closed in the test; raw keys,
testing tokens, emails, cookies, OAuth state, and storage state must never be retained.
Google and Apple are not silently marked successful: the current official helper does not provide
deterministic OAuth automation for those providers, so their hosted evidence remains operator-run.
This optional gate does not replace the provider/runner-backed `bun run verify:e2e` requirement.

## Full provider-backed gate

Run:

```bash
bun run test:e2e
```

Run the complete repository verification plus this suite with:

```bash
bun run verify:e2e
```

`bun run verify` deliberately stops after the production build and remains suitable for normal
local verification. `test:e2e` remains the canonical, unfiltered Playwright suite, while
`verify:e2e` runs the base gate before it. Before Playwright starts, the launcher validates the
same configuration contract used by `readDigitalOceanProviderConfig`. At minimum, both
`BRUNO_DIGITALOCEAN_TOKEN` and `BRUNO_RUNNER_BEARER_TOKEN` must be nonblank; any optional
provider settings must also be valid. The preflight reports only capability and variable names,
never configured values.

Like the CI surface, the full non-hosted suite pins development authentication independently of
local `.env.local` authentication settings.

With the default `digitalocean` mode, the full suite may create and delete billable provider resources. Use an approved development account with usable network, image, SSH, and runner prerequisites. Do not use synthetic values for a real full-suite run.

For local Docker validation, set `BRUNO_DIGITALOCEAN_PROVIDER_MODE=local_docker` and prepare the repository's local cloud-runner stack and its required runner token, image, endpoint, container, and Docker prerequisites. The same provider parser validates local-mode settings before Playwright starts.

An unconfigured or invalid full-suite run exits once with the sanitized capability message before any browser or provider-backed scenario begins. This fail-fast result does not replace provider-backed acceptance: use `test:e2e:ci` for the credential-free CI surface and run `test:e2e` whenever full provider capability is available and required.

## Capability-gated Hermes staging acceptance

Run:

```bash
bun run verify:hermes:staging
```

This command is the single entrypoint for the final live Hermes plus Telegram
acceptance smoke. It fails before any network, database, provider, Droplet, or
Telegram effect unless all 16 capabilities validate and the process has an
interactive TTY. Once authorized, it drives a durable hosted saga one bounded
effect at a time. A crash, timeout, duplicate command, or disabled acceptance
flag resumes cleanup from the database ledger rather than relying on a local
`finally` block. The first authorized live run has not yet been completed.

The preflight requires these capability names:

- `BRUNO_HERMES_STAGING_PUBLISHED_IMAGE_REF`: scanned GHCR release-candidate
  Hermes workload image as the exact untagged
  `ghcr.io/ametel01/bruno-hermes@sha256:...` linux/amd64 manifest. This must
  be the published artifact, not the upstream source-pinned digest or an OCI
  index.
- `BRUNO_HERMES_WORKLOAD_IMAGE`: the exact same untagged digest. Deployment
  and runtime reconciliation use this configured image.
- `BRUNO_HERMES_STAGING_IMAGE_SOURCE_REVISION`: lowercase 40-hex source
  revision embedded in the image config.
- `BRUNO_HERMES_STAGING_PUBLISH_WORKFLOW_RUN_ID`: positive safe-integer ID of
  the successful completed main-branch publish workflow run.
- `BRUNO_HERMES_STAGING_ACCEPTANCE_ENABLED`: exact value `true` during the
  authorized window. `false` or unset prevents forward work but does not stop
  cleanup reconciliation for an existing run.
- `BRUNO_HERMES_STAGING_ACCEPTANCE_BASE_URL`: exact HTTPS origin ending in
  `/`, with no credentials, path, query, or fragment.
- `BRUNO_HERMES_STAGING_ACCEPTANCE_BEARER_SECRET`: dedicated 32–256 character
  bearer-safe secret distinct from cron, runner, and operator authorities.
- `BRUNO_HERMES_STAGING_DIGITALOCEAN_BUDGET_AUTHORIZATION`: exact value
  `authorize-basic-4usd-digitalocean-staging`.
- `BRUNO_DIGITALOCEAN_TOKEN`: DigitalOcean staging token for the approved
  account.
- `BRUNO_RUNNER_BEARER_TOKEN`: staging runner command bearer credential.
- `BRUNO_HERMES_STAGING_ASSISTANT`: exactly `chatgpt` or `claude`.
- The matching direct model key: `BRUNO_HERMES_STAGING_OPENAI_API_KEY` for
  ChatGPT or `BRUNO_HERMES_STAGING_ANTHROPIC_API_KEY` for Claude. Configure
  exactly one. API usage is billed separately from consumer subscriptions.
- `BRUNO_HERMES_STAGING_TELEGRAM_BOT_TOKEN`: dedicated staging Telegram bot
  token. Do not reuse a bot that is active elsewhere.
- `BRUNO_HERMES_STAGING_TELEGRAM_TEST_USER_ID`: numeric allowed Telegram test
  user identifier.
- `BRUNO_HERMES_STAGING_TELEGRAM_TEST_CHAT_ID`: numeric Telegram chat
  identifier for the live smoke.
- `BRUNO_HERMES_STAGING_LIVE_SIDE_EFFECT_CONFIRMATION`: exact value
  `send-telegram-and-spend-digitalocean-staging`.

The command reports only capability names, configured/missing/malformed state,
safe reason codes, stages, Boolean evidence, and cleanup states. Before the
effect boundary it reports `sideEffectsAttempted: false`. It must never print
raw credentials, Telegram tokens, Telegram user or chat IDs, raw replies,
private endpoints, provider responses, internal resource IDs, or serialized
environment objects. A missing, blank, placeholder, malformed, or non-exact
sentinel value is a blocker, not a passing smoke.

### Prepare the dedicated bot and allowlist

1. Open [BotFather](https://t.me/BotFather), choose its new-bot flow, follow its
   prompts for a staging-only name and username, and copy the resulting token
   directly into an ignored local or hosted secret store. Bot creation,
   privacy-mode changes, and Telegram account management are not automated by
   Bruno. If the token is exposed, revoke it in BotFather before continuing.
2. Ensure no other running agent, gateway, webhook, or polling process uses that
   bot. Ready-mode creation rejects a token fingerprint already active for
   another agent, and concurrent polling with one token is unsupported.
3. Record the allowed person's positive decimal Telegram user ID. Product
   creation accepts one to 100 IDs, one per line; it rejects usernames, group
   IDs, CSV, wildcards, zero, and negative values. The staging chat ID is a
   separate signed numeric capability because Telegram chats may use negative
   identifiers.
4. Fund the direct OpenAI or Anthropic API key for the selected assistant. Automatic
   reconciliation records at most one successful bounded, low-output, no-tools
   canary for a deployment/config revision. An explicit Retry after a failed or
   unknown outcome creates a new persisted attempt and may incur one additional
   bounded canary charge; do not use retries merely to probe credentials.

### Run the authorized workflow

Do not run the live workflow until an operator has approved the exact basic
DigitalOcean budget plus Telegram contact and all 16 capabilities have been
installed out of band. Run it from an interactive terminal exactly:

```bash
bun run verify:hermes:staging
```

The executor creates only one staging canary agent for the immutable image
revision. It independently attests the GHCR bytes, config labels, amd64 digest,
and exact successful publish run, then observes the persisted deployment
sequence `pending` →
`provisioning_runner` → `configuring_hermes` → `starting_gateway` →
`verifying_model` → `connecting_telegram` → `ready`.

At each `operator_telegram` checkpoint, the command prints an exact one-time
challenge. The allowlisted human sends that text to the dedicated bot and
confirms that the correlated Hermes reply arrived by typing
`reply-confirmed`; the operator must not paste the reply. This is explicitly
`interactive_human_attested` evidence, not an automated Telegram-user or
MTProto claim. The command repeats the proof after Restart, audits redaction,
persists Stop before transport, observes a continuous stopped window, verifies
the stopped/manual rollback path, and cleans the exact workload, secrets,
firewall, Droplet, and runner in that order. Managed containers use
`unless-stopped`, so database-first Stop prevents restart policy from
resurrecting an intentionally stopped agent.

If setup fails, retain only its safe error code and stage. Reconciliation uses
persisted retries and backoff; terminal setup failures offer an explicit retry
and attempt safe container cleanup. After readiness, runtime reconciliation
reports recovery separately, bounds automatic restarts, and opens a circuit for
operator Restart after repeated or prolonged Telegram failures.

### Evidence and cleanup

Record only sanitized timestamps, command/CI references, immutable image digest,
stage names, safe reason codes, and yes/no assertions for reply, restart, Stop,
and cleanup. Never retain credentials, bot/user/chat IDs, message text, private
runner endpoints, raw upstream responses, environment dumps, browser storage,
or secret-bearing logs. The durable controller must independently prove
agent/workload, secret, firewall, Droplet, and runner absence. Revoke or rotate
temporary credentials as planned after it finishes. A cleanup deadline or
ambiguous owned set is a blocker and must be reported without exposing
identifiers; never manually delete an uncertain resource merely to make the
report green.

Only after this live run passes may the controlled environment set
`BRUNO_READY_AGENT_CREATION_ENABLED=true`. Roll back by setting it to `false`
or removing it and redeploying; this disables the common setup UI. The stopped-create API remains
only as a legacy operator compatibility path. Stop existing agents explicitly because disabling
the flag does not change their persisted desired state.
