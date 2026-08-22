# Bruno.Ai Operations

This context defines the language used to describe how a Founder directs Bruno.Ai and how Bruno.Ai
is made usable for its Owner.

## Language

### Product roles

**Founder**:
The customer-facing commercial decision-maker of a founder-led microbusiness. The business may
have a small delivery team, but in the initial product one Founder maps to exactly one Owner and is
the only person who controls Bruno.Ai.
_Avoid_: User, tenant, account

**Nontechnical Founder**:
A Founder who is comfortable using ordinary web applications and attended account connections but
does not want to manage APIs, models, credentials, servers, or automation infrastructure. The term
does not imply low business sophistication or poor digital literacy.
_Avoid_: Beginner, unsophisticated user

**Founder-led Service Business**:
An early-revenue or established microbusiness that sells expertise or recurring services through
high-trust client relationships and has no dedicated sales or operations function. Consultants,
coaches, and boutique agencies are representative examples.
_Avoid_: Ecommerce operation, developer-led SaaS, large sales team

**Lead-to-Client Loop**:
The commercial operating loop that captures a relationship, identifies its next action, follows
up, prepares and records meetings, advances a proposal, onboards the client, and prevents a
commitment from being forgotten.
_Avoid_: Sales funnel, generic workflow

**Founder Morning Brief**:
An evidence-backed daily view of who needs a response, which meeting needs preparation, which lead
or client has an overdue confirmed commitment, and which proposed Bruno.Ai action needs the
Founder's decision. The first brief is generated when selected evidence becomes current; later
briefs default to 7:00 AM Founder local time and may use a Founder-selected delivery time.
_Avoid_: Analytics dashboard, activity feed

**Brief Evidence Window**:
The bounded Company Source Data considered for a Founder Morning Brief: Calendar from 24 hours ago
through seven days ahead and Mail from the preceding 14 days. A brief opened after material source
change refreshes against the current window; its generated content is retained for 90 days.
_Avoid_: Historical import, mailbox archive

**Brief Attention Rule**:
A deterministic business condition supporting a Morning Brief item: an unanswered latest inbound
message, an external meeting within 24 hours, an overdue confirmed Relationship Record action or
commitment, or a Proposed Action awaiting decision. AI may explain and prioritize matching evidence
but does not invent the rule.
_Avoid_: Model judgment, engagement score

**Verified Quiet Brief**:
A Founder Morning Brief stating that nothing needs attention only after every selected evidence
check is Current and no Brief Attention Rule matches.
_Avoid_: Empty result, no generated items

**Relationship Candidate**:
A proposed Relationship Record grouped automatically only by an exact provider identity or email.
Fuzzy name, company, or domain similarity requires Founder confirmation before records are merged.
_Avoid_: Inferred contact, automatic CRM entry

**Founder Setup Complete**:
The state in which at least one Founder AI Connection and one Company Connection are ready, their
Processing Consent is confirmed, and the safe Authority Policy is in force. It is not itself
Founder activation.
_Avoid_: Deployment ready, account created

**Limited Operation**:
The operating level available after Founder Setup Complete with either Calendar or Mail evidence.
It provides only the outcomes supported by the selected Company Connection.
_Avoid_: Trial mode, incomplete deployment

**Core Operation**:
The operating level available when a Ready AI Connection can use both Calendar and Mail from the
Primary Communications Suite under confirmed Processing Consent and Authority Policy.
_Avoid_: Fully configured agent, all integrations connected

**Release Stage**:
An ordered boundary defining who may access the currently qualified Bruno.Ai capabilities. It is
independent of whether an individual Founder has Limited Operation or Core Operation.
_Avoid_: Capability tier, operating level, readiness claim

**Release Decision**:
An explicit, immutable decision to enter, deny, hold, or resume one Release Stage, bound to exact
application and runtime revisions, a capability manifest, and sanitized evidence digests.
_Avoid_: Feature flag, elapsed-time promotion, readiness claim

**Release Hold**:
An explicit pause on new admission and unsafe affected capabilities after a critical failure or
expired qualification. It preserves participant state and requires a new Release Decision to resume.
_Avoid_: Silent demotion, automatic rollback, account deletion

**Preview Qualification**:
Short-lived, exact-revision safety evidence allowing one provider capability for a named preview
cohort. It cannot satisfy Connected Acceptance or Founder Acceptance Evidence.
_Avoid_: Release evidence, preview bypass, provider availability

**Learning Round**:
An Owner or trusted-contact evaluation used to discover defects and refine the Founder journey. Its
self-testing or friend-test observations do not satisfy Founder Acceptance Evidence.
_Avoid_: Release evidence, usability acceptance, founder cohort

**Owner Preview**:
The first Release Stage, restricted to the person who owns and builds Bruno.Ai and limited to
preview-qualified OpenAI with Calendar-only Limited Operation. Its use is a Learning Round.
_Avoid_: Internal release, Founder preview, General Release evidence

