# Founder Operator Release Stages

This policy defines who may access Bruno.Ai as it moves from owner learning to its first public
offer. It does not declare that any stage has been entered; every transition requires a separate
Release Decision for an exact candidate.

Release Stage is independent of operating level. Limited Operation and Core Operation describe what
an individual Founder can use; a Release Stage describes who may access the currently qualified
capabilities.

## Stage contract

| Stage | Audience | Available capability | Required operating period | Evidence role |
| --- | --- | --- | --- | --- |
| Owner Preview | The single person who owns and builds Bruno.Ai | Preview-qualified OpenAI and Calendar-only Limited Operation | At least seven consecutive days | Learning Round only |
| Trusted Preview | At most three personally trusted contacts operating Founder-led Service Businesses | Preview-qualified OpenAI and Calendar-only Limited Operation; Gmail and Anthropic remain hidden | Until at least two participants complete the required journeys | Learning Round only |
| External Beta | Five to ten directly invited independent Nontechnical Founders outside the build team and close trust circle | External-Beta-qualified OpenAI, Anthropic, Calendar reading, Gmail reading, and one-to-one Gmail sending | At least 14 consecutive days, with at least five recurring Lead-to-Client Loops completed | Product-hardening evidence only |
| Initial General Release | Any eligible Founder-led Service Business without personal selection | Independently released OpenAI and Anthropic, Core Operation, and proven one-to-one sending; an individual Founder may connect either or both providers and may keep Sending Off | Governed by the current release and evidence cadence | Founder Acceptance Evidence |

Transparent capacity, geography, or waitlist limits do not make Initial General Release
invitation-only. Personal selection or Calendar-only operation does.

## Commercial boundary

Owner Preview, Trusted Preview, and External Beta are free. External Beta remains closed: testers
receive direct invitations, and no public signup or open-admission path grants access. Beta access
does not automatically convert into a paid subscription.

Initial General Release is a paid product without a permanent free tier. Signup, provider
connection, and setup waiting are not charged. The subscription begins only after Founder
Activation and a fresh Founder decision to join the published offer, with a clear 14-day refund
window.

Bruno.Ai provisions an Initial General Release Droplet only after Clerk authentication, at least one
Ready AI Connection, the Founder-selected required Company Connections and consents, and an explicit
`Create my Operator` decision. The Founder has 24 hours from authoritative Droplet creation to reach
Founder Activation. If activation does not occur, work stops, any durable state is archived, and
Infrastructure Retirement is due within one hour.

Founder Activation stops new Operator work and presents the published paid offer. The activated
Founder may inspect the first brief and choose whether to subscribe, but the Droplet is held for no
more than 24 hours without a verified Product Entitlement. If the Founder does not subscribe in that
window, Bruno.Ai archives durable state and retires the infrastructure. Signup, setup, and the first
brief remain free.

External Beta testers receive no secret or negotiated price and do not convert automatically. Any
beta-alumni credit must be public, time-limited, consistently available, and unrelated to feedback or
testimonial consent.

Before purchase, Bruno.Ai distinguishes its subscription price from the Founder's separate OpenAI or
Anthropic subscription or usage costs. Bruno.Ai never presents a blended price or implies that its
subscription includes AI-provider capacity.

## Identity, commerce, and entitlement

Clerk is the Identity Provider and proves Founder identity and session state. Lemon Squeezy is the
Commerce Provider and Merchant of Record for checkout, payments, refunds, and subscription state.
Bruno.Ai remains authoritative for invitations, Release Stage admission, internal Owner mapping,
Product Entitlements, business authority, and product-data lifecycle.

A valid Clerk session does not grant Operator access. During a closed stage Bruno.Ai also requires an
accepted applicable invitation; after Initial General Release it requires an eligible Product
Entitlement for continued paid operation.

Bruno.Ai creates a single-use Checkout Correlation bound locally to the authenticated internal Owner
and passes only that opaque value through Lemon Squeezy custom checkout data. Checkout email, Clerk
identifier, redirect parameters, and browser success state never establish ownership or entitlement.

Checkout return pages remain in a Founder-readable confirming-payment state. Bruno.Ai grants a
Product Entitlement only after a signature-verified Lemon Squeezy event is idempotently recorded,
matched to the Checkout Correlation, and reconciled against current provider state.

If payment succeeds but Bruno.Ai cannot establish Product Entitlement within one hour, Bruno.Ai
issues a full refund and retires any Droplet. A delayed or reordered event after that boundary cannot
restore the entitlement; paid operation requires a fresh checkout decision.

