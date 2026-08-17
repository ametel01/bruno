# GitHub Company Connection: least-privilege launch boundary

**Research date:** 2026-08-17

**Decision question:** Which GitHub App installation, organization and repository selection,
permissions, review constraints, token behaviors, and progressive-consent boundaries let Bruno.Ai
produce useful development evidence without granting unnecessary access or write authority?

**Method:** Primary-source review of current GitHub documentation for GitHub App installation and
authorization, repository permissions, installation tokens, webhooks, organization approval,
rulesets, protected branches, and app-security practices. No live GitHub App was registered or
installed, and no endpoint was exercised against a private repository.

## Recommendation

Launch one public, Bruno-owned **read-only GitHub App**. A Founder connects it by installing the app
on one personal account or organization and choosing **Only select repositories**. Bruno binds one
GitHub Company Connection to that installation account and its selected repository IDs. A Founder
who needs repositories from another organization installs a separate connection for that account.

The launch app should request only these repository permissions:

| GitHub permission | Level | Founder-facing explanation | Evidence unlocked |
| --- | --- | --- | --- |
| Metadata | Read | See names, basic settings, and collaborator access for repositories you select | Stable repository identity and connection health |
| Contents | Read | Read code, commits, branches, and releases in selected repositories; Bruno cannot change files | What shipped, commit/release history, source-grounded product evidence |
| Issues | Read | Read issues and their conversations; Bruno cannot create, edit, or close them | Product problems, work in progress, decisions, and recurring themes |
| Pull requests | Read | Read pull requests, diffs, reviews, and review comments; Bruno cannot open, approve, or merge them | Change intent, review state, and merge evidence |
| Checks | Read | Read automated check names, results, and annotations; Bruno cannot rerun or publish checks | Current CI evidence attached to commits and pull requests |
| Commit statuses | Read | Read pass, pending, and failure signals reported against commits; Bruno cannot change them | Coverage for integrations that still publish commit statuses instead of checks |