**Trusted Preview**:
The invitation-only Release Stage for at most three personally trusted contacts who operate
Founder-led Service Businesses. Attended use is allowed and remains a Learning Round.
_Avoid_: Private beta, usability acceptance, independent founder cohort

**External Beta**:
The closed, free Release Stage for invited independent Nontechnical Founders outside the build team
and close trust circle, using their own company accounts after both initial AI providers and the
full release capability set are independently beta-qualified. Ordinary use is not release evidence.
_Avoid_: Friend test, public release, acceptance by usage

**External Beta Invitation**:
A nontransferable, seven-day admission offer bound to one named Founder and one workspace. An
expression of interest does not create an invitation or access.
_Avoid_: Signup link, transferable access, waitlist admission

**Beta Compact**:
The plain-language agreement covering External Beta's non-extendable 14-day duration, instability,
capabilities, support, company-data handling, feedback, withdrawal, export, and deletion before
access begins.
_Avoid_: NDA, production SLA, marketing consent

**Identity Provider**:
Clerk, which proves Founder identity and session state without granting Release Stage admission,
product entitlement, business authority, or data ownership.
_Avoid_: Owner registry, entitlement source, access policy

**Commerce Provider**:
Lemon Squeezy, which acts as Merchant of Record for checkout, payments, refunds, and subscription
state without deciding who may use Bruno.Ai.
_Avoid_: Identity provider, entitlement authority, product access

**Checkout Correlation**:
A one-time opaque reference binding one checkout attempt to an internal Owner without exposing or
trusting a Clerk identifier, checkout email, redirect parameter, or browser success state.
_Avoid_: Email match, Clerk ID, checkout session

**Product Entitlement**:
Bruno.Ai's verified decision that an authenticated Owner may continue paid product operation,
derived from reconciled Commerce Provider evidence and never from a checkout redirect alone.
_Avoid_: Clerk session, payment success page, subscription webhook

**Commerce Lifecycle Receipt**:
An immutable Founder-commerce record proving that Bruno.Ai issued a short-lived signed Customer
Portal link or reconciled a cancellation or full refund. It never substitutes for an Infrastructure
Retirement Receipt or Account Closure receipt and never stores the signed portal URL itself.
_Avoid_: Subscription webhook, Infrastructure Retirement Receipt, Account Closure receipt

**Recovery Archive**:
An encrypted, verified-restorable copy of the minimum durable Operator state held outside its
Droplet for bounded recovery. It excludes raw provider credentials and expires after 30 days.
_Avoid_: Droplet snapshot, manual backup manifest, permanent archive

**Infrastructure Retirement**:
The entitlement-driven destruction of one exact owned Droplet and its firewall after a bounded
recovery archive attempt. It stops runtime cost without constituting Account Closure or data deletion.
_Avoid_: Power off, agent deletion, subscription cancellation

**Infrastructure Retirement Receipt**:
The Founder-readable record that remains in progress until runtime work has stopped, archive outcome
is recorded, runtime credentials are disabled, and authoritative provider checks prove no billable
runtime resource remains.
_Avoid_: Delete request, successful API response, Account Closure receipt

**Recovery Archive Deletion Receipt**:
The durable record proving that an expired Recovery Archive and its recovery-only credentials were
deleted at the end of their retention window. It does not claim deletion of Bruno-local business
records governed by ordinary retention or Account Closure.
_Avoid_: Account Closure receipt, Infrastructure Retirement Receipt, archive expiry timestamp

**Initial General Release**:
The first public self-serve Bruno.Ai offer, requiring independently released OpenAI and Anthropic,
Core Operation, and proven one-to-one sending. A Founder may choose either or both AI providers and
keep Sending Off; transparent capacity, geography, or waitlist limits are allowed.
_Avoid_: Calendar preview, AI-ready pilot

**First Brief Ready**:
The state in which Bruno.Ai has checked the selected company evidence and produced the first
Founder Morning Brief, including a verified nothing-needs-attention result when appropriate.
_Avoid_: Sync complete, setup complete

**Founder Activation**:
The milestone reached when the Founder opens the first evidence-backed Founder Morning Brief and
encounters either a supported business item or a verified nothing-needs-attention result.
_Avoid_: Sign-up, provider connected, runtime ready

**Founder Onboarding**:
The durable journey from account creation through Operator Preparation, Hermes AI Setup,
Founder-selected Company Connections, confirmed consent and authority, and the first Founder
Morning Brief. It resumes at the first unmet verified condition rather than restarting completed
work.
_Avoid_: Agent creation wizard, deployment progress

**Capability Degradation**:
A reduction in only the business outcomes dependent on an unavailable AI or Company Connection.
Unrelated ready capabilities and completed onboarding evidence remain usable.
_Avoid_: Setup failure, Bruno.Ai offline

**Bruno.Ai Operator**:
The single customer-visible operating counterpart responsible for company work. Internal agents,
models, and runtimes do not create separate customer-visible operators.
_Avoid_: Agent roster, agent fleet

