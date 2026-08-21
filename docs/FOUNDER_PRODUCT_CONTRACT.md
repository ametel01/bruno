# Founder Product Contract

The Founder Product Contract is an exact-revision release gate. It combines deterministic
application tests with one persisted Operator scenario exercised through both the real HTTP API and
the rendered Founder workspace. Browser tests do not replace the application boundary with route
interception.

Run it after migrating a disposable local PostgreSQL database:

The workflow first binds the exact run identity and observation instant. The contract runner then
executes the persisted lifecycle producer through the public API and writes the producer's fixed
artifact path. It does not accept a dispatch input or caller-authored JSON. It intentionally fails
before writing evidence when the producer is absent, the ledger is missing, or the signing secret is
absent.

```bash
BRUNO_FOUNDER_CONTRACT_SOURCE_REVISION="$(git rev-parse HEAD)" \
BRUNO_FOUNDER_CONTRACT_RUN_ID="local-$(git rev-parse --short HEAD)" \
BRUNO_FOUNDER_CONTRACT_OBSERVED_AT="2026-08-20T00:00:00.000Z" \
BRUNO_FOUNDER_CONTRACT_SCENARIO_LEDGER_PATH="founder-contract-scenario-ledger.json" \
BRUNO_FOUNDER_CONTRACT_SCENARIO_SIGNING_SECRET="${BRUNO_FOUNDER_CONTRACT_SCENARIO_SIGNING_SECRET:?set the trusted producer secret}" \
BRUNO_AUTH_MODE="development" \
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

The same run also emits `founder-initial-general-release-decision.json`. In ordinary CI this is an
explicit denied decision because attended evidence is absent. A release-mode dispatch may provide
two JSON inputs containing allowlisted counts and SHA-256 evidence digests only:

- `moderated_founder_summary_json` records the 4/4 desktop/phone cohort, cross-device day-two count,
  7-of-8 activation/action/recovery and first-brief thresholds, 8-of-8 comprehension, zero critical
  failure counts, and applied 90-day/30-day/24-month retention controls.
- `provider_decision_summary_json` records exact-revision released/hidden outcomes plus evidence
  digests for OpenAI, Calendar reading, Gmail reading, Gmail sending, and Anthropic.

The decision approves only when the product contract is release-eligible, every usability and
safety threshold passes, all four core provider decisions are released for the exact app revision,
and the attended summaries are complete. Anthropic is included only when its own outcome is
`released`. The retained decision excludes participant identities, recordings, transcripts,
credentials, prompts, and provider responses.

The workflow runs in automated mode for every push to `main`. A release candidate uses the manual
`release` mode only after attended assistive-technology evidence exists. No provider credential is
used by either mode.

## Deterministic lifecycle seam

Lifecycle scenarios use the public seam in `src/testing/founder-product-contract.ts`. The seam is
split into clock, provider-boundary, application-adapter, harness, and evidence-ledger modules.
The application adapter must point at the persisted Founder application and public API; the seam
does not emulate lifecycle state or authority. Deterministic doubles for Clerk, Lemon Squeezy,
DigitalOcean, OpenAI, Anthropic, and Google are passed to that same adapter boundary for contract
tests, while production lifecycle code remains authoritative for Release Stage, Product
Entitlement, Recovery Archive, and Infrastructure Retirement. Scenarios advance time explicitly,
never sleep, and record an allowlisted cleanup outcome without resource identifiers. Every
canonical scenario must pass exactly once against the same revision and within the bounded
observation window; missing, failed, skipped, retried, stale, mismatched, or unverified-cleanup
results fail closed. Release evidence consumes a signed, exact-run ledger emitted by the real
persisted application at the producer's fixed artifact path. The ledger binds the
canonical producer, source revision, workflow run ID, observation instant, results digest, and
HMAC signature using the protected
`BRUNO_FOUNDER_CONTRACT_SCENARIO_SIGNING_SECRET`; unsigned or caller-authored results are
rejected. Cleanup is rebuilt from its five-field explicit allowlist before serialization. The contract
runner never generates lifecycle results, and missing lifecycle evidence fails CI and release
dispatches alike. A lifecycle/API/provider failure blocks the workflow rather than emitting a
passing contract. The retained `scenarioLedger`
contains the complete sanitized signed payload, including schema version and every result's source
revision, observation time, cleanup outcome, digest, and signature, so its canonical signed input
can be independently reconstructed.
