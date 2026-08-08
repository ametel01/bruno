# Bruno Hermes Fleet Control Plane PRD

## Problem Statement

Solo founders, agencies, developers, and small operators want persistent AI agents that can run useful jobs without forcing them to manage VPS setup, process supervision, cloud provisioning, logs, backups, permissions, or recovery. Existing Hermes hosting products already make one-click deployment cheap, so the unsolved user problem is not simply "host Hermes for me." The stronger problem is that users do not have a reliable control plane for creating, supervising, limiting, auditing, recovering, and eventually scaling a small fleet of persistent Hermes agents.

The MVP must validate whether users trust a desktop-first web dashboard, with mobile-friendly controls, as the operational surface for running cloud agents. It should avoid starting with fully automated cloud provisioning because that creates infrastructure complexity before the dashboard, lifecycle model, event log, approval queue, and runner abstraction have been proven.

## Solution

Build Bruno as a desktop-first web SaaS for managing persistent Hermes agents, with a mobile-responsive control panel for monitoring, approvals, pause/resume, alerts, and quick recovery. The product should feel closer to Vercel, Railway, DigitalOcean, and Datadog for AI agents than to a chat app.

The first implementation should progress through thin vertical slices: product skeleton, agent records, fake lifecycle controls, event logs, simulated logs, templates, configuration, approval queue, mobile controls, local runner, Docker runner, manual remote runner, secure runner auth, automated DigitalOcean runner provisioning, multiple agents, backups, cost tracking, billing, real Hermes plus Telegram, and private beta.

The core product primitive is a supervised agent operation: a user creates an agent from a template, configures model/provider and limits, starts or stops it, sees status and logs, reviews approval requests, and can recover from failure. The runner abstraction should allow execution to evolve from fake state, to local processes, to Docker containers, to one manually provisioned VPS, to automated DigitalOcean droplets, without rewriting the product dashboard.

## User Stories

1. As a solo founder, I want to create an Bruno account, so that I can manage persistent AI agents from one dashboard.
2. As a solo founder, I want to view an empty dashboard after signup, so that I understand where agents will appear.
3. As a solo founder, I want to create an agent record without real execution, so that I can start configuring my operation before infrastructure exists.
4. As a solo founder, I want to name an agent, so that I can recognize its job in the dashboard.
5. As a solo founder, I want to choose an agent template, so that I do not need to design a useful agent from scratch.
6. As a solo founder, I want to create a Research Agent template, so that I can run recurring research jobs.
7. As an agency operator, I want to create an Inbox Triage Agent template, so that I can manage client support or sales intake.
8. As a developer, I want to create a GitHub Issue Agent template, so that repository maintenance can be supervised from Bruno.
9. As a content operator, I want to create a Social Content Agent template, so that recurring repurposing work has a clear starting point.
10. As a user, I want created agents to persist after refresh, so that the dashboard feels reliable.
11. As a user, I want every agent to have a detail page, so that I can inspect status, config, logs, approvals, and events in one place.
12. As a user, I want to start an agent from the dashboard, so that I can control lifecycle without touching a server.
13. As a user, I want to stop an agent from the dashboard, so that I can safely halt work or spend.
14. As a user, I want to restart an agent from the dashboard, so that I can recover from stuck or degraded states.
15. As a user, I want invalid lifecycle actions to be blocked, so that the product does not create inconsistent agent states.
16. As a user, I want agent status to progress through clear states, so that I know whether an agent is idle, starting, running, stopped, restarting, or errored.
17. As a user, I want lifecycle actions to create events, so that I can audit who changed what and when.
18. As a user, I want an activity feed for each agent, so that I can understand the sequence of creation, starts, stops, errors, config changes, and logs.
19. As a user, I want running agents to produce simulated logs before real execution exists, so that monitoring UX can be designed and tested early.
20. As a user, I want stopped agents to stop producing logs, so that dashboard state reflects actual lifecycle behavior.
21. As a user, I want to simulate an error state, so that I can see how failure and recovery will work.
22. As a user, I want to edit an agent's system prompt, so that I can tune the agent's behavior.
23. As a user, I want to select a model provider and model name, so that the agent can later run against my chosen model stack.
24. As a user, I want to set a maximum daily spend, so that an agent cannot silently exceed my budget.
25. As a user, I want to choose a schedule mode, so that an agent can run manually or on a defined cadence later.
26. As a user, I want bad configuration to be rejected, so that agents do not start from invalid settings.
27. As a user, I want config changes to appear in the event log, so that I can understand why an agent changed behavior.
28. As a user, I want agents to request approval for sensitive actions, so that I remain in control.
29. As a user, I want to approve an action, so that an agent can proceed with supervised work.
30. As a user, I want to deny an action, so that I can prevent risky or unwanted behavior.
31. As a user, I want approval decisions to be recorded in the event log, so that there is a durable receipt.
32. As a mobile user, I want to see my agent list on a phone, so that I can monitor agents away from my desk.
33. As a mobile user, I want to pause or resume an agent from my phone, so that I can respond quickly to issues.
34. As a mobile user, I want to approve or deny pending actions from my phone, so that agents are not blocked until I return to a laptop.
35. As a mobile user, I want to read latest logs and alerts from my phone, so that I can decide whether intervention is needed.
36. As a developer, I want a local runner adapter, so that the dashboard can control a real local process before cloud provisioning exists.
37. As a developer, I want the runner adapter to expose start, stop, restart, status, and log streaming operations, so that execution backends can change without changing product flows.
38. As a developer, I want agent crashes to update status to error, so that failure is visible to users.
39. As an operator, I want each agent to run in its own Docker container, so that logs, config, crashes, and lifecycle controls are isolated.
40. As an operator, I want logs from multiple agents to stay separated, so that I can debug the right agent.
41. As an operator, I want the dashboard to control a manually provisioned remote runner, so that the hosting model can be validated before automated cloud APIs are added.
42. As an operator, I want a runner heartbeat, so that I can tell whether the remote execution environment is online, offline, or degraded.
43. As a security-conscious user, I want runner API requests to be authenticated, so that only Bruno can control my runner.
44. As a user, I want to create a runner automatically on DigitalOcean, so that I can get to a zero-setup hosted agent without manual server work.
45. As a user, I want runner provisioning failures to be visible, so that I know whether setup is still pending or needs attention.
46. As a user, I want to run multiple agents on one runner, so that I can operate a small agent fleet economically.
47. As a user, I want to see runner capacity, so that I know how many agents can safely run on available CPU, memory, and disk.
48. As a user, I want manual backups of agent config and memory, so that I can recover from accidental loss.
49. As a user, I want manual restore, so that I can recover an agent's useful state.
50. As a user, I want backup and restore events in the timeline, so that recovery actions are auditable.
51. As a user, I want to see infrastructure cost estimates, so that I understand the monthly cost of running agents.
52. As a user, I want to see estimated cost per running agent, so that I can decide whether to consolidate or scale.
53. As a business owner, I want subscription plans to enforce runner and agent limits, so that pricing maps to usage.
54. As a business owner, I want Stripe checkout, so that users can pay without manual invoicing.
55. As a business owner, I want subscription status to sync into Bruno, so that cancelled or unpaid users cannot create new paid resources.
56. As a user, I want to configure Hermes with Telegram and BYOK model settings, so that I can use a real hosted Hermes agent.
57. As a user, I want the Hermes agent to reply through Telegram, so that I can validate real end-to-end value.
58. As a beta user, I want signup, agent creation, runner provisioning, lifecycle controls, logs, Telegram, BYOK, backups, billing, and error reporting to work together, so that I can run an agent without the founder's help.
59. As the product team, I want to observe whether users check the dashboard repeatedly, so that we know whether the control-plane value is real.
60. As the product team, I want to observe whether users trust agents enough to keep them running, so that we can validate the business before expanding native apps or enterprise features.