**Operator Preparation**:
The automatic work that begins after a Founder explicitly chooses to create the Operator and
establishes the isolated Hermes environment required by the Bruno.Ai Operator. It is not Founder
activation and does not require the Founder to name or configure an agent.
_Avoid_: Agent creation, deployment setup

**Prepared Operator**:
A Bruno.Ai Operator whose isolated persistent Hermes environment, structured provider surfaces,
runtime transport, and mandatory safety invariants are verified. No external messaging channel is
required, and this internal state is neither Founder Setup Complete nor Founder Activation.
_Avoid_: Ready Deployment, Telegram ready

**Bruno Conversation**:
The built-in private messaging relationship between a Founder and the Bruno.Ai Operator. It is
available without configuring an external messaging service; its transcript is Working Context,
not the permanent company record.
_Avoid_: Telegram bot, messaging integration

**Company Source Data**:
Mail, calendar, or later supported company content that remains authoritative in its connected
provider. Bruno.Ai retrieves it only through selected Connection Resources and does not create a
general archive of it.
_Avoid_: Synced company database, imported mailbox

**Working Context**:
The temporary Bruno Conversation transcript and bounded source evidence retained to continue active
work. Its full content is retained for 90 days; Founder-confirmed business state and durable
decisions are recorded separately.
_Avoid_: Company record, permanent memory

**Retained Business Evidence**:
The minimum source pointer, excerpt, or generated content needed to support a Relationship Record,
Founder Morning Brief, Proposed Action, or Action Receipt without copying the underlying source.
_Avoid_: Source-data archive, full synchronization

**Evidence Tombstone**:
A content-free record that preserves the occurrence, identity, time, and erasure reason of durable
evidence after its sensitive content is deleted.
_Avoid_: Deleted receipt, retained content

**Troubleshooting Evidence**:
Sanitized technical evidence retained for 14 days, or through an explicitly Founder-approved
support case and no later than 30 days after that case closes.
_Avoid_: Product history, permanent logs

**Bruno Data Deletion**:
An explicit erasure request that stops access immediately, removes content from active Bruno.Ai
systems within seven days, and expires encrypted backup copies within 30 days.
_Avoid_: Disconnect, soft delete, provider deletion

**Deletion Request**:
A Founder-reviewed description of the exact data and dependent work Bruno Data Deletion will
remove or cancel. Bruno Conversation may prepare it, but recent Founder reauthentication is
required to authorize it.
_Avoid_: Delete command, conversational instruction

**Deletion Receipt**:
A Founder-readable record that remains in progress until it separately confirms access stopped,
active systems purged, and backup copies expired; provider revocation is reported independently.
_Avoid_: Deletion confirmation, support ticket

**Founder Data Export**:
A Founder-only, recently reauthenticated download of retained Bruno.Ai business data in readable
HTML and portable JSON. It excludes credentials, provider source archives, and raw technical logs
and expires after 24 hours.
_Avoid_: Mailbox export, backup download

**Provider Processing Disclosure**:
The current factual account of which AI or company provider processed selected data, when it was
last used, and its verified settings, known retention, and unresolved limitations.
_Avoid_: Universal privacy promise, Bruno retention policy

**Privacy Center**:
The Founder-facing control surface for connected accounts, retained Bruno.Ai data, Provider
Processing Disclosures, Founder Data Export, Deletion Requests, and Account Closure.
_Avoid_: Technical settings, compliance dashboard

**Restricted Data**:
Secrets, payment or bank credentials, government identifiers, medical records, children's data,
and regulated or privileged case files that Bruno.Ai does not intentionally process at launch.
_Avoid_: Supported sensitive data, guaranteed detection

### Founder-experience acceptance

**Founder Acceptance Evidence**:
The release evidence that independently combines a Deterministic Product Contract, Connected
Acceptance, and Founder Usability Acceptance. No one evidence class substitutes for another.
_Avoid_: Green build, successful demo, stakeholder sign-off

**Deterministic Product Contract**:
Automated evidence that Bruno.Ai preserves its founder-facing state, authority, privacy, failure,
accessibility, and negative-interface invariants at an exact release revision. It covers current
Chrome, Safari/WebKit, and Firefox on desktop and iOS Safari and Android Chrome on phone, and passes
only when every required invariant succeeds without a rerun concealing failure.
_Avoid_: Mocked integration proof, unit-test coverage

**Acceptance Invariant Matrix**:
The required deterministic coverage for resumability and deduplication, Limited and Core Operation,
capability degradation, canonical cross-device decisions, exactly-once and uncertain effects,
retention and privacy controls, support recovery, and excluded technical or sensitive surfaces.
_Avoid_: Test plan, coverage percentage

