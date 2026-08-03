# AgentBay Milestones

Source documents:

- `conversation_dump.md`: original product exploration, surface-area decisions, and milestone sequence.
- `PRD.md`: consolidated product requirements, user stories, implementation decisions, testing decisions, and out-of-scope items.

This document turns the conversation milestone outline into implementation-ready build chunks. It assumes AgentBay is a desktop-first web SaaS with a mobile-responsive operations surface for managing hosted Hermes agents. The source documents intentionally leave the app stack open; the technical details below assume a TypeScript web app, Postgres-compatible database, background jobs, and a runner service boundary. Equivalent frameworks are acceptable if they preserve the same domain model, contracts, and validation behavior.

## Product Direction

AgentBay should not compete as commodity "Hermes hosting." The wedge is a control plane for supervised agent operations:

- Create agents from job-oriented templates.
- Configure lifecycle, model settings, schedules, budgets, and approval behavior.
- Start, stop, restart, monitor, and recover agents.
- Keep durable events, logs, approval receipts, backups, runner health, and cost visibility.
- Evolve execution from fake state to local process, Docker, manual VPS runner, automated DigitalOcean runner, and finally real Hermes plus Telegram.

Desktop web is the primary configuration and debugging surface. Mobile web is a focused control panel for status, approvals, pause/resume, alerts, and latest logs. Native mobile and native desktop apps are out of scope for MVP.

## Shared Technical Baseline

These conventions should be established early and reused across milestones.

### Core entities

- `users`: account owner records. A single development user is acceptable until auth is implemented.
- `agents`: durable agent records owned by users.
- `agent_configs`: editable runtime configuration for each agent.
- `agent_events`: audit timeline for lifecycle, config, approval, backup, runner, and system events.
- `agent_logs`: log lines emitted by simulated, local, Docker, remote, or Hermes runners.
- `agent_approvals`: pending and resolved approval requests.
- `runners`: local, manual VPS, or provisioned execution environments.
- `runner_heartbeats`: runner health observations.
- `runner_capacity_snapshots`: CPU, memory, disk, and running-agent observations.
- `backups`: backup manifests and restore history.
- `subscriptions`: billing state and plan limits.

### Status enums

Agent status:

```txt
idle
starting
running
stopped
restarting
error
deleting
```

Runner status:

```txt
registering
online
offline
degraded
provisioning
provision_failed
deleting
deleted
```

Approval status:

```txt
pending
approved
denied
expired
cancelled
```

Provisioning status:

```txt
not_started
queued
creating_droplet
bootstrapping
registering_runner
ready
failed
rolled_back
```

### Event conventions

Use `agent_events` as the durable audit timeline. Use `agent_logs` for chatty stdout/stderr/runtime output so the audit feed does not become unreadable.

Recommended `agent_events` fields:

```txt
id
agent_id
actor_user_id
runner_id
type
message
metadata_json
created_at
```

Recommended event types:

```txt
agent.created
agent.updated
agent.started
agent.stopped
agent.restarted
agent.error
agent.deleted
config.updated
approval.requested
approval.approved
approval.denied
runner.assigned
runner.offline
runner.online
backup.created
backup.restored
billing.limit_blocked
```

### API conventions

Use product-level APIs that remain stable as the backend evolves:

```txt
GET    /api/agents
POST   /api/agents
GET    /api/agents/:agentId
PATCH  /api/agents/:agentId
DELETE /api/agents/:agentId
POST   /api/agents/:agentId/actions/start
POST   /api/agents/:agentId/actions/stop
POST   /api/agents/:agentId/actions/restart
GET    /api/agents/:agentId/events
GET    /api/agents/:agentId/logs
GET    /api/agents/:agentId/approvals
POST   /api/approvals/:approvalId/approve
POST   /api/approvals/:approvalId/deny
```

Runner-facing APIs should be versioned separately:

```txt
POST /runner/v1/register
POST /runner/v1/heartbeat
GET  /runner/v1/readiness
POST /runner/v1/agents/:agentId/start
POST /runner/v1/agents/:agentId/stop
POST /runner/v1/agents/:agentId/restart
GET  /runner/v1/agents/:agentId/status
GET  /runner/v1/agents/:agentId/logs
```

### Validation expectations

Until a real repo toolchain exists, every milestone should define the nearest equivalent of:

- Unit tests for state transitions, validation, and data mapping.
- API or integration tests for user-visible workflows.
- Runner contract tests once the runner boundary exists.
- Mobile viewport checks for mobile-specific milestones.
- One smoke test that exercises the milestone from the UI or public API.

## Milestone 0: Product Skeleton [Completed]

Goal: The empty app exists, has deployable routes, and can connect to a database.

### Technical implementation

- Create the web app shell with a dashboard-oriented layout, top navigation, and empty states.
- Add routes:
  - `/dashboard`
  - `/agents`
  - `/agents/:agentId`
  - `/settings`
  - `/health`
- Add database connection configuration and migration tooling, but keep domain tables minimal until Milestone 1.
- Add environment variable validation for database URL, app URL, and session/auth placeholder values.
- Add a health check that verifies the app boots and can reach the database.
- Add deployment configuration for the selected platform, such as Vercel, Fly, Railway, or Render.
- Add a development seed path that can create a single local user later without real auth.

### Acceptance criteria

- `/dashboard`, `/agents`, `/settings`, and `/health` render successfully.
- Empty dashboard explains the absence of agents without marketing copy.
- Database migration command runs successfully.
- Health check returns success only when the database is reachable.
- The app can be deployed to the chosen hosting target.

### Tests

- Route smoke tests for the main pages.
- Health check test with database reachable and unreachable cases.
- Migration command included in local and deploy setup documentation.

## Milestone 1: Agent Model, No Execution [Completed]

Goal: Users can create persistent agent records without real runtime behavior.

### Technical implementation

- Add `users`, `agents`, and `agent_events` tables.
- Add `agents` fields:
  - `id`
  - `user_id`
  - `name`
  - `template_key`
  - `status`
  - `status_reason`
  - `created_at`
  - `updated_at`
  - `deleted_at`
- Default new agents to `stopped`.
- Create the agent list and detail pages backed by the database.
- Add a create-agent flow with name input and template dropdown.
- Insert `agent.created` event in the same transaction as agent creation.
- Use soft delete or a protected delete path only after lifecycle controls exist; avoid destructive deletes early.

### Acceptance criteria

- A user can create an agent called `Research Agent`.
- The new agent appears in the dashboard with status `stopped`.
- Refreshing the page preserves the agent.
- The detail page loads the agent from the database.
- Agent creation creates an `agent.created` event.

### Tests

- Database test for creating an agent and event transactionally.
- API test for `POST /api/agents`.
- UI or integration test for create, refresh, and detail navigation.

## Milestone 2: Fake Lifecycle Controls [Completed]

Goal: Start, stop, restart, and delete controls work against fake state.

### Technical implementation

- Add lifecycle action endpoints:
  - `POST /api/agents/:agentId/actions/start`
  - `POST /api/agents/:agentId/actions/stop`
  - `POST /api/agents/:agentId/actions/restart`
  - `DELETE /api/agents/:agentId`
- Implement an explicit state machine:
  - `stopped -> starting -> running`
  - `running -> stopped`
  - `running -> restarting -> running`
  - `error -> starting -> running`
- Block invalid transitions, such as starting an already running agent or stopping a stopped agent.
- Simulate delayed transitions using a background job, delayed task, or deterministic fake runner service.
- Write events for requested and completed transitions.
- Disable or show loading states for buttons while a transition is in progress.
- Treat delete as soft delete and block deletion while an agent is `starting` or `restarting`.

### Acceptance criteria

- Clicking Start changes status to `starting`, then `running`.
- Clicking Stop changes status to `stopped`.
- Clicking Restart changes status to `restarting`, then `running`.
- Invalid actions are rejected by the API and cannot corrupt state.
- Every lifecycle action creates events.

### Tests

- Unit tests for the lifecycle state machine.
- API tests for valid and invalid transitions.
- Integration test for UI status updates.
- Event assertion for each action.

## Milestone 3: Event Log and Activity Feed [Completed]

Goal: Every agent has a visible timeline of important actions and system events.

### Technical implementation

- Add an activity feed section to the agent detail page.
- Implement `GET /api/agents/:agentId/events` with pagination.
- Use cursor pagination by `created_at` and `id`.
- Show event time, type, message, actor, and relevant metadata.
- Decide display order explicitly, preferably newest first for operations dashboards.
- Add event helper functions so all milestones write consistent events.
- Add a compact dashboard feed with the latest events across all agents.

