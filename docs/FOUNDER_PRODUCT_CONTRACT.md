# Founder Product Contract

The Founder Product Contract is an exact-revision release gate. It combines deterministic
application tests with one persisted Operator scenario exercised through both the real HTTP API and
the rendered Founder workspace. Browser tests do not replace the application boundary with route
interception.

Run it after migrating a disposable local PostgreSQL database:

```bash
BRUNO_FOUNDER_CONTRACT_SOURCE_REVISION="$(git rev-parse HEAD)" \
BRUNO_FOUNDER_CONTRACT_RUN_ID="local-$(git rev-parse --short HEAD)" \
BRUNO_FOUNDER_CONTRACT_OBSERVED_AT="2026-08-20T00:00:00.000Z" \
bun run founder:contract
```

The runner executes the invariant files named in
`src/shared/founder-product-contract.ts`, then exercises the same persisted Operator through the
API and browser in desktop Chrome, Firefox, and Safari/WebKit plus iOS Safari and Android Chrome
device profiles. Playwright retries are disabled. A failure, skip, flaky retry, missing browser
project, or incomplete unit result stops the whole pack before an evidence summary is emitted.

Automated accessibility uses axe-core WCAG 2.0, 2.1, and 2.2 rules plus a keyboard-focus journey.
Browser device profiles do not claim screen-reader evidence. A release-mode dispatch also requires
the SHA-256 digests of separately reviewed VoiceOver/Safari and TalkBack/Chrome evidence, together
with the OS and browser versions used. Each attended record is bound to the app source revision and
the canonical resume, review, approve, and deny tasks with a passed outcome. The workflow rejects
release mode if either attended record is absent, malformed, or incomplete.

The retained JSON is an allowlisted summary bound to the source revision and GitHub run identity.
It excludes credentials, authorization codes, message bodies, recipients, prompts, provider
responses, and infrastructure identifiers. GitHub attests the summary and retains it for 90 days.
Unit and browser runner output is deliberately not uploaded because it is not part of the evidence
allowlist.

The workflow runs in automated mode for every push to `main`. A release candidate uses the manual
`release` mode only after attended assistive-technology evidence exists. No provider credential is
used by either mode.
