# Implementation Plan

## Product Outcome

plingpling creates a working Hermes agent from one primary action. The user chooses the assistant
experience they already recognize—ChatGPT or Claude—and the app owns every provider, model,
runtime, runner, deployment, health-check, and recovery detail that can be automated safely.

The first release supports:

- **ChatGPT**, backed by the direct OpenAI API.
- **Claude**, backed by the direct Anthropic API.
- Official API keys as the initial authorization method.
- Reuse of an existing healthy model connection so later agents do not ask for the key again.
- A dedicated Telegram bot as the first messaging channel.

OpenRouter is not a supported choice for new agents. Existing OpenRouter agents remain readable
and operable through a compatibility path until a separate migration is approved.

## User Promise

The primary flow asks only for decisions or actions that require the user:

1. Choose ChatGPT or Claude.
2. Connect that assistant if it is not connected yet.
3. Supply the Telegram details that Telegram does not allow plingpling to create on the user's
   behalf.
4. Select **Create my agent**.

After that click, plingpling selects a compatible model, assigns or provisions capacity, writes the
Hermes configuration, installs credentials, starts the gateway, validates the model, connects
Telegram, repairs retryable failures, and reports when the agent is ready. Internal terms such as
provider IDs, model IDs, runners, launch modes, revisions, canaries, environment variables, and
deployment stages do not appear in the common flow.

## Goals

- Replace OpenRouter-shaped creation with a deep model-connection boundary whose public choice is
  `chatgpt | claude`.
- Make the default model and Hermes provider mapping server-owned and versioned.
- Store credentials encrypted and owner-scoped, never redisplay them, and reuse them for later
  agents owned by the same user.
- Return only `connected`, `working`, `action_required`, or a safe recoverable failure to ordinary
  callers.
- Keep the automatic path durable and idempotent across duplicate requests, request completion,
  runner delay, and process restart.
- Preserve exact image/config evidence, private API authentication, a bounded model canary,
  Telegram connectivity, desired-state recovery, owner isolation, and secret redaction.
- Keep exact model/template/runner selection and the native Hermes terminal as secondary advanced
  or recovery tools.

## Non-Goals

- Supporting providers other than direct OpenAI and direct Anthropic for new agents.
- Offering OpenRouter as a new-agent fallback or asking a new user for an OpenRouter key.
- Claiming that a ChatGPT or Claude consumer subscription includes API usage. Direct API billing is
  separate and the UI must say so plainly.
- Offering Claude.ai subscription login in this third-party product. Anthropic requires products
  that call Claude on a user's behalf to use API credentials or an approved cloud-provider path.
- Scraping browser sessions, copying consumer cookies, accepting account passwords, or importing
  unsupported subscription artifacts.
- Automating Telegram BotFather bot creation, Telegram account changes, or privacy-mode changes.
- Sharing one Telegram bot across simultaneously running agents.
- Exposing Hermes provider IDs, model IDs, endpoints, or raw configuration in the common flow.
- Publishing images, provisioning billable live infrastructure, or contacting a real Telegram
  user without the existing explicit staging authorization and capabilities.

## Model Connection Contract

The common application surface is intentionally small:

```ts
type AssistantChoice = "chatgpt" | "claude";

type ModelConnectionView =
  | { state: "connected"; assistant: AssistantChoice; label: string }
  | { state: "working"; assistant: AssistantChoice; retryAfterMs: number }
  | {
      state: "action_required";
      assistant: AssistantChoice;
      action: {
        kind: "secret_entry";
        label: "API key";
        helpUrl: string;
      };
    }
  | {
      state: "failed";
      assistant: AssistantChoice;
      code: "credential_invalid" | "provider_unavailable" | "connection_unavailable";
      retryable: boolean;
      message: string;
    };
```

The module hides authorization routing, provider/model selection, credential validation and
encryption, refresh/revocation, Hermes binding, safe failure normalization, and canary policy.
Future official OAuth or device flows may add new internal actions without changing creation
callers. Tests use fake provider adapters; production uses direct OpenAI and Anthropic adapters.

## Server-Owned Assistant Profiles

Each assistant profile owns:

- Product label and nontechnical help copy.
- Hermes provider ID and environment-key mapping.
- One reviewed compatible default model.
- API-key shape and byte limits.
- Provider validation/canary adapter.
- Safe redaction patterns and error translation.

The browser sends an assistant choice, never a provider ID or model ID. The selected profile is
pinned into the agent's configuration revision so a catalog update cannot silently change a
running revision.

## Definition of Done

- New ready-agent requests accept only ChatGPT or Claude model choices and never accept or require
  OpenRouter fields.
- The primary UI presents two recognizable assistant choices, no model picker, no runner picker,
  no launch-mode selector, and no provider terminology.
- An owner with a healthy saved connection can create another agent without entering the model
  credential again.
- A first connection collects one masked API key, validates it through the provider boundary, and
  persists it encrypted without logging or redisplaying it.
- ChatGPT projects Hermes `openai-api` configuration and `OPENAI_API_KEY`; Claude projects Hermes
  `anthropic` configuration and `ANTHROPIC_API_KEY`.
- Launch specifications remain strictly parsed, byte-bounded, canonically serialized, and fully
  redacted. Provider-specific secret material never appears in logs, events, public DTOs, or
  deployment records.
- Agent creation still returns a stable `202 Accepted` operation, remains idempotent, and resumes
  through the existing durable reconciler.
- Readiness still requires the expected image/config revision, authenticated private API health,
  connected Telegram, and one bounded successful model canary.
