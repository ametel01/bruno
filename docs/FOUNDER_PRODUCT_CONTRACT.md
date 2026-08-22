# Founder Product Contract

The Founder Product Contract is an exact-revision release gate. It combines deterministic
application tests with one persisted Operator scenario exercised through both the real HTTP API and
the rendered Founder workspace. Browser tests do not replace the application boundary with route
interception.

Run it after migrating a disposable local PostgreSQL database:

The workflow first binds the exact run identity and observation instant. The contract runner then
executes the persisted lifecycle producer through the public API and writes the producer's fixed
artifact path. It does not accept a dispatch input or caller-authored JSON. It intentionally fails
before writing evidence when the producer is absent, the ledger is missing, or release signing
authority is absent. Automated CI binds a masked random signing key for that job only; it is never a
release authority and is destroyed with the runner.

```bash
BRUNO_FOUNDER_CONTRACT_SOURCE_REVISION="$(git rev-parse HEAD)" \
BRUNO_FOUNDER_CONTRACT_RUN_ID="local-$(git rev-parse --short HEAD)" \
BRUNO_FOUNDER_CONTRACT_RUN_ATTEMPT="1" \
BRUNO_FOUNDER_CONTRACT_OBSERVED_AT="$(date -u +'%Y-%m-%dT%H:%M:%S.000Z')" \
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
`release` mode only after attended assistive-technology evidence exists. Before either mode runs,
the workflow queries its GitHub Actions history for the exact source revision and fails closed when
an earlier run for that revision was unsuccessful or remains unresolved. A successful automated run
does not block the later attended release dispatch. No provider credential is used by either mode.

## Deterministic lifecycle seam

Lifecycle scenarios use the public seam in `src/testing/founder-product-contract.ts`. The seam is
split into clock, application adapter, harness, and evidence-ledger modules. The application
adapter calls Bruno's persisted Founder application and public API; it does not emulate lifecycle
state or authority. In deterministic mode the API installs stateful provider doubles at the same
provider interfaces used by the lifecycle service. The service records immutable Release
Decisions, single-use Owner-bound Checkout Correlations, signature-verified and idempotent Lemon
Squeezy event receipts, reconciled Product Entitlements, 30-day restorable Recovery Archives,
revoked runtime credentials, and exact-provider Infrastructure Retirement receipts. A Recovery
Archive is a strict v1 allowlist containing only the logical Operator identity, preparation
timezone, non-secret runtime configuration revision, and an explicit restoration plan that requires
provider reauthorization and contains zero reusable credentials. The payload is encrypted with a
per-archive data key; that key is wrapped by the dedicated server-only master key and stored as a
separate recovery-only object. The create operation downloads both objects immediately, verifies
their digests and authenticated encryption, parses the strict allowlist, and rebuilds the eligible
durable state before recording `restorable_verified`. A manifest or ciphertext-only check cannot
satisfy this boundary. In addition to exact-revision identity and OpenAI/Calendar Preview
Qualification, production preparation records the Owner Preview `enter` Release Decision only after
this verified-restorable archive exists; unavailable storage returns a fail-closed preparation
response without admission authority. Founder workspace reads require a prior exact-revision Owner
Preview admission. New work and effect-starting application boundaries additionally recheck that
their required capabilities remain available under the latest exact-revision decision and that its
verified archive remains within the 24-hour currency window. A Hold records its affected capability
subset separately from the complete admitted manifest, preserving unrelated qualified work plus all
safe reads and checkpoints. A stale archive or non-Ready runtime pauses new work without hiding that
saved state. A later Release Hold can be lifted only by a new `resume`
decision after fresh, independently evidenced OpenAI and Calendar qualifications revalidate the
same Owner, stage, application, runtime, and capability boundaries after that Hold. Runtime failures
persist the complete Owner Preview manifest and the affected capability subset
through one lifecycle-serialized canonical Hold writer while preserving the admitted runtime
revision and recording the failed attempted revision as evidence. Preview Qualification expiry is
persisted per capability and reconciled into a scoped Hold at access boundaries; legacy decisions
with no provable expiry migrate fail-closed. Cumulative Holds retain prior affected-capability
evidence. Full and partial Holds continue daily Recovery Archive refresh from the last admitted
durable checkpoint, including while runtime recovery needs attention, so protection does not lapse. Safe
operation reads are pure projections; reconciliation writes require a current work boundary. Core
Operation and Gmail effects remain unavailable throughout Calendar-only Owner Preview, including at
their deep application seams and when retained Mail state exists. Provider subscription state
applies bounded retirement deadlines and immediately
pauses new work for unpaid, expired, and refunded entitlement. The Proposed Action claim and Gmail
execution transactions pass
their captured operation time into this entitlement guard, so the deadline controls the real effect
path rather than only a policy helper. Verified archives that reach their 30-day expiry exercise a
durable, idempotent deletion boundary that requires separate absence proof for the encrypted object
and its recovery-only credential. The production adapter uses the configured S3-compatible object
store under the reserved `founder-recovery/` namespace, while the hourly protected reconciler
refreshes two schedule intervals before the 24-hour access boundary and processes expiry for retained
archives even when the Owner is no longer eligible for new archives. Neither the manual backup
manifest nor a DigitalOcean snapshot can enter the v1 archive state. Recovery Archive storage must
resolve to a supported managed-provider hostname (Amazon S3, DigitalOcean Spaces, Cloudflare R2, or
Backblaze B2); self-hosted or arbitrary S3-compatible endpoints fail closed because they do not
prove off-Droplet placement. Restore verification writes the archive projection through the actual
Operator, preparation, and runtime PostgreSQL tables in an always-rolled-back synthetic transaction,
so Bruno's current persistence constraints—not a field-copy model—decide eligibility. Archive and recovery-credential
deletion requires a live proof that bucket versioning is disabled, so a delete marker that leaves
recoverable object versions cannot produce a completed receipt. Archive and recovery-credential
object identities are persisted before provider upload, so interrupted, partial, and failed
creations remain eligible for 30-day deletion and a bounded receipt rather than becoming orphaned
objects. Each archive intent persists its trusted runtime revision before upload; reuse, admission,
and work authorization require that revision to match, while migrated archives without provable
revision identity fail closed. Completed Infrastructure Retirement ends daily replacement creation until later admission
authority restores the Operator; the final retained archive still reaches the same expiry boundary.
Retirement also invalidates the destroyed Operator runtime in the same completion transaction, so
the runtime cannot remain Ready after its Droplet and firewall are absent. Archive restore proof
includes the complete external-action pause state—boolean, a closed non-secret recovery reason, and
timestamp—rather than a flag that cannot be persisted safely after restoration. Raw
Founder-controlled pause text is excluded from the archive allowlist.
Delayed or
reordered commerce events cannot replace newer authority or extend a retirement clock; reactivation
requires a newly pending Owner-bound Checkout Correlation. DigitalOcean cleanup is derived from
authoritative owned-set observations before and after firewall-first deletion. The in-progress
retirement receipt and credential revocation commit before destructive provider effects, so
failures remain retryable against the same resource identity. Archive creation or expiry failure is
recorded but does not block infrastructure destruction; the bounded archive outcome is recorded
before the Infrastructure Retirement Receipt completes. S3-compatible request and response-body
operations use a 10-second abort deadline, including creation, restore verification, expiry, and
deletion-safety checks. These deterministic provider results prove
Bruno's application behavior only; they never substitute for separately
bound live-provider or moderated Founder evidence required for General Release. Scenarios advance
time explicitly, never sleep, and record an allowlisted cleanup outcome without resource
identifiers. Every
canonical scenario must pass exactly once against the same revision and within the bounded
observation window; missing, failed, skipped, retried, stale, mismatched, or unverified-cleanup
results fail closed. Official GitHub workflow reruns are rejected rather than receiving a fresh
evidence identity, and a fresh dispatch cannot erase an earlier failed run for the same source
revision. Scenario execution history is candidate evidence rather than user-owned fixture state, so
deleting a disposable lifecycle user cannot erase a failure. After each successful transition, the
application commits a canonical scenario-execution receipt. Only the application can assemble and
sign the complete exact-run ledger from those persisted receipts; the browser test copies that
response to the producer's fixed artifact path without constructing results or using the signing
authority. The runner executes an isolated public provider-failure proof first, then one lifecycle
producer under the candidate run identity, and finally the five-project browser and accessibility
matrix without lifecycle mutations. Both the failed proof receipt and the candidate's four passing
receipts survive disposable-user cleanup until the workflow database is destroyed. The ledger binds
the canonical producer, source revision, workflow run ID, observation instant, results digest, and
HMAC signature using the protected
`BRUNO_FOUNDER_CONTRACT_SCENARIO_SIGNING_SECRET`; unsigned or caller-authored results are
rejected. Cleanup is rebuilt from its five-field explicit allowlist before serialization. The contract
runner never generates lifecycle results, and missing lifecycle evidence fails CI and release
dispatches alike. A lifecycle/API/provider failure blocks the workflow rather than emitting a
passing contract. The retained `scenarioLedger`
contains the complete sanitized signed payload, including schema version and every result's source
revision, observation time, cleanup outcome, digest, and signature, so its canonical signed input
can be independently reconstructed.
