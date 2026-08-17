# Lead-to-Client account-connection feasibility

**Research date:** 2026-08-18
**Wayfinder question:** Which shortlisted providers offer a production-viable, Founder-authorized connection with explicit resource selection, least Connection Access, unattended refresh, plain revocation, and acceptable review, privacy, distribution, and AI-processing constraints?

## Decision brief

Bruno can launch the accepted Lead-to-Client Loop without a CRM. The production-capable core is one progressively authorized communications suite:

1. **Google Calendar, then Gmail**, using the independently revocable grants already defined by the Google Workspace research. Calendar is viable after sensitive-scope verification. Gmail remains viable but must not ship until restricted-scope verification, the required security assessment, and the Google-to-OpenAI/Anthropic Limited Use gate pass.
2. **Microsoft Outlook Calendar, then Outlook Mail**, using separate multitenant Microsoft Entra app registrations for an honest independent-revocation boundary. Delegated read permissions support both personal Microsoft accounts and work/school accounts, core permissions do not inherently require administrator consent, and server-side authorization-code refresh supports unattended operation. Tenant policy can still require an administrator.

Provider OAuth generally authorizes an account or portal, not the exact records Bruno promises to use. Calendar IDs, mail folders, CRM pipelines, and event types selected after authorization are usually **Bruno-enforced resource boundaries** and must be described that way in the Connection Receipt.

The optional compatibility order is:

1. **Pipedrive first, later** for Founders who already maintain a CRM. Its read scopes and activity model map directly to the Lead-to-Client Loop, but the scopes are broader than their labels suggest and any commercially distributed app requires Pipedrive approval.
2. **HubSpot second, later**. It has strong OAuth, object, association, and webhook surfaces, but an OAuth token can see account-wide objects even when the installing user normally sees only owned records. Current Marketplace rules also require an app that primarily connects HubSpot to external generative AI to use HubSpot's MCP Server and user-level permissions.
3. **Bonsai later, after beta and permission gates**. Its new remote MCP server is a genuine OAuth path designed for Claude, Codex, and other AI clients, but it is beta and exposes every tool allowed by the connected Bonsai role rather than a read-only scope set.

Do not promise **Calendly, HoneyBook, Dubsado, or Bonsai at launch**:

- Calendly has useful invitee-question and routing-form evidence, but its Developer Policy requires prior written consent before subcontracting processing to a third-party subprocessor. Bruno cannot send Calendly data through OpenAI or Anthropic until Calendly grants that consent.
- HoneyBook and Dubsado expose customer-generated API keys for Zapier, not a documented public OAuth contract Bruno can use. That would recreate the raw-secret onboarding the destination rules out.
- Bonsai is promising but not release-ready while its MCP server is beta and the Founder cannot choose read-only Connection Access independently of their Bonsai role.

Contacts are optional enrichment for both suite families. Mail participants and calendar attendees already identify relationships; Bruno's Founder-confirmed Business Graph remains authoritative for lead/client classification, commitments, and next actions.

## Classification

