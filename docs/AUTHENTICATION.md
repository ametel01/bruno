# Authentication modes

AgentBay resolves one server-only `AGENTBAY_AUTH_MODE` policy before browser requests reach the
application user resolver. Request hosts and forwarded headers never select the mode.

Browser runner settings and APIs resolve that configured application user once, then scope runner
lists, placement, provisioning, registration-token creation, and credential rotation or revocation
to the resulting internal user ID. A runner owned by another user is indistinguishable from a
missing runner and cannot trigger provider or credential side effects.

The complete two-user, runner-machine, legacy-claim, and provider-smoke evidence map is maintained
in [Two-user authentication and isolation acceptance](./TWO_USER_ACCEPTANCE.md).

## Local development

For a non-Vercel loopback `NEXT_PUBLIC_APP_URL`, an unset mode defaults to `development`:

```dotenv
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

No Clerk keys or registration are needed. Browser pages and APIs use the shared internal
development user. The existing Basic operator password, when configured, remains an independent
barrier until the production cutover issue removes it. The three runner-machine endpoints keep
their registration-token or runner-credential contracts and never use Clerk:

- `/runner/v1/register`
- `/runner/v1/heartbeat`
- `/runner/v1/bootstrap-events`

Set `AGENTBAY_AUTH_MODE=development` when an explicit local mode is preferable. Blank, whitespace,
case-variant, or unknown values fail closed.

## Clerk mode

Production, `plingpling.xyz`, Vercel production, and any current custom application hostname must
use:

```dotenv
AGENTBAY_AUTH_MODE=clerk
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=replace-with-development-publishable-key
CLERK_SECRET_KEY=replace-with-development-secret-key
```

Both Clerk variables are required and are read only from the server environment. Never commit,
print, or copy their values into diagnostics. `NODE_ENV`, request `Host`, and forwarded-host headers
cannot downgrade a production or custom deployment to development mode.

## Protected preview opt-in

The safe default for previews is Clerk mode. A registration-free Vercel preview is allowed only
when all of these are true:

1. `VERCEL_ENV=preview` and the configured application hostname matches the current `VERCEL_URL`.
2. `AGENTBAY_AUTH_MODE=development` is explicit.
3. `AGENTBAY_PREVIEW_PROTECTION_VERIFIED=true` is exact.
4. An operator has verified through the Vercel project API that Deployment Protection requires SSO
   and that no preview exceptions, share links, or automation-bypass paths expose the deployment.

The attestation is non-secret and does not enable protection by itself. Do not set it before the
live project check. Changing Vercel protection, environment variables, or deployments requires
separate approval. After an approved preview exists, verify that raw unauthenticated access is
blocked and that authenticated `vercel curl` reaches the application; keep all output redacted.

Vercel build planning resolves an unset preview mode to Clerk and requires both Clerk keys. It
rejects incomplete Clerk configuration, an unverified development preview, and every development
production/custom-domain combination before the application build starts.
