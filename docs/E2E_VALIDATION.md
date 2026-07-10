# End-to-end validation

AgentBay keeps two distinct Playwright gates. Both use the unchanged desktop and mobile projects in `playwright.config.ts`.

## Credential-free CI gate

Run:

```bash
bun run test:e2e:ci
```

This is the repository-owned GitHub CI command. It runs only the health route, shell routes, browser health response, and invalid create-input selectors that do not require a configured cloud-runner provider. The selector list is single-sourced in `scripts/run-e2e.ts`; CI calls the package command rather than duplicating it.

The command still requires the normal test database and application URL. Package defaults target the local PostgreSQL service on port `54329` and the Next.js test server on port `3100`; parallel runs should override `DATABASE_URL`, `NEXT_PUBLIC_APP_URL`, and `PORT` with isolated values.

## Full provider-backed gate

Run:

```bash
bun run test:e2e
```

This remains the canonical, unfiltered Playwright suite. `bun run verify` ends with this full gate. Before Playwright starts, the launcher validates the same configuration contract used by `readDigitalOceanProviderConfig`. At minimum, both `AGENTBAY_DIGITALOCEAN_TOKEN` and `AGENTBAY_RUNNER_BEARER_TOKEN` must be nonblank; any optional provider settings must also be valid. The preflight reports only capability and variable names, never configured values.

With the default `digitalocean` mode, the full suite may create and delete billable provider resources. Use an approved development account with usable network, image, SSH, and runner prerequisites. Do not use synthetic values for a real full-suite run.

For local Docker validation, set `AGENTBAY_DIGITALOCEAN_PROVIDER_MODE=local_docker` and prepare the repository's local cloud-runner stack and its required runner token, image, endpoint, container, and Docker prerequisites. The same provider parser validates local-mode settings before Playwright starts.

An unconfigured or invalid full-suite run exits once with the sanitized capability message before any browser or provider-backed scenario begins. This fail-fast result does not replace provider-backed acceptance: use `test:e2e:ci` for the credential-free CI surface and run `test:e2e` whenever full provider capability is available and required.
