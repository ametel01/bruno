# Implementation Plan

## Source Documents

- Path: `/Users/alexmetelli/source/agentbay/PRD.md`
  - Role: Primary product requirements document.
  - Summary: Defines AgentBay as a desktop-first web SaaS control plane for persistent Hermes agents, with mobile-responsive operational controls. It says the MVP should start with thin vertical slices, avoid cloud provisioning first, and begin with a product skeleton before agent records, lifecycle controls, logs, approvals, runners, billing, and Hermes integration.
- Path: `/Users/alexmetelli/source/agentbay/MILESTONES.md`
  - Role: Expanded milestone design.
  - Summary: Milestone 0 requires an empty deployable app with a dashboard-oriented layout, routes for `/dashboard`, `/agents`, `/agents/:agentId`, `/settings`, database connectivity, migration tooling, environment validation, a database-backed health check, and deployment configuration.
- Path: `/Users/alexmetelli/source/agentbay/conversation_dump.md`
  - Role: Original product discussion and milestone source.
  - Summary: The product should start as a desktop-first web dashboard, mobile-friendly from day one, and should not begin with real cloud provisioning. Milestone 0 is "Product skeleton": empty app exists, deploys, has database connection, migration, health check, dashboard route, agent detail route, and settings route.

## Goals

- Deliver only Milestone 0: a deployable AgentBay product skeleton.
- Establish a concrete web app stack, local development workflow, quality gates, and deployment readiness.
- Provide a desktop-first dashboard shell with mobile-responsive foundations.
- Provide route-level skeletons for `/dashboard`, `/agents`, `/agents/:agentId`, `/settings`, and `/health`.
- Provide a Postgres-compatible database connection, migration command, and health check that verifies database reachability.
- Leave the repository ready for Milestone 1 agent model work without implementing agent CRUD or execution behavior.

## Non-Goals

- Do not implement account signup/login beyond any minimal placeholder needed by the skeleton.
- Do not implement `users`, `agents`, `agent_events`, templates, lifecycle controls, logs, approvals, runners, provisioning, backups, cost tracking, billing, or Hermes integration.
- Do not build native iOS, native Android, Electron, Tauri, desktop tray, or local bridge apps.
- Do not automate cloud Droplet provisioning.
- Do not integrate Telegram, Discord, model providers, secret storage, Stripe, or object storage.
- Do not add broad marketing landing-page content; the first screen should be a product dashboard shell.

## Definition of Done

- Project root contains an initialized application scaffold with package scripts, TypeScript config, formatter, linting, tests, build command, and deployment-ready configuration.
- `PROGRESS.md` and `CHANGELOG.md` exist and follow the tracking rules in this plan.
- The app runs locally and renders `/dashboard`, `/agents`, `/agents/:agentId`, and `/settings`.
- `/dashboard` renders an empty operational dashboard state for AgentBay without fake agent records.
- `/agents/:agentId` accepts a placeholder ID and renders a skeleton detail page without requiring an agent record.
- `/settings` renders a skeleton settings page focused on future app, database, and deployment settings.
- `/health` returns success only when the app can reach the database, and returns a failure response when the database is unavailable.
- A local Postgres-compatible database can be started for development, and the database migration command runs successfully.
- Environment variables are documented in `.env.example` and validated at runtime or startup.
- A README or equivalent developer note explains local setup, database migration, health check, route smoke checks, quality gates, and deployment steps.
- Full quality gates pass: format check, lint, typecheck, unit tests, route smoke/E2E tests, database migration check, and production build.
- A Vercel-ready deployment path exists. If deployment credentials are available, a preview deployment URL is produced and recorded in `PROGRESS.md`; if credentials are unavailable, deploy readiness is validated with `bun run build` and the missing credential blocker is recorded.

## Assumptions and Open Questions

- Assumption: This directory is the project root because no parent Git repository exists for `/Users/alexmetelli/source/agentbay`.
- Assumption: The executing agent should initialize Git in this project root if `.git` is still absent, so per-step commits can be created.
- Assumption: Use a TypeScript web stack because `MILESTONES.md` assumes a TypeScript web app and the product is a web dashboard.
- Assumption: Use Next.js App Router for the app skeleton because it is a pragmatic fit for a desktop-first SaaS dashboard, API routes, health checks, and Vercel deployment.
- Assumption: Use Bun for package management and scripts, Biome for formatting/linting, Vitest for unit tests, Playwright for route smoke tests, and Drizzle with Postgres-compatible SQL migrations for database setup.
- Assumption: Use local Postgres through Docker Compose for development unless the user supplies a managed `DATABASE_URL`.
- Assumption: Use Vercel as the default deployment target because it pairs naturally with Next.js. Fly, Railway, or another target can replace this later without changing the Milestone 0 product behavior.
- Open question: Actual deployment credentials and production database URL are not present in the source documents. If unavailable during execution, deployment is documented as blocked after local deploy-readiness is proven.
- Open question: The final visual design system is not specified. Milestone 0 should use a restrained operational dashboard style and avoid over-investing in a custom component system.

