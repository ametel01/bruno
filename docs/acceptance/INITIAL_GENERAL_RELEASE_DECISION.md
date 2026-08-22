# Initial General Release Decision

## Decision: do not release

The Founder Operator is **not eligible for Initial General Release** on 20 August 2026. The exact
CI Founder Product Contract passes its automated unit and five-browser checks, but it is explicitly
`releaseEligible: false`: no attended VoiceOver/Safari or TalkBack/Chrome evidence is bound to the
candidate. There is also no completed eight-founder moderated-study summary. The provider tickets
resolved safely by keeping OpenAI, Google reading, Gmail sending, and Anthropic unreleased after
their production preflights could not run.

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
  phone-first, all completing a cross-device day-two task;
- at least seven independently activating, acting on a Lead-to-Client item, and recovering from an
  interruption, plus at least seven reaching the first brief within 15 minutes of Active Founder
  Time;
- all eight correctly explaining access, AI processing, authority, disconnect, Bruno deletion, and
  provider deletion;
- zero permission/safety failures, unintended effects, unsafe misunderstandings, technical setup
  requirements, or Founder credential handling;
- independent exact-revision released evidence for OpenAI, Anthropic, Calendar reading, Gmail
  reading, and one-to-one Gmail sending.

Each provider record carries only its released outcome, source revision, qualification and expiry
instants, and sanitized evidence digest. Hidden, missing, malformed, expired, stale, future-dated,
or revision-mismatched evidence denies the decision. No capability may borrow another capability's
digest, including OpenAI and Anthropic. A missing or malformed provider summary produces a denied
artifact without echoing supplied content.

Releasing both AI providers does not require a Founder to connect both. After release, Provider
Routing may use OpenAI only, Anthropic only, or both according to the Ready accounts that Founder
explicitly authorized. Bruno.Ai supplies neither funded capacity nor silent enrollment. Loss of one
provider's current qualification pauses only its dependent capability at a Safe Work Checkpoint;
the other provider and unrelated qualified work remain available.

## Evidence minimization and retention

The workflow accepts only aggregate counts, exact timestamps, release outcomes, and SHA-256 digests
of separately reviewed evidence. The retained release summary excludes identities, recordings,
transcripts, credentials, prompts, and provider responses. Release evidence is retained for 90
days, recordings must be deleted within 30 days, and deidentified metrics are retained for 24
months. The attended summary must state that these controls were applied.

## Required rerun

First complete the independent provider acceptance runs against one exact candidate. Then conduct
the moderated cohort and attended VoiceOver/TalkBack journeys without facilitator rescue, review and
sanitize the source evidence, and dispatch the Founder Product Contract in `release` mode with only
the two allowlisted summaries and accessibility digests. General Release remains denied until that
exact run emits `outcome: approved`.