**Connected Acceptance**:
Evidence from real provider authorization and effect boundaries using isolated accounts populated
only with representative synthetic company data. It proves only the providers and capabilities
actually exercised and includes one approved one-to-one message delivered exactly once to a
controlled synthetic recipient with provider acknowledgement and an Action Receipt.
_Avoid_: Simulated OAuth, production-customer test

**Provider Acceptance Gate**:
The release boundary requiring every AI, Calendar, or Mail capability shown as available to pass
its applicable real authorization, identity, persistence, live-use, degradation, revocation, and
reauthorization evidence. An unproven provider remains hidden without blocking a proven provider.
_Avoid_: Compatibility claim, provider beta badge

**Founder Usability Acceptance**:
Observed evidence from eight independent Nontechnical Founders who match the initial customer
archetype and were not involved in building Bruno.Ai. It passes only when at least seven activate
and complete the core action and recovery journeys without facilitator instruction, all eight pass
the required authority and privacy teach-back, and no Critical Founder Acceptance Failure occurs.
_Avoid_: Internal dogfooding, satisfaction survey

**Active Founder Time**:
The time a Founder actively spends progressing the journey, measured separately from provider or
organizational-administrator waiting. Founder Usability Acceptance requires at least seven of eight
participants to reach the first evidence-backed brief within 15 minutes of Active Founder Time.
_Avoid_: Wall-clock setup time, provider wait time

**Critical Founder Acceptance Failure**:
An unintended external effect, unsafe approval caused by misunderstanding, exposed technical
configuration requirement, facilitator handling of credentials, or failure to distinguish access,
processing consent, authority, disconnect, and deletion. One occurrence fails Founder Usability
Acceptance regardless of aggregate task completion.
_Avoid_: Usability friction, wrong turn

**Cross-device Founder Acceptance**:
Evidence from four desktop-first and four phone-first activation journeys, with every participant
then completing a day-two authority task on the other form factor. It proves shared decision state,
not merely responsive rendering.
_Avoid_: Responsive screenshot, viewport smoke test

**Accessible Founder Acceptance**:
Evidence that the core brief, conversation, approval, privacy, and recovery journeys satisfy
automated WCAG 2.2 AA checks and can be completed keyboard-only on desktop and with VoiceOver on
Safari and TalkBack on Chrome.
_Avoid_: Accessibility score, visual review

**Acceptance Evidence Bundle**:
The sanitized, reproducible record binding an acceptance result to the exact application revision,
environment, runtime release, provider capability, browser and viewport, scenario outcome, cleanup
outcome, and evidence digest. Its allowlist excludes credentials, authorization codes, message
bodies, recipients, prompts, raw provider responses, unrestricted metadata, and infrastructure IDs.
_Avoid_: Screenshot, branch-level test result

**Acceptance Failure Scope**:
A Deterministic Product Contract failure or Critical Founder Acceptance Failure blocks the entire
release. Before Initial General Release, missing OpenAI or Anthropic blocks promotion; afterward, a
provider-specific failure blocks only that provider or capability and preserves proven paths.
_Avoid_: Best-effort acceptance, all-provider release block

**Provider Evidence Incident**:
The incident opened when a scheduled live-provider smoke loses verified capability. Bruno.Ai stops
offering new affected connections while preserving existing connection state, avoids silent
rerouting, and restores availability only after renewed Connected Acceptance.
_Avoid_: Automatic disconnect, provider fallback

**Acceptance Cadence**:
Deterministic evidence runs for every release candidate; Connected Acceptance runs before production
promotion and after relevant provider-boundary changes, with a weekly synthetic-provider smoke.
Founder Usability Acceptance reruns before initial release and after material founder-journey changes.
_Avoid_: One-time certification, every-commit usability study

**Acceptance Evidence Retention**:
Sanitized machine evidence is retained for 90 days, consented raw usability recordings for no more
than 30 days, and deidentified task metrics and findings for 24 months.
_Avoid_: Permanent research archive, product-data retention

**Implementation Handoff**:
The Wayfinder milestone reached when the founder-experience product contract and its acceptance
requirements are decision-complete enough to become implementation work. It does not claim the
unimplemented experience has passed Founder Acceptance Evidence or is ready for release.
_Avoid_: Release approval, acceptance passed

**Acceptance Fixture**:
An isolated real provider account containing representative synthetic mail, calendar, relationship,
and commitment evidence that can be reset and whose retained test data is verified deleted after
each acceptance run.
_Avoid_: Mock account, participant company data

**Founder Acceptance Journey**:
A mandatory end-to-end scenario proving incremental activation, evidence-backed value, one exact
external effect, honest empty results, capability-specific degradation, safe interruption recovery,
and distinct privacy controls. Happy-path evidence alone cannot satisfy Founder Acceptance Evidence.
_Avoid_: Smoke test, demo script

**Forbidden Technical Surface**:
Any ordinary onboarding or navigation exposure of models, API keys, messaging-channel setup,
Hermes, runners, containers, deployment stages, logs, terminals, infrastructure identifiers, token
counts, or provider costs. Provider account identity may appear through Connections; these technical
operations may appear only in the gated Troubleshooting Surface.
_Avoid_: Advanced settings, optional setup detail

