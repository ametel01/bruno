# End-to-end validation

AgentBay keeps two distinct Playwright gates. Both use the unchanged desktop and mobile projects in `playwright.config.ts`.

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
- `AGENTBAY_OPERATOR_USERNAME` and `AGENTBAY_OPERATOR_PASSWORD` for the
  development Basic-auth shell, which remains enabled until production cutover; and
- `E2E_CLERK_TEST_USER_A_EMAIL` and `E2E_CLERK_TEST_USER_B_EMAIL`, both approved development
  `+clerk_test` identities.

Its sanitized preflight reports missing capability names and exits before starting the app or
browser. Playwright supplies the operator credentials only as in-memory HTTP credentials scoped
to the local AgentBay origin, so the test can reach the protected development pages without
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
`AGENTBAY_DIGITALOCEAN_TOKEN` and `AGENTBAY_RUNNER_BEARER_TOKEN` must be nonblank; any optional
provider settings must also be valid. The preflight reports only capability and variable names,
never configured values.

With the default `digitalocean` mode, the full suite may create and delete billable provider resources. Use an approved development account with usable network, image, SSH, and runner prerequisites. Do not use synthetic values for a real full-suite run.

For local Docker validation, set `AGENTBAY_DIGITALOCEAN_PROVIDER_MODE=local_docker` and prepare the repository's local cloud-runner stack and its required runner token, image, endpoint, container, and Docker prerequisites. The same provider parser validates local-mode settings before Playwright starts.

An unconfigured or invalid full-suite run exits once with the sanitized capability message before any browser or provider-backed scenario begins. This fail-fast result does not replace provider-backed acceptance: use `test:e2e:ci` for the credential-free CI surface and run `test:e2e` whenever full provider capability is available and required.

## Capability-gated Hermes staging acceptance

Run:

```bash
bun run verify:hermes:staging
```

This command is the single entrypoint for the final live Hermes plus Telegram
acceptance smoke. It fails before any network, database, provider, Droplet, or
Telegram effect unless all 15 capabilities validate and the process has an
interactive TTY. Once authorized, it drives a durable hosted saga one bounded
effect at a time. A crash, timeout, duplicate command, or disabled acceptance
flag resumes cleanup from the database ledger rather than relying on a local
`finally` block. The first authorized live run has not yet been completed.

The preflight requires these capability names:

- `AGENTBAY_HERMES_STAGING_PUBLISHED_IMAGE_REF`: scanned GHCR release-candidate
  Hermes workload image as the exact untagged
  `ghcr.io/ametel01/agentbay-hermes@sha256:...` linux/amd64 manifest. This must
  be the published artifact, not the upstream source-pinned digest or an OCI
  index.
- `AGENTBAY_HERMES_WORKLOAD_IMAGE`: the exact same untagged digest. Deployment
  and runtime reconciliation use this configured image.
- `AGENTBAY_HERMES_STAGING_IMAGE_SOURCE_REVISION`: lowercase 40-hex source
  revision embedded in the image config.
- `AGENTBAY_HERMES_STAGING_PUBLISH_WORKFLOW_RUN_ID`: positive safe-integer ID of
  the successful completed main-branch publish workflow run.
- `AGENTBAY_HERMES_STAGING_ACCEPTANCE_ENABLED`: exact value `true` during the
  authorized window. `false` or unset prevents forward work but does not stop
  cleanup reconciliation for an existing run.
- `AGENTBAY_HERMES_STAGING_ACCEPTANCE_BASE_URL`: exact HTTPS origin ending in
  `/`, with no credentials, path, query, or fragment.
- `AGENTBAY_HERMES_STAGING_ACCEPTANCE_BEARER_SECRET`: dedicated 32–256 character
  bearer-safe secret distinct from cron, runner, and operator authorities.
- `AGENTBAY_HERMES_STAGING_DIGITALOCEAN_BUDGET_AUTHORIZATION`: exact value
  `authorize-basic-4usd-digitalocean-staging`.
- `AGENTBAY_DIGITALOCEAN_TOKEN`: DigitalOcean staging token for the approved
  account.
- `AGENTBAY_RUNNER_BEARER_TOKEN`: staging runner command bearer credential.
- `AGENTBAY_HERMES_STAGING_OPENROUTER_API_KEY`: funded OpenRouter key used only
  for the bounded model canary.
- `AGENTBAY_HERMES_STAGING_TELEGRAM_BOT_TOKEN`: dedicated staging Telegram bot
  token. Do not reuse a bot that is active elsewhere.
- `AGENTBAY_HERMES_STAGING_TELEGRAM_TEST_USER_ID`: numeric allowed Telegram test
  user identifier.
- `AGENTBAY_HERMES_STAGING_TELEGRAM_TEST_CHAT_ID`: numeric Telegram chat
  identifier for the live smoke.
- `AGENTBAY_HERMES_STAGING_LIVE_SIDE_EFFECT_CONFIRMATION`: exact value
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
   AgentBay. If the token is exposed, revoke it in BotFather before continuing.
2. Ensure no other running agent, gateway, webhook, or polling process uses that
   bot. Ready-mode creation rejects a token fingerprint already active for
   another agent, and concurrent polling with one token is unsupported.
3. Record the allowed person's positive decimal Telegram user ID. Product
   creation accepts one to 100 IDs, one per line; it rejects usernames, group
   IDs, CSV, wildcards, zero, and negative values. The staging chat ID is a
   separate signed numeric capability because Telegram chats may use negative
   identifiers.
4. Fund the OpenRouter key for the selected approved model. Automatic
   reconciliation records at most one successful bounded, low-output, no-tools
   canary for a deployment/config revision. An explicit Retry after a failed or
   unknown outcome creates a new persisted attempt and may incur one additional
   bounded canary charge; do not use retries merely to probe credentials.

### Run the authorized workflow

Do not run the live workflow until an operator has approved the exact basic
DigitalOcean budget plus Telegram contact and all 15 capabilities have been
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
`AGENTBAY_READY_AGENT_CREATION_ENABLED=true`. Roll back by setting it to `false`
or removing it and redeploying; explicit `launchMode:"stopped"` creation remains
available. Stop existing agents explicitly because disabling the flag does not
change their persisted desired state.
