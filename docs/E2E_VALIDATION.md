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

The versioned `bruno.provider-trial-cohort.v1` report selects slots only by the supplied cohort ID
and orders them by their original number. `apiAcceptance` counts committed requests, pre-commit
failures, pending slots, and availability across all 30 slots. `readiness` separately counts
ready-within-60 outcomes, all-slot misses, pending outcomes, and the committed-deployment pass rate.
The gate remains false until every slot has a terminal outcome, at least 29 requests committed, at
least 29 of all 30 slots reached ready within 60 seconds, and at least 95 percent of committed
deployments did so. Reports expose only cohort configuration, numbered outcomes, a closed vocabulary
of mapped safe codes, and exact deployment IDs; request-attempt IDs, raw deployment errors, Owner
identity, Telegram data, credentials, tokens, endpoints, and arbitrary provider metadata are omitted.
The server report boundary supports
canonical SHA-256 digesting and Ed25519 signing with an identified key, and verification rejects
tampered or internally inconsistent summaries.

Version 4 of the benchmark uses the immutable database-clock
`agent_deployments.accepted_at` boundary. New Agent Deployments capture this timestamp inside the
request transaction after the earlier persistence work, so transaction commit latency remains in
the measurement. `created_at` remains audit and ordering metadata, and `runner_accepted_at` keeps
its runner-operation meaning. The migration does not backfill historical rows: a null boundary is
reported as `legacy_boundary` and remains available only as a `created_at`-based diagnostic. After
the column is added, its database-clock default covers future inserts that omit the field; a trigger
rejects an explicit null and later mutation, so missing-boundary regressions fail at persistence
instead of being mislabeled as historical data.

The binary Cold-Deployment gate is failure-inclusive. A Ready Deployment at or before 60 seconds
is `ready_within_60`; every deployment that does not meet that objective is `slo_miss`. The separate
allowlisted `sloMissCause` distinguishes `slow_ready`, `terminal_failure`, and
`not_ready_at_boundary` evidence without renaming the domain outcome. A deployment observed before
its deadline is `pending`. Missing boundaries and invalid event ordering fail visibly as diagnostic
evidence instead of being assigned a zero duration or silently admitted to the SLO cohort.

Each new Agent Deployment also persists immutable origin, initial cohort, deployment environment,
and rollout-configuration generation evidence. Explicit retries and runner-replacement recovery
inherit the triggering deployment's generation instead of reading a later default. Only production
Owner requests in the `cold_deployment` cohort are eligible. Operator trials, non-production
deployments, Same-Owner Reuse, runner-replacement work, and explicit Owner cancellation before the
60-second boundary are excluded. Historical rows without immutable identity remain diagnostic. A
missing rollout generation and cancellation timestamp before durable acceptance are reported as
invalid evidence,
not silently excluded. The default query applies the durable eligibility rules before selecting the
latest observations by `accepted_at` and deployment ID.

The JSON report is versioned and deterministic. It contains:

- `slo.sampleSize`, `requiredSampleSize`, `requiredReadyWithin60`, `eligible`, `readyWithin60`,
  `misses`, `pending`, `passRate`, and `passesGate` for the `cold_deployment` cohort; `passesGate`
  remains false until all 100 observations are decided and at least 95 are ready within 60 seconds;
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
Ordinary CI must not run that mode. Provider-backed ready-within-60 acceptance is owned by the
final SLO proof step after operator authorization; this read-only benchmark records evidence but
does not claim live provider acceptance by itself.

The local full-cycle smoke emits a sanitized `local_agent_cycle_deployment_latency` report after the
deployment reaches durable ready and before its database volume is removed. The smoke fails unless
the report contains `acceptedAt`, uses `accepted_at` as its duration boundary, and produces a
non-diagnostic SLO result. The report exposes the sanitized ready-within-60 result. Reports and
terminal completion logs project allowlisted fields only: deployment ID, runner ID when present,
accepted timestamp, duration boundary, outcome, SLO classification/status, total duration, bounded
stage timing/status, and issue names. They must not retain user identity,
agent identity, raw credentials, tokens, endpoint URLs, provider resource IDs, provider responses,
cloud-init output, arbitrary metadata, or serialized environment objects.

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
