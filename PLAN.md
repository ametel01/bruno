# Implementation Plan

## Source Documents
- Path: `/Users/alexmetelli/source/agentbay/docs/MILESTONES.md`
  - Role: Primary milestone roadmap.
  - Summary: Milestone 16, "Cost Tracking", requires infrastructure-cost-only estimates for supported DigitalOcean runner sizes, reproducible runner/agent usage intervals, daily and monthly cost views, dashboard and runner-detail summaries, estimate labeling, and tests for uptime, multiple agents, stopped agents, partial days, missing stop events, and UI cost summaries.

## Goals
- Show users estimated infrastructure cost for running AgentBay runners and agents.
- Keep the first cost model limited to infrastructure cost; token/model spend and billing enforcement remain future work.
- Persist enough usage facts for estimates to be reproducible from runner and agent start/stop timing.
- Display runner monthly cost, estimated daily cost, running-agent count, and estimated cost per agent on the dashboard.
- Display cost context on runner detail surfaces so users can understand why the plan cost is higher than raw compute.
- Provide daily and monthly views with explicit "estimate" language unless values are reconciled against provider invoices.

## Non-Goals
- Do not add Stripe, subscriptions, payment collection, invoices, checkout, billing gates, or plan enforcement.
- Do not estimate model, token, storage, backup, bandwidth, support, tax, or payment-processing costs beyond the explicit infrastructure estimate explanation.
- Do not call DigitalOcean pricing APIs at runtime; use checked-in provider price metadata for supported Droplet sizes.
- Do not add multi-user billing isolation beyond the existing development-user persistence pattern in this repo.
- Do not add a new standalone runner-detail route unless implementation discovers an existing local route convention that requires it; extend the existing dashboard, settings runner management, and assigned-runner detail surfaces first.

## Definition of Done
- Supported DigitalOcean Droplet size slugs have provider price metadata with monthly and derived daily/hourly rates and tests for known supported sizes.
- Agent lifecycle start and stop paths create or close durable usage records, or derive equivalent reproducible periods from persisted lifecycle events with deterministic handling for missing stop events.
- Daily and monthly estimate DTOs account for runner uptime, multiple running agents, stopped agents, partial days, and open-ended intervals at a supplied clock time.
- Dashboard displays runner monthly cost and estimated cost per running agent with clear estimate labeling.
- Daily and monthly cost views exist in the UI and are backed by tested server-side summaries.
- Runner detail surfaces show the runner's estimated infrastructure cost context, including raw compute, platform/plan explanation text, running-agent count, and per-agent estimate.
- Cost estimates are labeled as estimates everywhere unless a future invoice reconciliation source is present.
- Acceptance criteria from `docs/MILESTONES.md` are verified by unit tests, UI tests, and a final quality-gate run.
- `PROGRESS.md` is current for Milestone 16 and records completed steps, validation evidence, commit references if available, current status, and next step.
- `CHANGELOG.md` follows Keep a Changelog 1.0.0 and includes only functional Milestone 16 changes under `## [Unreleased]`.

## Assumptions and Open Questions
- Assumption: DigitalOcean size slugs already stored on `runners.sizeSlug` are the source for provider price lookup. Impact: manual VPS runners or unknown sizes should render "price unavailable" rather than blocking the page.
- Assumption: The first implementation can use checked-in static price metadata for the supported sizes visible in current config/tests: `s-1vcpu-512mb-10gb`, `s-1vcpu-1gb`, and `s-2vcpu-2gb`. Impact: adding a new supported Droplet size later requires updating metadata and tests.
- Assumption: "Runner detail" maps to existing runner-detail surfaces: dashboard runner health/provisioning cards, settings runner management, and assigned runner information on agent detail. Impact: no new route is required for milestone completion unless a later implementation decision adds one.
- Assumption: Usage intervals may be stored in a dedicated table because milestone 16 explicitly asks for event or usage records and reproducible estimates. Impact: this adds a migration and lifecycle writes, but avoids relying only on text event semantics.
- Open question: The exact platform markup or plan-inclusive cost explanation is not specified. Conservative default: show raw compute estimate plus explanatory copy that the user-facing plan may include infrastructure, orchestration, backups, monitoring, support, and margin, without adding billing amounts.