### Acceptance criteria

- Agent creation, start, stop, restart, config changes, approval decisions, errors, backups, and restore actions all appear in the event feed as they are added by later milestones.
- Events are ordered consistently.
- The feed handles empty state, loading state, and pagination.
- An operator can understand what happened without reading raw database rows.
- Current shipped event types are `agent.created`, `agent.start_requested`, `agent.start_completed`, `agent.stop_requested`, `agent.stop_completed`, `agent.restart_requested`, `agent.restart_completed`, and `agent.deleted`; config, approval, error, backup, restore, runner, billing, Hermes, and Telegram events remain future milestone additions.

### Tests

- Event ordering tests.
- API pagination tests.
- UI test that performs actions and sees corresponding events.

## Milestone 4: Simulated Logs

Goal: Running agents produce fake logs before real execution exists.

### Technical implementation

- Add `agent_logs` table with:
  - `id`
  - `agent_id`
  - `runner_id`
  - `stream`
  - `level`
  - `message`
  - `sequence`
  - `created_at`
- Add a log panel to agent detail.
- Add `GET /api/agents/:agentId/logs` with cursor pagination.
- When an agent enters `running`, start a simulator that periodically writes lines such as:
  - `Checking task queue...`
  - `No pending tasks.`
  - `Heartbeat OK.`
  - `Memory loaded.`
- Stop simulation when the agent is stopped, deleted, or enters error.
- Add a developer-only action to simulate an error state.
- Keep audit events separate from high-volume logs.

### Acceptance criteria

- Starting an agent causes log lines to appear.
- Stopping an agent stops new log lines.
- Simulated error moves the agent to `error` and records an event.
- Logs stay scoped to the correct agent.

### Tests

- Background job test for generating logs only while running.
- API test for log pagination.
- UI test for start, wait, see logs, stop, and see log generation halt.

## Milestone 5: Agent Templates [Completed]

Goal: Users can choose useful predefined agent types.

### Technical implementation

- Add a template registry in source code, backed by a typed schema.
- Initial templates:
  - `research_agent`
  - `inbox_triage_agent`
  - `github_issue_agent`
  - `social_content_agent`
- Template fields:
  - `key`
  - `version`
  - `name`
  - `description`
  - `default_tools`
  - `default_schedule`
  - `default_system_prompt`
  - `required_integrations`
- Store `template_key`, `template_version`, and a `template_snapshot_json` on the agent or config so later template edits do not silently change existing agents.
- Render template metadata on the create flow and agent detail page.
- Keep templates as metadata only; do not integrate tools or model APIs yet.

### Acceptance criteria

- The create-agent form lists the initial templates. *done*
- Creating from `Research Agent` persists the template key and snapshot. *done*
- Agent detail shows template name, tools, schedule, and default prompt. *done*
- Template display works after page refresh. *done*

### Tests

- Schema test for all templates.
- Agent creation test with template snapshot.
- UI test for selecting and viewing template metadata.

## Milestone 6: Agent Config Editor [Completed]

Goal: Users can edit basic agent configuration and see changes persisted.

### Technical implementation

- Add `agent_configs` table or one-to-one config JSON with typed validation.
- Editable fields:
  - `name`
  - `system_prompt`
  - `model_provider`
  - `model_name`
  - `max_daily_spend_cents`
  - `schedule_mode`
  - `schedule_cron`
  - `timezone`
- Use a validation library or structured server-side schema for all config updates.
- Normalize money as integer cents.
- Add optimistic UI only after server validation is reliable.
- Compute a structured diff for config changes and write `config.updated` events.
- Do not store real API keys in this milestone; use placeholders or future secret references only.

### Acceptance criteria

- User can edit max daily spend and model name. *done*
- Refreshing the page preserves config changes. *done*
- Invalid spend, blank required fields, and invalid schedule values are rejected. *done*
- Config changes create readable timeline events. *done*

### Tests

- Validation tests for config schema.
- API tests for valid and invalid updates.
- Event test asserting changed fields are recorded without leaking secrets.
- UI test for edit, save, refresh.

## Milestone 7: Approval Queue, Fake Actions

