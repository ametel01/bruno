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
acceptance smoke. In the current Step 1 implementation it is a fail-closed
capability preflight only: it performs no network, Docker, browser, database,
provider, Droplet, or Telegram send side effects, and it exits nonzero even
when every capability is configured because the live executor is added only
after the automatic-ready deployment path exists.

The preflight requires these capability names:

- `AGENTBAY_HERMES_STAGING_PUBLISHED_IMAGE_REF`: scanned GHCR release-candidate
  Hermes workload image with an immutable `@sha256:` digest. This must be the
  published/scanned artifact, not the upstream Nous source image digest.
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
safe reason codes, and `sideEffectsAttempted: false`. It must never print raw
credentials, Telegram tokens, Telegram user or chat IDs, private endpoints,
provider responses, or serialized environment objects. A missing, blank,
placeholder, malformed, or non-exact sentinel value is a blocker, not a passing
smoke. The later live run may create billable DigitalOcean resources and send a
Telegram message only after the explicit authorization and confirmation values
above are present.