## Implementation Approach
- Add a small server-only cost domain under `src/server/costs/` for price metadata, interval math, cost DTOs, and development-user summary queries. Keep calculations pure and deterministic where possible.
- Add a Drizzle migration for a dedicated usage-period table, for example `agent_usage_periods`, with `agent_id`, `runner_id`, `started_at`, nullable `stopped_at`, `source`, non-secret metadata, and indexes by runner/time and agent/time. The table should reject inverted intervals.
- Instrument `startAgentForDevelopmentUser` and `stopAgentForDevelopmentUser` after successful runner operations so completed lifecycle actions open and close usage periods transactionally with existing agent status and audit events. Restart should close and reopen periods only if the existing restart flow performs stop/start semantics; otherwise preserve a continuous running period when the agent remains running.
- Treat missing stop timestamps as open intervals bounded by the calculation clock. Treat missing or unknown runner price metadata as unavailable, not zero, so the UI does not imply free infrastructure.
- Derive runner-level cost from `runners.kind`, `runners.provider`, `runners.sizeSlug`, runner lifecycle timestamps/usage observations, and assigned/running agent counts. For DigitalOcean runners, use monthly price metadata. For manual or unknown runners, show estimate-unavailable state with explanatory text.
- Allocate runner infrastructure cost per agent by dividing the runner's estimate for the selected window by the number of agents active during that same window. Handle zero active agents explicitly to avoid divide-by-zero and misleading per-agent values.
- Expose summaries through server functions consumed by existing React Server Components. Do not introduce client-side pricing state or duplicate math in components.
- Reuse existing UI patterns: definition lists inside runner panels, existing `PlaceholderPanel`/runner panel structure, and the existing dashboard/agent detail loaders. Keep visible copy concise and operational rather than billing-marketing language.
- Keep all secret-bearing inputs out of cost summaries, events, metadata, test output, issue bodies, and progress logs.

## Quality Gates
- Setup status: Existing Bun, Biome, TypeScript, Vitest, Next build, Playwright, Drizzle, and CI gates are configured in `package.json`, `playwright.config.ts`, `vitest.config.ts`, `drizzle.config.ts`, and `.github/workflows/ci.yml`.
- Baseline command: `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run verify`
- Format command: `bun run format:check`
- Lint command: `bun run lint`
- Typecheck command: `bun run typecheck`
- Test command: `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test`
- Build command: `bun run build`
- E2E command: `PORT=3100 DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3100 bun run test:e2e`
- Migration command: `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay bun run db:migrate`
- Full verification command: `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run verify`

## Progress Tracking
- File: `PROGRESS.md`
- Requirement: Update `PROGRESS.md` for Milestone 16 before implementation work begins. The file already exists from an earlier rollout, so replace or append in a way that clearly makes Milestone 16 the active tracker.
- Update rule: After each step is completed, update `PROGRESS.md` with the completed step, validation results, commit reference if available, current status, and next step.

## Changelog Tracking
- File: `CHANGELOG.md`
- Standard: Keep a Changelog 1.0.0, <https://keepachangelog.com/en/1.0.0/>
- Requirement: `CHANGELOG.md` already exists and has `# Changelog`, the standard preamble, and `## [Unreleased]`. Confirm that structure before implementation starts.
- Update rule: After each step is completed and validated, update `CHANGELOG.md` before creating that step's commit only if the step shipped a functional change. Omit entries for chores, progress tracking, implementation plans, docs-only updates, tests or coverage, CI or validation runs, framework migration housekeeping, and empty category headings.