## Implementation Approach

- Treat Milestone 0 as a greenfield scaffold plus a thin product shell, not as agent functionality.
- Set up project tooling first because the directory currently contains only documentation and no package, test, lint, build, or CI files.
- Use a small Next.js App Router structure:
  - `app/layout.tsx` for global shell.
  - `app/page.tsx` to redirect or link to `/dashboard`.
  - `app/dashboard/page.tsx` for the empty dashboard.
  - `app/agents/page.tsx` for an empty agent list shell.
  - `app/agents/[agentId]/page.tsx` for a placeholder detail shell.
  - `app/settings/page.tsx` for settings shell.
  - `app/health/route.ts` for database-backed health JSON.
- Add a minimal shared UI layer only where it helps the shell: app frame, navigation, status badge, empty state, and page header.
- Add a database module with environment validation and a migration command. Keep domain tables out of scope; use a minimal `app_metadata` or equivalent infrastructure table so migration and health checks can prove database connectivity.
- Use local Docker Compose for Postgres to make database validation repeatable.
- Add tests around externally visible behavior:
  - Unit tests for environment validation and health-check status mapping.
  - Route smoke tests for `/dashboard`, `/agents`, `/agents/test-agent`, `/settings`, and `/health`.
- Keep the app mobile-responsive from the first layout pass, but only at the skeleton level. Full mobile operations belong to later milestones.
- Document deployment and local commands in README, but do not create cloud resources beyond an optional Vercel preview deployment.

## Quality Gates

- Setup status: No existing toolchain, quality gates, package manager files, CI files, or test configuration were found. Step 1 must create the quality-gate setup before product implementation proceeds.
- Bootstrap command: `bun install`
- Baseline command after Step 1: `bun run verify`
- Format command: `bun run format:check`
- Lint command: `bun run lint`
- Test command: `bun run test`
- Additional gates:
  - Typecheck: `bun run typecheck`
  - Production build: `bun run build`
  - Route smoke tests: `bun run test:e2e`
  - Database start for DB-dependent steps: `docker compose up -d postgres`
  - Database migration: `bun run db:migrate`
  - Full verification: `bun run verify`

## Progress Tracking

- File: `PROGRESS.md`
- Requirement: Create `PROGRESS.md` before any quality-gate setup or implementation work begins.
- Update rule: After each step is completed, update `PROGRESS.md` with the completed step, validation results, commit reference if available, current status, and next step.

## Changelog Tracking

- File: `CHANGELOG.md`
- Standard: Keep a Changelog 1.0.0, <https://keepachangelog.com/en/1.0.0/>
- Requirement: Create `CHANGELOG.md` before any quality-gate setup or implementation work begins.
- Initial content: Include `# Changelog`, the standard preamble, and an `## [Unreleased]` section.
- Update rule: After each step is completed and validated, update `CHANGELOG.md` before creating that step's commit only if the step shipped a functional change. Omit entries for chores, progress tracking, implementation plans, docs-only updates, tests or coverage, CI or validation runs, framework migration housekeeping, and empty category headings.

## Goal Handoff

- Readiness: This plan is ready to be used as a `/goal` payload for Milestone 0 only.
- Scope: The `/goal` should execute only Milestone 0 work described in this plan unless the user explicitly expands it.
- Done: The `/goal` is complete only when every item in `## Definition of Done` is satisfied, all incremental steps are complete, required quality gates pass or documented credential blockers are handled, `PROGRESS.md` and `CHANGELOG.md` are current, and the final state is summarized for the user.

## Incremental Steps

### Step 0: Progress and Changelog Tracking Setup

Goal: Create durable progress and changelog files the user can consult while Milestone 0 is executed.

Depends on:

- None.

Changes:

- If `.git` is absent, initialize Git in `/Users/alexmetelli/source/agentbay` so step commits can be created.
- Create `PROGRESS.md` in the project root.
- Add the plan title, source documents, Milestone 0 scope, step checklist, current status, and short update log.
- Document that `PROGRESS.md` must be updated after every completed step.
- Create `CHANGELOG.md` in the project root before any quality-gate setup or implementation work begins.
- Add Keep a Changelog 1.0.0 structure with `# Changelog`, the standard preamble, and `## [Unreleased]`.
- Document that `CHANGELOG.md` is updated after validated steps only when they ship functional user-visible or operator-visible changes.

Acceptance criteria:

- `PROGRESS.md` exists and includes all steps from this plan.
- `CHANGELOG.md` exists and follows Keep a Changelog 1.0.0 structure.
- If Git was missing, the repository is initialized before the first commit.

Validation:

- Run `test -f PROGRESS.md`
- Run `test -f CHANGELOG.md`
- Run `rg -n "Milestone 0|Step 0|Step 1|Step 2|Step 3|Step 4" PROGRESS.md`
- Run `rg -n "# Changelog|## \\[Unreleased\\]" CHANGELOG.md`

Progress:

- Mark Step 0 complete in `PROGRESS.md`, record validation results, current status, and next step.

Changelog:

- Do not add a changelog entry for progress and changelog tracking setup because it is not a functional change.

Commit:

- `chore: initialize milestone tracking`

### Step 1: Project Scaffold and Quality Gates Setup

Goal: Establish the application scaffold and runnable quality gates before Milestone 0 product behavior is implemented.

Depends on:

- Step 0.

Changes:

- Create a Bun-managed TypeScript Next.js App Router project in the existing project root without overwriting source documents.
- Add or update:
  - `package.json`
  - `bun.lock`
  - `tsconfig.json`
  - `next.config.ts`
  - `biome.json`
  - `vitest.config.ts`
  - `playwright.config.ts`
  - `.gitignore`
  - `.env.example`
  - `app/layout.tsx`
  - `app/page.tsx`
  - `app/globals.css`
  - `tests/unit/`
  - `tests/e2e/`
- Add scripts:
  - `format`
  - `format:check`
  - `lint`
  - `typecheck`
  - `test`
  - `test:e2e`
  - `build`
  - `dev`
  - `verify`
- Configure `verify` to run format check, lint, typecheck, unit tests, production build, and E2E route smoke tests once those tests exist.
- Add a minimal root page that links or redirects to `/dashboard` so the app can compile before dashboard routes are added.
- Keep styling minimal and operational, with responsive defaults in global CSS.

Acceptance criteria:

- `bun install` completes.
- `bun run verify` exists and runs.
- The app builds with a minimal root route.
- No source documents are deleted or overwritten.

Validation:

- Run `bun install`
- Run `bun run format:check`
- Run `bun run lint`
- Run `bun run typecheck`
- Run `bun run test`
- Run `bun run build`
- Run `bun run test:e2e`
- Run `bun run verify`

Progress:

- Update `PROGRESS.md` with completion notes, validation results, commit reference if available, current status, and next step.

Changelog:

- Do not add a changelog entry unless the scaffold exposes a meaningful user-visible app page. If only project infrastructure is created, omit the changelog entry.

Commit:

- `chore: scaffold web app quality gates`

### Step 2: Database Foundation and Health Check

Goal: Connect the skeleton app to a Postgres-compatible database, prove migrations run, and expose a database-backed health check.

Depends on:

- Step 0.
- Step 1.

Changes:

- Add local Postgres development support:
  - `compose.yaml` with a `postgres` service.
  - `.env.example` entries for `DATABASE_URL`, `NEXT_PUBLIC_APP_URL`, and any required app environment values.
- Add environment validation:
  - server-only validation for `DATABASE_URL`.
  - clear failure messages for missing or malformed required variables.
- Add database client module, for example:
  - `src/server/db/client.ts`
  - `src/server/env.ts`
- Add migration tooling, for example with Drizzle:
  - `drizzle.config.ts`
  - `src/server/db/schema.ts`
  - `drizzle/` or equivalent migration directory.
- Add one infrastructure migration that creates a minimal `app_metadata` table or equivalent non-domain table.
- Add scripts:
  - `db:generate` if the chosen migration tool needs generation.
  - `db:migrate`
  - `db:health`
- Add `app/health/route.ts`.
- Make `/health` return JSON with at least:
  - `status`
  - `database`
  - `timestamp`
  - optional `version` or `environment`
- Make `/health` return a non-2xx response when database connectivity fails.
- Add unit tests for environment validation and health status mapping.

Acceptance criteria:

- `docker compose up -d postgres` starts local Postgres.
- `bun run db:migrate` runs successfully against local Postgres.
- `/health` returns success when the database is reachable.
- `/health` returns failure when `DATABASE_URL` is invalid or the database is unavailable.
- No AgentBay domain tables such as `agents` or `agent_events` are created in this milestone.

Validation:

- Run `docker compose up -d postgres`
- Run `bun run db:migrate`
- Run `bun run db:health`
- Run `bun run format:check`
- Run `bun run lint`
- Run `bun run typecheck`
- Run `bun run test`
- Run `bun run build`
- Run `bun run test:e2e`
- Run `bun run verify`

Progress:

- Update `PROGRESS.md` with completion notes, validation results, commit reference if available, current status, and next step.