## Implementation Decisions

- Build a desktop-first web SaaS as the primary surface. The dashboard should be mobile-responsive from day one, but native desktop and native mobile apps are out of scope for the MVP.
- Treat Bruno as an agent operations control plane, not a commodity Hermes hosting wrapper.
- Start with thin vertical slices that are clickable and testable at every milestone.
- Defer real cloud provisioning until the dashboard, state model, lifecycle controls, event timeline, templates, config editor, approval queue, and runner abstraction are proven.
- Model agents as durable records with name, status, template, timestamps, and later configuration.
- Use an explicit agent status lifecycle with states for idle, starting, running, stopped, restarting, and error.
- Add an agent event timeline early. Events should become the foundation for later audit receipts.
- Simulate lifecycle transitions before starting real processes. This lets dashboard behavior and tests mature before infrastructure integration.
- Generate fake logs only for running agents. This validates monitoring UX before Hermes integration.
- Add agent templates as product-level metadata before they affect runtime execution. Initial templates are Research Agent, Inbox Triage Agent, GitHub Issue Agent, and Social Content Agent.
- Add a config editor before model integration. Editable config includes name, system prompt, model provider, model name, maximum daily spend, and schedule mode.
- Record config changes as events.
- Add an approval queue before real sensitive actions exist. Fake agents should be able to create approval requests for Telegram messages, research tasks, Gmail access, and similar future capabilities.
- Approval requests should have pending, approved, and denied states.
- Mobile should focus on operational control: agent list, status, latest logs, alerts, approvals, pause, resume, approve, and deny.
- Introduce a runner adapter as the main execution boundary. The dashboard should talk to a stable runner interface for start, stop, restart, status, and log streaming.
- First runner implementation can control a dummy long-running process or local Hermes process.
- Next runner implementation should isolate each agent in a Docker container.
- Validate remote execution with one manually provisioned VPS before building automated Droplet provisioning.
- The dashboard-to-runner connection should use runner registration, runner identity, authenticated API requests, and heartbeat.
- The first automated cloud provider should be DigitalOcean because Droplets are simple and predictable.
- Automated runner provisioning should use cloud-init or an equivalent bootstrapping path to install dependencies, start the runner, and register it with Bruno.
- Multiple agents should run on one runner before multiple runners become a priority.
- Until the dedicated multi-agent resource and isolation workstream is complete, hosted placement
  must remain fail-closed at one agent per runner. Cold-deployment performance work must not claim
  this product requirement complete or mix Same-Owner Reuse results into the cold SLO.