### Company access

**Company Connection**:
A Founder-authorized relationship representing one external provider authorization, credential,
and revocation boundary. It contains one or more explicit Connection Resources selected by the
Founder.
_Avoid_: API-key integration, inferred account access

**Connection Resource**:
An immutable provider-identified mailbox, calendar, or later supported company object that the
Founder explicitly allows Bruno.Ai to use within a Company Connection. Provider access may be
broader than the selected resource set and must be described separately.
_Avoid_: Integration, inferred resource

**Primary Communications Suite**:
The one Founder-selected Google or Microsoft account whose independently authorized calendar and
mail Company Connections provide the core evidence for the Lead-to-Client Loop. Its receipt states
whether it is a managed organizational account or a personal account.
_Avoid_: Google Workspace account, Microsoft 365 tenant

**Mail Sending Connection**:
An optional Company Connection granting only one-to-one sending access from the same immutable
provider identity as the Primary Communications Suite's Mail connection. It has its own provider
grant, credential, revocation boundary, and Connection Receipt and is presented with that mailbox.
_Avoid_: Mail permission, compose access, shared Gmail grant

**Sending Off**:
The state in which a Founder has declined, disconnected, or not yet authorized a Mail Sending
Connection. Core Operation, Mail reading, Calendar, Action Previews, and prior Proposed Actions
remain visible, but no email execution can begin.
_Avoid_: Mail disconnected, Core Operation unavailable

**Contextual Connection Offer**:
A Company Connection invitation shown only when the Founder explicitly enables its business outcome
or reviews the first Action Preview that requires it. Declining or abandoning the offer preserves
existing capabilities and does not create repeated prompts.
_Avoid_: Onboarding permission bundle, automatic scope expansion

**Relationship Record**:
Bruno.Ai's Founder-confirmed record of a lead, client, partner, or ignored relationship, including
its next action, commitments, and evidence pointers. It remains authoritative while active and for
12 months after the Founder marks it closed or ignored, unless the Founder deletes it sooner;
Bruno.Ai warns once 30 days before automatic removal.
_Avoid_: Contact, CRM record, lead score

**One-to-One Outreach**:
A contextual message to a known relationship, prepared from the Lead-to-Client Loop and subject to
Authority Policy. It excludes campaigns, audience automation, scraping, and bulk prospecting.
_Avoid_: Marketing campaign, outreach sequence

**Business Action**:
A unit of work classified by its highest-impact business meaning rather than by the provider tool
or API operation used to carry it out.
_Avoid_: Tool call, API request

**Action Family**:
A Founder-readable class of Business Actions governed together by Authority Policy. Initial
families distinguish observing evidence, maintaining internal records, preparing work,
communicating externally, managing meetings, making commercial commitments, and deleting,
exporting, or disclosing company data.
_Avoid_: Tool permission, OAuth scope

**Connection Access**:
The provider-enforced data and actions available to Bruno.Ai through a Company Connection. It does
not by itself authorize Bruno.Ai to perform a business action.
_Avoid_: Authority, autonomy setting

**Connection Availability**:
Whether a Company Connection is connecting, waiting for external approval, ready for use, needs
Founder attention, or is disconnected. It does not claim that the connection's evidence is fresh.
_Avoid_: Sync status, service health

**Evidence Freshness**:
Whether evidence from a Connection Resource is being checked, current, stale, or unavailable. It
is independent of Connection Availability.
_Avoid_: Connection status, authorization state

**Ready Company Connection**:
A Company Connection whose provider identity, actual granted access, and at least one selected
Connection Resource have been verified through a bounded live evidence check and confirmed by the
Founder. A successful check with no matching evidence is valid.
_Avoid_: OAuth callback completed, account linked

**Connection Receipt**:
An immutable, Founder-confirmed record of a Company Connection's provider identity, selected
Connection Resources, provider-granted access, Bruno.Ai's narrower use, available and unavailable
capabilities, applicable consent reference, and live verification result at a material point in its
history. Consent-only changes update the current summary through a Governance Receipt without
creating a new Connection Receipt; prior receipts remain immutable.
_Avoid_: OAuth scope list, sync log

**Connection Reauthorization**:
Renewed authorization for the same immutable provider identity. It preserves the Company
Connection's selected resources and receipt history when its identity and access boundary have not
materially changed.
_Avoid_: New connection, account replacement

**Connection Disconnection**:
The immediate end of new provider access, local credential custody, and applicable subscriptions,
with provider revocation attempted separately. The Founder separately chooses whether to retain or
delete the connection's Retained Business Evidence.
_Avoid_: Data deletion, account replacement

**Connection Data Deletion**:
Bruno Data Deletion applied to evidence, drafts, briefs, and relationship content derived only from
one Company Connection. It cancels unstarted dependent actions but cannot reverse completed effects.
_Avoid_: Disconnect, provider revocation