Bruno.Ai uses Lemon Squeezy's signed hosted Customer Portal for payment-method updates, billing
history, cancellation, and eligible resumption. Initial General Release does not expose plan
switching or customer-initiated subscription pausing until their Product Entitlement consequences
are separately released.

The application requests a fresh signed portal URL only after authenticating the internal Owner and
checking a current `verified`, in-window `past_due`, or paid-through `cancelled` Product Entitlement.
It rechecks that authority before redirecting and records only an immutable digest plus portal expiry,
never the signed URL. The Lemon Squeezy Customer Portal configuration for Initial General Release
must expose payment methods, billing history, cancellation, and eligible resumption while leaving
plan switching and customer-initiated pausing disabled.

Losing or deleting a Clerk identity does not cancel commerce or delete Bruno.Ai data. It creates an
identity-recovery problem. Only recently reauthenticated Account Closure coordinates external-action
pause, Lemon Squeezy cancellation, connection revocation, Bruno Data Deletion, and receipts; refunds
remain a separate policy decision.

A signature-verified Clerk `user.deleted` event records an `identity_loss_recorded` receipt and
denies Operator access while the recovery is pending. Recovery requires a short-lived server-signed
assertion bound to the same internal Owner plus exact prior and replacement Clerk-subject digests.
Email, checkout metadata, possession of a new Clerk account, or an authenticated session are not
ownership proof. Failed takeover attempts record `recovery_denied`; a successful same-Owner rebind
records `identity_rebound`. These receipts never represent commerce cancellation, Product
Entitlement change, refund, Infrastructure Retirement, Recovery Archive deletion, Bruno Data
Deletion, or Account Closure.

Before Initial General Release, billing qualification must prove live checkout, activation-timed
charging, failed payment, cancellation, refund, entitlement reconciliation, duplicate and reordered
delivery, cross-device state, receipts, and payment-without-access recovery.

Provider qualification also requires an attended production Clerk run plus Lemon Squeezy test-mode
and live-mode runs. The live canary proves one real charge, signed webhook processing, Product
Entitlement, Customer Portal access, cancellation, full refund, duplicate and reordered delivery,
reconciliation, and sanitized cleanup. Existing provider accounts do not satisfy these gates. The
allowlisted evidence handoff and exact application/runtime binding are defined in
[`CLERK_LEMON_SQUEEZY_PRODUCTION_QUALIFICATION.md`](CLERK_LEMON_SQUEEZY_PRODUCTION_QUALIFICATION.md).

## Entitlement expiry and infrastructure cost

A DigitalOcean Droplet remains billable while powered off, so stopping an Operator does not end
Bruno.Ai's infrastructure cost. Product Entitlement transitions therefore use explicit deadlines:

- `past_due` retains operation during a disclosed payment-recovery window of no more than seven days;
- `unpaid` stops new work immediately and requires Infrastructure Retirement within 24 hours;
- `cancelled` retains operation through the paid `ends_at` boundary and retires infrastructure then;
- `expired` requires Infrastructure Retirement within one hour of verified expiry;
- a full refund ends Product Entitlement, stops new work immediately, and requires Infrastructure
  Retirement within 24 hours; and
- duplicate, delayed, or reordered commerce events never restart or extend a retirement clock.

Founder surfaces project these states separately: payment recovery with its exact deadline,
cancelled-through with the paid `ends_at`, stopped new work with retirement due or in progress, and
completed Infrastructure Retirement after provider absence is verified. Cancellation and full
refund create immutable Commerce Lifecycle Receipts; Infrastructure Retirement and Account Closure
continue to use their own decisions and receipts.

The deterministic Founder Product Contract includes required `subscription_lifecycle` and
`identity_recovery_lifecycle` scenarios. The subscription scenario exercises the signed hosted
portal boundary and its exact allowed/forbidden actions, all recovery and terminal deadlines,
cancellation through paid `ends_at`, and the rule that reordered active events cannot restart
terminal clocks. The identity scenario proves loss denial, takeover denial, same-Owner rebound,
separate truthful receipts, unchanged commerce/Product Entitlement/infrastructure/archive state,
and a later explicit Account Closure as the sole destructive coordinator. Deterministic evidence
does not prove live Clerk or Lemon Squeezy configuration; attended provider qualification remains
required before release.

Before retirement, Bruno.Ai creates and verifies an encrypted off-Droplet Recovery Archive containing
the minimum durable Operator state needed to rebuild. It excludes raw provider credentials, expires
after 30 days, and is distinct from a manual backup manifest or a billable DigitalOcean snapshot.
Owner Preview and every later stage must maintain a verified daily Recovery Archive. A
verified-restorable archive is therefore an Owner Preview admission gate, not a later billing
enhancement. Retirement attempts one emergency refresh but may not extend the destruction deadline
by more than 24 hours.