- Runner capacity should expose maximum agents, memory, CPU, disk, and current running-agent count.
- Backups should start with agent config, system prompt, skills, memory files, and logs metadata. Full infrastructure snapshots are not required first.
- Cost tracking should begin with infrastructure cost and uptime, then later expand to token/model spend.
- Billing should use Stripe subscriptions with plan limits for runners and agents.
- Real Hermes integration should begin with one narrow path: Hermes plus Telegram plus bring-your-own model key.
- Private beta should require signup, create agent, provision runner, start/stop/restart, logs, Telegram integration, BYOK model config, basic backups, billing or manual payment, admin visibility, and error reporting.

## Testing Decisions

- Good tests should assert external behavior visible to users or integration partners, not implementation details. The best tests should answer whether a user can create, configure, control, monitor, approve, recover, and pay for agents.
- Primary test seam: product-level integration tests through the dashboard/API using a fake runner. This is the highest-value seam because most milestones should preserve the same user-visible behavior as execution evolves from fake state to local processes to Docker to remote runners.
- Secondary test seam: runner contract tests for start, stop, restart, status, log streaming, authentication, and heartbeat. This seam is justified because the runner boundary protects the dashboard from execution backend changes.
- Test agent CRUD by verifying created agents persist, appear in the dashboard, and load on the agent detail page.
- Test lifecycle controls by verifying valid transitions, invalid action blocking, event creation, and UI state updates.
- Test event logging by verifying every user action and system transition creates an ordered event.
- Test simulated logs by verifying running agents generate logs and stopped agents do not.
- Test template creation by verifying template metadata is stored and displayed.
- Test config editing by verifying persistence, validation, and config-change events.
- Test approval queue behavior by verifying pending approvals appear, approve/deny transitions resolve them, and decisions are logged.
- Test mobile behavior with responsive viewport checks for agent list, approval flow, logs, and pause/resume controls.
- Test local runner behavior by verifying start creates a real process, stop terminates it, logs are captured, and crashes become error states.
- Test Docker runner behavior by verifying one container per agent, isolated logs, restart behavior, and crash detection.
- Test remote runner behavior by verifying the hosted dashboard can control a runner on a manually provisioned VPS.
- Test runner auth by verifying unauthorized requests fail and heartbeat changes runner status between online and offline.
- Test DigitalOcean provisioning with a provider abstraction or recorded test mode where possible, plus one real smoke test before beta.
- Test multi-agent behavior by verifying multiple agents can run on one runner without mixed logs or incorrect status.
- Test backup and restore by verifying manual backup, manual restore, and timeline events.
- Test cost tracking by verifying infrastructure cost, uptime, and estimated per-agent cost calculations.
- Test billing by verifying checkout, subscription sync, plan limit enforcement, and cancellation behavior.
- Test real Hermes integration with a narrow end-to-end smoke test: create Telegram-connected Hermes agent, start it, receive a reply, inspect logs, and stop it.

## Out of Scope

- Native iOS and Android apps.
- Full native desktop dashboard.
- Desktop tray app or local bridge for filesystem, local Git repositories, terminal access, browser session access, SSH keys, or local MCP servers.
- Enterprise role-based access control.
- Team workspaces and client workspaces.
- White-label deployments.
- Marketplace for templates.
- Multiple cloud providers beyond the first DigitalOcean implementation.
- Full VM snapshot backup and restore.
- Advanced model routing, bundled credits, or fallback model orchestration.
- Advanced permission policy engine beyond the first approval queue.
- Supporting every Hermes integration path. The first real path is Hermes plus Telegram plus BYOK.
- Replacing Hermes's own local dashboard.
- Competing on low-cost VPS hosting alone.

## Further Notes

- Competitive research suggests commodity managed Hermes hosting already exists. The moat should be operational trust: templates, permissions, monitoring, audit trails, recovery, cost controls, and business-specific workflows.
- The MVP should avoid a native app build until mobile usage patterns prove repeated approval, alert, summary, or chat behavior.
- A future desktop bridge may become strategically important if users need safe cloud-agent access to local files, repositories, terminals, browsers, or MCP servers.
- The product should use "agent receipts" as a long-term differentiator: durable records of prompts, actions, touched tools, config changes, approvals, logs, and recovery events.
- The milestone plan should be broken into agent-ready tickets that each deliver one visible behavior and avoid broad tasks like "build the dashboard."
