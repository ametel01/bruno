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
BRUNO_FOUNDER_CONTRACT_RUNTIME_REVISION="founder-contract-v1" \
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
with the OS and browser versions used. Each attended record is bound to the app source revision,
exact runtime, and the canonical resume, review, approve, and deny tasks. Its separately reviewed
result metadata must report exactly one attempt with zero failures, flakes, or skips. Each record
must also identify exactly one independent attended human reviewer and zero automated runs, Owner,
friend-or-family, Trusted Preview, External Beta, coached, or build-team participants, self-tests, support
interventions, or facilitator rescues. The workflow rejects release mode if either attended record
is absent, malformed, incomplete, not clean, or crosses that participant boundary. Numeric claims
use blank-preserving string dispatch inputs so an omitted zero claim cannot become synthetic proof.

The retained JSON is an allowlisted summary bound to the source revision, exact runtime revision,
and GitHub run identity. The lifecycle fixture persists that runtime revision in the exercised
Operator runtime, and the application reads it back into every signed scenario result and the v2
ledger. A caller cannot relabel a ledger after execution: a persisted, result-level, ledger-level,
or candidate runtime mismatch fails before evidence is emitted.
It excludes credentials, authorization codes, message bodies, recipients, prompts, provider
responses, and infrastructure identifiers. GitHub attests the summary and retains it for 90 days.
Unit and browser runner output is deliberately not uploaded because it is not part of the evidence
allowlist.

The same run also emits `founder-initial-general-release-decision.json`. In ordinary CI this is an
explicit denied decision because attended evidence is absent. A release-mode dispatch may provide
four JSON inputs containing only allowlisted aggregate counts, exact timestamps, release outcomes,
retention controls, and SHA-256 evidence digests:

- `moderated_founder_summary_json` records the 4/4 desktop/phone cohort, cross-device day-two count,
  exactly one study attempt with zero failures, flakes, or skips,
  7-of-8 activation/action/recovery and first-brief thresholds, 8-of-8 comprehension, zero critical
  failure counts, and applied 90-day/30-day/24-month retention controls. It also binds eight fresh,
  independent, nontechnical participants and zero Owner, Trusted Preview, coached, External Beta,
  build-team, self/friend-test, facilitator-rescue, or support-intervention participants.
- `provider_decision_summary_json` records each capability's released/hidden outcome, exact source
  revision, qualification and expiry instants, exactly one clean attempt with no failures, flakes,
  or skips, and a distinct sanitized evidence digest for OpenAI, Anthropic, Calendar reading, Gmail
  reading, and one-to-one Gmail sending.
- `production_provider_qualification_summary_json` records exactly one attended production Clerk
  qualification, one Lemon Squeezy test-mode qualification, and one attended Lemon Squeezy live
  canary. Every record binds the same exact application and runtime revisions, environment,
  observation and expiry instants, exactly one clean attempt with no failures, flakes, or skips,
  result, sanitized digest, and its fixed checklist. The live
  record also binds separate intended and observed store and product reference digests.
- `general_release_operational_summary_json` proves that all External Beta findings were resolved
  before the exact candidate froze and retains separate passing operational, privacy, billing,
  recovery, and retirement digests, each from exactly one clean attempt with no failures, flakes,
  or skips. None may borrow an accessibility, usability, capability, or production-provider digest.

The decision is timestamped when it is created, and provider currency is evaluated against that
instant rather than the earlier contract observation time. The decision approves only when the product contract is release-eligible, every usability and
safety threshold passes, all five provider capability decisions are independently released and
current for the exact app revision, and the attended summaries are complete. Clerk production,
Lemon Squeezy test mode, and the attended live canary must all pass independently for the same exact
application and runtime candidate. Hidden, missing, malformed, stale, expired, future-dated,
revision-mismatched, or reused provider evidence fails closed. Evidence digests must be distinct
across the capability summary, every capability record, the production qualification summary, and
every qualification record. A test-mode record cannot occupy the
live-canary slot; the live canary's intended store and product digests must match their observed
references and must not alias each other. Those target digests are compared to independent,
environment-protected release-candidate variables; values inside dispatch JSON are evidence claims,
not target authority. The retained decision excludes participant identities,
recordings, transcripts, credentials, payment details, webhook secrets, prompts, provider payloads,
provider responses, raw store/product identifiers, and any unrecognized supplied fields. It also records the
General Release policy boundary: each Founder may authorize OpenAI only, Anthropic only, or both;
routing uses only those authorized Ready connections; Bruno-funded fallback is prohibited; and
qualification loss is capability-scoped at Safe Work Checkpoints.