| Provider surface | Classification | Decision-ready reason |
| --- | --- | --- |
| Google Calendar | **Launch-ready after provider review** | Public OAuth and unattended sync are viable; private event reading requires sensitive-scope verification. Calendar selection is a Bruno allow-list because Google scopes remain account-wide. |
| Gmail | **Launch-ready after heightened release gates** | Public OAuth is viable, but `gmail.readonly` is restricted and server-side storage or transmission requires verification, a security assessment, recurring compliance, and a proven AI Limited Use route. |
| Outlook Calendar | **Launch-ready after operational validation** | Delegated `Calendars.Read` supports personal and organizational accounts, offline refresh, change notifications, and delta sync. Selected calendars are Bruno-enforced; shared/delegated resources have notification limitations. |
| Outlook Mail | **Launch-ready after operational validation** | Delegated `Mail.Read` supports personal and organizational accounts without inherent admin consent. The grant covers the signed-in mailbox; folders or relationship filters are Bruno-enforced. |
| Google People / Outlook Contacts | **Later-compatible, optional** | Technically viable read access, but it adds address-book noise and does not establish relationship type, stage, commitment, or next action. |
| Pipedrive | **Later-compatible; preferred first CRM probe** | OAuth, refresh, revocation, read scopes, webhooks, and explicit company identity are documented. Commercial distribution requires approval and read scopes include broader notes/files/filter data. |
| HubSpot | **Later-compatible; second CRM probe** | Strong public APIs and webhooks, but account-wide object access, Marketplace review, current AI-connector/MCP rules, and explicit no-training/data-sharing terms require a dedicated release path. |
| Calendly | **Not presently viable for AI-backed production** | OAuth and useful booking context exist, but external AI processing is blocked until Calendly gives prior written subprocessor consent. Webhooks and routing forms also depend on paid plans. |
| HoneyBook | **Not presently viable** | Current official integration is a user-level API key specifically entered into Zapier; no public OAuth/API contract was found. |
| Dubsado | **Not presently viable** | Current official integration is an Owner/Admin-generated API key specifically for Zapier; no public OAuth/API contract was found. |
| Bonsai | **Later-compatible after beta and access-boundary validation** | Its official beta MCP server uses OAuth 2.1, background refresh, revocation, and explicitly supports AI clients, but access inherits the whole Bonsai role and includes writes. |

“Launch-ready after” means the public provider contract supports a production design; it does not mean Bruno has completed the provider's review or its own release evidence.

## Shared release contract

Every shipped Company Connection should satisfy all of these gates:

1. **Founder-attended authorization:** the Founder selects the provider account or company and sees the exact requested read capability before redirect.
2. **Verified identity:** Bruno binds the provider's immutable account, tenant, portal, or company identifier, not an editable display name or email alone.
3. **Truthful resource selection:** the receipt distinguishes the provider-enforced maximum from the smaller calendars, folders, pipelines, or records Bruno will actually use.
4. **Read-first access:** activation requests no send, modify, delete, pipeline-write, scheduling-write, or invoice-write capability.
5. **Unattended continuity:** refresh rotation, subscription renewal, delta recovery, throttling, missed events, and reconnect states are tested.
6. **Plain revocation:** disconnect revokes the provider credential, stops webhooks/subscriptions, and immediately stops new processing. Retained-data deletion remains a separate Founder choice where provider terms allow it.
7. **Explicit AI transfer:** before a Company Connection can feed a Founder AI Connection, the receipt names OpenAI or Anthropic, the data sent, the outcome, retention, and the applicable no-training/limited-use behavior.
8. **No hidden activation dependency:** Calendar may activate a limited brief. Mail completes the accepted brief. CRM, contacts, booking, and client-management products remain optional.

## Core suite family: Google

