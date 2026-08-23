# Initial General Release Decision

## Decision: do not release

The Founder Operator is **not eligible for Initial General Release** on 20 August 2026. The exact
CI Founder Product Contract passes its automated unit and five-browser checks, but it is explicitly
`releaseEligible: false`: no attended VoiceOver/Safari or TalkBack/Chrome evidence is bound to the
candidate. There is also no completed eight-founder moderated-study summary. The provider tickets
resolved safely by keeping OpenAI, Google reading, Gmail sending, and Anthropic unreleased after
their production preflights could not run. No exact-application-and-runtime attended Clerk
production, Lemon Squeezy test-mode, or attended live-canary qualification summary exists.

No founder participant, activation, timing, comprehension, recovery, accessibility, or provider
result is inferred from automated tests. No interview, recording, transcript, credential, prompt,
provider response, or participant identity was created or retained for this decision.

## Approval boundary

The exact-release workflow now emits
`bruno.founder-initial-general-release-decision.v1`. Approval requires all of:

- a release-mode Founder Product Contract bound to the exact source revision, with desktop Chrome,
  Firefox, and Safari; iOS Safari; Android Chrome; keyboard/axe; attended VoiceOver/Safari; and
  attended TalkBack/Chrome all passing without retry, flake, failure, or skip;
- exactly eight representative nontechnical B2B service founders, split four desktop-first and four
  phone-first, all completing a cross-device day-two task; all eight must be fresh, independent,
  and nontechnical, with zero Owner, Trusted Preview, coached, External Beta, build-team,
  self/friend-test, facilitator-rescue, or support-intervention participants;
- at least seven independently activating, acting on a Lead-to-Client item, and recovering from an
  interruption, plus at least seven reaching the first brief within 15 minutes of Active Founder
  Time;
- all eight correctly explaining access, AI processing, authority, disconnect, Bruno deletion, and
  provider deletion;
- zero permission/safety failures, unintended effects, unsafe misunderstandings, technical setup
  requirements, or Founder credential handling;
- independent exact-revision released evidence for OpenAI, Anthropic, Calendar reading, Gmail
  reading, and one-to-one Gmail sending; and
- independently reviewed, exact-application-and-runtime qualification for attended Clerk production,
  Lemon Squeezy test mode, and an attended Lemon Squeezy live canary against the intended live store
  and product; and
- a separately reviewed exact-candidate operational summary proving that every External Beta finding
  was resolved before candidate freeze, with separate passing operational, privacy, billing,
  recovery, and retirement evidence digests.

Each provider record carries only its released outcome, source revision, qualification and expiry
instants, and sanitized evidence digest. Hidden, missing, malformed, expired, stale, future-dated,
or revision-mismatched evidence denies the decision. No capability may borrow another capability's
digest, including OpenAI and Anthropic, and no capability or production-qualification summary or
record may reuse another retained digest. Currency is evaluated at the actual decision creation
instant. A missing or malformed provider summary produces a denied
artifact without echoing supplied content.

The separate production-provider summary carries exactly one Clerk production record, one Lemon
Squeezy test-mode record, and one attended live-canary record. Existing accounts and deterministic
CI do not count. The live record must prove the intended store and product through matching,
non-aliased sanitized reference digests, and every record must match the decision's exact application
and runtime revisions. The retained booleans are only an allowlisted summary of independently
reviewed evidence; they are not the source proof. The release workflow obtains the runtime and
expected live Store/Product digest authorities from its protected environment, never freely
supplied dispatch metadata.

Releasing both AI providers does not require a Founder to connect both. After release, Provider
Routing may use OpenAI only, Anthropic only, or both according to the Ready accounts that Founder
explicitly authorized. Bruno.Ai supplies neither funded capacity nor silent enrollment. Loss of one
provider's current qualification pauses only its dependent capability at a Safe Work Checkpoint;
the other provider and unrelated qualified work remain available.

## Persisted authority and public admission

The workflow artifact is not runtime authority by itself. After independent review, a mapped Bruno.Ai
Owner may use the protected operator seam to persist the sanitized, approved artifact:

```sh
BRUNO_FOUNDER_RELEASE_DECISION_OWNER_USER_ID=<mapped-owner-uuid> \
  bun run founder:release:import-decision \
  founder-contract-artifacts/founder-initial-general-release-decision.json
```

Run that command only in the intended protected deployment environment. It validates the artifact
digest, exact deployed application revision, protected runtime revision, expiry, exact five-capability
manifest, all separate evidence digests, current provider qualifications, and mapped Owner identity.
It never accepts source evidence, credentials, recordings, or provider responses. This repository
change does not run the command or assert that its missing real-world evidence exists.

Public availability configuration cannot admit anyone without this global database authority. Each
new public activation binds the exact `founder_release_decisions.id`; preexisting unbound rows remain
unbound and fail closed instead of inheriting later authority. A provider or capability regression
appends an immutable capability-scoped `hold`. Existing work that does not require a held capability
may continue, but new public admission remains closed. Recovery of an environment variable does not
erase the Hold: the mapped Owner must import a fresh complete approved artifact, which appends an
explicit `resume`. Per-Founder Owner, Trusted Preview, and External Beta decisions remain separate.

## Evidence minimization and retention

The workflow accepts only aggregate counts, exact timestamps, release outcomes, and SHA-256 digests
of separately reviewed evidence. The retained release summary excludes identities, recordings,
transcripts, credentials, prompts, and provider responses. Release evidence is retained for 90
days, recordings must be deleted within 30 days, and deidentified metrics are retained for 24
months. The attended summary must state that these controls were applied.

## Required rerun

First complete the independent provider acceptance runs against one exact application and runtime
candidate by following
[`CLERK_LEMON_SQUEEZY_PRODUCTION_QUALIFICATION.md`](CLERK_LEMON_SQUEEZY_PRODUCTION_QUALIFICATION.md).
Then resolve all External Beta findings before freezing the candidate. Conduct the fresh independent
moderated cohort and attended VoiceOver/TalkBack journeys without coaching, self/friend testing, or
facilitator rescue; separately review and sanitize the operational/privacy/billing/recovery/retirement
evidence; and dispatch the Founder Product Contract in `release` mode with only the four allowlisted
summaries and accessibility digests. General Release remains denied until that exact run emits
`outcome: approved` and the protected Owner import persists it for the matching deployed candidate.