Infrastructure Retirement verifies the exact owned resource set, disables runtime credentials,
deletes the firewall and Droplet, and rechecks authoritative provider absence. An Infrastructure
Retirement Receipt remains in progress until no billable runtime resource remains. Ambiguous identity,
unknown provider outcome, and failed cleanup retry idempotently against the same exact resource and
never broaden deletion scope. The receipt freezes the complete provider identity before deletion,
records work stoppage and the emergency archive outcome, and measures the billable interval from
DigitalOcean's resource creation time through the final authoritative absence observation. Local
assignment, idle, stopped, or powered-off state does not end that interval while the Droplet remains
present at DigitalOcean.

If no valid Recovery Archive can be produced by the hard deadline, Bruno.Ai still destroys the
Droplet and records a critical preservation failure truthfully. During the 30-day retention window,
a new payment may provision a new Droplet and restore the same logical Operator after provider
reauthorization. Restoration does not preserve an IP address or infrastructure identity; failed
restoration requires a refund. After archive expiry, rejoining creates a new Operator environment.
Archive expiry automatically deletes the Recovery Archive and any recovery-only credentials and
produces a Recovery Archive Deletion Receipt. Provider/runtime credentials that can no longer serve
an entitled Operator are revoked. Bruno-local business records continue under their ordinary
retention policy unless the Founder chooses Account Closure.

Runtime cost is measured from authoritative DigitalOcean resource creation until Infrastructure
Retirement proves destruction. Agent activity, stopped work, reported uptime, and local assignment
state cannot make an existing Droplet disappear from cost accounting.

## Safety, data, and support

Every stage uses the same production-grade authority, privacy, retention, deletion, isolation, and
external-effect safeguards. Earlier stages narrow audience and capability, never safeguards.

Participants may connect genuine company accounts only inside their own isolated environment after
the applicable qualification, consent, disclosure, deletion, and Restricted Data guardrails pass.
No participant account may be used as another participant's fixture.

Owner Preview is fully attended. Trusted Preview permits attended onboarding and observation.
External Beta onboarding and ordinary use are self-serve, with reactive support only after a problem
occurs. Initial General Release uses ordinary product support. Support activity does not become or
upgrade release evidence.

## External Beta admission

Each External Beta tester receives an External Beta Invitation bound to one named Founder and one
workspace. It is nontransferable and expires after seven days if unaccepted. Replacement or renewed
invitation after non-acceptance requires a deliberate invitation decision.

Before access begins, the invited Founder accepts a short, plain-language Beta Compact covering the
non-extendable 14-day window, expected instability, exact available capabilities, support boundary,
company-data handling, feedback commitment, withdrawal, export, and deletion. No nondisclosure
agreement is required by default.

Bruno.Ai may publicly describe the closed beta and collect expressions of interest. An expression of
interest grants no access and does not create an invitation.

External Beta access ends after 14 days and cannot be extended or renewed for that Founder. Work
stops and Infrastructure Retirement is due within one hour; participant data is not deleted
automatically. The Founder may export or delete retained Bruno-local data or later join Initial
General Release through a fresh paid decision. A new payment inside the Recovery Archive retention
window may restore the same logical Operator under the recovery rules above. If the cohort does not
satisfy its promotion gate, Bruno.Ai holds promotion and recruits a new invited cohort rather than
extending existing participants.

## Measurement and disclosure

External Beta measurement is limited to allowlisted operational facts: activation, journey
completion, timing, capability state, safe failure category, and support duration. Analytics must
not contain message bodies, calendar content, recipients, prompts, provider responses, or
unrestricted metadata.

Recordings require separate opt-in and deletion within 30 days. Beta Compact acceptance grants no
feedback, testimonial, identity, name, logo, quotation, case-study, or other marketing consent; each
use requires a separate specific decision and cannot be presented as General Release proof.

The product starts External Beta measurement opted out. It accepts only six static event shapes:
activation completion, allowlisted journey completion or timing, allowlisted capability state,
allowlisted safe failure category, and support duration. It rejects unknown event names and
properties before persistence; no autocapture, session replay, person profile, shared participant
identity, message or Calendar content, recipient, prompt, provider response, credential, or
unrestricted metadata path is permitted. Every accepted fact remains bound to the admitted
participant, Operator, and invitation workspace and is permanently classified as product-hardening
evidence.