The emitted decision remains a sanitized evidence artifact until a mapped Bruno.Ai Owner imports it
through `bun run founder:release:import-decision` in the matching protected deployment. Runtime
admission reads only the global persisted decision, binds each new activation to its exact decision
ID, and denies an absent, malformed, stale, denied, revision-mismatched, or unbound authority even
when public availability is configured `open`. Post-release qualification loss appends an immutable
capability-scoped Hold; only a fresh complete protected import appends Resume. Deterministic unit and
lifecycle fixtures exercise this boundary but never become attended, moderated, production-provider,
payment, refund, cleanup, or release-readiness evidence.
The signed `initial_general_release_activation` lifecycle scenario proves zero admission for missing,
denied, or stale authority; denial of a legacy unbound setup; capability-scoped Hold with unaffected
work preserved; no configuration-only resume; and an explicit fresh Resume before activation can
continue.

The workflow runs in automated mode for every push to `main`. With no external provider summary, CI
still validates the parser and decision logic and emits an explicit denied decision; deterministic
Clerk and Lemon Squeezy doubles never create test-mode, attended-production, real-charge, refund, or
cleanup evidence. A release candidate uses the manual `release` mode only after attended
assistive-technology evidence exists. Its exact immutable runtime revision and expected live Store
and Product digests come from the protected release environment, never workflow-dispatch inputs.
Ordinary CI uses the explicit `founder-contract-v1` deterministic fixture identity. Before a release
run begins, the workflow creates a GitHub Actions Check Run bound to the exact source revision and a
one-way digest of the protected runtime, after querying every Check Suite and its Check Runs for that
exact source. The globally bounded scan fails closed rather than trusting GitHub's truncated
commit-run view. Only the run-unique expected control name created by the GitHub Actions app is
authority; the unique name also prevents GitHub's same-name automatic deletion threshold from
erasing an older exact-candidate result. An earlier
denied, unsuccessful, or unresolved control for the pair blocks a fresh dispatch even if another
control succeeded; a different protected runtime is a different candidate, and ordinary CI fixture
runs do not create release controls. A denied release decision is still sanitized, attested, and
retained before the control is finalized as failed and the workflow fails terminally. Candidate
execution is serialized across refs by the exact source revision. A completed-success control is
trusted only when its canonical run URL resolves to this workflow's exact source and the originating
manual workflow is authoritatively completed-success; missing, malformed, unresolved, failed, or
ambiguous control/run state blocks replacement dispatch. The 90-day artifact is evidence retention,
not rerun authority.
No provider credential is used by either mode.

The qualification booleans and digests are only the allowlisted summary of separately reviewed
source evidence. They are not the source proof, do not make an existing Clerk or Lemon Squeezy
account qualified, and must never be authored from deterministic test results. Follow
[`CLERK_LEMON_SQUEEZY_PRODUCTION_QUALIFICATION.md`](acceptance/CLERK_LEMON_SQUEEZY_PRODUCTION_QUALIFICATION.md)
for the attended evidence boundary and sanitized handoff.

## Deterministic lifecycle seam

Lifecycle scenarios use the public seam in `src/testing/founder-product-contract.ts`. The seam is
split into clock, application adapter, harness, and evidence-ledger modules. The application
adapter calls Bruno's persisted Founder application and public API; it does not emulate lifecycle
state or authority. In deterministic mode the API installs stateful provider doubles at the same
provider interfaces used by the lifecycle service. The service records immutable Release
Decisions, single-use Owner-bound Checkout Correlations, signature-verified and idempotent Lemon
Squeezy event receipts, reconciled Product Entitlements, 30-day restorable Recovery Archives,
revoked runtime credentials, and exact-provider Infrastructure Retirement receipts.