This is enough for Founder Morning Brief, Product Intelligence, and Launch Operator evidence such as
“three changes merged,” “release published,” “two product issues recur,” and “the latest pull
request has a failing check.” GitHub confirms that commits and releases use `Contents: read`,
repository issues use `Issues: read`, pull-request listing uses `Pull requests: read`, check data
uses `Checks: read`, and combined commit status uses `Commit statuses: read`.
([Commits](https://docs.github.com/en/rest/commits/commits),
[Releases](https://docs.github.com/en/rest/releases/releases),
[Issues](https://docs.github.com/en/rest/issues/issues),
[Pull requests](https://docs.github.com/en/rest/pulls/pulls),
[Check runs](https://docs.github.com/en/rest/checks/runs),
[Commit statuses](https://docs.github.com/en/rest/commits/statuses))

Do **not** request repository write permission, organization permission, account permission, user
authorization, Administration, Actions, Workflows, Deployments, security-alert, secret, member, or
webhook-management permission at launch. In particular, do not request a personal access token or
GitHub password. GitHub recommends the minimum app permissions and says apps should never use a
personal access token or password for authentication.
([GitHub App best practices](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app),
[Choosing GitHub App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app))

## Installation and account selection

### Use installation, not user authorization

GitHub distinguishes installing an app from authorizing it. Installation grants repository and
organization access to the app and lets the installer choose repositories. User authorization
grants account permissions and lets the app act on behalf of that person. The read-only Bruno
connection needs the former and not the latter, so the app registration should leave **Request user
authorization (OAuth) during installation** disabled and should not request account permissions.
([Installing a third-party GitHub App](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party),
[Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app))

Founder-facing copy can still say **Connect GitHub**. The receipt should describe the actual grant:
“Bruno is installed on `ACCOUNT` and can read development activity in these repositories.” It
should not imply access to every repository the person can see or that Bruno acts as the person.

### Bind one connection to one installation account

GitHub Apps are installed on a personal account or organization, and the same app may be installed
on multiple accounts. The durable connection key should therefore be GitHub's installation ID and
the account's immutable numeric ID, not a username or organization slug. Store each repository by
its immutable numeric ID as well; GitHub explicitly recommends durable IDs because names can
change.
([Installing a third-party GitHub App](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party),
[GitHub App best practices](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app))

The connection receipt should show:

- personal account or organization name;
- exact selected repositories and whether each is public or private;
- the plain-language read permissions above;
- who installed or requested the app, when known;
- whether organization-owner approval is pending;
- last successful reconciliation and latest development event;
- repositories added or removed since the previous receipt;
- a link to GitHub's installation configuration page; and
- separate **Disconnect** and **Delete retained GitHub data** actions.

### Default to selected repositories

The Founder should explicitly select at least one repository. Bruno should recommend likely company
repositories but never preselect **All repositories**. GitHub's installation screen supports either
all repositories or only selected repositories, and the installer can later change the selection.
If the Founder intentionally chooses all repositories, Bruno should show a stronger receipt and
reminder of the broader account-wide scope; Bruno should still issue task tokens narrowed to the
exact repositories needed.
([Installing a third-party GitHub App](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party),
[Reviewing installed GitHub Apps](https://docs.github.com/en/apps/using-github-apps/reviewing-and-modifying-installed-github-apps))

### Handle organization review without calling it an error

Organization owners can install an app. A repository administrator may also install an app for
repositories they administer when the app asks for no organization permissions and no repository
Administration permission, unless the organization has disabled that ability. Other members can
send an installation request to an owner if the organization's policy permits requests.
([Installing a third-party GitHub App](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party))

That supports a plain connection state machine:

1. **Choose account** — personal account or organization.
2. **Choose repositories** — selected repositories only.
3. **Waiting for your GitHub owner** — a request exists but is not installed; activation may
   continue through another useful Company Connection.
4. **Connected** — installation and selected repositories verified.
5. **Needs attention** — access was suspended, removed, narrowed, or no longer authenticates.

Do not ask the Founder for an owner credential, admin token, or workaround when approval is
required. Provide a shareable explanation of the exact repositories and read-only permissions for
the GitHub owner.

## Webhook and reconciliation boundary

Prefer verified webhooks to broad polling. GitHub recommends webhooks for staying within rate
limits and recommends subscribing only to the events the app needs. The launch app should subscribe
to:

- `push` and `release` for commit and release evidence;
- `issues` and `issue_comment` for product-work evidence;
- `pull_request`, `pull_request_review`, and `pull_request_review_comment` for change and review
  evidence;
- `check_run` and `check_suite` for modern CI results; and
- `status` for legacy commit-status results.

GitHub documents the matching read permission for each of those event families.
([Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads),
[GitHub App best practices](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app))

Every GitHub App receives `installation` and `installation_repositories` events by default. The
latter reports repositories added to and removed from an installation, so Bruno should update the
connection receipt and immediately stop fetching a removed repository. Periodically reconcile the
installation and selected repository IDs as defense against missed webhooks.
([Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads))

Validate `X-Hub-Signature-256` with the raw payload and a high-entropy webhook secret before doing
any work. Process deliveries idempotently, bind every stored event to its installation, account,
and repository ID, and never accept an unverified webhook as business evidence. GitHub explicitly
recommends HMAC-SHA-256 signature validation with a constant-time comparison.
([Validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries))

## Token and credential behavior

Use installation access tokens for the read-only automation. They attribute requests to the GitHub
App rather than to the Founder. The Bruno control plane should hold the app private key in a
sign-only key vault; the key must never reach a Founder runner, browser, log, database row, or
support bundle. GitHub calls the private key the credential that grants access across every
installation and warns against sharing or hard-coding it.
([GitHub App best practices](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app),
[Managing private keys](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps))

For each task, mint or reuse an encrypted cached installation token narrowed to:

- the specific installation;
- the exact selected repository IDs needed for the task; and
- the minimum subset of the app's granted read permissions needed for that task.

GitHub allows installation tokens to be narrowed by repositories and permissions, never widened
beyond the installation, and makes them expire after one hour. GitHub recommends caching a valid
token until expiry rather than repeatedly minting tokens. Tokens must be treated as opaque strings:
GitHub began a staged rollout in April 2026 of a new stateless installation-token format, so Bruno
must not depend on a fixed token length or legacy shape.
([Generating an installation access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app),
[GitHub App best practices](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app))

If a read operation must run on the isolated Founder runner, send only the narrowed, short-lived
installation token for that task over the authenticated runner channel, keep it in memory, redact
it from process output, and discard it at completion or expiry. Prefer doing ordinary evidence
collection in the control plane so no GitHub credential needs to enter the runner at all.

Suspension or uninstallation blocks app access. Repository removal must stop new access to that
repository. Bruno should mark affected evidence stale rather than continuing from cached data, and
offer the already-decided separate deletion action for retained data. GitHub also recommends a
self-service way for users and organization owners to delete app-held data.
([Reviewing installed GitHub Apps](https://docs.github.com/en/apps/using-github-apps/reviewing-and-modifying-installed-github-apps),
[GitHub App best practices](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/best-practices-for-creating-a-github-app))

## Review constraints and write boundary

The launch connection cannot create or edit issues, comment, open pull requests, push code, approve
reviews, rerun checks, change workflows, deploy, or merge. That is both the app's GitHub-enforced
Connection Access and Bruno's initial Authority Policy boundary.

Future write support must be a separately released capability, because GitHub's permission units
are broader than Bruno's business actions:

- `Issues: write` can create issues but also update or close issues and manage issue content.
- `Pull requests: write` can create pull requests and submit reviews, including request-changes
  reviews.
- `Contents: write` can create or replace repository files; modifying `.github/workflows` can also
  require `Workflows: write`.

Those GitHub permissions cannot express “create a draft issue but never close one” or “open a pull
request but never approve or merge it.” Any future write grant therefore needs a narrower Authority
Policy, approval receipts, endpoint allowlists, and runtime enforcement in addition to GitHub's
technical permission.
([Issue endpoints](https://docs.github.com/en/rest/issues/issues),
[Pull-request reviews](https://docs.github.com/en/rest/pulls/reviews),
[Repository contents](https://docs.github.com/en/rest/repos/contents))

For any future code-writing capability, require changes on a Bruno branch through a pull request.
Never grant Bruno Administration permission, never add the app to a branch-protection or ruleset
bypass list, never allow direct pushes to a protected/default branch, and never let Bruno approve
or merge its own work. The repository should require an independent human review, successful
status checks, conversation resolution where appropriate, and no bypass. GitHub supports required
reviews and status checks and permits GitHub Apps on ruleset bypass lists, which is exactly why the
Bruno app must stay off those lists.
([Protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches),
[Ruleset rules](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets))

## Progressive-consent boundary

GitHub App permissions are configured on the app registration. Adding a repository or organization
permission prompts each installation owner to approve the new permission; until approval, that
installation keeps its old permissions. Removing permissions takes effect immediately. A token can
be narrowed below the installed grant, but that hidden token narrowing does not reduce the grant
the Founder approved or the maximum access obtainable by the app's private key.
([Modifying a GitHub App registration](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration),
[Generating an installation access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app))

Therefore:

1. **Repository expansion is clean progressive consent.** The Founder changes the selected
   repository list in GitHub; Bruno consumes the default `installation_repositories` event and
   updates its receipt.
2. **More read categories are app-version consent, not a per-feature toggle.** Adding `Actions:
   read` for workflow logs or `Deployments: read` for GitHub deployment records would prompt
   existing installation owners, while every new installer would see the expanded grant.
3. **Write access must not be pre-granted and hidden behind Bruno policy.** Although task tokens can
   be narrowed, the app private key could mint the full installed write scope. Internal policy is
   not a substitute for GitHub-enforced least privilege.
4. **Use a separate GitHub App for future write authority.** A clearly named optional app such as
   “Bruno GitHub Actions” can be installed only when the Founder chooses a write workflow and only
   on the selected repositories. This is an architectural recommendation inferred from GitHub's
   app-wide permission model; GitHub does not prescribe Bruno's product split.
5. **Keep deep CI diagnostics separate.** Launch checks and statuses provide founder-relevant
   pass/fail evidence. If later troubleshooting genuinely needs GitHub Actions workflow logs,
   jobs, or artifacts, request `Actions: read` through a separately consented diagnostics boundary
   instead of collecting those broader artifacts from every repository at launch.

## Release gates

Before exposing **Connect GitHub**, verify with a test organization and a private test repository:

1. installation on a personal account and an organization;
2. repository-admin installation and organization-owner request/approval behavior;
3. selected-repository add and remove reconciliation;
4. every intended REST and GraphQL read with exactly the six launch permissions and no user token;
5. expected `403` or `401` failures for every prohibited write endpoint;
6. webhook signature rejection, duplicate delivery handling, retry, and missed-event reconciliation;
7. installation suspension, uninstallation, repository removal, account rename, and permission
   update states;
8. one-hour token expiry, cache renewal, explicit revocation, redaction, and the current stateless
   token format;
9. source attribution by immutable installation, account, repository, object, and commit IDs;
10. connection receipt accuracy, disconnect behavior, retained-data deletion, and stale-evidence
    treatment; and
11. proof that the app cannot bypass repository protections or write, approve, deploy, or merge.

## Facts versus recommendations

**Confirmed by current GitHub sources:** the separation of installation and user authorization;
account and repository selection; organization installation and approval constraints; REST and
webhook permission requirements; app-wide permission-update approval; installation-token narrowing
and one-hour expiry; installation and repository-change events; private-key sensitivity; webhook
signature validation; and branch/ruleset review and bypass capabilities.

**Recommendations and inferences from those facts:** one connection per installation account;
selected repositories as Bruno's default; the six-permission read-only launch bundle; the exact
event subscription; omission of Actions and Deployments at launch; control-plane token custody;
plain-language receipts and states; a separate future GitHub App for write authority; and the
specific release-gate tests above.