Goal: Agents can request approval for actions, and users can approve or deny them.

### Technical implementation

- Add `agent_approvals` table:
  - `id`
  - `agent_id`
  - `title`
  - `description`
  - `status`
  - `payload_json`
  - `requested_by`
  - `resolved_by`
  - `created_at`
  - `resolved_at`
  - `expires_at`
- Add dashboard-level pending approvals panel.
- Add agent-detail approvals tab or section.
- Add approve and deny endpoints.
- Resolve approvals transactionally and write events:
  - `approval.requested`
  - `approval.approved`
  - `approval.denied`
- Extend the fake running-agent simulator to occasionally create approval requests for actions such as sending a Telegram message, running a research task, or accessing Gmail.
- Ensure resolved approvals cannot be approved or denied again.

### Acceptance criteria *done*

- Pending approvals appear on dashboard and agent detail.
- Approve changes status to `approved`.
- Deny changes status to `denied`.
- Decisions are recorded in the event log.
- Repeated approve/deny requests are idempotent or rejected cleanly.

### Tests

- API tests for approval lifecycle.
- Transaction test that approval decision and event are written together.
- UI test for pending approval, approve, and deny.

## Milestone 8: Mobile Control Panel [Completed]

Goal: The core operations surface is usable from a phone.

### Technical implementation

- Build or refine mobile routes:
  - `/agents`
  - `/approvals`
  - `/alerts`
- Keep mobile focused on quick operations:
  - view agent status
  - pause or resume
  - approve or deny
  - view latest logs
  - view alerts
- Use responsive layouts with stable button sizes, readable tables converted to lists, and no desktop-only hover dependency.
- Add an alerts model if needed, or derive alerts from `agent_events` and runner state until a dedicated table is justified.
- Ensure dangerous actions require confirmation on mobile.
- Keep full agent creation and complex config editing available but not optimized as the primary mobile workflow.

### Acceptance criteria *done*

- On a phone viewport, agent list is readable and actionable.
- User can stop or resume an agent without layout issues.
- User can approve or deny a request from mobile.
- Latest logs and alerts are readable.
- No core mobile controls are hidden behind desktop-only UI.

### Tests

- Responsive viewport checks for iPhone-sized and small Android-sized widths.
- UI test for mobile approval flow.
- UI test for mobile stop/resume action.

## Milestone 9: Local Hermes Runner Adapter [Completed]

Goal: Replace fake lifecycle behavior with a real local process adapter.

### Technical implementation

- Define a runner adapter interface:

```ts
type RunnerAgentStatus = "starting" | "running" | "stopped" | "error";

interface RunnerAdapter {
  startAgent(agentId: string): Promise<void>;
  stopAgent(agentId: string): Promise<void>;
  restartAgent(agentId: string): Promise<void>;
  getAgentStatus(agentId: string): Promise<RunnerAgentStatus>;
  streamLogs(agentId: string): AsyncIterable<RunnerLogLine>;
}
```

- Implement a local process runner that can launch a dummy long-running process first.
- Keep Hermes command details behind adapter configuration so the implementation can swap from dummy runner to real Hermes without UI changes.
- Use process spawning with argument arrays, not shell interpolation.
- Track process IDs in a local registry or durable runner state table.
- Capture stdout and stderr into `agent_logs`.
- On process exit, update agent status to `stopped` or `error` depending on exit reason.
- Add runner contract tests that do not depend on Hermes being installed.

### Acceptance criteria

- Starting an agent launches a real local process.
- Stopping an agent terminates that process.
- Process logs appear in the dashboard.
- Unexpected process exit changes status to `error`.
- The dashboard still uses the same lifecycle buttons and status model.

### Tests

- Runner adapter contract tests using a dummy process.
- API integration test through lifecycle endpoints.
- Crash test that exits the process and verifies `error` status and event.

## Milestone 10: Dockerized Agent Runner [Completed]

Goal: Each agent runs in its own container.

### Technical implementation

- Add a Docker runner implementation behind the same runner adapter interface.
- Use container names or labels such as `agentbay.agent_id=<agentId>`.
- Mount per-agent config into the container read-only where possible.
- Mount a per-agent workspace volume for mutable data.
- Apply initial resource limits for memory and CPU.
- Capture logs from Docker log streams into `agent_logs`.
- Use Docker inspect or health checks to derive status.
- Detect container crash and update agent status to `error`.
- Avoid mixing logs by always filtering by container label or exact container ID.
- Add a cleanup path for stopped and deleted agents.

