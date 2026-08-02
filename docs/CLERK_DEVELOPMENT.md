# Clerk development instance and production provider prerequisites

This runbook is the operator contract for issue #232. It separates the approved AgentBay
development-instance work from the later production cutover in issue #240.

## Current status and authority

Approval `de322ae8-c258-440e-a679-b74bafb61048` authorizes one dedicated **AgentBay development**
Clerk application, verified email-code sign-in, development Google and Apple connections, an
explicit CLI link, and development test keys written only to this repository's ignored local
`.env.local` file.

The approved issue #232 development setup is complete: the dedicated AgentBay development
application is explicitly linked, verified email-code sign-in and development Google/Apple provider
configuration are enabled, required local `.env.local` variable names are present, and a sanitized
`clerk doctor --json` gate passed for that linked development app. This is setup, link, provider
configuration, local-key presence, and doctor evidence only. It does not claim hosted browser
email-code, Google, Apple, current-user, or sign-out flow success; those issue #239 smoke checks
still require a supported browser backend and isolated synthetic identities.

The approval does not include Ask Siargao, any production instance, Vercel configuration,
deployment, billing, destructive deletion, or issue #240. Stop and obtain a new durable approval
before any of those operations.

## Safe development setup

Run these steps from the AgentBay repository on the approved host. Do not use verbose shell
tracing, record the terminal, or redirect raw CLI output into a tracked file.

1. Reauthenticate with `clerk auth login`. Confirm authentication locally, but do not publish the
   identity returned by `clerk whoami`.
2. Inventory accessible applications with `clerk apps list`. Reuse an application only when its
   name and environment unambiguously identify it as the dedicated AgentBay development app.
   Never select Ask Siargao or a production instance. If no such app exists, create exactly one
   with `clerk apps create "AgentBay Development"`.
3. Capture the selected opaque application ID privately and run `clerk link --app <app-id>`.
   Confirm the linked-project check locally with `clerk doctor --json`; the doctor command may
   still report the expected missing-environment failure at this point. `clerk whoami` shows the
   authenticated user and linked application, so use it only for the local confirmation. Do not
   publish the account email or raw application ID. Evidence may state only the sanitized
   linked-app confirmation, application-ID fingerprint, and matched development environment.
4. In the linked development instance, require email address verification by email code. Enable
   Google and Apple as development social connections using Clerk's development credentials. Do
   not add custom production OAuth credentials during this step.
5. Before writing keys, prove the destination is ignored:

   ```sh
   git check-ignore -q .env.local
   ```

   Restrict the destination before writing any keys, then pull only the development environment:

   ```sh
   touch .env.local
   chmod 600 .env.local
   clerk env pull --instance dev --file .env.local
   ```

   Do not use `--instance prod`, another output file, Vercel, or a tracked artifact. Verify the
   required variable names by presence only; never print, diff, hash, or copy their values.
6. Run `clerk doctor --json` without `--fix`. Sanitize the result before recording it: retain the
   command version, pass/fail state, check names, linked development-app fingerprint, and key
   presence only. Remove account identity, paths outside the repository, URLs containing state,
   and every key, token, cookie, or session value.
7. Follow the hosted provider smoke boundary in
   [Two-user authentication and isolation acceptance](./TWO_USER_ACCEPTANCE.md). Record Google or
   Apple success only after that provider completed end to end. Component tests and an enabled
   dashboard toggle are not hosted success evidence.

If inventory is ambiguous, the link targets a non-development instance, email verification cannot
be required, a provider requests custom production credentials, `.env.local` is not ignored, or
doctor exposes an unsafe value, stop without mutating further state and return the sanitized
blocker to the coordinator.

## Required completion evidence

Issue #232 is closed complete because the operator supplied all of the following without secret or
PII values:

- dedicated app name plus opaque application-ID fingerprint and development-environment status;
- explicit CLI-link confirmation that excludes every unrelated app;
- enabled configuration status for verified email code, development Google, and development Apple;
- `.env.local` ignored-file and required-variable-presence checks;
- a passing sanitized `clerk doctor --json` result; and
- repository quality-gate results and the hosted browser/provider smoke handoff to issue #239.

An approval record, app creation, provider toggle, local component test, or failed doctor result is
intermediate evidence only. The completed #232 setup still does not prove hosted email-code,
Google, Apple, current-user, sign-out, or full provider-backed `bun run verify:e2e` success.

## Production Google prerequisites

Production must use custom Google OAuth credentials; Clerk's shared development credentials are
not a production credential set. Before the separately approved production cutover:

1. Select an organization-owned Google Cloud project and configure the OAuth consent screen,
   application identity, support contacts, authorized domains, requested scopes, publishing state,
   and any required test users.
2. Create a **Web application** OAuth client and retain its client ID and client secret in the
   approved production secret manager. Never commit them or place them in this development
   `.env.local` file.
3. Copy the exact authorized redirect URI shown by the **production Clerk instance's** Google
   connection into the Google client. Treat the Clerk Dashboard value as authoritative; do not
   construct or reuse a development callback URL. Add authorized JavaScript origins only when the
   Clerk/Google configuration calls for them, using the final HTTPS production origins.
4. After production approval, enter the client ID and secret into only the AgentBay production
   Clerk connection. A matching redirect URI is exact, including scheme, host, path, and trailing
   slash behavior; a mismatch must block cutover.

See Clerk's [Google social connection guide](https://clerk.com/docs/guides/configure/auth-strategies/social-connections/google)
and Google's [OAuth client guidance](https://support.google.com/cloud/answer/15549257).

## Production Apple prerequisites

Production Sign in with Apple requires an organization-controlled Apple Developer Program team and
custom credentials. Prepare these items without adding them to the development instance:

1. A primary App ID with the Sign in with Apple capability enabled, plus a web **Services ID**
   grouped with that primary App ID. The Services ID is the web OAuth client identifier.
2. The Apple Team ID, Services ID, and a Sign in with Apple Key ID.
3. A Sign in with Apple private key file. Apple permits the private key to be downloaded once, so
   transfer it directly to the approved production secret manager, restrict access, and retain the
   recovery/rotation owner. Never commit the file, paste it into tickets or chat, put it in this
   development `.env.local`, or print its PEM contents. Provide it to the production Clerk
   connection using Clerk's current protected Dashboard workflow only during the separately
   approved cutover.
4. Under the Services ID's web configuration, register the final production website domain and the
   exact return URL displayed by the **production Clerk instance's** Apple connection. Use the
   Clerk-displayed HTTPS callback verbatim; do not substitute the application landing page, a
   development `accounts.dev` URL, localhost, or an inferred path.
5. Support Apple's Hide My Email flow. Register every domain or individual source address that can
   send AgentBay mail to Apple relay addresses, publish the SPF DNS record Apple requires for each
   outbound domain, and wait for Apple to verify it. The user-facing application/return domains and
   the outbound relay domains are separate allowlists; both must be ready before production smoke.

After credentials are entered, exercise an actual Apple sign-in and relay-address email path before
cutover. An Apple dashboard configuration alone is not success evidence.

See Clerk's [Apple social connection guide](https://clerk.com/docs/guides/configure/auth-strategies/social-connections/apple),
Apple's [Sign in with Apple web configuration](https://developer.apple.com/help/account/configure-app-capabilities/configure-sign-in-with-apple-for-the-web),
and Apple's [private email relay configuration](https://developer.apple.com/help/account/configure-app-capabilities/configure-private-email-relay-service).