The `identity_recovery_lifecycle` scenario enters through the same signed application-owned seam.
It records a verified Clerk identity-loss event, proves the unresolved subject cannot use the
Operator, rejects a mismatched replacement subject, rebinds only a short-lived strong proof to the
same internal Owner, and retains separate loss, denial, and rebound receipts. Snapshots on both
sides of that flow prove it did not mutate commerce events, Product Entitlement, Infrastructure
Retirement, Recovery Archive deletion, refund, Bruno Data Deletion, or Account Closure authority.
Only after those checks does the scenario request Account Closure through its existing coordinator
and verify the distinct closure receipt, subscription cancellation, and a seeded Google Calendar
connection's provider-visible revocation. The browser proof renders the separate successful
revocation receipt. The deterministic identity signing secret and encrypted connection grant are
scoped to the loopback contract process and are not live Clerk or Google credentials or release
acceptance.

The Lemon Squeezy production boundary verifies the `X-Signature` HMAC over the exact bounded raw
request body before decoding JSON. Because Lemon Squeezy does not document a webhook delivery ID,
Bruno.Ai records the signed payload digest as an explicitly derived delivery key together with the
provider resource identity, event name, and normalized provider timestamp. That receipt commits
before current Subscription and linked Order reads. Provider unavailability therefore leaves a
durable confirming-payment state rather than erasing evidence. Reconciliation grants access only
for the configured test/live Store and Variant when the Subscription is active and the Order is
fully paid and unrefunded. Duplicate and older receipts remain evidence but cannot replace newer
provider authority or extend retirement. A one-hour unresolved payment creates a leased terminal
refund intent, cancels future billing, confirms the full Order refund, closes the attempt, and
retries exact Infrastructure Retirement. A later signed success receipt cannot cross that terminal
fence; paid access requires a fresh Owner decision and Checkout Correlation.

A Recovery Archive is a strict v1 allowlist containing only the logical Operator identity, preparation
timezone, non-secret runtime configuration revision, and an explicit restoration plan that requires
provider reauthorization and contains zero reusable credentials. The payload is encrypted with a
per-archive data key; that key is wrapped by the dedicated server-only master key and stored as a
separate recovery-only object. The create operation downloads both objects immediately, verifies
their digests and authenticated encryption, parses the strict allowlist, and rebuilds the eligible
durable state before recording `restorable_verified`. A manifest or ciphertext-only check cannot
satisfy this boundary. In addition to exact-revision identity and OpenAI/Calendar Preview
Qualification, production preparation records the Owner Preview `enter` Release Decision only after
this verified-restorable archive exists. Runtime preparation never admits automatically: the mapped
Bruno.Ai Owner must choose the explicit Owner Preview entry control. Missing, stale, mismatched, or
incomplete evidence records an immutable exact-candidate `deny` decision with sanitized digests;
unavailable storage returns a fail-closed response without admission authority. Founder workspace
reads require a prior exact-revision Owner
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
operation reads are pure projections; reconciliation writes require a current work boundary. The
Founder-visible projection names Owner Preview, its currently available capabilities, its fully
attended support boundary, and its Learning Round evidence classification. Promotion evidence is a
read-only assessment bound to the latest persisted exact-candidate `enter` or `resume`: seven
consecutive daily briefs plus timestamped desktop and phone activation, interruption recovery,
provider reauthorization and disconnect, export, deletion, and zero release
blockers can make the record eligible for a later human Release Decision, but never create one and
never count as Founder Acceptance.

Trusted Preview is a separate exact-revision cohort decision owned by the mapped Bruno.Ai Owner.
It accepts at most three fixed cohort slots. Each invitation is bound to a sanitized Clerk-subject
digest, an explicit Founder-led Service Business evidence digest, and the active cohort decision;
the mapped Owner is ineligible for those contact slots, and the token is returned only for direct
delivery and is never stored in recoverable form. A participant
receives access only after Clerk authentication, invitation acceptance, a participant-specific
Release Decision bound to that participant's Owner, Operator, workspace and runtime, plus a current
verified-restorable Recovery Archive. The Founder projection names Trusted Preview, OpenAI and
Calendar reading as its only capabilities, attended onboarding and observation as its support
boundary, and Learning Round as its immutable evidence classification. A cohort-wide Critical or
release-blocking finding records a Hold, revokes pending invitations, preserves admitted participant
state and Safe Work Checkpoints, and requires a fresh exact-revision resume decision. Revoked
pending slots can be rebound to that fresh decision without allowing more than three current
invited-or-admitted contacts. Promotion
assessment derives its roster under the cohort lock from admitted invitation, exact participant
decision, Operator, and ready-runtime rows; two distinct admitted contacts must complete activation,
recurring use, authority, recovery, and privacy journeys under attended observation. It remains ineligible for Founder
Acceptance Evidence and cannot promote automatically. These focused persisted and classification
tests are registered in the Founder Product Contract invariant pack.

