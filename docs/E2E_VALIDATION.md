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
- `E2E_CLERK_TEST_USER_A_EMAIL` and `E2E_CLERK_TEST_USER_B_EMAIL`, both approved development
  `+clerk_test` identities.

Its sanitized preflight reports missing capability names and exits before starting the app or
browser. Screenshots, traces, and videos are disabled; browser contexts are closed in the test;
raw keys, testing tokens, emails, cookies, OAuth state, and storage state must never be retained.
Google and Apple are not silently marked successful: the current official helper does not provide
deterministic OAuth automation for those providers, so their hosted evidence remains operator-run.
This optional gate does not replace the provider/runner-backed `bun run verify` requirement.

## Full provider-backed gate

Run:

```bash
bun run test:e2e
```

This remains the canonical, unfiltered Playwright suite. `bun run verify` ends with this full gate. Before Playwright starts, the launcher validates the same configuration contract used by `readDigitalOceanProviderConfig`. At minimum, both `AGENTBAY_DIGITALOCEAN_TOKEN` and `AGENTBAY_RUNNER_BEARER_TOKEN` must be nonblank; any optional provider settings must also be valid. The preflight reports only capability and variable names, never configured values.

With the default `digitalocean` mode, the full suite may create and delete billable provider resources. Use an approved development account with usable network, image, SSH, and runner prerequisites. Do not use synthetic values for a real full-suite run.

For local Docker validation, set `AGENTBAY_DIGITALOCEAN_PROVIDER_MODE=local_docker` and prepare the repository's local cloud-runner stack and its required runner token, image, endpoint, container, and Docker prerequisites. The same provider parser validates local-mode settings before Playwright starts.

An unconfigured or invalid full-suite run exits once with the sanitized capability message before any browser or provider-backed scenario begins. This fail-fast result does not replace provider-backed acceptance: use `test:e2e:ci` for the credential-free CI surface and run `test:e2e` whenever full provider capability is available and required.
