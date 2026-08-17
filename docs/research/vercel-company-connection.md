# Least-privilege Vercel Company Connection

Status: decision-ready research for [Define least-privilege Vercel Connection Access](https://github.com/ametel01/bruno/issues/318)

Researched: 2026-08-17

Scope: authorization, account and project selection, API permissions, webhooks, token lifecycle, review constraints, and progressive consent. This does not design deployment authority or implement the integration.

## Decision

Bruno should connect to Vercel as a **connectable account integration** initiated from Bruno through Vercel's external installation flow. The Founder selects the Vercel personal account or team in Vercel and grants access to **specific projects only**. Bruno then asks the Founder to confirm which of those projects are company resources; Vercel access and Bruno business selection remain separate.

The initial integration should request only these Vercel API scopes:

| Vercel scope | Level | Why Bruno needs it |
| --- | --- | --- |
| `integration-configuration` | Read | Verify the installation status, granted scopes, `selected` project boundary, and current project IDs. |
| `project` | Read | Resolve selected project IDs to founder-readable project names and the minimum project metadata needed for receipts. Vercel also bundles project-domain retrieval into this permission. |
| `deployment` | Read | Reconcile deployment history and status after missed webhooks and produce durable deployment evidence. |

All other scopes remain `None`. In particular, Bruno must not request Read/Write access to deployments or projects, and must not request Deployment Checks, Project Environment Variables, Global Project Environment Variables, Team, Current User, Log Drains, Drains, Domain, Edge Config, or Billing access.

This is the smallest documented scope set that supports named project selection plus reliable, reconcilable deployment evidence. It gives Bruno **no API authority to create, cancel, or delete deployments and no authority to change projects**. Vercel's Read permissions are nevertheless coarse: `project: Read` also permits retrieving domains for an individual project, while `deployment: Read` permits reading build logs, deployment file listings, builds, and file structure. Bruno must disclose those facts plainly and enforce a narrower product policy:

- status, target, timestamps, deployment URL, production promotion, failure state, regions, and dashboard links may be read automatically;
- project names and identifiers may be read automatically, while project-domain endpoints are not used in the initial product;
- build-log retrieval is allowed only after the Founder opens troubleshooting or explicitly asks Bruno to investigate a failed deployment;
- deployment file listing, file contents, source bundles, and environment-variable endpoints are never used in the initial product;
- build logs are summarized transiently for the attended troubleshooting case and are not copied into ordinary conversation, the Business Graph, or long-lived analytics.

Vercel does not expose a metadata-only deployment scope. The product-level restriction is therefore a data-use boundary, not a claim that the provider token is incapable of reading logs or file listings. [Vercel's permissions table](https://vercel.com/docs/integrations/install-an-integration/manage-integrations-reference) and [integration scope-to-endpoint matrix](https://vercel.com/docs/integrations/create-integration/vercel-api-integrations) establish this limitation.

## Authorization and installation flow

### Use a connectable account integration

Vercel describes a connectable account integration as the type that links an existing third-party account through a redirect URL and OAuth-style installation flow. From Bruno, start the external flow at:

```text
https://vercel.com/integrations/<bruno-integration-slug>/new
```

Vercel returns `code`, `teamId` when a team was selected, `configurationId`, `next`, `state`, and `source=external` to the registered redirect URL. Bruno must bind a random, single-use `state` to the Founder and pending Company Connection before redirecting and reject missing, mismatched, replayed, or expired callbacks. The exchange happens server-side using the registered client ID, client secret, redirect URI, and the returned code. These fields and the external flow are documented in [Requirements for listing an Integration](https://vercel.com/docs/integrations/create-integration/submit-integration).

The authorization code is valid for 30 minutes and can be exchanged once at `POST https://api.vercel.com/v2/oauth/access_token` for a long-lived access token. Vercel explicitly says the access token must stay server-side because it grants access to the selected personal account or team. See [Building Integrations with Vercel REST API](https://vercel.com/docs/integrations/create-integration/vercel-api-integrations).

Bruno should store the encrypted access token together with:

- the Owner/Founder ID;
- `configurationId` as the provider installation identity;
- returned `team_id`, or an explicit personal-account marker when it is null;
- Vercel `user_id`/installer identity if returned by the exchange;
- the granted scope set;
- `projectSelection` and selected project IDs;
- connection status, last verified time, and last successful event/reconciliation cursor.

For a team installation, every API request must include `teamId`. Do not infer team ownership from a project name or reuse a token across team IDs. [Vercel's team interaction guidance](https://vercel.com/docs/integrations/create-integration/vercel-api-integrations) makes the `teamId` query parameter mandatory for team resources.

### Account and team selection

The Founder chooses the Vercel personal account or team on Vercel's own authorization surface. Bruno should not request the `team: Read` scope merely to list team members or decorate the receipt. That scope includes member-list access, which is unrelated to deployment evidence.

The receipt should identify the connection through selected project names and preserve the provider's opaque team/account ID internally. If a human-readable team name cannot be obtained from the selected project payload without `team: Read`, Bruno should let the Founder assign a plain workspace label rather than broadening the provider permission.

For team installations, explain that the Vercel integration token is associated with the member who installed it. Vercel disables the integration if that member loses team access; team owners can transfer or remove it. A disabled integration loses API access and most webhook delivery, and is automatically removed after 30 days if not re-enabled. See [Permissions and Access](https://vercel.com/docs/integrations/install-an-integration/manage-integrations-reference).

Founder-facing recovery should say:

> Vercel paused this connection because its team access changed. Ask a Vercel team owner to transfer the integration, or reconnect it.

Do not surface `integration_configuration_disabled` or the installer user ID outside troubleshooting.

## Project selection is a two-boundary decision

Vercel's installation dialog lets the installing member choose which projects the integration may access, and installed integrations can later manage that access. Vercel models project access as `all` or `selected`, with an explicit project ID list for `selected`. See [Add a Connectable Account](https://vercel.com/docs/integrations/install-an-integration/add-a-connectable-account), [Permissions and Access](https://vercel.com/docs/integrations/install-an-integration/manage-integrations-reference), and [Retrieve an integration configuration](https://vercel.com/docs/rest-api/integrations/retrieve-an-integration-configuration).

Bruno's rule should be stricter than Vercel's maximum:

1. The Founder chooses the account/team in Vercel.
2. The Founder chooses **Specific Projects** in Vercel; never recommend **All Projects**.
3. Vercel's project grant defines the maximum provider-enforced Connection Access.
4. Back in Bruno, the Founder confirms the named projects that should count as Company Connections. Nothing is preselected.
5. Bruno records both provider access and the narrower Founder-approved project allowlist.

Vercel's approval checklist explicitly warns that the project selection before the integration popup is a security boundary and does not, by itself, define which projects the third party should connect inside its own product. It also requires the third-party flow to respect a single-project Vercel grant. See the [Integration Approval Checklist](https://vercel.com/docs/integrations/create-integration/approval-checklist).

If Vercel reports `projectSelection=all`, Bruno should mark the connection as overbroad and ask the Founder to change it to Specific Projects. It must not automatically adopt current or future projects. If Bruno temporarily permits the installation to finish, its own project allowlist remains closed until explicit confirmation.

Listen for `integration-configuration.permission-upgraded`. Its payload includes whether access is `all` or `selected`, the current project IDs, and added/removed project IDs. Removed projects become stale immediately and stop contributing fresh evidence; their retained evidence follows Bruno's separate retention/deletion policy. Added projects remain unselected in Bruno until the Founder confirms them. The event contract is in [Vercel's Webhooks API reference](https://vercel.com/docs/webhooks/webhooks-api).

## Evidence contract

### Webhook-first, REST-reconciled

Subscribe only to events needed to establish deployment state and connection integrity:

- `deployment.created`
- `deployment.ready`
- `deployment.error`
- `deployment.canceled`
- `deployment.promoted`
- `deployment.rollback`
- `integration-configuration.permission-upgraded`
- `integration-configuration.scope-change-confirmed`
- `integration-configuration.transferred`
- `integration-configuration.removed`

`deployment.ready` reports a successfully ready deployment and its target. `deployment.promoted` is the stronger evidence that a deployment has begun serving production traffic. `deployment.rollback` only proves that Vercel accepted a rollback request; Vercel warns that traffic may not yet have switched. `deployment.succeeded` is not appropriate here because Vercel sends it when the integration has registered checks and all blocking checks passed; Bruno is not requesting Deployment Checks. These semantics are documented in [Vercel's Webhooks API reference](https://vercel.com/docs/webhooks/webhooks-api).

Each webhook receipt should retain an allowlisted evidence record, not the raw provider payload:

- Vercel event ID and received time;
- `configurationId`, internal Owner ID, and selected project ID;
- deployment ID and project name;
- lifecycle event and provider timestamp;
- target (`production`, `staging`, or preview/null);
- deployment URL and Vercel dashboard links;
- regions when present;
- the explicit inference, such as "ready" or "promoted to production";
- signature-verification result and source schema version.

Verify `x-vercel-signature` over the raw request body using the Integration Secret, compare it in constant time, and deduplicate by Vercel event ID before changing evidence state. Vercel documents HMAC-SHA1 verification and recommends constant-time comparison in [Setting Up Webhooks](https://vercel.com/docs/webhooks) and the [Webhooks API reference](https://vercel.com/docs/webhooks/webhooks-api).

Use REST reconciliation after initial connection, after a webhook gap, and on a bounded schedule. Restrict calls to selected project IDs and allowlist response fields. The automatic path may call only:

- `GET /v1/integrations/configuration/{id}`;
- `GET /v9/projects` and `GET /v9/projects/{idOrName}` for selected project identity;
- `GET /v6/deployments` and `GET /v13/deployments/{idOrUrl}` for selected-project status/history;
- `GET /v2/deployments/{idOrUrl}/aliases` only when the evidence needs the serving URL.

The automatic path must not call deployment-events/build-log endpoints or deployment-file endpoints. Vercel warns that response shapes can gain fields without an endpoint version change and says clients should read only needed keys rather than proxying entire responses. It also exposes rate-limit state through `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset`; Bruno should back off on 429 rather than repeatedly polling. See the [Vercel REST API reference](https://vercel.com/docs/rest-api).

### Plain permission explanation

Before leaving Bruno, show:

> **See deployment activity for the Vercel projects you choose**
>
> Bruno can read project names and domains, deployment history, status, preview and production links, and build output for those projects. Bruno uses project names, deployment status, and links automatically; it uses build output only when you ask it to troubleshoot. Bruno cannot deploy, cancel, delete, change projects, read environment variables, or view billing.

After the callback, show a Connection receipt containing:

- personal Vercel account or Founder-assigned workspace label;
- selected project names;
- "Read deployment evidence" as the active Connection Access;
- a plain disclosure that Vercel bundles build logs/file listings into its read permission;
- "No deployment or project changes";
- the last successful verification and one evidence sample if history exists;
- links to manage project access in Vercel and disconnect in Bruno.

Do not say "read-only Vercel" without qualification: the integration is API read-only, but the deployment read scope includes potentially sensitive build output.

## Token and configuration lifecycle

Vercel documents the integration authorization code as single-use and 30 minutes, and the exchanged integration access token as long-lived. The connectable-integration documentation does **not** publish a refresh-token contract or a precise access-token expiry. Bruno should therefore not model this as a periodically refreshed OAuth token:

- keep the token encrypted and server-only;
- use the integration configuration as the durable provider identity;
- treat 401 as invalid/revoked credentials and offer reconnect;
- treat 403 with `integration_configuration_disabled` as a team-ownership recovery case;
- treat 429 as temporary provider throttling and honor reset headers;
- process `integration-configuration.removed` as immediate provider disconnection;
- process `integration-configuration.transferred` as an account-boundary change, checkpoint work, update the team ID only from the verified event/reconciliation, and require the Founder to reconfirm project mappings before resuming.

Configuration IDs are never reused after deletion or uninstall. A reinstall receives a new configuration ID and must be treated as a new Company Connection; do not attach the new token to retained state from the old connection without a Founder-reviewed migration. See [Building Integrations with Vercel REST API](https://vercel.com/docs/integrations/create-integration/vercel-api-integrations).

Vercel can rotate the Integration Secret in the Integration Console, but its current public integration documentation does not state whether that rotation affects already-issued installation access tokens. The implementation release gate must test secret rotation, token invalidation, uninstall/reinstall, installer removal/role downgrade, installation transfer, and an expired/invalid token rather than relying on undocumented behavior.

## Progressive-consent boundary

Vercel integration scopes are configured on the integration, not requested ad hoc through a per-request scope parameter. Additions and permission upgrades require Vercel review and confirmation; affected users and team owners are notified. Downgrades and removals apply immediately without confirmation. Multiple pending upgrades are confirmed together. See [Updating Scopes](https://vercel.com/docs/integrations/create-integration/vercel-api-integrations#updating-scopes).

That means progressive consent should be designed at feature-release boundaries:

| Capability | Vercel permission | Initial status |
| --- | --- | --- |
| Deployment status, history, and links | Deployment Read | Included and disclosed |
| Project identity and mapping | Project Read | Included and disclosed |
| Installation/project-boundary reconciliation | Integration Configuration Read | Included and disclosed |
| Build-log troubleshooting | Already technically inside Deployment Read | Attended product approval; no new Vercel scope exists |
| Create, redeploy, cancel, or delete deployments | Deployment Read/Write | Out of scope; would require a new decision and scope upgrade |
| Create or update deployment checks | Deployment Checks Read/Write | Out of scope |
| Read or change environment variables | Project/Global Project Environment Variables Read/Write | Out of scope |
| Change projects or domains | Project/Domain Read/Write | Out of scope |
| Team-member, billing, drains, or Edge Config access | Separate scopes | Out of scope |

No Authority Policy should imply that Bruno can perform a Vercel write action under the initial connection. If a later product wants deployment authority, it requires a new Wayfinder decision, a Vercel scope upgrade with a meaningful change note, Vercel/user confirmation, a separate Founder Authority Policy, and a new approval/evidence contract.

## Review and distribution constraints

Bruno can distribute a created connectable account integration from its own site through the external installation URL. Vercel says such integrations carry a **Community** badge and can be installed externally even when they are not listed on the public Integrations page. Public marketplace listing requires at least 500 active installations, compliance with Vercel's review guidelines, and a review request. See [Create an Integration](https://vercel.com/docs/integrations/create-integration).

Before release, Bruno still needs the complete integration-console submission and approval checklist:

- legal developer identity, public support contact, website, documentation, EULA, and privacy policy;
- explicit disclosure of collected Vercel data and every requested permission;
- registered redirect, configuration, and webhook URLs;
- accepted Vercel Integrations Marketplace Agreement;
- tested install while logged in and logged out, callback replay rejection, pagination, long project names, single-project restriction, cancellation, reconnect, uninstall, and reinstallation;
- a configuration page that lets a Founder revisit linked projects;
- verified callback and webhook behavior in the final production domains;
- confirmation in the Integration Console that the connection may be distributed under the selected visibility/review state.

The relevant primary checklists are [Requirements for listing an Integration](https://vercel.com/docs/integrations/create-integration/submit-integration) and the [Integration Approval Checklist](https://vercel.com/docs/integrations/create-integration/approval-checklist). Marketplace discovery is not a launch dependency; correct external distribution and provider approval state are.

## Release gates

Vercel should appear in Bruno's service chooser only after all of these pass against a real personal account and a real team account:

1. The external installation flow validates state and exchanges the code only on Bruno's server.
2. The stored token cannot be observed in browser storage, client payloads, logs, analytics, conversation, or troubleshooting downloads.
3. The installed configuration reports exactly the three Read scopes and no Read/Write scopes.
4. The Founder can select one and multiple specific projects; `all` access is rejected or clearly held as overbroad without ingesting projects.
5. Removed/added projects, scope changes, transfer, disablement, uninstall, and reinstall all yield the specified paused/stale/reconfirm behavior.
6. Signed, duplicate, reordered, and invalid-signature webhook fixtures prove idempotent evidence handling.
7. `ready`, `error`, `canceled`, `promoted`, and rollback events produce truthful receipts; rollback is not mislabeled as completed traffic switching.
8. A missed webhook is repaired by bounded REST reconciliation without calling logs or file endpoints.
9. Build logs can be fetched only through attended troubleshooting, are minimized, and do not enter ordinary retention paths.
10. 401, disabled 403, generic 403, 429, secret rotation, and undocumented token expiry produce plain recovery rather than raw errors.
11. Vercel's current distribution/review state, privacy/EULA/support surfaces, and production callback URLs are accepted before founders see Connect.

## Unresolved implementation facts to verify with Vercel

The public documentation is sufficient for the product decision but leaves these operational details undocumented or ambiguous. They are release tests, not reasons to broaden scope:

- exact lifetime and revocation semantics of the long-lived connectable-integration access token;
- whether rotating the Integration Secret invalidates existing installation tokens;
- webhook retry duration, ordering guarantees, and duplicate-delivery behavior;
- whether every selected-project deployment event is delivered when the integration uses the three recommended Read scopes;
- the exact minimum Vercel team role allowed to install or transfer a connectable integration;
- whether a human-readable team name can be obtained without `team: Read` in the final integration response shapes.

## Primary sources

- [Create an Integration](https://vercel.com/docs/integrations/create-integration)
- [Requirements for listing an Integration](https://vercel.com/docs/integrations/create-integration/submit-integration)
- [Integration Approval Checklist](https://vercel.com/docs/integrations/create-integration/approval-checklist)
- [Building Integrations with Vercel REST API](https://vercel.com/docs/integrations/create-integration/vercel-api-integrations)
- [Permissions and Access](https://vercel.com/docs/integrations/install-an-integration/manage-integrations-reference)
- [Add a Connectable Account](https://vercel.com/docs/integrations/install-an-integration/add-a-connectable-account)
- [Retrieve an integration configuration](https://vercel.com/docs/rest-api/integrations/retrieve-an-integration-configuration)
- [Webhooks API Reference](https://vercel.com/docs/webhooks/webhooks-api)
- [Setting Up Webhooks](https://vercel.com/docs/webhooks)
- [Vercel REST API Reference](https://vercel.com/docs/rest-api)
