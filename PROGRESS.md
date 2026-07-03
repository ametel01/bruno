# AgentBay Milestone 0 Progress

Source documents:

- `PRD.md`: product requirements for the AgentBay MVP.
- `MILESTONES.md`: milestone sequence and technical expectations.
- `PLAN.md`: implementation plan and validation gates for Milestone 0.
- `conversation_dump.md`: original product discussion and milestone source.

## Milestone 0 Scope

Milestone 0 delivers a deployable AgentBay product skeleton only: an empty dashboard-oriented web app, required skeleton routes, database connectivity, migration tooling, environment validation, a database-backed health check, and deployment readiness. It does not include agent records, lifecycle controls, logs, approvals, runners, billing, Hermes integration, auth, or cloud provisioning behavior.

## Tracking Rules

- Update this file after every completed Milestone 0 slice.
- Each completed slice should record the completed step, issue number, validation results, commit reference if available, current status, and next step.
- Update `CHANGELOG.md` after validated steps only when they ship functional user-visible or operator-visible behavior.

## Step Checklist

- [x] Step 0 / issue #1: Progress and changelog tracking setup.
- [x] Step 1 / issue #2: Project scaffold and quality gates setup.
- [x] Deployment slice / issue #6: Initial Vercel preview deployment for the empty app.
- [x] Step 2 / issue #3: Database foundation and health check.
- [x] Step 3 / issue #4: Dashboard shell and Milestone 0 routes.
- [ ] Step 4: Deployment readiness and Milestone 0 acceptance.

## Current Status

- Milestone 0 is in progress.
- Step 0 / issue #1 is complete after local file-content validation.
- Step 1 / issue #2 is complete after scaffold, build, unit, and E2E validation.
- Deployment slice / issue #6 is complete after linking the empty scaffold to Vercel and creating an initial preview deployment.
- Step 2 / issue #3 is complete after local Postgres, migration, database health, unit, build, and E2E validation.
- Step 3 / issue #4 is complete after adding the AgentBay product shell, skeleton dashboard/agents/settings routes, desktop and mobile route smoke coverage, and preserving database-backed `/health`.
- Commit reference: PR #11 head commit `0be50b8aec9285cb51f0b0658d239a86becf6c18` for issue #4 dashboard shell; review-fix follow-up commit records this progress note correction.
- Next step: issue #5, deployment readiness and Milestone 0 acceptance documentation.

## Vercel Preview Deployment

- Vercel account: authenticated local CLI user `ametel01`.
- Vercel scope: `ametel01s-projects`.
- Vercel project: `agentbay`.
- Local link state: `.vercel/project.json` exists locally with project `agentbay` and org `team_FkJJXF4sxyagkat1MIqcv0xD`; `.vercel/` is ignored and should not be committed.
- Link command used: `vercel link --project agentbay --scope ametel01s-projects -y`.
- Initial preferred deploy command attempted: `vercel deploy -y --no-wait --scope ametel01s-projects`; Vercel created a production-target deployment at `https://agentbay-83hkf7lqd-ametel01s-projects.vercel.app`, so an explicit preview target was required for this issue.
- Preview deployment command used: `vercel deploy -y --no-wait --target preview --scope ametel01s-projects`.
- Preview URL: `https://agentbay-9wi2xvhbh-ametel01s-projects.vercel.app`.
- Vercel inspect URL: `https://vercel.com/ametel01s-projects/agentbay/2hPrX8fpMTPxS3PJSyR8L1SY6jYc`.
- Preview deployment ID: `dpl_2hPrX8fpMTPxS3PJSyR8L1SY6jYc`.
- Exact Vercel-side blocker: none; no missing environment variables were required for the empty scaffold preview.

## Validation Results

Step 0 / issue #1 validation:

- `git rev-parse --is-inside-work-tree`: passed, returned `true`.
- `test -f PROGRESS.md`: passed.
- `test -f CHANGELOG.md`: passed.
- `rg -n "Milestone 0|Step 0|Step 1|Step 2|Step 3|Step 4" PROGRESS.md`: passed.
- `rg -n "# Changelog|## \\[Unreleased\\]" CHANGELOG.md`: passed.
- `git diff --check`: passed.

Step 1 / issue #2 validation:

- `bun install`: passed after one retry; the first attempt was interrupted after stalling during dependency resolution, and the retry completed with `bun.lock`.
- `bun run format:check`: passed.
- `bun run lint`: passed.
- `bun run typecheck`: passed.
- `bun run test`: passed, 1 unit test.
- `bun run build`: passed with Next.js 16.2.10.
- `bun run test:e2e`: passed, 1 Chromium route smoke test.
- `bun run verify`: passed.
- Source/tracking document existence check: passed for `PRD.md`, `MILESTONES.md`, `PLAN.md`, `conversation_dump.md`, `PROGRESS.md`, `CHANGELOG.md`, and the shared coordinator `STATUS.md`.

Deployment slice / issue #6 validation:

- `git status --short` before Vercel CLI actions: clean.
- `vercel --version`: passed, returned Vercel CLI 54.19.0.
- `vercel whoami`: passed, returned `ametel01`.
- `vercel teams list --format json`: passed, returned one available team scope, `ametel01s-projects`.
- Existing Vercel link metadata check: passed, no existing `.vercel/project.json` or `.vercel/repo.json` before linking.
- `vercel link --repo --scope ametel01s-projects -y`: did not link because no existing Vercel project was linked to `https://github.com/ametel01/agentbay.git` and no project was selected non-interactively.
- `vercel link --project agentbay --scope ametel01s-projects -y`: passed and created the Vercel project/link state locally.
- `vercel deploy -y --no-wait --scope ametel01s-projects`: passed, but Vercel classified the deployment as `target production`, so it was not used as the issue #6 preview evidence.
- `vercel deploy -y --no-wait --target preview --scope ametel01s-projects`: passed and returned the preview URL.
- `vercel inspect https://agentbay-9wi2xvhbh-ametel01s-projects.vercel.app --scope ametel01s-projects`: passed and confirmed `target preview`; status moved from `Building` immediately after `--no-wait` deployment to `Ready` on the follow-up inspection.
- `git status --short` after Vercel CLI actions: showed only `.gitignore` modified after adding the generated `.vercel/` ignore rule; `.vercel/` and `.env.local` stayed untracked/ignored local files.
- First `bun run verify`: failed because dependencies were not installed in this worktree and `biome` was unavailable.
- `bun install`: passed and installed dependencies without changing `bun.lock`.
- Second `bun run verify`: passed, including format check, lint, typecheck, unit test, Next.js production build, and Playwright E2E smoke test.
- Final `bun run verify` after the last progress-note edit: passed with the same gate coverage.

Step 2 / issue #3 validation:

- `docker compose up -d postgres`: passed; the first run pulled `postgres:17-alpine`, created the `agentbay-issue-3-postgres-1` container, and started it.
- Postgres container health polling: passed after correcting the local shell polling variable name; container status was `healthy`.
- `bun run db:migrate`: passed and applied the infrastructure-only Drizzle migration for `app_metadata`.
- `bun run db:health`: passed and returned JSON with `status: "ok"`, `database: "reachable"`, and an ISO timestamp.
- `bun run format:check`: passed.
- `bun run lint`: passed.
- `bun run typecheck`: passed after tightening env validator and health-check parameter types.
- `bun run test`: passed, 4 unit test files and 7 tests covering root page, env validation, database health failure mapping, and `/health` invalid-env JSON.
- `bun run build`: passed with `/health` listed as a dynamic server route.
- `bun run test:e2e`: passed, 2 Chromium route tests covering the root scaffold and reachable database-backed `/health`.
- `bun run verify`: passed after the final progress update; format check, lint, typecheck, unit tests, production build, and Playwright E2E all passed.

Step 3 / issue #4 validation:

- `bun install --frozen-lockfile`: passed after the first format attempt found dependencies missing in this worktree; `bun.lock` did not change.
- First `docker compose up -d postgres`: failed because stale container `agentbay-issue-3-postgres-1` already owned host port `54329`.
- `docker stop agentbay-issue-3-postgres-1`: passed to release the fixed local AgentBay Postgres port from the completed issue #3 worktree.
- Second `docker compose up -d postgres`: passed and started `agentbay-issue-4-postgres-1`.
- Postgres container health polling: passed after correcting the local shell polling variable name from zsh-reserved `status` to `health_status`; container status was `healthy`.
- `docker compose up -d --force-recreate postgres`: passed after the initial failed create left the issue #4 container without the host port binding; the recreated container published `0.0.0.0:54329->5432/tcp`.
- `bun run db:migrate`: passed against the issue #4 Postgres container.
- `bun run db:health`: passed and returned JSON with `status: "ok"`, `database: "reachable"`, and an ISO timestamp.
- `bun run format:check`: passed.
- `bun run lint`: passed.
- `bun run typecheck`: passed.
- `bun run test`: passed, 4 unit test files and 11 tests covering root, dashboard, agents list, placeholder agent detail, settings placeholders, env validation, database health failure mapping, and `/health` invalid-env JSON.
- `bun run build`: passed with `/`, `/dashboard`, `/agents`, `/agents/[agentId]`, `/settings`, and dynamic `/health` listed in the app route output.
- `bun run test:e2e`: passed, 14 Playwright tests across `chromium-desktop` and `chromium-mobile`, covering `/`, `/dashboard`, `/agents`, `/agents/test-agent`, `/settings`, and `/health`.
- `bun run verify`: passed with format check, lint, typecheck, unit tests, production build, and desktop/mobile Playwright route smoke coverage.

## Update Log

- 2026-07-03: Created the Milestone 0 progress tracker and Keep a Changelog baseline for issue #1. Step 0 validation passed and issue #2 is the next implementation slice.
- 2026-07-03: Completed issue #2 by adding a Bun-managed Next.js App Router scaffold with TypeScript, Biome, Vitest, Playwright, unit/E2E smoke coverage, and a minimal root route pointing to `/dashboard`.
- 2026-07-03: Completed issue #6 by linking the empty scaffold to Vercel project `ametel01s-projects/agentbay` and creating the initial preview deployment at `https://agentbay-9wi2xvhbh-ametel01s-projects.vercel.app`.
- 2026-07-03: Completed issue #3 by adding local Postgres support, infrastructure-only Drizzle migration tooling, required environment validation, and an operator-visible database-backed `/health` endpoint.
- 2026-07-03: Completed issue #4 by adding the Milestone 0 AgentBay product shell, empty dashboard and agents states, placeholder agent detail/settings routes, and desktop/mobile route smoke coverage.