Changelog:

- Add a Keep a Changelog entry under `## [Unreleased]` and `Added` for the database-backed health check, because it is operator-visible product behavior.

Commit:

- `feat: add database health foundation`

### Step 3: Dashboard Shell and Milestone 0 Routes

Goal: Render the empty AgentBay dashboard and required skeleton routes.

Depends on:

- Step 0.
- Step 1.
- Step 2.

Changes:

- Add a restrained dashboard-oriented app shell:
  - global layout
  - top or side navigation
  - desktop-first content width
  - mobile-responsive navigation behavior
  - page header component
  - empty state component
- Add pages:
  - `app/dashboard/page.tsx`
  - `app/agents/page.tsx`
  - `app/agents/[agentId]/page.tsx`
  - `app/settings/page.tsx`
- The dashboard empty state should communicate that agents will appear here after creation, without implementing creation.
- The agents list page should render an empty list state and a disabled or non-functional "Create agent" affordance only if it is clearly marked as coming in Milestone 1.
- The agent detail route should accept placeholder IDs such as `/agents/test-agent` and render a skeleton detail page without querying an agent table.
- The settings page should render placeholders for future environment, billing, integrations, or runner settings without implementing them.
- Add Playwright route smoke tests for:
  - `/`
  - `/dashboard`
  - `/agents`
  - `/agents/test-agent`
  - `/settings`
  - `/health`
- Add responsive assertions or screenshots for at least one desktop viewport and one mobile viewport.

Acceptance criteria:

- A user can visit `/dashboard`, `/agents`, `/agents/test-agent`, and `/settings`.
- Empty dashboard renders without fake data.
- Layout works at desktop and mobile widths.
- There is no real agent creation, lifecycle, log, approval, or runner behavior.
- `/health` remains database-backed after the route work.

Validation:

- Run `docker compose up -d postgres`
- Run `bun run db:migrate`
- Run `bun run format:check`
- Run `bun run lint`
- Run `bun run typecheck`
- Run `bun run test`
- Run `bun run build`
- Run `bun run test:e2e`
- Run `bun run verify`

Progress:

- Update `PROGRESS.md` with completion notes, validation results, commit reference if available, current status, and next step.

Changelog:

- Add a Keep a Changelog entry under `## [Unreleased]` and `Added` for the initial AgentBay dashboard shell and skeleton routes.

Commit:

- `feat: add product skeleton routes`

### Step 4: Deployment Readiness and Milestone 0 Acceptance

Goal: Make the skeleton deployable and verify Milestone 0 acceptance end to end.

Depends on:

- Step 0.
- Step 1.
- Step 2.
- Step 3.

Changes:

- Add deployment configuration for Vercel if needed:
  - `vercel.json` only if default Next.js behavior is insufficient.
  - documented build command and output assumptions.
  - documented environment variables.
- Add README setup instructions:
  - install dependencies
  - start local Postgres
  - configure `.env`
  - run migrations
  - run dev server
  - run quality gates
  - run route smoke tests
  - deploy preview
- Add a Milestone 0 acceptance checklist to README or `PROGRESS.md`.
- If Vercel credentials are available, deploy a preview and record the URL in `PROGRESS.md`.
- If Vercel credentials are unavailable, record the missing credential blocker in `PROGRESS.md` after local deploy-readiness passes.
- Ensure `.env.example` contains every variable required for local and deploy environments, without secrets.

Acceptance criteria:

- `bun run build` passes.
- `bun run verify` passes.
- Local health check works with the local database.
- Documentation is sufficient for another agent or developer to run the app locally.
- Deployment path is either completed with a preview URL or explicitly blocked only by missing external credentials.
- Every item in `## Definition of Done` is satisfied or the only unresolved item is an external deployment credential blocker documented in `PROGRESS.md`.

Validation:

- Run `docker compose up -d postgres`
- Run `bun run db:migrate`
- Run `bun run db:health`
- Run `bun run format:check`
- Run `bun run lint`
- Run `bun run typecheck`
- Run `bun run test`
- Run `bun run build`
- Run `bun run test:e2e`
- Run `bun run verify`
- If credentials are available, run the chosen Vercel preview deploy command and record the URL.

Progress:

- Update `PROGRESS.md` with completion notes, all validation results, preview deployment URL or credential blocker, commit reference if available, final Milestone 0 status, and recommended next step: Milestone 1 agent model.

Changelog:

- Add a Keep a Changelog entry under `## [Unreleased]` and `Added` only if deployment readiness or documentation changes expose new operator-visible behavior beyond prior entries. Otherwise, do not add a changelog entry for docs-only or validation-only work.

Commit:

- `chore: document milestone zero deployment readiness`