### Acceptance criteria *done*

- Start creates one container for the selected agent.
- Stop stops only that agent's container.
- Restart recreates or restarts the correct container.
- Logs appear in the dashboard and are not mixed across agents.
- Container crash is detected.

### Tests

- Docker runner contract tests, skipped or marked separately when Docker is unavailable.
- Integration test for start, stop, restart, logs, and crash detection.
- Cleanup test for deleted agents.

## Milestone 11: Single Cloud VM Deployment

Goal: Control agents on one manually provisioned remote VPS before automating cloud provisioning.

Status: local contract implementation and operator documentation are present, but Milestone 11 is not marked complete until an authorized hosted dashboard plus manual VPS smoke test verifies the acceptance criteria below, or the user explicitly accepts deferring that external smoke blocker.

### Technical implementation

- Manually create one VPS and install Docker plus the runner service.
- Deploy the dashboard separately and configure it with the runner endpoint.
- Add minimal `runners` support if not already present:
  - `id`
  - `user_id`
  - `name`
  - `kind`
  - `endpoint_url`
  - `status`
  - `created_at`
  - `updated_at`
- Add a runner assignment field on `agents`.
- Implement dashboard-to-runner command forwarding for start, stop, restart, status, and logs.
- Use HTTPS for runner traffic. A temporary manually configured token is acceptable only for this milestone and must be replaced in Milestone 12.
- Make runner reconnect and dashboard redeploy tolerant by storing runner identity and endpoint in the database.

### Acceptance criteria

- Hosted dashboard can start an agent on the manually provisioned VPS.
- Remote logs flow back into the dashboard.
- Stop and restart work remotely.
- Runner remains known after dashboard redeploy.
- Failure to reach the runner is visible in the UI.

### Tests

- Contract test against a locally hosted runner service.
- Staging smoke test against the manual VPS.
- UI test showing remote runner status and agent logs.

## Milestone 12: Secure Runner Auth [Completed]

Goal: Dashboard and runner communicate safely with registration, identity, and heartbeat.

Status: local automated acceptance is complete. The final #134 evidence map covers every acceptance criterion with passing focused tests, serialized aggregate unit coverage, production build, and Playwright smoke/full-suite evidence. The default-parallel `bun run verify` path still fails in the known shared local database isolation mode, so completion relies on the documented serialized/focused rerun evidence rather than claiming the default-parallel aggregate passed.

### Technical implementation

- Add runner registration flow:
  - dashboard creates one-time registration token
  - runner exchanges token for runner identity and scoped credential
  - dashboard stores only hashed long-lived runner credential material
- Add authenticated runner commands using bearer tokens, HMAC signatures, or mTLS. Keep the first implementation simple but explicit.
- Add replay protection for signed command requests if using HMAC.
- Add `runner_heartbeats` table:
  - `id`
  - `runner_id`
  - `status`
  - `version`
  - `metrics_json`
  - `last_seen_at`
  - `created_at`
- Add heartbeat endpoint and background offline detection.
- Show runner health in dashboard and agent detail.
- Rotate or revoke runner credentials from settings.
- Reject unauthenticated and wrong-runner requests.

### Acceptance criteria **done**

- Unauthorized runner API requests fail.
- Registered runner heartbeat changes status to `online`.
- Missing heartbeat changes status to `offline`.
- Agent pages show runner health.
- Credential revocation prevents further runner communication.

### Tests

- Auth tests for missing, malformed, expired, revoked, and wrong-runner credentials.
- Heartbeat tests for online/offline transitions.
- UI test for runner offline and online status.

## Milestone 13: Cloud Provisioning V1

Goal: Automatically create a DigitalOcean runner without exposing cloud setup to the user.

### Technical implementation

- Add a provider abstraction, but implement only DigitalOcean first.
- Use platform-owned DigitalOcean infrastructure for MVP unless the business explicitly chooses BYO cloud later.
- Add provisioning records or extend `runners` with:
  - `provider`
  - `provider_resource_id`
  - `region`
  - `size_slug`
  - `image`
  - `provisioning_status`
  - `provisioning_error`
