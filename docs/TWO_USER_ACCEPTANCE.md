# Two-user authentication and isolation acceptance

This matrix is the repository-level acceptance contract for two distinct Clerk identities and the
runner machine identities they own. All committed checks are credential-free: they use opaque
synthetic Clerk IDs, internal UUIDs, fake providers, and hash-only runner credentials. They never
contact Clerk, DigitalOcean, or another external provider.

## Human-user ownership matrix

Every foreign-object assertion uses the same response as a well-formed missing UUID and verifies
the protected row, audit trail, runtime adapter, object store, or provider fake is unchanged.

| Domain | Owner path | Foreign/missing concealment and zero-effect evidence |
| --- | --- | --- |
| Clerk-to-user mapping | Two opaque Clerk IDs resolve to distinct internal UUIDs | `tests/unit/application-user.test.ts` proves signed-out resolution opens no database and first sign-up never claims a legacy row |
| Agents and configuration | Create, list, detail, and patch use the request user's UUID | `tests/unit/agent-user-isolation.test.ts` compares every foreign/missing route and counts database/runtime effects |
| Lifecycle | Start, stop, restart, simulated failure, and delete record the owner actor and usage period | `tests/unit/agent-user-isolation.test.ts` proves foreign/missing lifecycle calls invoke no runtime adapter and create no events or usage periods |
| Logs | Persisted, local, Docker, and manual-runner reads stay under the owned agent | `tests/unit/agent-user-isolation.test.ts` and `tests/unit/operational-pages-user-isolation.test.tsx` reject foreign reads without leak strings or writes |
| Events | Latest activity and per-agent event feeds join through the owned agent | `tests/unit/user-operations-isolation.test.ts` compares foreign/missing API bodies and excludes the other user's event text |
| Costs | Estimates and usage periods include only owned agents and runners | `tests/unit/agent-user-isolation.test.ts` and `tests/unit/operational-pages-user-isolation.test.tsx` assert the other user's usage and cost text is absent |
| Approvals | Owner approve/deny writes one owned audit event | `tests/unit/user-operations-isolation.test.ts` compares foreign/missing responses and verifies no decision or audit write |
| Backups and restores | Object keys include the internal user namespace and owner restore creates an owned stopped agent | `tests/unit/user-operations-isolation.test.ts` proves foreign/missing restore performs no object-store download and exposes no backup ID or URI |
| Runner reads and placement | Settings, health, capacity, placement, and reconciliation receive the request user's UUID | `tests/unit/runner-placement.test.ts`, `tests/unit/cloud-runner-provisioning.test.ts`, and `tests/unit/runner-user-isolation-source.test.ts` prove foreign runners are neither selected nor reconciled |
| Registration tokens | Browser creation binds `agb_reg_*` material to one user and stores only its hash | `tests/unit/runner-registration.test.ts` and `tests/unit/runner-registration-routes.test.ts` prove one-time owner binding and signed-out rejection |
| Credentials and heartbeat | Rotate/revoke requires the runner owner; heartbeat uses `agb_run_*` independently | `tests/unit/runner-credential-lifecycle.test.ts` compares foreign/missing results, preserves the foreign credential, and proves old/revoked credentials fail heartbeat |
| Provisioning | Browser provisioning creates rows and fake-provider calls only for the request user | `tests/unit/runner-provisioning.test.ts`, `tests/unit/runner-provisioning-route.test.ts`, and `tests/unit/cloud-runner-provisioning.test.ts` cover owner binding, fail-before-provider auth, safe failures, and user-scoped reconciliation |

## Signed-out and machine boundaries

- `tests/unit/clerk-proxy.test.ts` exercises every current protected page family and browser API
  family. Signed-out pages redirect to `/sign-in`; APIs return the same safe JSON `401` without a
  Basic-auth challenge.
- `/health`, `/sign-in`, and `/sign-up` remain reachable without a Clerk session. Only the exact
  `/runner/v1/register`, `/runner/v1/heartbeat`, and `/runner/v1/bootstrap-events` paths bypass
  Clerk; a future `/runner/v1/*` route is protected by default.
