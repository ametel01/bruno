# Least-privilege Google Workspace Connection Access

Research date: 2026-08-17

## Question

Which OAuth resources, scopes, review constraints, token behaviors, and progressive-consent
boundaries let a Founder connect selected Gmail and Google Calendar company resources for useful
Bruno.Ai outcomes without granting unnecessary access?

## Decision brief

Bruno should treat Gmail and Google Calendar as **two independently authorized Company
Connections**, even when they belong to the same Google Account:

1. A Calendar connection uses its own production Google Cloud project and OAuth grant.
2. A Gmail connection uses a different production Google Cloud project and OAuth grant.
3. Bruno groups them in the product only after verifying that their Google OpenID Connect `sub`
   values identify the same Google Account. Email is display data, not the durable identifier.
4. Each flow asks only for the read capability the Founder has just chosen. Write scopes are later,
   separate consent steps tied to a visible feature.

This separation is not cosmetic. Within one Google API project, incremental authorization combines
all granted scopes, and revoking a token removes all scopes granted to that project across its OAuth
clients. Separate projects are therefore the clean technical boundary for independently revocable
Gmail and Calendar connections. This is a Bruno design inference from Google's documented grant
and revocation behavior, and it should be confirmed during Google's verification process.

Calendar can ship before Gmail. Calendar event reading is a **sensitive-scope** review; Gmail
message or metadata reading is a **restricted-scope** review and, because Bruno transmits or stores
the data server-side, brings restricted-scope security assessment obligations.

## What the Founder is actually selecting

### Google Account

The OAuth grant belongs to one authenticated Google Account. Bruno should retain the verified
OpenID Connect `sub` as the stable account identifier and display the verified email address.
Google explicitly warns that email can change and must not be used as the primary identifier. The
`hd` claim can distinguish an organization-managed Workspace account from a consumer Google
Account; the email domain alone cannot.

Founder-facing receipt:

- **Connected account:** `founder@company.example`
- **Managed by:** `company.example` when a verified `hd` claim is present
- **Account type:** `Google account (not organization-managed)` when `hd` is absent

Bruno must not infer that a consumer Gmail address is a company-owned resource merely because the
Founder calls it one.