- Add `POST /api/runners` or `Create runner` action.
- Backend provisioning job:
  - creates a one-time runner registration token
  - creates a Droplet with tags
  - applies firewall rules
  - injects cloud-init to install Docker and runner service
  - runner registers itself with AgentBay
  - dashboard marks runner ready only after an online heartbeat and an authenticated probe through the runner's public endpoint
- Persist every provisioning phase so refreshes show progress.
- Add rollback or cleanup for failed provisioning where safe.
- Keep cloud provider secrets server-side only.

### Acceptance criteria

- User clicks Create runner and sees provisioning progress.
- Droplet is created.
- Runner installs itself and registers.
- Dashboard shows runner `online`.
- User can create or assign an agent to the new runner.
- Provisioning failure is visible and actionable.

### Tests

- Provider unit tests with fake DigitalOcean client.
- Provisioning job tests for success and failure states.
- One real smoke test before beta using a small Droplet.
- Security test that provider credentials are never exposed to the browser.

## Milestone 14: One User, Multiple Agents

Goal: A user can run multiple agents on one runner with separated status, logs, and capacity.

### Technical implementation

- Add runner placement logic:
  - choose user's online runner
  - check plan limits
  - check runner capacity
  - assign `runner_id` to agent
- Add capacity fields or snapshots:
  - `max_agents`
  - `running_agents`
  - `cpu_used_percent`
  - `memory_used_mb`
  - `memory_total_mb`
  - `disk_used_mb`
  - `disk_total_mb`
- Add runner capacity UI, such as `3 / 5 agents running`.
- Ensure container names, volumes, config paths, and log streams are unique per agent.
- Add concurrency handling so two starts cannot overbook capacity.
- Keep multiple runners out of scope except where needed by billing or provisioning state.

### Acceptance criteria

- User can create three agents and start all on one runner.
- Stopping one agent does not affect the others.
- Logs stay separated by agent.
- Runner capacity is visible and updates.
- Capacity and plan limits block excess starts or creates.

### Tests

- Placement tests for capacity available and unavailable.
- Concurrency test for simultaneous start requests.
- Integration test with multiple agents and separated logs.
- UI test for capacity display.

## Milestone 15: Backups and Restore

Goal: Users can recover agent config, memory, and important metadata.

### Technical implementation

- Start with manual backup and restore; scheduled backups can come later.
- Store backup artifacts in S3-compatible object storage, such as DigitalOcean Spaces or AWS S3.
- Add `backups` table:
  - `id`
  - `agent_id`
  - `runner_id`
  - `status`
  - `storage_uri`
  - `manifest_json`
  - `created_by`
  - `created_at`
  - `restored_at`
- Backup manifest should include:
  - agent metadata
  - config
  - template snapshot
  - system prompt
  - skills folder metadata
  - memory files
  - logs metadata, not necessarily full high-volume logs
- Encrypt sensitive backup payloads or exclude secrets and store secret references only.
- Restore can initially create a new agent from backup to avoid overwriting a running agent.
- Write `backup.created` and `backup.restored` events.

### Acceptance criteria

- User can create a manual backup.
- Backup status is visible.
- User can restore an agent from backup.
- Restored agent has expected config and metadata.
- Backup and restore events appear in the timeline.

### Tests

- Backup manifest schema tests.
- Object storage fake tests for upload and download.
- Restore test creating a new agent from backup.
- Security test ensuring raw secrets are not written into backup manifests.

## Milestone 16: Cost Tracking

Goal: Show users the infrastructure cost of running agents.

### Technical implementation

- Start with infrastructure cost only; token/model spend comes later.
- Add provider price metadata for supported Droplet sizes.
- Track runner uptime and agent running intervals from lifecycle events or dedicated usage periods.
- Add daily and monthly cost estimates:
  - runner cost per month
  - estimated cost per day
  - agents running
  - estimated infra cost per agent
- Add cost summary to dashboard and runner detail.
- Add event or usage records when agents start and stop so estimates are reproducible.
- Keep estimates labeled as estimates unless reconciled against provider invoices.

### Acceptance criteria

- Dashboard displays runner monthly cost.
- Dashboard displays estimated cost per running agent.
- Daily and monthly views exist.
- Start and stop times affect estimates.
- Users can understand why a plan costs more than raw compute.