- `tests/unit/runner-registration-routes.test.ts`, `tests/unit/runner-heartbeat-route.test.ts`, and
  `tests/unit/runner-bootstrap-events-route.test.ts` preserve `agb_reg_*` and `agb_run_*` request
  contracts without a Clerk session.
- `tests/unit/manual-runner-adapter.test.ts` and `tests/unit/runner-service.test.ts` prove agent
  lifecycle HTTP calls use the separate server-side bearer token and reject missing or invalid
  credentials. `tests/unit/runner-user-isolation-source.test.ts` guards this separation from Clerk.

## Legacy claim safety

The only migration path is the explicit `scripts/claim-legacy-user.ts --clerk-user-id <opaque-id>`
command. It defaults to a count-only dry run and requires `--apply` for the single eligible legacy
user. `tests/unit/legacy-user-claim.test.ts` covers dry run, explicit ownership, idempotency,
ambiguity refusal, conflicts, concurrent resolution, and CLI argument redaction.

Normal Clerk resolution never invokes that claim. When an unclaimed legacy user exists, a first
request from a new Clerk identity creates a separate internal user and leaves the legacy row
unchanged; `tests/unit/application-user.test.ts` pins this no-auto-claim rule.

## Clerk provider smoke boundary

The repository deterministically proves the sign-in/sign-up widgets, current-user control, and
sign-out redirect configuration in `tests/unit/clerk-auth-surfaces.test.tsx`. A successful hosted
flow cannot be claimed from those component tests.

Email-code, Google, Apple, current-user, and sign-out browser success remain part of issue #232's
approved development-instance smoke. They require a dedicated AgentBay development Clerk app,
test-only keys, a `CLERK_TESTING_TOKEN`, and configured provider state. Approval
`de322ae8-c258-440e-a679-b74bafb61048` permits that development-only setup with local
`.env.local` as the sole key destination. The stored Clerk CLI session is currently expired, so
external inventory, provisioning, provider success, and a passing doctor remain host-auth-blocked.
Follow the [development-instance runbook](./CLERK_DEVELOPMENT.md); never reuse another app or treat
the approval itself as provider evidence.

After that approval, the smoke run must:

1. Use Clerk's Playwright helpers with a fresh browser context and isolated storage state for each
   synthetic user.
2. Call `setupClerkTestingToken()` before visiting an auth page and use only Clerk-supported test
   identities and strategies for the linked development instance.
3. Exercise email-code sign-in where the instance exposes the supported deterministic test flow;
   record Google and Apple success only when each provider is configured and reachable.
4. Verify the current-user control, sign out to `/sign-in`, and rejection of the prior session.
5. Delete or invalidate test sessions/users according to the approved cleanup scope.
6. Report only pass/fail, capability names, and opaque aliases. Never print keys, tokens, email
   addresses, provider profile data, cookies, or session/storage-state contents.

`playwright.config.ts` resolves the same authentication policy as the application. Trace,
screenshot, and video capture are disabled whenever that policy resolves Clerk or rejects an
invalid/unsafe environment, including an unset Vercel preview that infers Clerk. Only a valid
development decision may retain a first-retry trace, and its fixtures contain only synthetic
values.

## Verification and current external gap

Use a fresh PostgreSQL container, Compose project, application port, and explicit `DATABASE_URL`
for every run. Never rely on the package fallback port while another agent may own it. The canonical
repository checks are:

```text
bun run db:migrate
bun run format:check
bun run lint
bun run typecheck
bun run test
bun run build
bun run test:e2e:ci
bun run test:e2e
clerk doctor --json
```

`bun run test:e2e` is the provider-backed final step of `bun run verify`; its sanitized capability
gate is expected to stop before Playwright when approved provider credentials are absent.

On 2026-07-10, a read-only `clerk doctor --json` run found the repository unlinked, with no local
Clerk environment and application checks skipped. The command returned its sanitized
`doctor_failed` envelope. Development setup was subsequently approved, but a read-only inventory
attempt found the stored Clerk session expired. Host reauthentication is required before linking,
local-only key retrieval, doctor, or hosted provider smoke can continue; this document does not
claim any of them passed.