Source: [Google OpenID Connect claims](https://developers.google.com/identity/openid-connect/reference)

### Gmail resource boundary

For the Gmail API, the resource is the authenticated user's mailbox. The `userId=me` methods refer
to that mailbox. Neither `gmail.metadata` nor `gmail.readonly` lets the Founder constrain the OAuth
grant to individual labels, senders, threads, or messages.

Bruno may enforce a Founder-selected label or query allow-list in its own policy, and Gmail `watch`
can filter notifications by label, but those are **Bruno restrictions**, not provider-enforced
Connection Access. The permission explanation must still say that the token can read the mailbox
data covered by its scope.

Sources:

- [Gmail profile resource](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/getProfile)
- [Gmail scope definitions](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Gmail push label filtering](https://developers.google.com/workspace/gmail/api/guides/push)

### Calendar resource boundary

The Calendar API can enumerate the calendars on the authenticated user's calendar list, including
their IDs and access roles. Bruno can then let the Founder choose specific calendars and persist an
allow-list of calendar IDs.

However, `calendar.events.readonly` authorizes viewing events on **all** calendars the account can
access. `calendar.events.owned.readonly` narrows that to calendars the account owns, but still not to
individually selected calendars. The selected-calendar boundary is therefore also enforced by
Bruno, not by Google OAuth.

Founder-facing receipt must distinguish:

- **Google permits:** events on all accessible calendars, or all owned calendars for the owned-only
  scope.
- **Bruno will use:** the exact calendars the Founder selected.

Sources:

- [Calendar scope definitions](https://developers.google.com/workspace/calendar/api/auth)
- [Calendar list method and access roles](https://developers.google.com/workspace/calendar/api/v3/reference/calendarList/list)
- [Calendar events list method](https://developers.google.com/workspace/calendar/api/v3/reference/events/list)

## Recommended scope ladder

Scopes are requested only after the Founder chooses the corresponding outcome. Denying one grant
must leave other connections and the rest of Bruno usable.

| Founder choice | Request now | What it enables | Do not request yet |
| --- | --- | --- | --- |
| Identify the connected account | `openid`, `email` | Stable Google account binding via `sub`; verified display email | `profile`, unless Bruno has a concrete need for name or avatar |
| See availability only | `calendar.calendarlist.readonly`, `calendar.events.freebusy` | List calendars, let the Founder select them, and read only availability | Event titles, descriptions, attendees, or write access |
| Include agenda details in briefs | `calendar.calendarlist.readonly`, `calendar.events.readonly` | List calendars and read event details for Bruno's selected-calendar allow-list | Calendar properties, ACLs, or write access |
| Owned calendars only | `calendar.calendarlist.readonly`, `calendar.events.owned.readonly` | Read event details only on calendars the account owns | Shared-calendar event access |
| Include email content in briefs | `gmail.readonly` | Read messages needed for a visible reporting, monitoring, or generative-summary outcome | Compose, modify, settings, or permanent-delete access |
| Header-only email signals | `gmail.metadata` | Read labels and headers but not message bodies | Message bodies and write access |
| Send an approved email | `gmail.send` | Send mail on the Founder's behalf | `gmail.compose`, `gmail.modify`, or `mail.google.com` |
| Add or change owned calendar events | `calendar.events.owned` | Write events on calendars the account owns | Write access to every accessible calendar |
| Maintain an app-created Bruno calendar | `calendar.app.created` | Create and manage only secondary calendars Bruno creates | Existing-calendar write access |

Scope source pages:

- [Gmail API scopes and classifications](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Google Calendar API scopes](https://developers.google.com/workspace/calendar/api/auth)

### Gmail metadata is not a verification shortcut

`gmail.metadata` is still a restricted scope. It reduces exposed content but does not avoid the
restricted-scope review or assessment path. It also cannot use the Gmail messages `q` search
parameter, which can make a useful signal-only workflow less efficient or less capable.

Bruno should offer header-only access only if product evaluation proves a clear Founder outcome.
Otherwise, a plain, explicit `gmail.readonly` request is more honest than presenting metadata access
as a low-risk connection while failing to deliver value.

Sources:

- [Gmail restricted scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Gmail messages list query limitation](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)

### Never request broad mailbox or calendar scopes at launch

Do not request these during ordinary activation:

- `https://mail.google.com/`
- `gmail.compose`
- `gmail.modify`
- `gmail.settings.basic`
- `gmail.settings.sharing`
- `calendar`
- `calendar.events`
- Calendar ACL scopes

They exceed a read-first Morning Brief and violate Google's direction to request only the narrowest
scope required by implemented functionality. If a later feature genuinely needs one, it gets its
own contextual explanation, consent event, Authority Policy, and release review.

Sources:

- [Google OAuth minimum-scope policy](https://developers.google.com/identity/protocols/oauth2/policies)
- [Google verification requirements](https://support.google.com/cloud/answer/13464321)

## Progressive-consent contract

1. **Service choice precedes Google OAuth.** Gmail and Calendar are unselected by default.
2. **Explain before redirecting.** Immediately before consent, state the account data accessed, the
   Founder-visible outcome, whether data is stored, and that selected Calendar/label limits are
   enforced by Bruno rather than Google.
3. **Request one capability family at a time.** Use Google's web-server authorization-code flow,
   `access_type=offline`, and incremental authorization.
4. **Handle partial consent.** Google may grant only some requested scopes. Bruno checks the actual
   returned scope set, enables only supported outcomes, and never loops the Founder back into
   consent unless they explicitly choose the missing feature again.
5. **Select resources after consent.** Once Calendar list access succeeds, show the actual calendar
   names, account, ownership/access role, and an all-unselected chooser. Gmail selection ends at the
   authenticated mailbox; optional label filters are an additional Bruno policy.
6. **Issue a connection receipt.** Record the Google account, granted scopes, Founder-selected
   calendars or Gmail filter policy, unavailable outcomes, last successful sync, data handling, and
   how to disconnect/delete.
7. **Escalate in context.** Ask for email content only when the Founder enables an email-derived
   brief; ask for send or event-write access only when they enable that action family.
8. **Keep OAuth separate from business authority.** A Google write scope only makes an API call
   technically possible. Consequential actions remain approval-required unless the Founder sets a
   narrower Authority Policy.

Google requires an in-product disclosure immediately before affirmative consent; a privacy-policy
link alone is insufficient. Its granular-permissions flow also requires apps to tolerate users
granting only some requested scopes.

Sources:

- [Google Workspace transparent notice and control](https://developers.google.com/workspace/workspace-api-user-data-developer-policy#transparent_and_accurate_notice_and_control)
- [Google granular permissions](https://developers.google.com/identity/protocols/oauth2/resources/granular-permissions)
- [Google incremental authorization](https://developers.google.com/identity/protocols/oauth2/web-server#incrementalAuth)

## Review and release constraints

### Calendar

Reading private Calendar events is a sensitive-scope use case. A public production application must
complete Google's sensitive-scope verification. The review requires configured domains and privacy
policy, scope-specific justification, and a demonstration of the real consent flow and feature.

Calendar can be the first Google Company Connection because it does not require Gmail's
restricted-scope assessment.

Sources:

- [Sensitive-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)
- [Submitting an app for verification](https://support.google.com/cloud/answer/13461325)

### Gmail

Google classifies `gmail.readonly` and `gmail.metadata` as restricted. Google also defines any Gmail
scope that reads message bodies, metadata, or headers as restricted. If Bruno stores restricted data
on servers or transmits it, a security assessment is required. Google's current help states that
restricted-scope applications undergo annual security assessment/recertification.

Gmail release gates:

- restricted-scope verification approved for exactly the scopes in production;
- required CASA assessment and recurring recertification operational;
- encrypted tokens and Google user data at rest and in transit;
- user-visible deletion controls and security-incident handling;
- prompt-injection protection for Workspace data entering agent/model context;
- no production request for a newly added scope before Google approves it.

Sources:

- [Gmail API scope classifications](https://developers.google.com/workspace/gmail/api/auth/scopes)
- [Workspace restricted-scope security requirements](https://developers.google.com/workspace/workspace-api-user-data-developer-policy#restricted-scopes)
- [Google security assessment](https://support.google.com/cloud/answer/13465431)
- [Google annual recertification](https://support.google.com/cloud/answer/13463816)
- [Changes to an approved app](https://support.google.com/cloud/answer/13464018)

### Pre-verification limits and Workspace administrators

An external project in Testing is limited to listed test users, and its non-basic refresh tokens
expire after seven days. An unverified app requesting unapproved sensitive or restricted scopes is
subject to an unverified-app warning and a lifetime 100-new-user cap. These are development
conditions, not a viable founder-facing launch state.

Workspace administrators can block unconfigured third-party apps, restrict Google services, or
allow only specified OAuth access. Bruno must translate `admin_policy_enforced` into a plain
"Your Google Workspace administrator must approve Bruno" state with an admin-ready app name,
client ID, requested services, scopes, and justification.

Sources:

- [Google app audience and user cap](https://support.google.com/cloud/answer/15549945)
- [Google refresh-token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)
- [Workspace app access control](https://support.google.com/a/answer/7281227)

## Google data sent to OpenAI or Anthropic

Google explicitly approves Gmail productivity features such as generative AI summaries. That does
not permit unrestricted model use.

Google's Workspace policy permits transfer only with the user's consent to provide a prominent
user-facing feature. It prohibits transferring or using Workspace data to create, train, or improve
a machine-learning or AI model beyond that specific user's personalized model for the appropriate
feature. The rules apply to raw data and derived data.

Therefore Bruno must not send Gmail or Calendar content through a Founder AI Connection until the
specific OpenAI or Anthropic route has passed a release gate showing:

- Google data is used only to produce the Founder-requested Bruno feature;
- it is not used to train or improve a general provider model;
- subprocessors and sharing are accurately disclosed immediately before consent;
- the Founder has affirmatively consented to that transfer;
- retention and deletion comply with Google's Limited Use requirements.

Provider compatibility alone is not enough. If a personal subscription route cannot establish
these controls, that route cannot process Google Workspace data even if it can process ordinary
Bruno Conversation messages.

Sources:

- [Approved Gmail productivity and generative-summary uses](https://developers.google.com/workspace/workspace-api-user-data-developer-policy#appropriate_access_to_and_use_of_gmail_scopes)
- [Google Workspace Limited Use rules](https://developers.google.com/workspace/workspace-api-user-data-developer-policy#limited-use-of-user-data)

## Token and synchronization behavior

### OAuth tokens

- Use the server-side authorization-code flow and request offline access. A refresh token lets Bruno
  work while the Founder is absent.
- Persist the refresh token in encrypted long-term storage. Do not repeatedly create tokens: Google
  caps live refresh tokens at 100 per Google Account per OAuth client ID and silently invalidates
  the oldest when the cap is exceeded.
- Treat refresh failure as normal recoverable state. Tokens can stop working after user revocation,
  six months of non-use, a Google password change when Gmail scopes are present, token-limit
  eviction, time-limited consent, or Workspace administrator policy.
- A project in external Testing gets seven-day refresh tokens for non-basic scopes.
- Disconnect must revoke the provider grant, stop watches, delete credentials, and independently
  apply the Founder's retained-data choice. Revocation and retained-data deletion are distinct.

Sources:

- [Google web-server OAuth flow](https://developers.google.com/identity/protocols/oauth2/web-server)
- [Google refresh-token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)

### Gmail freshness

- Gmail push uses Cloud Pub/Sub and mailbox `watch`.
- A watch must be renewed at least every seven days; Google recommends daily renewal.
- Notifications may be delayed or dropped, so periodic reconciliation is still required.
- Incremental sync uses `historyId`. History is typically available for at least one week but can be
  shorter; HTTP 404 requires a full sync.

Sources:

- [Gmail push notifications](https://developers.google.com/workspace/gmail/api/guides/push)
- [Gmail synchronization](https://developers.google.com/workspace/gmail/api/guides/sync)

### Calendar freshness

- Calendar notification channels can expire and have no automatic renewal; Bruno must replace them
  before the returned expiration.
- Notifications contain no event body, so Bruno follows them with an authorized API request.
- Calendar incremental sync uses `syncToken`. HTTP 410 means the token is invalid; Bruno must clear
  the affected local event state and perform a new full sync.

Sources:

- [Calendar push notifications](https://developers.google.com/workspace/calendar/api/guides/push)
- [Calendar synchronization](https://developers.google.com/workspace/calendar/api/guides/sync)

## Plain-language permission copy

### Calendar availability

> Bruno can see when calendars in this Google account are busy. After Google approves the
> connection, you choose which calendars Bruno will use. Bruno cannot see event titles or details
> with this permission.

### Calendar agenda details

> Google gives Bruno permission to read events on calendars this account can access. You choose the
> calendars Bruno is allowed to use for briefs and answers. Bruno will not add or change events.

### Gmail content

> This permission lets Bruno read messages in this mailbox so it can surface the work you asked for.
> Google does not limit this permission to one label or sender; any filters you choose are enforced
> by Bruno. Bruno will not send, delete, archive, or relabel email.

### AI processing disclosure

> To produce the brief or answer you requested, Bruno sends only the needed Google data to the
> OpenAI or Anthropic account you connected. It is not used to train a general AI model. You can
> disconnect Google and delete retained Google data separately.

The final copy must name the actual AI provider route, actual retention behavior, and actual
subprocessors; placeholders are not sufficient for release.

## Resolution

The least-privilege launch boundary is:

- ship Calendar as an independently revocable, read-first connection;
- let the Founder select calendars while plainly disclosing that OAuth scopes remain account-wide;
- ship Gmail only after restricted-scope verification, security assessment, and AI data-handling
  gates are complete;
- request `gmail.readonly` only for an explicit email-content outcome, not by default;
- defer every write scope to a later contextual consent plus Authority Policy;
- pause and ask for reconnect or administrator approval when Google access is no longer valid;
- never present Bruno's internal allow-list as a Google-enforced permission boundary.

This preserves a useful partial activation path while keeping high-risk Gmail access out of the
default onboarding grant.