Core Operation, Gmail reading, Gmail sending, and Anthropic remain unavailable throughout
Calendar-only Owner Preview and Trusted Preview, including at
their deep application seams and when retained Mail state exists. Trusted Preview hides the mixed
Calendar-and-Mail Relationship Records UI and denies its API before retained Mail-backed evidence
can be projected or changed. Provider subscription state
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
revision identity fail closed. External Beta recording cleanup persists verified late deletion as a
terminal breach receipt and reports the breach without suppressing Infrastructure Retirement; both
cleanup outcomes remain independently observable from the scheduled run. Completed Infrastructure Retirement ends daily replacement creation until later admission
authority restores the Operator; the final retained archive still reaches the same expiry boundary.
Retirement also invalidates the destroyed Operator runtime in the same completion transaction, so
the runtime cannot remain Ready after its Droplet and firewall are absent. Archive restore proof
includes the complete external-action pause state—boolean, a closed non-secret recovery reason, and
timestamp—rather than a flag that cannot be persisted safely after restoration. Raw
Founder-controlled pause text is excluded from the archive allowlist.

A fresh eligible payment after completed Infrastructure Retirement enters Returning Founder
restoration instead of applying Product Entitlement directly. Within the verified archive's 30-day
retention window, the restoration preserves the same logical Operator and durable state while the
canonical runner provisioner creates a new exact Droplet, firewall, runtime identity, and endpoint;
the old infrastructure identity and IP address are never a compatibility promise. Work stays paused
while provisioning is pending and until fresh `reauthorized` receipts make both AI Provider accounts
and the Calendar and Gmail Company Connections Ready after the new infrastructure became Ready.
Only then does the same transaction verify Product Entitlement and resume work. Provider ambiguity
keeps the signed payment receipt pending. A terminal or partial restoration failure verifies absence
of the exact new owned-resource set before closing a full Lemon Squeezy refund. Once the linked
archive expires, or a completed archive-deletion receipt exists, delayed payment events cannot
revive it: the former Operator is archived, a distinct new Operator environment is created, and the
ineligible restoration payment is refunded.

The same exact-candidate lifecycle seam records the External Beta Preview Qualifications as five
independent, immutable capability records: OpenAI, Anthropic, Calendar reading, Gmail reading, and
one-to-one Gmail sending. Every record binds the named cohort, application revision, runtime
revision, sanitized evidence digest, observation time, and expiry. The complete manifest remains
unavailable when any record or its matching Connected Acceptance evidence is missing, malformed,
stale, mismatched, or expired; no AI provider or Gmail capability can borrow a sibling's evidence.
This qualification does not admit an External Beta participant by itself. Later admission must bind
the complete manifest in an explicit Release Decision. After admission, the persisted per-capability
state supports scoped degradation: an unavailable provider or Company Connection pauses only its
dependent work while unrelated capabilities and Safe Work Checkpoints remain available. AI routing
continues to select only Ready provider accounts the Founder explicitly connected, permits OpenAI,
Anthropic, or both, and has no Bruno-funded fallback. The Founder API and reusable capability view
publish only ordinary labels and Available or Paused state; cohort IDs, revisions, evidence digests,
models, credentials, Hermes details, runners, and raw provider evidence remain server-only.