### Tests

- Cost calculation tests for uptime and multiple agents.
- UI test for cost summary.
- Edge-case tests for stopped agents, partial days, and missing stop events.

## Milestone 17: Billing Gate

Goal: Charge for the product and enforce plan limits.

### Technical implementation

- Add plans:
  - Starter: 1 runner, 1 agent
  - Operator: 1 runner, 3 agents
  - Agency: multiple runners and agents
- Add Stripe Checkout for subscription creation.
- Add Stripe Customer Portal for cancellation and payment method updates if available in the chosen billing setup.
- Add webhook handling for subscription lifecycle events.
- Store:
  - `stripe_customer_id`
  - `stripe_subscription_id`
  - `plan_key`
  - `subscription_status`
  - `current_period_end`
  - plan limits
- Enforce limits before creating agents, starting agents, and provisioning runners.
- Add clear billing-blocked states instead of failing silently.
- Add manual override fields for early beta users if needed.

### Acceptance criteria

- Test user can complete checkout.
- Subscription status syncs into AgentBay.
- Free or unpaid user cannot create resources beyond allowed limits.
- Paid user can create resources within plan limits.
- Cancelled user is blocked from creating new paid resources while existing cleanup behavior is explicit.

### Tests

- Webhook signature and event tests.
- Limit enforcement tests for create agent, start agent, and create runner.
- Checkout success and cancelled-flow tests.
- Cancellation behavior test.

## Milestone 18: Real Hermes Integration

Goal: Replace dummy runner behavior with actual Hermes plus Telegram plus BYOK.

### Delivery status (2026-08-03)

The control-plane and runner implementation is complete through the local acceptance boundary.
Feature-gated `launchMode:"ready"` creation atomically persists encrypted OpenRouter, Telegram,
allowlist, and private API credentials; a versioned Hermes projection; and durable deployment state.
The reconciler advances persisted setup stages, records at most one successful bounded model canary
per deployment/config revision, requires Telegram connected before readiness, and presents redacted
failures with Retry, Stop, or Delete controls. An explicit Retry creates a new persisted attempt and
may incur one additional bounded canary charge. Existing `launchMode:"stopped"` creation remains the
rollback path.

Post-ready runtime reconciliation is also implemented. Selected Hermes containers use
`unless-stopped`; desired-running agents are observed and recovered with bounded backoff and a
circuit breaker, while intentional Stop persists desired stopped state before cleanup. Deterministic
unit/browser coverage, the local cloud smoke, and the pinned-image Hermes contract smoke verify this
boundary without external provider or Telegram side effects.

Milestone 18 is not accepted for hosted rollout yet. A scanned/published release-candidate image,
authorized DigitalOcean budget, funded OpenRouter key, and dedicated Telegram bot/user are still
required for the real message/reply, restart, durable Stop, redaction, and cleanup acceptance. The
default-disabled `bun run verify:hermes:staging` workflow now has a durable hosted ledger, exact
published-image and owned-resource attestation, bounded reconciliation, interactive-human Telegram
proof before and after Restart, and ordered cleanup. It still fails closed without all 15 explicit
capabilities and has not produced live acceptance evidence. Native provider OAuth remains deferred;
the implemented narrow path is OpenRouter BYOK.

### Technical implementation

- Confirm current Hermes install, CLI, config, and Telegram integration details during implementation; do not hard-code assumptions from this planning document without verification.
- Support one narrow real path first:
  - Hermes runtime
  - Telegram integration
  - bring-your-own model key
- Add secret storage for model provider keys and Telegram credentials. Store encrypted secrets or references to a secret manager; never store plaintext keys in events, logs, or backups.
- Generate per-agent Hermes config from `agent_configs`, template snapshot, and integration settings.
- Mount per-agent config, skills, memory, and workspace into the runner container.
- Capture Hermes stdout/stderr into `agent_logs`.
- Add readiness detection so the UI can show when Hermes is booted and reachable.
- Add stop and restart behavior that gracefully terminates Hermes before killing the container.
- Add a narrow end-to-end smoke path: create Telegram-connected agent, start it, send a Telegram message, receive a reply, inspect logs, stop it.

### Acceptance criteria