- Existing OpenRouter agents remain on an explicit legacy compatibility path; they are not shown as
  an option for new connections and are never silently converted.
- Staging acceptance requires either an OpenAI or Anthropic test credential chosen explicitly for
  that run and continues to fail closed before side effects when capabilities are missing.
- `.env.example`, README, operator/E2E docs, milestones, progress, and changelog describe the
  provider policy, manual prerequisites, one-click automation boundary, rollback, and acceptance
  evidence.
- Format, lint, typecheck, unit tests, production build, CI browser tests, local cloud smoke,
  pinned Hermes contract smoke, credential-free staging preflight, migrations, and diff hygiene
  pass. Live gates remain blocked unless separately authorized and fully configured.

## Implementation Approach

1. Introduce a server-only assistant profile catalog and model-connection module. Keep the common
   type vocabulary product-facing and translate to Hermes details only at the launch/projection
   boundary.
2. Generalize encrypted credentials and managed launch spec v3 for direct OpenAI and Anthropic.
   Retain a parse/build/projection compatibility branch for existing OpenRouter rows only.
3. Make the create route and transaction resolve or save an owner connection, pin its profile and
   model, then reuse the existing deployment record and reconciler.
4. Replace the wide ready form with a progressive nontechnical flow. Hide optional expert choices
   behind an Advanced disclosure and keep the native setup terminal on agent detail as recovery.
5. Update deterministic fakes, local smokes, staging capability checks, documentation, and release
   notes. Do not contact providers during ordinary tests.

## Quality Gates

- `bun run format:check`
- `bun run lint`
- `bun run typecheck`
- `bun run test`
- `bun run build`
- `bun run test:e2e:ci`
- `bun run local:cloud:smoke`
- `bun run agent:hermes:contract-smoke`
- `bun run verify:hermes:staging` without live capabilities; expected fail-closed with
  `sideEffectsAttempted: false`
- `bun run db:generate` and `bun run db:migrate` for schema changes
- `git diff --check`

## Progress and Changelog Rules

- Preserve historical implementation evidence in `PROGRESS.md`, including the fact that the
  unreleased implementation previously used OpenRouter.
- Append a provider-correction ledger and update it after each step with validation and commit
  evidence.
- Update `CHANGELOG.md` before each functional commit. Because the feature is unreleased, its top
  section must describe only the corrected ChatGPT/Claude behavior, while historical progress may
  continue to mention the superseded implementation.
- Commit after every completed step.

## Incremental Steps

### Step 1: Correct the Product Contract

Changes:

- Replace the OpenRouter-first plan with this ChatGPT/Claude model-connection contract.
- Record the correction, provider-policy evidence, compatibility boundary, checklist, and next
  step in `PROGRESS.md`.

Acceptance:

- No active plan requirement asks a new user for OpenRouter.
- The plan distinguishes product labels from direct API billing and records the Claude auth policy
  constraint.
- Historical ledgers are preserved.

Validation: format, lint, typecheck, plan/progress tests, and diff hygiene.

Commit: `docs: replace OpenRouter onboarding plan`

### Step 2: Add Direct ChatGPT and Claude Runtime Support

Changes:

- Add the assistant profile/model-connection module and production/fake validation adapters.
- Generalize managed creation, encrypted secrets, launch building/spec parsing, redaction, Hermes
  projection, lifecycle eligibility, backup references, and deterministic smokes.
- Add and validate migrations required for owner-scoped reusable connections.
- Preserve legacy OpenRouter launch compatibility without exposing it to new creation.

Acceptance:

- Both assistant profiles build strict secret-safe managed launch specs and exact Hermes files.
- Invalid, missing, revoked, cross-owner, and ambiguous credentials fail safely.
- Existing OpenRouter fixtures still parse and project only through the legacy path.

Validation: migrations, focused unit/database/projection tests, full static gates, local smokes, and
diff hygiene.

Commit: `feat: support direct ChatGPT and Claude connections`

### Step 3: Ship the One-Click Common Flow

Changes:

- Replace the ready-mode model/key fields with ChatGPT and Claude cards plus one connection action
  when required.
- Reuse a healthy owner connection automatically.
- Hide model, runner, template, launch-mode, and deployment internals from the common flow; retain
  them only in the advanced/manual path.
- Keep safe persisted progress, retry, redirect, responsive, and accessible behavior.

Acceptance:

- A connected owner chooses an assistant and starts a new agent with one primary click.
- A first-time owner sees only the unavoidable API-key and Telegram actions before the same click.
- Browser payloads contain no provider or model identifiers.

Validation: focused component/controller/route/E2E tests, accessibility/responsive checks, full
static gates, build, CI browser tests, and diff hygiene.

Commit: `feat: simplify agent setup to one click`

### Step 4: Correct Acceptance, Documentation, and Release Evidence

Changes:

- Replace OpenRouter staging capabilities and fixtures with an explicit ChatGPT-or-Claude direct
  provider capability.
- Update `.env.example`, README, E2E validation, milestones, progress, and the unreleased
  changelog.
- Run all deterministic gates and the credential-free no-side-effect staging preflight.

Acceptance:

- Primary product and operator docs contain no instruction to obtain an OpenRouter key.
- New-provider staging fails closed unless exactly one supported provider credential is selected.
- Live provider, infrastructure, and Telegram work remains unclaimed and blocked without explicit
  authorization and capabilities.

Validation: every quality gate listed above.

Commit: `docs: finalize ChatGPT and Claude onboarding`