## Goal Handoff
- Readiness: This plan is ready to be used as a `/goal` payload.
- Scope: The `/goal` should execute only Milestone 16 Cost Tracking work described in this plan unless the user explicitly expands it.
- Done: The `/goal` is complete only when every item in `## Definition of Done` is satisfied, all incremental steps are complete, required quality gates pass or documented pre-existing failures are handled, `PROGRESS.md` and `CHANGELOG.md` are current, and the final state is summarized for the user.

## Incremental Steps

### Step 0: Progress and Changelog Tracking Setup
Goal: Establish active Milestone 16 tracking before code, migration, or UI work starts.

Depends on:
- None.

Changes:
- Update `PROGRESS.md` in the project root so it clearly tracks Milestone 16 Cost Tracking, source document, issue links, step checklist, current status, and update log.
- Confirm `CHANGELOG.md` exists and follows the required Keep a Changelog 1.0.0 structure.
- Record that changelog entries are added only for functional cost-tracking behavior, not for setup, planning, tests-only, or validation-only work.

Acceptance criteria:
- `PROGRESS.md` identifies Milestone 16 as the active plan and lists every incremental step in this plan.
- `CHANGELOG.md` has `# Changelog` and `## [Unreleased]`.
- No secrets or provider credentials are recorded.

Validation:
- Run `test -f PROGRESS.md`
- Run `test -f CHANGELOG.md`
- Run `rg "Milestone 16|Cost Tracking|Step 0|Step 1|Step 2|Step 3|Step 4|Step 5|Step 6" PROGRESS.md`
- Run `rg "# Changelog|## \\[Unreleased\\]" CHANGELOG.md`
- Run `git diff --check`

Progress:
- Mark Step 0 complete in `PROGRESS.md`, record validation results, set current status, and identify Step 1 or Step 2 as the next parallel implementation work.

Changelog:
- Do not add a changelog entry for progress and changelog tracking setup because it is not a functional change.

Commit:
- `docs: track milestone 16 cost work`

### Step 1: Add Provider Price Metadata
Goal: Add a tested infrastructure price catalog for supported DigitalOcean runner sizes.

Depends on:
- Step 0.

Changes:
- Add a server-only price metadata module under `src/server/costs/` for supported DigitalOcean Droplet sizes.
- Include monthly price in integer cents and derived daily/hourly helpers that avoid floating-point display drift.
- Cover known supported/configured size slugs: `s-1vcpu-512mb-10gb`, `s-1vcpu-1gb`, and `s-2vcpu-2gb`.
- Add tests under `tests/unit/` for known prices, unknown size fallback, derived rates, and formatting-safe DTO output.

Acceptance criteria:
- Supported Droplet sizes resolve to provider, size slug, monthly cents, daily cents estimate, and hourly/monthly display fields.
- Unknown or unsupported sizes produce an explicit unavailable result, not a zero-cost result.
- Price metadata contains no credentials and does not call provider APIs.

Validation:
- Run `bun run format:check`
- Run `bun run lint`
- Run `bun run typecheck`
- Run `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test tests/unit/cost-prices.test.ts`
- Run `git diff --check`

Progress:
- Update `PROGRESS.md` with completion notes, validation results, commit reference if available, current status, and next step.

Changelog:
- Add an `Added` entry only if this step exposes functional cost metadata to runtime code; otherwise defer the changelog entry until the estimate service consumes it.

Commit:
- `feat: add runner price metadata`

### Step 2: Persist Agent Usage Periods
Goal: Make start and stop timing reproducible for cost estimates.

Depends on:
- Step 0.

Changes:
- Add a Drizzle schema and migration for dedicated agent usage periods or an equivalent durable usage record model.
- Open a usage period after a successful start transition and close the latest open period after a successful stop transition.
- Ensure restart behavior does not double-count time; either keep a continuous period when restart preserves running state, or close/reopen periods with tests documenting the selected behavior.
- Include `runner_id` where available so costs can be allocated to the runner that hosted the agent.
- Add lifecycle/unit tests covering start, stop, stopped agents, repeated stop attempts, restart behavior, open intervals, and missing stop events.