External Beta begins only through an exact-candidate Release Decision after Trusted Preview's
promotion gate and the complete five-capability manifest both pass. Each invitation is an opaque,
single-workspace, named-Founder grant: Bruno stores only digests, rejects copying or transfer, and
expires the pending invitation after exactly seven days. Admission requires the Founder to accept
the Beta Compact before access starts. The Founder surface shows the External Beta stage, exact
time remaining, capability availability, self-serve and reactive-support boundary, withdrawal,
Founder Data Export, and Bruno Data Deletion. The cohort is free, never asks for a card, and has no
conversion path. Access lasts exactly fourteen days and cannot be extended; expiry stops new work
immediately and gives the existing retirement executor a fixed one-hour deadline while export and
deletion remain available for retained Bruno-local data.

Promotion remains a later human Release Decision, not an automated outcome. A qualifying cohort is
five to ten independent Founders who each complete fourteen days and at least five recurring
Lead-to-Client Loops without attended operation. A missed threshold cannot be repaired by extending
access or reusing the cohort: assessment requires a new cohort. All External Beta observations are
Product Hardening Evidence only and never Founder Acceptance Evidence. A signed top-level External
Beta cohort lifecycle scenario exercises the actual invitation and Beta Compact admission seams,
copied-account and wrong-workspace denial, visible exact boundaries and nonconversion, hard expiry,
the real retirement reconciler and Infrastructure Retirement executor, and denied promotion that
requires a new cohort. Focused admission, promotion, and Founder-surface tests support that signed
scenario in the Founder Product Contract invariant pack.

Delayed or
reordered commerce events cannot replace newer authority or extend a retirement clock; reactivation
requires a newly pending Owner-bound Checkout Correlation. DigitalOcean cleanup is derived from
authoritative owned-set observations before and after firewall-first deletion. The in-progress
retirement receipt freezes the complete Droplet, firewall, operation-tag, name, region, size, and
expected firewall identity before destructive provider effects; later retries never rebuild
deletion scope from mutable runner assignment. New work is paused and runtime credentials are
revoked in that same transaction. Provider ambiguity, request timeout, lost deletion responses,
duplicate execution, and partial cleanup leave the receipt in progress and retry the same frozen
identity. The registered Founder Product Contract retirement suite exercises normal completion,
duplicate scheduling, worker interruption after a provider-side effect, ambiguous ownership,
provider timeout, unknown deletion outcome, and partial cleanup retry. A completed receipt requires
authoritative absence for both resources. It records the
provider-reported Droplet creation time and the final absence observation so billable runtime
includes powered-off, stopped, idle, or locally unassigned provider-present Droplets. Archive
creation or expiry failure is recorded as a critical preservation failure but does not block
infrastructure destruction or extend the hard deadline; the bounded emergency attempt finishes or
is recorded failed before the first destructive provider request, and its outcome is recorded
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
evidence identity, and a fresh dispatch cannot erase an earlier failed run for the same source and
protected runtime candidate. Scenario execution history is candidate evidence rather than user-owned fixture state, so
deleting a disposable lifecycle user cannot erase a failure. After each successful transition, the
application commits a canonical scenario-execution receipt. Only the application can assemble and
sign the complete exact-run ledger from those persisted receipts; the browser test copies that
response to the producer's fixed artifact path without constructing results or using the signing
authority. The runner executes an isolated public provider-failure proof first, then one lifecycle
producer under the candidate run identity, and finally the five-project browser and accessibility
matrix without lifecycle mutations. Both the failed proof receipt and the candidate's eight passing
receipts survive disposable-user cleanup until the workflow database is destroyed. Each receipt
persists the runtime exercised at claim time; legacy receipts without that provenance remain null
and fail closed. The ledger binds the canonical producer, source revision, persisted runtime
revision, workflow run ID, observation instant, results digest, and
HMAC signature using the protected
`BRUNO_FOUNDER_CONTRACT_SCENARIO_SIGNING_SECRET`; unsigned or caller-authored results are
rejected. Cleanup is rebuilt from its five-field explicit allowlist before serialization. The contract
runner never generates lifecycle results, and missing lifecycle evidence fails CI and release
dispatches alike. A lifecycle/API/provider failure blocks the workflow rather than emitting a
passing contract. The retained `scenarioLedger`
contains the complete sanitized signed payload, including schema version and every result's source
and runtime revisions, observation time, cleanup outcome, digest, and signature, so its canonical signed input
can be independently reconstructed.