Measurement, recording, testimonial, identity, name, logo, quotation, and case-study purposes each
have their own append-only consent decision. Refusal or withdrawal changes only that purpose and
cannot change External Beta admission or its 14-day window. Recording deletion stays pending until
the configured object provider verifies absence no later than the exact 30-day deadline. The
retention worker records a verified late deletion as a terminal `deleted_late` breach receipt and
fails its scheduled run for operator attention; a retry can never strand a provider-deleted artifact
in active state merely because the deadline has passed. Recording cleanup and Infrastructure
Retirement run independently, and the internal scheduler reports both outcomes when either fails.
Founder-visible External Beta privacy controls show the allowlist and exclusions, permit every
purpose to be allowed, refused, or withdrawn separately, and provide a bounded privacy export and
measurement deletion.

Every External Beta surface must identify the stage and show the remaining access window, available
and unavailable capabilities, support boundary, and withdrawal, export, and deletion controls.
Bruno.Ai never presents External Beta as generally released.

## Qualification boundaries

Preview Qualification is owner- or cohort-scoped, bound to exact application and runtime revisions,
short-lived, and fail-closed. It must prove safe authorization, real use, recovery, revocation,
provider disclosure, and cleanup for only the named provider capability and stage.

Preview Qualification never bypasses a provider gate and cannot be consumed as Connected Acceptance
or Founder Acceptance Evidence. Gmail reading and Gmail sending qualify independently. Anthropic is
hidden during Owner Preview and Trusted Preview, but both Anthropic and OpenAI must qualify for
External Beta and pass Connected Acceptance before Initial General Release.

The External Beta boundary persists one record per capability with the named cohort, exact
application and runtime revisions, sanitized evidence digest, observation time, and expiry. The
admission manifest is all-or-nothing, while post-admission capability status remains independent so
one lost qualification can pause only its affected work. Founder-facing status uses Available and
Paused labels and does not expose candidate revisions, evidence digests, provider internals, or
runtime configuration.

## Promotion authority

Elapsed time, participant count, telemetry, and prior-stage completion never promote Bruno.Ai
automatically. A Release Decision must explicitly enter, deny, hold, or resume a stage and bind:

- the exact application revision;
- the exact Operator and runtime revisions;
- the complete capability manifest;
- the applicable qualification and acceptance evidence digests; and
- the named stage and decision outcome.

Missing, stale, mismatched, or incomplete evidence denies promotion.

A critical failure or expired qualification creates a Release Hold. Bruno.Ai stops new admissions
and only the affected unsafe capability, preserves accounts and Safe Work Checkpoints, and requires
a new exact-revision Release Decision to resume. It does not silently demote a stage or erase state.

Participants retain completed onboarding and eligible retained state as stages advance, with fresh
consent required for newly introduced capability boundaries. Their evidence classification never
changes: trusted contacts remain Learning Round participants, and coached beta testers never become
fresh Founder Usability Acceptance participants.

## Owner Preview to Trusted Preview

The Owner must complete at least seven consecutive days of use, including desktop and phone
activation, daily briefs, interruption recovery, reauthorization, disconnect, export, and deletion.
No Critical Founder Acceptance Failure or release-blocking defect may remain unresolved.

This is operational learning and cannot satisfy General Release evidence.

## Trusted Preview to External Beta

At least two trusted participants must independently complete activation, recurring use, authority,
recovery, and privacy journeys. Every critical or release-blocking finding must be resolved.

OpenAI, Anthropic, Calendar reading, Gmail reading, and Gmail sending must then independently pass
Preview Qualification against the exact External Beta candidate before any external participant is
admitted.

## External Beta to Initial General Release

External Beta must run with five to ten independent Founders for at least 14 consecutive days, with
at least five completing the recurring Lead-to-Client Loop. Its ordinary usage remains
product-hardening evidence and cannot satisfy Founder Usability Acceptance.

After beta findings are resolved, Bruno.Ai freezes an exact candidate and recruits eight fresh
independent Nontechnical Founders. Experienced Owner, Trusted Preview, or External Beta participants
cannot enter that cohort. Initial General Release requires the Deterministic Product Contract,
Connected Acceptance for every released provider capability, attended accessibility evidence,
Founder Usability Acceptance, operational evidence, and sanitized evidence controls to pass
together for that candidate.

## Provider choice and degradation

Initial General Release requires both OpenAI and Anthropic to be available, but a Founder may connect
either or both. Bruno.Ai routes only among explicitly connected providers and never silently enrolls
a provider or uses Bruno-funded capacity.

After Initial General Release, loss of one provider's qualification appends an immutable Hold scoped
to that provider's dependent capability. Existing work remains at Safe Work Checkpoints and
unaffected capabilities stay available to already bound, entitled Founders. New public admission is
closed until a fresh complete exact-candidate decision appends an explicit Resume; provider
configuration recovering by itself never erases the Hold.
