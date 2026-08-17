# Least-privilege PostHog Connection Access

**Status:** Decision support for [Define least-privilege PostHog Connection Access](https://github.com/ametel01/bruno/issues/317)

**Researched:** 2026-08-17

**Scope:** Founder-authorized access to an existing PostHog account; no product implementation

## Recommendation

Launch PostHog as a **read-only, single-project Company Connection** using PostHog's OAuth 2.0
authorization-code flow with CIMD and PKCE. Force the Founder to choose exactly one PostHog
project on PostHog's consent screen. The initial permission should read only that project's
weekly web-analytics digest; Bruno must ask the Founder to reconnect and approve a clearly named
capability before it can run broader product-data queries.

Do not request a personal API key, an all-project or organization-wide grant, `query:read`, raw
person access, session replay, or any write scope during the initial connection.

The initial Connection Access contract is:

| Boundary | Decision |
| --- | --- |
| Authorization | PostHog OAuth 2.0 authorization code with PKCE (`S256`), using a production CIMD metadata URL as `client_id` |
| Resource | Exactly one Founder-selected PostHog project (`required_access_level=project`) |
| Initial scopes | `openid`, `project:read`, `web_analytics:read` |
| Initial evidence | Weekly visitors, pageviews, sessions, bounce rate, average session duration, top pages, top sources, and configured goals |
| Mutations | None; no `*:write` scope in the launch ceiling or token |
| Raw data | No event export, person/profile reads, session replay, or arbitrary HogQL in the initial grant |
| Broader analysis | Separate attended re-consent for an explicit capability bundle; never inferred from a question or Authority Policy |
| Token custody | Bruno's server-side connection broker only; never browser storage, logs, Hermes workspace files, prompts, or model tool arguments |
| Disconnect | Revoke with PostHog, stop all use immediately, then delete Bruno's token material; retained findings are handled by the separate data-deletion boundary |
| Initial cardinality | One active PostHog project per Founder; replacing it is an attended reconnect |

This gives a nontechnical Founder an honest permission statement:

> Bruno can read the weekly website performance summary for the PostHog project you choose. It
> cannot change PostHog, inspect recordings or customer profiles, or analyze other projects. If
> you later ask for deeper product analysis, Bruno will explain the extra access and ask you first.

## Why this is the least-privilege usable route

### OAuth is the customer integration path

PostHog explicitly directs apps that other PostHog users install to OAuth instead of personal API
keys. Its recommended CIMD flow uses a URL on Bruno's production domain as the client identity,
does not require pre-registration, and displays the metadata document's app name and logo on the
consent screen. Redirect URIs must match exactly and use HTTPS outside loopback development.
[PostHog OAuth documentation](https://posthog.com/docs/api/oauth)

The current authorization server advertises authorization-code and refresh-token grants, PKCE
`S256`, a revocation endpoint, and separate read/write resource scopes. PostHog's development guide
also documents three resource access levels—everything, selected organizations, or selected
projects—and the `required_access_level=project` parameter for forcing a single project choice.
[PostHog OAuth development guide](https://github.com/PostHog/posthog/blob/532798aeee7b3baec86c773ca453e7e409092505/docs/published/handbook/engineering/oauth-development-guide.md#L171-L264)

Bruno should therefore let PostHog perform the project selection. Bruno stores the selected
project's immutable ID, display name, organization display name when available, and region in the
Connection Receipt. It must not default to the last project visited, select every project, or ask
the Founder to paste IDs.

### A useful narrow read exists without `query:read`

PostHog exposes a weekly web-analytics digest guarded by `web_analytics:read`. It returns bounded,
aggregated evidence: visitors, pageviews, sessions, bounce rate, average session duration,
period-over-period comparisons, top pages, top sources, and goal conversions.
[PostHog web analytics API](https://posthog.com/docs/api/web-analytics)

That endpoint is sufficient for a first "product pulse" without granting the general query
permission. If the chosen project has no usable web-analytics data, the Connection Receipt should
say so and offer a separate "Analyze product usage" permission expansion; lack of data is not a
reason to silently request broader access.

### `query:read` is read-only but not narrow

`query:read` is technically non-mutating, but it is a high-sensitivity permission. PostHog's query
API can query events, persons, data-warehouse tables, and session-replay metadata; its own example
selects email addresses from person properties. PostHog also states that resource-level access
controls do not currently prevent a project member from querying underlying data through HogQL or
the API. Property-level controls can hide selected event, person, and group properties, but their
availability depends on the customer's PostHog plan and configuration.
[PostHog query API](https://posthog.com/docs/api/queries),
[PostHog access control](https://posthog.com/docs/settings/access-control)

Consequently, the consent copy for `query:read` must not say only "read analytics." It should say:

> Bruno can ask read-only questions across events and warehouse data in this project. Depending on
> how your PostHog project is configured, that data can contain customer identifiers. Bruno will
> use aggregate queries by default and will not export your event or person tables.

Bruno's own query broker must add a second safety boundary: typed allowlisted query shapes,
aggregate outputs by default, short date windows, bounded row counts, no model-authored arbitrary
HogQL, and rejection of person-level output unless the Founder has separately approved the exact
workflow. These controls reduce exposure inside Bruno, but must not be presented as narrowing the
provider's `query:read` grant itself.

## Progressive-consent bundles

The CIMD metadata should declare a finite ceiling containing only the launch read scopes Bruno may
request. PostHog documents that `com.posthog.scopes` is a ceiling, not a grant: every requested
scope still requires user consent. Omitting the ceiling would allow the app to request any
grantable scope and should fail Bruno's release review.
[PostHog scope-ceiling documentation](https://posthog.com/docs/integrate/provisioning#declare-oauth-scopes-for-your-app-optional)

Within that ceiling, request the smallest bundle that matches the Founder's chosen outcome:

| Founder-facing capability | Additional resource scopes | Consent and handling |
| --- | --- | --- |
| **Website performance** (initial) | `web_analytics:read` | Bounded weekly digest only |
| **Review my saved analytics** | `dashboard:read`, `insight:read`, `query:read` | Explain that saved insight results still require broad query access; restrict execution to selected saved insights |
| **Analyze product usage** | `query:read`, `event_definition:read`, `property_definition:read`, `action:read` | High-sensitivity re-consent; aggregate templates only; no exports |
| **Track experiments** | `experiment:read`, `feature_flag:read` | Read status and results; never change rollout or flags |
| **Review product errors** | `error_tracking:read` | Read issue summaries first; do not include raw stack variables in model context by default |
| **Inspect session recordings** | `session_recording:read` | Separate high-sensitivity consent for a concrete troubleshooting request; never part of a standing default bundle |
| **Inspect customers or journeys** | `person:read`, `group:read`, `customer_journey:read` | Separate high-sensitivity consent; not required for ordinary product evidence |

Rules for every expansion:

1. Trigger it only from a Founder request that cannot be fulfilled with current Connection Access.
2. Explain the new data category, affected PostHog project, intended outcome, and whether customer
   identifiers may be present.
3. Return to PostHog for attended consent. A Bruno Authority Policy cannot add OAuth scopes.
4. Record the old and new grants in the Workspace Ledger and issue a new Connection Receipt.
5. If consent is declined, keep the existing narrower connection usable.
6. Never request a write scope as an "upgrade" to a read bundle. Any future PostHog mutation
   capability needs its own product decision and Authority Policy mapping.

## Token and recovery behavior

### Provider facts

PostHog documents `pha_` access tokens as short-lived and `phr_` refresh tokens as long-lived, and
publishes an RFC 7009 revocation endpoint. GitHub secret scanning automatically revokes a detected
PostHog OAuth access or refresh token and its paired credential.
[PostHog OAuth token documentation](https://posthog.com/docs/api/oauth#token-types),
[PostHog API credential handling](https://posthog.com/docs/api#github-secret-scanning)

Current PostHog source gives dynamically registered CIMD clients a seven-day access-token lifetime
and non-rotating refresh tokens. On refresh, an app ceiling that has been narrowed also narrows the
new access token; if the old grant no longer overlaps the ceiling, refresh fails and requires
reauthorization. These are implementation observations, not a Bruno product guarantee, so Bruno
must obey `expires_in` and OAuth errors rather than hard-code either behavior.
[PostHog current OAuth token implementation](https://github.com/PostHog/posthog/blob/532798aeee7b3baec86c773ca453e7e409092505/posthog/api/oauth/views.py#L92-L108),
[PostHog current refresh behavior](https://github.com/PostHog/posthog/blob/532798aeee7b3baec86c773ca453e7e409092505/posthog/api/oauth/views.py#L686-L778)

PostHog's current disconnect implementation revokes every access token, refresh token, and grant
for the same PostHog user and OAuth application, not only the presented project session. That makes
independent per-project remote disconnect semantics unsafe to promise. Initial Bruno compatibility
should therefore allow one active PostHog project per Founder. Multi-project support must first
design around provider-wide revocation.
[PostHog current revocation behavior](https://github.com/PostHog/posthog/blob/532798aeee7b3baec86c773ca453e7e409092505/posthog/models/oauth.py#L655-L704)

### Bruno behavior

- Exchange the code only on Bruno's server; verify exact redirect URI, `state`, PKCE verifier, and
  issuer/region before persisting anything.
- Encrypt access and refresh tokens with a dedicated connection-secret envelope and make the token
  broker the only component allowed to decrypt them.
- Refresh before expiry with a single-flight lock. Never spray concurrent refresh attempts.
- On `invalid_grant`, revocation, membership loss, scope loss, or repeated `401`, checkpoint affected
  work and show: "PostHog needs to be reconnected." Preserve derived findings as stale until the
  Founder reconnects or deletes them.
- On `403`, distinguish missing scope from lost project permission. Offer the exact consent or
  project-replacement action; do not expose raw OAuth errors in ordinary navigation.
- On disconnect, stop new calls first, revoke remotely, delete local token material even if remote
  revocation is temporarily unavailable, and retain a sanitized audit receipt. Retry remote
  revocation without restoring local usability.
- Never place tokens, authorization codes, PKCE verifiers, raw response bodies, customer
  properties, or person identifiers in logs, analytics, model prompts, or troubleshooting exports.

## Query and evidence boundaries

PostHog says `/query` is for ad-hoc or embedded analytics, not bulk or recurring export. It may
rate-limit or reject export-like traffic, does not support offset pagination for programmatic
requests, and currently limits a project to 2,400 queries per hour, 240 per minute, and three
concurrent queries. Bruno should use the weekly digest or cached typed queries, never mirror raw
events or persons into the Business Graph.
[PostHog query API limits](https://posthog.com/docs/api/queries#rate-limits)

Persist only what Bruno needs to explain an outcome:

- the selected project and region;
- the time window and query purpose;
- the granted scope set at execution time;
- aggregate result values and their PostHog source timestamp;
- a provider request/query identifier when available;
- whether the result was cached, incomplete, stale, or permission-limited.

PostHog records API queries in `query_log`, including the supplied `name`. Bruno should give every
query a stable, non-PII purpose label such as `bruno:weekly-product-pulse` so a Founder or support
operator can trace the access in PostHog without leaking Bruno conversation text.
[PostHog query logging](https://posthog.com/docs/api/queries#creating-a-query)

## Connection Receipt

After authorization, Bruno should show and durably record:

- **Connected:** PostHog region, organization display name, and the one selected project;
- **Authorized by:** the PostHog subject identifier, without copying an email unless required for
  disambiguation;
- **Can read now:** plain-language capability list derived from the actual returned scopes;
- **Cannot do:** change flags, experiments, dashboards, events, people, or settings; read other
  projects; inspect recordings or customer profiles unless separately approved;
- **Evidence check:** the first bounded endpoint attempted, time window, success or unavailable
  reason, and sample aggregate finding when available;
- **Lifecycle:** connected time, last successful refresh, last successful evidence read, and
  reconnect state;
- **Controls:** expand access, replace project, disconnect, and delete retained PostHog-derived
  findings as distinct actions.

The receipt must be generated from the token response and a live project read, not inferred from
what Bruno originally requested.

## Release and review gates

PostHog verification is optional for protocol use, but an unverified-app warning is incompatible
with Bruno's trust-first founder onboarding. Do not expose "Connect PostHog" generally until:

1. the CIMD metadata is hosted on Bruno's production HTTPS domain;
2. all redirect URIs use the same production domain and exact HTTPS paths;
3. the public Bruno product page and privacy disclosure describe the integration;
4. the finite read-only scope ceiling is published in `com.posthog.scopes`;
5. PostHog has verified Bruno in every supported region (US and EU are separate reviews);
6. the Bruno-owned PostHog organization is linked with a CIMD verification token;
7. attended acceptance proves single-project selection, denial, refresh, scope expansion,
   membership loss, revocation, reconnect, and disconnect in both regions;
8. release tests prove no token or raw customer value reaches logs, analytics, model prompts, or
   troubleshooting artifacts.

PostHog says verification checks publisher identity, branding, and scope fit; it is not a security
audit or endorsement. It may be removed after material scope, branding, or behavior changes, so a
scope-ceiling change must re-run the verification release gate.
[PostHog verification requirements](https://posthog.com/docs/api/oauth#going-live-and-getting-verified)

One discovery inconsistency also belongs in acceptance: on 2026-08-17, the documented
region-agnostic authorization-server metadata endpoint returned successfully, and both regional
protected-resource metadata endpoints returned successfully, but the documented
`https://oauth.posthog.com/.well-known/oauth-protected-resource` endpoint returned `404`. Bruno
should not depend on that region-agnostic protected-resource URL until PostHog resolves or documents
the behavior; regional discovery must be tested directly.

## Decision summary

The PostHog Company Connection can meet Bruno's founder-first standard if it begins as a verified,
read-only, single-project OAuth connection with a small aggregated evidence endpoint. The important
boundary is that PostHog's general `query:read` scope is far broader than its name sounds. It must
remain an explicit, high-sensitivity expansion backed by Bruno-side query controls, never the
default permission and never a substitute for plain consent.

## Primary sources

- [OAuth integration](https://posthog.com/docs/api/oauth)
- [Current OAuth authorization metadata](https://oauth.posthog.com/.well-known/oauth-authorization-server)
- [OAuth development guide](https://github.com/PostHog/posthog/blob/532798aeee7b3baec86c773ca453e7e409092505/docs/published/handbook/engineering/oauth-development-guide.md)
- [Scope ceiling](https://posthog.com/docs/integrate/provisioning#declare-oauth-scopes-for-your-app-optional)
- [Web analytics API](https://posthog.com/docs/api/web-analytics)
- [API queries](https://posthog.com/docs/api/queries)
- [Access control](https://posthog.com/docs/settings/access-control)
- [Current OAuth token implementation](https://github.com/PostHog/posthog/blob/532798aeee7b3baec86c773ca453e7e409092505/posthog/api/oauth/views.py)
- [Current OAuth revocation implementation](https://github.com/PostHog/posthog/blob/532798aeee7b3baec86c773ca453e7e409092505/posthog/models/oauth.py)