**Connection Replacement**:
A newly authorized Company Connection for a different provider account, mailbox, tenant, or
installation. It does not inherit retained evidence or Relationship Records without a
Founder-reviewed migration.
_Avoid_: Reauthorization, silent account switch

**Authority Policy**:
A Founder-controlled rule that makes an Action Family, optionally narrowed to a business resource
or relationship context, always allowed, approval required, or never allowed. Learning, repeated
approvals, and conversational instructions do not change it; a change requires a separate explicit
Founder decision and immutable receipt.
_Avoid_: OAuth scope, tool approval

**Governance Receipt**:
An immutable record of a Processing Consent or Authority Policy decision. A consent change updates
the applicable Company Connection summary but creates no new Connection Receipt unless the access
boundary also changes; sensitive content becomes an Evidence Tombstone after 24 months.
_Avoid_: Preference history, settings log

**Product Guardrail**:
A nondelegable product boundary that prevents unsupported, unsafe, or Founder-only actions
regardless of Authority Policy. It cannot grant Connection Access, Processing Consent, or authority
to change itself.
_Avoid_: Never-allowed policy, approval preference

**Action Preview**:
A non-executable presentation of intended recipient, material content, evidence, and business effect
when a required Company Connection is absent. It may offer the applicable Contextual Connection
Offer, but creates no approval or authority; a Ready connection produces a new Proposed Action.
_Avoid_: Proposed Action, pending approval, OAuth consent

**Proposed Action**:
An immutable, versioned description of one externally observable Business Action, including its
exact destination, material content, side effects, governing Authority Policy, validity boundary,
and execution preconditions. Related proposals may be presented together but remain independently
reviewable and executable.
_Avoid_: Draft, tool call, standing instruction

**Action Decision**:
The Founder's choice to approve, request changes to, or decline one exact Proposed Action version.
Requesting changes supersedes that version; no decision grants authority to a future or changing
action.
_Avoid_: Policy change, blanket approval

**Authorized Action**:
A Proposed Action permitted once by either an explicit approval or an always-allowed Authority
Policy. Authorization permits an execution attempt but does not prove that the intended effect
occurred.
_Avoid_: Completed action, reusable approval

**Action Receipt**:
An immutable record binding a Proposed Action version, its Authority Policy evaluation, any Action
Decision, execution attempts, provider acknowledgement, and verified outcome or unresolved
uncertainty. Its sensitive content is retained for 24 months and then replaced by an Evidence
Tombstone.
_Avoid_: Approval status, activity log

**Uncertain Outcome**:
An external action result for which Bruno.Ai cannot prove either that the intended effect occurred
or that retrying would be safe. Email delivery uses a unique message identity for reconciliation,
but enters this state without retry when the provider result cannot be proven.
_Avoid_: Failure, safe retry

**Scheduled Action**:
An Authorized Action bound to an exact future execution window. It remains subject to its original
material content and to current Product Guardrails, Connection Access, Processing Consent, and
execution preconditions when that window arrives.
_Avoid_: Reminder, standing instruction

**External Action Pause**:
A Founder-controlled state that prevents any new external effect while allowing observation,
analysis, preparation, and Bruno Conversation to continue. It does not claim to reverse an effect
whose execution has already begun.
_Avoid_: Stop Bruno.Ai, revoke access

**Account Closure**:
The Founder-only action that applies External Action Pause, revokes every connection, cancels
unstarted actions, begins Bruno Data Deletion, and tracks completion through a Deletion Receipt.
_Avoid_: Sign out, delete agent

### Managed intelligence

**Compatible AI Provider**:
An AI service Bruno.Ai can authenticate with and route work through without exposing model or
infrastructure choices to the Founder. OpenAI may appear alone during earlier previews, but Initial
General Release offers independently released OpenAI and Anthropic; later providers are an expansion.
_Avoid_: Model picker, provider marketplace

**Founder AI Connection**:
A required Founder-authorized relationship that lets Bruno.Ai use the Founder's eligible OpenAI or
Anthropic account. Bruno.Ai remains responsible for selecting the model and operating the runtime,
but does not provide or silently fall back to Bruno-funded model capacity.
_Avoid_: API key form, model configuration

**Hermes AI Setup**:
The ordinary Founder AI Connection journey presented by Bruno.Ai through Hermes' structured
provider authentication, status, model-assignment, and configuration capabilities. Hermes remains
authoritative for provider credential formats and persistence; Bruno.Ai limits choices to released
providers and does not collect raw provider credentials.
_Avoid_: Bruno-owned OAuth implementation, terminal wizard

**Full Hermes Setup**:
The complete canonical `hermes setup` terminal wizard for advanced configuration or
troubleshooting. It is a Founder-only, recently reauthenticated 15-minute Advanced repair session
run while the Operator is stopped; any provider or model change must pass Ready AI Connection
verification before work resumes.
_Avoid_: Founder onboarding, required AI connection