Acceptance criteria:
- Successful agent starts create reproducible usage records.
- Successful agent stops close the correct open usage record.
- Missing stop events remain calculable as open intervals bounded by the cost calculation clock.
- Usage records do not expose runner credentials, endpoint internals, provider tokens, or backup storage URIs.

Validation:
- Run `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay bun run db:migrate`
- Run `bun run format:check`
- Run `bun run lint`
- Run `bun run typecheck`
- Run `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test tests/unit/agent-schema.test.ts tests/unit/start-agent-route.test.ts tests/unit/stop-agent-route.test.ts`
- Run any new targeted usage-period tests.
- Run `git diff --check`

Progress:
- Update `PROGRESS.md` with completion notes, validation results, commit reference if available, current status, and next step.

Changelog:
- Add an `Added` entry for reproducible infrastructure usage tracking after validation.

Commit:
- `feat: persist agent usage periods`

### Step 3: Build Daily and Monthly Cost Estimate Service
Goal: Convert price metadata and usage periods into deterministic runner and per-agent estimate DTOs.

Depends on:
- Step 1.
- Step 2.

Changes:
- Add pure interval math helpers for clipping usage periods to daily and monthly windows.
- Add a development-user cost summary query that joins runners, agents, usage periods, and price metadata.
- Compute runner monthly cost, estimated cost per day, active/running agent counts, and estimated infrastructure cost per agent.
- Return explicit estimate labels, unavailable states, and explanation fields for raw compute versus user-facing plan cost.
- Add unit tests for uptime, multiple agents, partial days, stopped agents, open intervals/missing stops, unknown size slugs, and zero-agent windows.

Acceptance criteria:
- Daily and monthly summaries are deterministic when supplied a fixed clock.
- Multiple agents on one runner allocate cost without double-counting runner infrastructure.
- Stopped agents and partial-day intervals affect estimates correctly.
- Missing stop timestamps are treated as open intervals through the calculation clock.
- Unknown prices produce unavailable estimates with safe explanatory text.

Validation:
- Run `bun run format:check`
- Run `bun run lint`
- Run `bun run typecheck`
- Run `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test tests/unit/cost-estimates.test.ts`
- Run any changed lifecycle/cost integration tests.
- Run `git diff --check`

Progress:
- Update `PROGRESS.md` with completion notes, validation results, commit reference if available, current status, and next step.

Changelog:
- Add an `Added` entry for daily/monthly infrastructure cost estimate calculation.

Commit:
- `feat: calculate runner cost estimates`

### Step 4: Add Dashboard Cost Summary and Views
Goal: Show dashboard users the monthly runner cost, cost per running agent, and daily/monthly views.

Depends on:
- Step 3.

Changes:
- Load the cost summary from the dashboard server component.
- Add a dashboard cost summary panel using existing page/panel styles and dense operational layout.
- Display runner monthly cost, estimated cost per running agent, running agents, estimated daily cost, and estimate labels.
- Add daily and monthly view controls or sections that are visible and testable without introducing client-side duplicate calculation logic.
- Add unit and Playwright coverage for the dashboard cost summary, daily/monthly views, estimate labels, and unavailable-state rendering.

Acceptance criteria:
- Dashboard displays runner monthly cost.
- Dashboard displays estimated cost per running agent.
- Daily and monthly views exist.
- Estimate labels are visible.
- UI does not expose raw runner IDs, credentials, endpoint tokens, provider tokens, or secret-looking metadata.

Validation:
- Run `bun run format:check`
- Run `bun run lint`
- Run `bun run typecheck`
- Run `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test tests/unit/root-page.test.tsx`
- Run `PORT=3100 DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3100 bun run test:e2e -- tests/e2e/root-route.spec.ts`
- Run `git diff --check`