The prior [Google Workspace Connection Access research](https://github.com/ametel01/bruno/blob/research/google-workspace-connection-314/docs/research/google-workspace-connection-access.md) remains the authoritative detailed source. Its conclusions are carried forward rather than reopened.

### Authorization and resource boundary

- Gmail and Calendar use separate production Google Cloud projects and grants so either can be revoked independently.
- The OAuth grant selects a Google account. Bruno binds its OpenID Connect `sub`; email is display data.
- Calendar list access lets Bruno present real calendars after OAuth, but `calendar.events.readonly` covers every accessible calendar and `calendar.events.owned.readonly` covers every owned calendar. The selected calendar IDs are a Bruno policy.
- Gmail OAuth covers the authenticated mailbox. Google provides no label-, sender-, thread-, or message-level OAuth boundary.

Sources: [Google OpenID Connect](https://developers.google.com/identity/openid-connect/reference), [Calendar scopes](https://developers.google.com/workspace/calendar/api/auth), [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes).

### Minimum read ladder and unattended operation

- Limited availability: `calendar.calendarlist.readonly` plus `calendar.events.freebusy`.
- Useful meeting preparation: `calendar.calendarlist.readonly` plus `calendar.events.readonly`, or `calendar.events.owned.readonly` when owned calendars suffice.
- Full email-derived brief: `gmail.readonly`. `gmail.metadata` is still restricted and cannot use the messages `q` search parameter, so it is not a compliance shortcut.
- Server-side authorization-code flow requests offline access and stores the refresh token encrypted.
- Gmail watches must be renewed at least every seven days; Google recommends daily renewal. A stale `historyId` returns HTTP 404 and requires full sync.
- Calendar channels expire and must be replaced. An invalid `syncToken` returns HTTP 410 and requires full sync.

Sources: [Google OAuth web-server flow](https://developers.google.com/identity/protocols/oauth2/web-server), [Gmail push](https://developers.google.com/workspace/gmail/api/guides/push), [Gmail sync](https://developers.google.com/workspace/gmail/api/guides/sync), [Calendar push](https://developers.google.com/workspace/calendar/api/guides/push), [Calendar sync](https://developers.google.com/workspace/calendar/api/guides/sync).

### Review, privacy, and AI gates

- Calendar event reading is sensitive-scope access and requires production verification.
- Gmail message or metadata reading is restricted-scope access. Server-side storage or transmission requires restricted-scope verification and the applicable security assessment/recertification.
- Google permits prominent user-facing generative summaries but prohibits using Workspace data to train or improve a general AI model. Data transfer must be necessary for the selected user-facing feature, disclosed, consented, retained only as permitted, and deletable.

Sources: [Google sensitive-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification), [Google restricted-scope requirements](https://developers.google.com/workspace/workspace-api-user-data-developer-policy#restricted-scopes), [Google Workspace Limited Use](https://developers.google.com/workspace/workspace-api-user-data-developer-policy#limited-use-of-user-data).

## Core suite family: Microsoft

### Founder-authorized install path

Register two publisher-verified, multitenant Microsoft Entra applications that accept both work/school and personal Microsoft accounts:

1. **Outlook Calendar connection**
2. **Outlook Mail connection**

Each uses server-side OAuth 2.0 authorization code flow, OIDC, PKCE, and `offline_access`. The `common` authorization endpoint accepts organizational and personal accounts; the Founder chooses the account in Microsoft's attended sign-in. A separate app registration is a Bruno design inference from Microsoft's grant behavior: a refresh token is valid across permissions previously granted to that client, and user revocation is app-level. Separate client identities preserve independent disconnect and progressive consent.

Publisher verification is not nominal. Microsoft warns users about newly registered unverified multitenant apps requesting more than basic sign-in, and tenant consent policy may permit users to approve only verified publishers. A work/school administrator can still block or require approval even though the delegated read permissions themselves do not require admin consent.

Sources: [Microsoft authorization-code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow), [supported account types](https://learn.microsoft.com/en-us/entra/architecture/establish-applications), [publisher verification](https://learn.microsoft.com/en-us/entra/identity-platform/publisher-verification-overview), [consent management](https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/manage-consent-requests).

### Account and resource selection

- Bind the connection to Microsoft Graph's stable user ID plus tenant ID for organizational accounts; display the verified address and account type.
- `Calendars.Read` authorizes the signed-in user's calendars. After OAuth, Bruno lists calendars and starts with all unselected. Selected calendar IDs are Bruno-enforced, not an Entra permission boundary.
- `Mail.Read` authorizes the signed-in user's mailbox. Founder-selected folders or filters are Bruno-enforced; the token remains capable of reading the mailbox.
- Shared/delegated resources are a later boundary. `Mail.Read.Shared` and `Calendars.Read.Shared` exist only for work/school accounts, and delegated permissions cannot create change-notification subscriptions for another user's shared or delegated folders. Application permissions would expand access beyond the Founder and are prohibited for launch.

Sources: [Microsoft Graph permissions](https://learn.microsoft.com/en-us/graph/permissions-reference), [Outlook change notifications](https://learn.microsoft.com/en-us/graph/outlook-change-notifications-overview), [calendar sharing and delegation](https://learn.microsoft.com/en-us/graph/outlook-share-or-delegate-calendar).

### Minimum read ladder

| Founder outcome | Delegated permissions | Boundary |
| --- | --- | --- |
| Identify account and sustain access | `openid`, `profile`, `email`, `offline_access`, `User.Read` | Signed-in account |
| Basic calendar signals | `Calendars.ReadBasic` | User calendars; excludes bodies, attachments, and extensions |
| Meeting-preparation details | `Calendars.Read` | User calendars; selected calendars remain Bruno-enforced |
| Header-only mail signals | `Mail.ReadBasic` | Signed-in mailbox; excludes body, preview, attachments, and extensions |
| Response and follow-up brief | `Mail.Read` | Signed-in mailbox |
| Optional address-book enrichment | `Contacts.Read` | Personal contacts in the signed-in mailbox |

Do not request `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite`, `.Shared`, or application permissions during activation. `Mail.ReadBasic` cannot support message summarization or drafting from thread content; it is a genuine degraded mode, not a replacement for `Mail.Read`.

Source: [Microsoft Graph permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference).

### Unattended refresh, synchronization, and revocation

- A server-side web app that requests `offline_access` receives refresh tokens. Microsoft can rotate the refresh token; Bruno must atomically replace the old value and treat expiry, revocation, Conditional Access, password/admin events, and tenant policy as reconnect states.
- Outlook mail, events, and contacts support change notifications. Subscriptions expire and must be renewed; lifecycle notifications and delta reconciliation protect against missed events.
- Message delta operates per mail folder. Event, message, and contact delta queries provide incremental state without full polling.
- Shared/delegated resources cannot rely on delegated webhook subscriptions and stay out of launch.
- Work/school users can revoke consent in My Apps; personal-account consent is managed in the Microsoft account permissions page. Bruno disconnect should revoke or delete the app grant where supported, erase credentials, and stop subscriptions.

Sources: [Microsoft refresh tokens](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens), [Outlook change notifications](https://learn.microsoft.com/en-us/graph/outlook-change-notifications-overview), [Graph delta query](https://learn.microsoft.com/en-us/graph/delta-query-overview), [revoke work/school permissions](https://support.microsoft.com/en-us/accounts-billing/work-school-edit-or-revoke-application-permissions-in-the-my-apps-portal).

### Distribution, privacy, and AI processing

Microsoft does not require a Marketplace listing for a registered multitenant OAuth application, but Bruno must maintain accurate app registration, a verified publisher, least permissions, a privacy statement, secure storage, deletion/retention behavior, and breach response.

The Microsoft API Terms:

- prohibit requesting more data or permissions than needed;
- prohibit copies beyond the intended application scenario;
- prohibit advertising use, redistribution, or resale of Microsoft API data;
- require express customer permission for Outlook/email uses beyond sync or backup;
- require consent before processing and renewed consent if processing changes;
- require a privacy statement, revocation links, retention policy, and deletion when the user abandons or uninstalls the application.

The reviewed Microsoft API Terms do not state a Google-like blanket prohibition on AI inference or model training. That absence is not permission to train. Bruno's allowed use is the expressly consented Founder feature only, and sending data to OpenAI or Anthropic is a disclosed processing change. The relevant Founder AI Connection must independently prove no-training and appropriate retention before Microsoft data is sent.

Source: [Microsoft APIs Terms of Use](https://learn.microsoft.com/en-us/legal/microsoft-apis/terms-of-use).

## Optional CRM compatibility

### Pipedrive — preferred first later target

#### Install and resource boundary

- A commercially distributed Bruno integration is a Marketplace App even if distributed outside the public catalog, and must pass Pipedrive approval. Private apps are defined for non-commercial internal or specific-client use and cannot be used to bypass approval for general Bruno customers.
- OAuth 2.0 presents the requested scopes and installs into a Pipedrive company. The returned token response includes the company-specific API domain. The selected Pipedrive company is the provider-enforced resource boundary.
- Users accept or deny all requested scopes together. There is no per-pipeline, per-deal, or per-person OAuth selection.

Sources: [Pipedrive Developer Agreement](https://www.pipedrive.com/en/developer-agreement), [OAuth reference](https://developers.pipedrive.com/docs/api/v1/Oauth), [installation flow](https://pipedrive.readme.io/docs/app-installation-flows).

#### Minimum read access and hidden breadth

The smallest useful read set is `base`, `contacts:read`, `deals:read`, and `activities:read`.

Those names understate their breadth:

- `contacts:read` includes people, organizations, notes, files, filters, fields, followers, and related data.
- `deals:read` includes deals, participants, notes, files, filters, pipelines, stages, products, and statistics; it excludes most activities.
- `activities:read` includes activities, fields, types, files, and filters.

Bruno should fetch only Founder-selected pipelines and active relationship records, but that is a Bruno policy inside company-wide granted scopes. Do not request `mail:read`; the core suite mailbox is the canonical communication source.

Source: [Pipedrive scopes and permission explanations](https://pipedrive.readme.io/docs/marketplace-scopes-and-permissions-explanations).

#### Continuity, revocation, distribution, and data use

- Access tokens last about 60 minutes; refresh tokens support unattended renewal.
- V2 webhooks cover deals, leads, people, organizations, activities, and related objects. Events are checked against the authorizing user's permissions.
- User uninstall sends a signed callback. Vendor-initiated disconnect revokes the refresh token through the RFC 7009 endpoint and marks the app uninstalled.
- Public review requires OAuth, least scopes, tested install/uninstall, webhook use where possible, terms, privacy policy, support, test accounts, and a permissions demonstration. Pipedrive currently warns that reviews can take up to 21 business days.
- The Developer Agreement requires clear disclosure and express consent for every collection, use, processing, or disclosure of client data. The reviewed agreement has no HubSpot-like express AI-training clause; Bruno must nevertheless limit processing to the Founder-approved feature and disclose OpenAI or Anthropic before transfer.

Sources: [Pipedrive app approval](https://pipedrive.readme.io/docs/marketplace-app-approval-process), [Pipedrive webhooks](https://developers.pipedrive.com/docs/api/v1/Webhooks), [Pipedrive uninstallation](https://pipedrive.readme.io/docs/app-uninstallation), [Pipedrive Developer Agreement](https://www.pipedrive.com/en/developer-agreement).

### HubSpot — second later target

#### Install and resource boundary

- HubSpot OAuth lets the installing Founder choose a HubSpot account and review scopes. The HubSpot account is the provider-enforced resource boundary; object-, pipeline-, and record-level selection is a Bruno policy.
- A critical overbreadth: HubSpot says an OAuth token reflects app scopes, not the installing user's ordinary record visibility. A user limited to owned contacts can authorize a token that reads all contacts in the account.
- The smallest useful object set is `crm.objects.contacts.read`, `crm.objects.companies.read`, and `crm.objects.deals.read`, with other capabilities conditionally required or optional only when a distinct outcome needs them.

Sources: [HubSpot OAuth](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/oauth/working-with-oauth), [HubSpot scopes](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/authentication/scopes).

#### Continuity, webhooks, revocation, and distribution

- The OAuth exchange returns a long-term refresh token and short-lived access tokens for unattended renewal.
- App-level webhooks cover contact, company, deal, association, property, deletion, merge, restore, and privacy-deletion events when the corresponding read scope is granted.
- Certification requires the official uninstall endpoint, minimal used scopes, verified domain, vulnerability assessment, and a security questionnaire covering encryption, access control, and token lifecycle.
- A privately distributed OAuth app is limited to 10 allowlisted accounts. A Marketplace-distributed app is limited to 25 accounts until listing approval and unlimited afterward. Marketplace listing requires at least three active unaffiliated installs and review.

Sources: [HubSpot OAuth token management](https://developers.hubspot.com/docs/api-reference/latest/authentication/manage-oauth-tokens), [HubSpot webhooks](https://developers.hubspot.com/docs/api-reference/latest/webhooks/guide), [HubSpot app management and install limits](https://developers.hubspot.com/docs/apps/developer-platform/build-apps/manage-apps-in-hubspot), [HubSpot listing requirements](https://developers.hubspot.com/docs/apps/developer-platform/list-apps/listing-your-app/app-marketplace-listing-requirements), [HubSpot certification](https://developers.hubspot.com/docs/apps/developer-platform/list-apps/apply-for-certification/certification-requirements).

#### AI-processing constraints

HubSpot's current Developer Terms expressly apply to agents and agentic features. They prohibit using Customer Data or Content to train, fine-tune, improve, or otherwise develop an AI/ML model, product, or service, except a single-customer model trained only for that customer's exclusive benefit with express permission. They also require express customer permission before sharing data with a third party.

Current Marketplace requirements add a structural gate: an “AI connector” whose primary purpose is connecting HubSpot to external generative AI must use HubSpot's MCP Server and user-level permissions. Whether Bruno's broader operator product is classified as an AI connector must be resolved with HubSpot before release; do not assume the ordinary object-API design will pass review.

Sources: [HubSpot Developer Terms](https://legal.hubspot.com/hs-developer-terms), [HubSpot Marketplace listing requirements](https://developers.hubspot.com/docs/apps/developer-platform/list-apps/listing-your-app/app-marketplace-listing-requirements).

## Conditional scheduling enrichment: Calendly

### What it adds beyond Calendar

Calendly is useful only when its own record contains context that a synchronized calendar event does not reliably preserve:

- invitee details and answers;
- cancellation, reschedule, and no-show state;
- event-type identity;
- routing-form questions and submissions.

`routing_forms:read` requires Calendly Teams or higher. Webhooks require a paid Standard, Teams, or Enterprise plan. A Founder on Free can still use ordinary API reads, so polling could support a degraded connection.

Sources: [Calendly scopes](https://developer.calendly.com/scopes), [Calendly supported MCP tools and plan gates](https://developer.calendly.com/supported-tools), [Calendly API FAQ](https://developer.calendly.com/frequently-asked-questions).

### Technical connection

- Public multi-account applications use OAuth 2.1 authorization code flow with PKCE and a production HTTPS redirect URI.
- Minimum read access is `users:read` plus `scheduled_events:read`; add `routing_forms:read` only for the explicit routing-context outcome and `webhooks:write` only for a paid real-time connection.
- The authorization binds one Calendly user and current organization. There is no per-event-type consent boundary; any selected event types are a Bruno policy.
- Access tokens last two hours. Calendly is moving to single-use rotating refresh tokens; clients must atomically save the new token on every refresh by the August 31, 2026 deadline.
- Calendly documents OAuth token revocation and user reconnect.

Sources: [Calendly OAuth app setup](https://developer.calendly.com/creating-an-oauth-app), [Calendly scopes](https://developer.calendly.com/scopes), [Calendly refresh-token rotation](https://developer.calendly.com/refresh-token-rotation-guide), [Calendly API FAQ](https://developer.calendly.com/frequently-asked-questions).

### Blocking data-processing rule

Calendly's Developer Policy requires transparent disclosure of collection, use, and sharing, and says developers may not subcontract data processing to a third-party subprocessor without prior written consent. It also prohibits combining the API with software, technology, services, or materials not authorized by Calendly.

OpenAI or Anthropic processing is central to Bruno, not incidental. Therefore Calendly is **not presently viable for production** until Calendly provides written authorization for Bruno's exact subprocessors and use. Its technical OAuth capability does not override this contractual gate.

Source: [Calendly Developer Policy](https://calendly.com/legal/developer-policy).

## Client-management discovery gates

### HoneyBook — no public Bruno authorization path found

The current official HoneyBook integration documentation exposes a **user-level API key for Zapier**. The Founder copies the secret from HoneyBook and pastes it into Zapier. HoneyBook warns that the key is unique to the user and should not be shared. Official integration catalogs emphasize built-in partners and Zapier rather than a public OAuth developer platform.

This path fails Bruno's ordinary onboarding boundary: it requires a raw secret, does not expose scopes, does not document independent unattended refresh, and provides no public third-party review or AI-processing contract for Bruno. HoneyBook remains a discovery partnership, not a promised Company Connection.

Sources: [HoneyBook Zapier setup](https://help.honeybook.com/en/articles/2209205-automate-tasks-with-zapier), [HoneyBook integration catalog](https://www.honeybook.com/product/integrations).

Release gate: HoneyBook must provide a public or partner OAuth contract with scoped read access, stable account identity, revocation, refresh, privacy terms, and explicit OpenAI/Anthropic processing permission.

### Dubsado — no public Bruno authorization path found

Dubsado's current official path is an Owner/Admin-generated API key under Third party connections, specifically for Zapier and available on the Premier plan. The key is displayed once, treated like a password, and manually deleted to revoke it. No public OAuth developer or distribution contract was found in the current official documentation.

That is not a viable Bruno connection: it exposes a raw secret, has no documented scopes or resource chooser, and provides no public AI-processing approval path.

Sources: [Dubsado Zapier connection](https://help.dubsado.com/en/articles/15920600-connecting-with-zapier), [Dubsado settings and integrations](https://help.dubsado.com/en/articles/12856164-accessing-your-settings).

Release gate: Dubsado must provide a public or partner OAuth contract with least read access, refresh, revocation, resource identity, distribution terms, and explicit OpenAI/Anthropic processing permission.

### Bonsai — real OAuth path, but beta and too broad for launch

Bonsai's new hosted MCP server is a materially different result from its older Zapier integration:

- It is live in beta at `https://mcp.hellobonsai.com/mcp` and explicitly supports Claude, Codex, Cursor, n8n, and other OAuth-capable MCP clients.
- It uses OAuth 2.1 authorization code flow with PKCE and dynamic client registration. There are no API keys to copy.
- Access tokens last 15 minutes and the client refreshes them in the background.
- The client can revoke its token through Bonsai's OAuth revocation endpoint.
- Bonsai explicitly tells users that requested data goes to the connected AI provider and to review that provider's handling.
- Read and write tools cover tasks, projects, deals, contacts, companies, notes, time entries, and invoices.

The blocking weakness is Connection Access. Bonsai exposes no scopes: the token inherits the logged-in user's company role, and tools are hidden or allowed based on that role. A Founder/Owner commonly has broad write and financial capability. Bruno's Authority Policy can prevent unauthorized actions, but it cannot make the provider token read-only. The server is also beta.

Sources: [Bonsai MCP server](https://docs.hellobonsai.com/), [Bonsai MCP overview](https://help.hellobonsai.com/en/articles/15519733-bonsai-mcp-server).

Bonsai is later-compatible only after:

1. the MCP server leaves beta or Bonsai supplies a production support commitment;
2. Bruno proves its remote MCP OAuth and refresh flow with the Hermes runtime;
3. Bonsai offers scoped read-only authorization or Bruno validates a genuinely least-privileged role that contains the required records without write/financial access;
4. write tools remain unavailable during activation and are introduced only with contextual Connection Access plus Authority Policy;
5. disconnect, data retention, and provider-routing behavior pass end-to-end tests.

## Portfolio implication for the next decision

The next Wayfinder decision should choose the **suite portfolio**, not a broad integration catalog:

- Commit launch scope to Google, Microsoft, or both based on review cost and time-to-first-value.
- Preserve partial activation after Calendar and complete the accepted Morning Brief after Mail.
- Keep Contacts off by default and CRM absent from activation.
- If one optional CRM is selected later, probe Pipedrive before HubSpot, but require real Founder demand before paying either review cost.
- Keep Calendly unavailable until written subprocessor consent exists.
- Keep HoneyBook and Dubsado as partnership discovery items.
- Treat Bonsai as a promising post-launch MCP compatibility experiment, not a launch dependency.

This preserves the accepted product boundary: a Nontechnical Founder chooses familiar company accounts and outcomes, while Bruno handles credentials, synchronization, models, and infrastructure without pretending provider access is narrower than it is.
