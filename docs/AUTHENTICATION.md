# Authentication modes

Bruno.Ai resolves one server-only `BRUNO_AUTH_MODE` policy before browser requests reach the
application user resolver. Request hosts and forwarded headers never select the mode.

Browser runner settings and APIs resolve that configured application user once, then scope runner
lists, placement, provisioning, registration-token creation, and credential rotation or revocation
to the resulting internal user ID. A runner owned by another user is indistinguishable from a
missing runner and cannot trigger provider or credential side effects.

The complete two-user, runner-machine, legacy-claim, and provider-smoke evidence map is maintained
in [Two-user authentication and isolation acceptance](./TWO_USER_ACCEPTANCE.md).

The approved development-instance procedure and production Google/Apple credential prerequisites
are maintained in [Clerk development instance and production provider prerequisites](./CLERK_DEVELOPMENT.md).

## Local development

For a non-Vercel loopback `NEXT_PUBLIC_APP_URL`, an unset mode defaults to `development`:

```dotenv
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

No Clerk keys or registration are needed. Browser pages and APIs use the shared internal
development user. The three runner-machine endpoints keep their registration-token or
runner-credential contracts and never use Clerk:

- `/runner/v1/register`
- `/runner/v1/heartbeat`
- `/runner/v1/bootstrap-events`

Set `BRUNO_AUTH_MODE=development` when an explicit local mode is preferable. Blank, whitespace,
case-variant, or unknown values fail closed. Explicit development mode on a non-Vercel loopback or
`host.docker.internal` URL does not activate the Basic-auth prompt even when a production operator
password is present in a local ignored environment file. `bun run local:up` and the local cloud
Docker stack set this mode automatically.

## Public hosted development

A Vercel production deployment may temporarily use the shared development user without browser
authentication only when both settings are explicit:

```dotenv
BRUNO_AUTH_MODE=development
BRUNO_ALLOW_PUBLIC_DEVELOPMENT=true
```

This exception is accepted only when `VERCEL_ENV=production` and `NEXT_PUBLIC_APP_URL` is a valid
absolute URL. The opt-in must be exactly `true`; missing, blank, case-variant, or false values keep
production fail-closed. It does not weaken runner registration, heartbeat, bootstrap-event, or
runner lifecycle credentials.

Public development exposes every browser page and app-side API—including agent lifecycle,
runner provisioning, credential rotation, backups, and approval controls—to anyone who can reach
the deployment. Use it only for a temporary development environment. Remove
`BRUNO_ALLOW_PUBLIC_DEVELOPMENT` and switch back to `operator` or `clerk` before sharing the
deployment or using production data and cloud credentials.

## Operator mode

Until the production Clerk cutover is complete, an existing production deployment can retain the
shared internal user only behind the Basic-auth operator gate:

```dotenv
BRUNO_AUTH_MODE=operator
BRUNO_OPERATOR_PASSWORD=replace-with-strong-operator-password
```

Operator mode is explicit and fails closed when the password is absent or blank. It does not enable
Clerk pages, sessions, or automatic legacy-user claiming. The production cutover replaces this mode
with `clerk`; the operator password and Basic-auth code are removed only after hosted Clerk and
ownership acceptance passes. Both `operator` and `clerk` production modes enforce persisted Release
Decision and Recovery Archive access boundaries; only explicit development mode uses the local
bypass. Authentication alone is not admission: the first qualified Owner Preview entry binds one
internal user as the Bruno.Ai Owner, later Owner candidates fail closed, and runtime preparation
never creates an Owner Preview decision without the Owner's explicit entry action. Trusted Preview
additionally requires Clerk, one of three identity-bound invitations issued under the current
exact-revision cohort decision, and a participant-specific admission decision. A Clerk session
without that invitation authority cannot open a Founder workspace.

## Clerk mode

Production, `getbruno.xyz`, Vercel production, and any current custom application hostname use
the temporary `operator` mode above or, after cutover:

```dotenv
BRUNO_AUTH_MODE=clerk
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=replace-with-development-publishable-key
CLERK_SECRET_KEY=replace-with-development-secret-key
```

Both Clerk variables are required and are read only from the server environment. Never commit,
print, or copy their values into diagnostics. `NODE_ENV`, request `Host`, and forwarded-host headers
cannot downgrade a production or custom deployment to development mode.

### Founder identity recovery

Configure Clerk's `user.deleted` webhook to the exact public endpoint
`/api/webhooks/clerk` and keep its signing secret in server-only hosted secret storage:

```dotenv
CLERK_WEBHOOK_SIGNING_SECRET=replace-with-dedicated-clerk-webhook-secret
BRUNO_IDENTITY_RECOVERY_SIGNING_SECRET=replace-with-generated-secret-at-least-32-characters
```

Bruno verifies the webhook signature before recording a pending Identity Recovery against the
existing internal Owner. A verified `user.deleted` event records deletion; a verified
`user.updated` event whose Clerk user is banned records provider-confirmed identity loss. While that
recovery is pending, the old Clerk subject is denied at the application-user boundary. The webhook
records identity loss only: it does not cancel Lemon Squeezy, change Product Entitlement, start a
refund, begin Infrastructure Retirement, delete Recovery Archives, begin Bruno Data Deletion, or
request Account Closure.

Before identity loss, the recently reauthenticated Founder creates a one-time, high-entropy
Identity Recovery code from the Privacy Center. In Clerk mode, "recently reauthenticated" means
Clerk's server-side strict reverification check succeeds; JWT issuance or session refresh time is
never accepted as credential verification. Bruno shows the code once, stores only its digest,
and replaces any earlier code. The `/identity-recovery` surface accepts that code only while it is
unused, unrevoked, unexpired, and bound to the pending recovery for the same internal Owner. The
server then issues a short-lived assertion bound to that recovery, the prior and exact replacement
Clerk-subject digests, and the credential evidence digest. A checkout email, a new Clerk ID, or
possession of a browser session cannot claim an existing workspace. Bruno stores only digests and
the distinct `identity_loss_recorded`, `recovery_denied`, and `identity_rebound` receipts; it does
not retain the raw code, assertion, email, Clerk profile, or session material.

Identity Recovery only restores the Owner mapping. The existing recently reauthenticated Account
Closure control remains the sole coordinator of external-action pause, Lemon Squeezy subscription
cancellation, connection revocation, Bruno Data Deletion, and its own receipts. Refunds remain a
separate commerce-policy decision. Do not issue a recovery proof from browser-visible state or
after weak email-only verification.

## Protected preview opt-in

The safe default for previews is Clerk mode. A registration-free Vercel preview is allowed only
when all of these are true:

1. `VERCEL_ENV=preview` and the configured application hostname matches the current `VERCEL_URL`.
2. `BRUNO_AUTH_MODE=development` is explicit.
3. `BRUNO_PREVIEW_PROTECTION_VERIFIED=true` is exact.
4. An operator has verified through the Vercel project API that Deployment Protection requires SSO
   and that no preview exceptions, share links, or automation-bypass paths expose the deployment.

The attestation is non-secret and does not enable protection by itself. Do not set it before the
live project check. Changing Vercel protection, environment variables, or deployments requires
separate approval. After an approved preview exists, verify that raw unauthenticated access is
blocked and that authenticated `vercel curl` reaches the application; keep all output redacted.

Vercel build planning resolves an unset preview mode to Clerk and requires both Clerk keys. It
rejects incomplete Clerk configuration, operator mode without its Basic-auth password, an
unverified development preview, and every development production/custom-domain combination except
the explicit public-production development opt-in before the application build starts.
