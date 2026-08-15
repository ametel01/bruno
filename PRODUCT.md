# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Bruno is for solo SaaS founders running a one-person company. They already operate through a
predictable digital stack—such as Stripe, Gmail, Google Calendar, GitHub, Vercel, analytics,
project tracking, and customer support—and need help keeping up with customers, revenue, support,
leads, shipping, marketing, and product signals.

The founder values completed work and operational awareness but should not need to understand or
administer agent runtimes, models, context windows, skills, cron jobs, containers, or servers. They
remain the manager: Bruno brings forward decisions, asks for approval according to clear business
policies, and handles permitted work.

## Product Purpose

Bruno is the operating system for a one-person company. It continuously understands the business,
finds work that matters, prepares or completes the appropriate action, verifies the outcome, and
keeps the founder informed only when their judgment is needed.

Success means the founder spends less time prompting and coordinating software, misses fewer
important business loops, and can see concrete time, revenue, retention, and customer outcomes
attributable to Bruno.

## Positioning

Bruno is not a hosted-agent product or a general chat assistant. Its differentiated mechanism is a
persistent **Business Graph**: structured company state covering goals, customers, prospects,
conversations, revenue, subscriptions, product, releases, metrics, commitments, experiments, and
open loops.

Business events update that graph. Bruno interprets their significance, decides whether action is
needed, prepares or executes the action within policy, verifies the result, and updates company
state. The founder manages the business through an Action Inbox and outcome reporting rather than
through a stream of prompts.

## Operating Context

Bruno connects to the systems that already describe and run a solo SaaS company. The initial
company picture is expected to combine email, revenue, source control, deployment, analytics,
planning, and support data while keeping the underlying integrations focused on business-critical
work.

The first operating loops are:

- Founder Morning Brief: summarize what changed, what matters today, and which decisions need the
  founder.
- Lead Follow-up: detect unanswered prospects, prepare follow-ups, and maintain the next action
  until the opportunity closes or is abandoned.
- Customer Risk: detect cancellations, failed payments, unhappy messages, or declining usage and
  prepare an appropriate intervention.
- Product Intelligence: combine customer conversations, product analytics, and engineering work
  to surface recurring problems and evidence-backed product tasks.
- Launch Operator: respond to a release with coordinated communication, observe the response, and
  report its effect.
- Weekly CEO Review: review revenue, growth, product, customers, commitments, experiments, missed
  objectives, and concrete next actions.

The primary control surface is a founder command center. Its signature workflow is an Action Inbox
that separates items needing review or approval from work already completed by Bruno. Core
monitoring and approval actions must remain usable on mobile even though the product is
desktop-first.

## Capabilities and Constraints

- The current repository implements a substantial web control plane for creating, configuring,
  running, observing, approving, backing up, and recovering persistent Hermes agents. This is an
  infrastructure foundation, not the new lead customer promise.
- The Business Graph, event-driven operating loops, company connectors, Action Inbox, and Bruno
  Impact reporting are the approved product direction; they must not be presented as already
  shipped without implementation evidence.
- Autonomy is expressed as understandable business policies per system and action: always allow,
  ask, or never allow. Bruno may suggest broader permission after repeated approvals but must not
  silently expand authority.
- Bruno should report business outcomes—time saved, revenue influenced, churn recovered, leads
  followed up, support resolved, and insights found—rather than foregrounding tokens or model
  usage.
- Agent runtimes are interchangeable infrastructure. Hermes is the current runtime foundation;
  Bruno should own company context, policies, business state, workflows, user experience, and
  outcomes rather than couple the product identity to Hermes.
- Infrastructure, runtime selection, multi-agent orchestration, and model selection should remain
  invisible unless an operational exception genuinely requires founder attention.
- The product should begin with a small number of excellent operating loops for solo SaaS founders,
  not a generic personal agent, a marketplace, or a broad catalog of skills and integrations.
- Sensitive external actions remain supervised according to explicit policy. Durable events,
  approvals, recovery paths, and clear operating state are product trust requirements.

## Brand Commitments

- Product name: **Bruno**.
- Product mantra: **The operating system for a one-person company.**
- Core promise: **Bruno runs your one-person business with you.**
- Bruno should feel like a capable employee who understands the company and closes loops, not a
  chatbot, infrastructure console, or collection of AI experts.
- Customer-facing language should describe business work, decisions, policies, and outcomes. Avoid
  making Hermes, OpenClaw, MCP, cron, skills, subagents, context windows, models, or VPS concepts
  part of the founder's required vocabulary.

## Evidence on Hand

- `docs/PIVOT.md` is the approved authority for the product direction, target market, Business
  Graph, operating loops, Action Inbox, policy model, outcome measurement, and runtime-agnostic
  strategy.
- `README.md` and the current `app/` and `src/` implementation document the shipped agent control
  plane, lifecycle, approvals, events, runners, backups, cost estimates, and authentication modes.
- `docs/PRD.md` documents the earlier fleet-control-plane thesis. It remains useful implementation
  history but does not override the customer direction in `docs/PIVOT.md`.
- The repository does not yet contain validated customer testimonials or measured Bruno Impact
  outcomes. Future product work must not fabricate customers, revenue influence, time savings,
  conversion changes, or other proof.

## Product Principles

1. **The founder manages; Bruno operates.** Bring decisions and exceptions to the founder instead
   of requiring them to continually invent prompts and workflows.
2. **Understand the company before acting.** Ground every recommendation and action in persistent,
   structured business state rather than generic model memory.
3. **Close loops, then verify outcomes.** Work is not complete when an action is generated; Bruno
   follows through, observes the result, and updates company state.
4. **Earn autonomy through legible policy and evidence.** Keep authority explicit, approvals
   understandable, actions auditable, and recovery available.
5. **Measure work in business terms.** Optimize for time, revenue, retention, customer outcomes,
   and founder attention—not infrastructure novelty or token throughput.

## Accessibility & Inclusion

The product must be understandable to founders without agent-infrastructure expertise. Important
status, risk, approval, and outcome information should not depend on technical jargon or color
alone. The desktop-first command center must preserve essential monitoring and decision workflows
on mobile and support keyboard-visible interaction in the web interface.