Progress:
- Update `PROGRESS.md` with completion notes, validation results, commit reference if available, current status, and next step.

Changelog:
- Add an `Added` entry for dashboard infrastructure cost visibility.

Commit:
- `feat: show dashboard cost estimates`

### Step 5: Add Runner Detail Cost Context
Goal: Help users understand runner-specific estimate context and why a plan costs more than raw compute.

Depends on:
- Step 3.

Changes:
- Extend existing runner-detail surfaces, prioritizing assigned runner details on `app/agents/[agentId]/page.tsx`, dashboard runner status/provisioning cards, and settings runner management if needed.
- Reuse the same server-side cost DTOs as the dashboard; do not duplicate calculation logic in React components.
- Show raw infrastructure estimate, running-agent allocation, provider size slug when safe, unavailable states, and clear explanatory copy that user-facing plans may include orchestration, monitoring, backups, support, and margin.
- Add tests for rendered runner detail cost context, estimate labels, unavailable cost states, and secret redaction.

Acceptance criteria:
- Runner detail surfaces include a cost summary for known priced DigitalOcean runners.
- Unknown/manual runner prices are visibly unavailable rather than shown as zero.
- Users can understand why a plan costs more than raw compute without this milestone adding billing enforcement.
- Existing runner health/capacity details remain visible and do not overlap with new cost content.

Validation:
- Run `bun run format:check`
- Run `bun run lint`
- Run `bun run typecheck`
- Run `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run test tests/unit/root-page.test.tsx`
- Run any new runner cost component tests.
- Run `PORT=3100 DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3100 bun run test:e2e -- tests/e2e/root-route.spec.ts`
- Run `git diff --check`

Progress:
- Update `PROGRESS.md` with completion notes, validation results, commit reference if available, current status, and next step.

Changelog:
- Add an `Added` entry for runner-level infrastructure cost context.

Commit:
- `feat: show runner cost context`

### Step 6: Final Acceptance and Milestone Closeout
Goal: Prove Milestone 16 acceptance criteria end to end and close out tracking artifacts.

Depends on:
- Step 4.
- Step 5.

Changes:
- Review `docs/MILESTONES.md` Milestone 16 acceptance criteria against implementation and tests.
- Add or adjust focused tests for any uncovered edge cases: stopped agents, partial days, multiple agents, missing stop events, daily/monthly view visibility, and cost summary UI.
- Run the full verification gate with local Postgres and Playwright.
- Update `PROGRESS.md` with final validation evidence and current status.
- Reconcile `CHANGELOG.md` so it contains only notable functional cost-tracking changes and no setup/test-only noise.

Acceptance criteria:
- Every Milestone 16 acceptance criterion is explicitly satisfied or has a documented reason approved by the user.
- Full verification passes, or any pre-existing unrelated failure is clearly documented with evidence.
- `PROGRESS.md` and `CHANGELOG.md` are current.
- No adjacent Milestone 17 billing-gate work is included.

Validation:
- Run `DATABASE_URL=postgres://agentbay:agentbay@127.0.0.1:54329/agentbay NEXT_PUBLIC_APP_URL=http://localhost:3000 bun run verify`
- Run `git diff --check`
- Run `rg "Milestone 17|Stripe|subscription|checkout|invoice|token spend|model spend" src app tests drizzle CHANGELOG.md PROGRESS.md` and confirm any matches are pre-existing references or explicit non-goal language, not milestone scope creep.

Progress:
- Mark Step 6 complete in `PROGRESS.md`, record validation results, commit reference if available, and summarize the final milestone state.

Changelog:
- Ensure `CHANGELOG.md` has concise functional entries for usage tracking, cost calculations, and UI visibility. Remove any setup-only/test-only entries if they were added accidentally.

Commit:
- `test: close milestone 16 cost tracking`