**Ready AI Connection**:
A Founder AI Connection whose account identity, plan eligibility, inference access, current
capacity, and Processing Consent have been verified. An authorization callback alone does not make
the connection ready.
_Avoid_: Authenticated provider, saved credential

**Processing Consent**:
The Founder's explicit permission for one Founder AI Connection to process the data Bruno.Ai needs
from any selected Company Connection. It ends when that AI connection is explicitly disconnected.
_Avoid_: OAuth scope, Authority Policy

**Provider Routing**:
Bruno.Ai's automatic selection between the Founder's connected Compatible AI Providers. Routing may
use only providers the Founder explicitly connected; if none has capacity, affected work pauses
instead of using Bruno-funded capacity.
_Avoid_: Model selection, silent provider enrollment

**AI Compatibility Policy**:
Bruno.Ai's versioned release policy defining available Compatible AI Providers, approved model
assignment, routing order, and fallback eligibility. Hermes remains authoritative for credentials
and persisted configuration; affected work evidence records the policy version while ordinary views
hide model details.
_Avoid_: Model picker, Hermes provider catalog

**Safe Work Checkpoint**:
A durable boundary from which Bruno.Ai can resume work through another authorized provider without
repeating an irreversible or uncertain external action.
_Avoid_: Retry, conversation history

**Paused Work**:
Work held at a Safe Work Checkpoint because no Ready AI Connection can continue it. It retains its
evidence and authority state without silently changing provider, payer, or requested action.
_Avoid_: Failed work, cancelled work

### Deployment

**Agent Deployment**:
The legacy durable attempt created by an Owner request to make an agent usable. It does not define
Operator Preparation, Founder Setup Complete, or Founder Activation.
_Avoid_: Agent creation, creation run

**Cold Deployment**:
An Agent Deployment that creates a new runner only after the owner's request commits. Capacity that
already existed before the request is outside the cold-deployment cohort.
_Avoid_: Cold start, cold run

**Owner**:
The authorization principal with exclusive authority over Bruno.Ai and any assigned runtime. In the
initial product, each Owner maps to exactly one Founder.
_Avoid_: Tenant, account, runner user

**Same-Owner Reuse**:
Placement of an agent on compatible spare capacity belonging to the same Owner. It is never part of
the Cold Deployment cohort.
_Avoid_: Same-user reuse, shared runner, warm capacity

**Ready Deployment**:
An Agent Deployment whose real Hermes gateway is healthy, whose intended Telegram configuration is
verified, and whose readiness is durably recorded.
_Avoid_: Runner ready, gateway ready, boot ready

**Cold-Deployment SLO**:
At least 95 percent of eligible Cold Deployments must become Ready Deployments within five minutes
(300 seconds) of the request transaction committing. A terminal failure or timeout misses the
objective; this legacy Telegram-dependent measure does not govern a Prepared Operator.
_Avoid_: Successful-run p95, API response time

**Eligible Cold Deployment**:
A real production Owner request that commits and requires a newly created runner. Explicitly tagged
operator trials and deployments cancelled by the Owner before the SLO boundary are excluded;
service and provider failures are not.
_Avoid_: Benchmark trial, successful deployment

**SLO Miss**:
An Eligible Cold Deployment that has not become a Ready Deployment within five minutes (300
seconds). An SLO Miss does not itself stop the deployment from continuing toward readiness or
ordinary terminal failure.
_Avoid_: Deployment failure, timeout

**Provider Trial Cohort**:
An authorized, immutable sequence of numbered synthetic deployment attempts used to decide whether
a guarded production rollout may begin. Attempts are never replaced or discarded after the cohort
starts.
_Avoid_: Benchmark sample, successful trials

**Rollout Configuration**:
The versioned set of infrastructure and validation choices assigned to an Agent Deployment. A later
default or rollback does not reinterpret that deployment's recorded choices.
_Avoid_: Current environment, feature flags

**Runner Capacity**:
The number of agents a runner may safely host under an approved resource profile. Missing or stale
capacity evidence reduces capacity rather than permitting optimistic placement.
_Avoid_: Slot count, configured maximum

**Snapshot Attestation**:
Immutable evidence binding a runner snapshot to the exact runner, Hermes, platform, and boot-contract
identities that were validated together. It does not expire merely because time passes.
_Avoid_: Snapshot metadata, image name

**Approved Snapshot**:
A Snapshot Attestation currently authorized for new Cold Deployments. Approval may be superseded or
revoked without changing the attestation itself.
_Avoid_: Latest snapshot, valid snapshot

**Verified Release**:
Immutable evidence that an Approved Snapshot and the exact control-plane-to-runner contract were
successfully exercised together using the full boot fixture.
_Avoid_: Successful build, deployed revision