- Hermes boots inside the runner environment.
- Agent can respond through Telegram.
- BYOK model config is used without exposing the key.
- Logs appear in AgentBay.
- Stop and restart work.
- Failure to boot Hermes creates an `agent.error` event with safe diagnostic detail.

### Tests

- Config generation tests with secrets redacted.
- Runner integration test with a mocked Hermes process where possible.
- Manual or automated smoke test for Telegram reply before beta.
- Log redaction tests for API keys and tokens.

## Milestone 19: Public Beta Version

Goal: Make AgentBay usable by 5 to 10 real users without founder-assisted setup.

### Delivery status (2026-08-03)

The feature-gated create-to-ready UI, persisted deployment/runtime status, mobile presentation,
manual lifecycle controls, redacted events/logs, runners, approvals, backups, and cost estimates
provide most of the operational path needed for a beta canary. Automatic-ready creation remains
disabled by default, and the hosted Telegram reply acceptance described under Milestone 18 has not
been run. Billing/manual-payment completion, admin/support surfaces, production Clerk cutover, and
multi-user private-beta acceptance also remain open; Milestone 19 is therefore not complete.

### Technical implementation

- Complete the integrated beta flow:
  - signup/login
  - create agent
  - provision runner
  - configure BYOK and Telegram
  - start, stop, restart
  - view logs and events
  - review approvals
  - manual backup and restore
  - billing or manual payment
  - admin visibility
  - error reporting
- Add admin panel views for users, agents, runners, provisioning failures, billing status, and recent errors.
- Add operational telemetry:
  - agent created
  - runner provisioned
  - agent started
  - approval resolved
  - backup created
  - Hermes reply observed
  - billing conversion
- Add error reporting and alerting for provisioning failures, runner offline, payment webhook failure, and Hermes boot failure.
- Add onboarding checklist so a beta user knows what remains to get a working agent.
- Add basic support tooling to inspect logs and events without direct database access.
- Add data-retention and deletion behavior for failed provisioning and deleted agents.

### Acceptance criteria

- A beta user can create a working Telegram-connected Hermes agent without founder help.
- User understands what the agent is doing from logs, events, and status.
- User can stop or restart the agent when needed.
- User can recover from a basic config loss using restore.
- Billing or manual payment path is operational.
- Admin can diagnose failed provisioning, offline runners, and Hermes boot failures.

### Tests

- End-to-end beta smoke test covering signup through real agent response.
- Failure-path tests for provisioning failure, runner offline, and billing webhook failure.
- Admin visibility tests.
- Mobile smoke test for approval and stop/restart.

## Recommended Build Order

1. Product skeleton.
2. Agent model and CRUD.
3. Fake lifecycle controls.
4. Event log.
5. Simulated logs.
6. Templates.
7. Config editor.
8. Approval queue.
9. Mobile control panel.
10. Local runner.
11. Docker runner.
12. Remote runner on one manual VPS.
13. Secure runner auth.
14. Automated DigitalOcean provisioning.
15. Multiple agents on one runner.
16. Backups and restore.
17. Cost tracking.
18. Billing gate.
19. Real Hermes plus Telegram.
20. Public beta.

## Agent-Ready Ticket Pattern

Each coding-agent ticket should be small enough to produce one visible behavior and one focused commit.

Good ticket format:

```txt
Implement the agent_events table and render the latest 20 events on the agent detail page.

Constraints:
- Do not change auth.
- Do not add real execution.
- Add tests for event insertion and event ordering.
- Use existing UI components.
- Update seed data if the repo has seed data.
```

Avoid broad tickets such as:

```txt
Build the agent dashboard.
```

## Definition of Done for MVP

The MVP is ready for public beta when:

- Users can sign up and create an agent.
- Users can provision one hosted runner without touching cloud infrastructure.
- Users can configure Hermes plus Telegram plus BYOK model settings.
- Users can start, stop, restart, inspect logs, and inspect events.
- Users can approve or deny sensitive actions.
- Users can create and restore a basic backup.
- Plan limits are enforced through billing or manual beta overrides.
- Admins can inspect users, agents, runners, billing state, logs, and failures.
- Runner communication is authenticated.
- Secrets are encrypted or stored through a secret manager and redacted from logs, events, and backups.
- The beta smoke test proves a user can receive a Telegram reply from a hosted Hermes agent.