**Admitted Runner**:
A runner accepted for agent placement after presenting the required snapshot, release, identity,
registration, heartbeat, and readiness evidence.
_Avoid_: Booted runner, healthy machine

**Observed Check**:
Evidence measured directly from the runner currently seeking admission.
_Avoid_: Attested check, release evidence

**Attested Check**:
Historical evidence imported from the exact Approved Snapshot or Verified Release and not rerun on
the runner currently seeking admission.
_Avoid_: Observed check, current health

### Troubleshooting

**Interruption State**:
The Founder-visible classification of disrupted work as Recovering, Waiting on provider, Needs you,
Outcome uncertain, or Recovery exhausted, based on who or what can safely advance it.
_Avoid_: Error status, technical failure code

**Automatic Recovery**:
A bounded, capability-specific attempt by Bruno.Ai to restore work from verified state without a
Founder decision. It never retries indefinitely or repeats an uncertain external effect.
_Avoid_: Retry loop, silent intervention

**Recovery Exhausted**:
The Interruption State reached when Automatic Recovery has spent its safe budget, repeatedly failed,
cannot verify required state, or cannot retry without risking evidence or an external effect.
_Avoid_: Needs you, waiting on provider

**Troubleshooting Incident**:
A canonical Founder-readable record of one Recovery Exhausted interruption, limited to its affected
business capability, timing, safe cause, attempted repairs, recovery choices, and sanitized support
reference. Bruno Conversation and Help link to this record rather than duplicating alerts.
_Avoid_: Log stream, infrastructure alert

**Shared Service Incident**:
A Bruno.Ai platform interruption affecting multiple Founders that remains Recovering through one
service-status update. It creates a Troubleshooting Incident only for a capability still broken
after the shared incident resolves.
_Avoid_: Customer support case, provider outage

**Support Case**:
A Founder-opened troubleshooting relationship for one Troubleshooting Incident. It begins with a
sanitized evidence bundle and grants no live access by itself.
_Avoid_: Support account, standing access

**Support Case State**:
The Founder-visible case position: Open, Needs you, Support working, Verifying recovery, Resolved, or
Closed without recovery. Only Verified Recovery may produce Resolved.
_Avoid_: Ticket status, support workflow stage

**Closed without Recovery**:
A terminal Support Case State that preserves the Safe Work Checkpoint and leaves only the affected
capability paused because no released Repair Catalogue operation can recover it safely.
_Avoid_: Resolved, failed repair

**Support Access Grant**:
A recently reauthenticated Founder decision allowing one named, MFA-authenticated Bruno.Ai support
person read-only access to exact evidence for one Support Case for no more than 60 minutes.
_Avoid_: Impersonation, admin access, support role

**Support Tool**:
An allowlisted diagnostic query or release-reviewed repair operation available within an applicable
Support Access Grant. It never provides arbitrary shell, database, filesystem, or script execution.
_Avoid_: Admin console, remote shell

**Repair Catalogue**:
The release-reviewed set of exact Bruno-owned recovery operations that may back a Repair Proposal.
It excludes arbitrary configuration, provider credentials, company data, and destructive cleanup.
_Avoid_: Support playbook, command library

**Repair Proposal**:
A one-time description of an exact Bruno-owned recovery operation, its affected capability,
expected interruption, preserved state, and rollback boundary, requiring Founder approval.
_Avoid_: Shell command, support instruction

**Support Decision**:
A Support Access Grant or Repair Proposal presented as one canonical Action Inbox item and linked
from Bruno Conversation and its Troubleshooting Incident.
_Avoid_: Email approval, chat consent

**Support Access Receipt**:
An immutable record of a Support Access Grant, its named support person, scope, access period,
revocation, evidence categories inspected, and any separately authorized Repair Proposal. Its
sensitive content is retained for 24 months and then replaced by an Evidence Tombstone.
_Avoid_: Support log, case notes

**Support Access Revocation**:
The immediate end of one Support Access Grant. It cancels unstarted repairs, while a repair already
underway enters reconciliation and reports its verified outcome.
_Avoid_: Repair rollback, case closure

**Verified Recovery**:
Live bounded evidence that the affected business capability works after a repair and that unrelated
capabilities remain preserved. Command completion or infrastructure health alone is insufficient.
_Avoid_: Repair completed, container healthy

**Security Quarantine**:
An automated isolation of an environment or external effects during a security risk without human
access to Founder content. It does not grant support access.
_Avoid_: Break-glass access, support session

**Troubleshooting Surface**:
A separately gated view reached from a Troubleshooting Incident or deliberate Help action after
Automatic Recovery is exhausted. It is absent from ordinary product navigation.
_Avoid_: Founder dashboard, ordinary settings

**Founder Help**:
A deliberately opened, nontechnical view of current business capability, safe self-service recovery,
and support choices. Before Recovery Exhausted it does not reveal the Troubleshooting Surface, raw
technical evidence, or Full Hermes Setup.
_Avoid_: Troubleshooting Surface, system health
