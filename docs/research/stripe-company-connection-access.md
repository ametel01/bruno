# Stripe Company Connection Access

Research for [Define least-privilege Stripe Connection Access](https://github.com/ametel01/bruno/issues/315), current as of 17 August 2026.

## Decision

Bruno.Ai should connect a Founder's existing Stripe business through a **public, back-end-only Stripe App using Stripe Apps OAuth 2.0**. It should not use legacy Connect OAuth, ask the Founder for an API key, or request payment-changing permissions in the initial release.

The first release should grant one fixed, read-only **Commerce Evidence** permission bundle:

| Stripe App permission | Founder-facing reason |
| --- | --- |
| `connected_account_read` | Confirm which Stripe business was connected. |
| `balance_read` | Show money available and pending. |
| `charge_read` | Summarize payments and refunds. |
| `payment_intent_read` | Identify failed, processing, and completed payment attempts. |
| `dispute_read` | Warn about disputes that need attention. |
| `payout_read` | Show money moving to the Founder's bank. |
| `invoice_read` | Surface paid, open, overdue, and failed invoices. |
| `subscription_read` | Measure active and changing recurring relationships. |
| `plan_read` | Calculate recurring revenue from Stripe Prices without reading customer profiles. |
| `event_read` | Keep the permitted evidence current when those Stripe objects change. |

Stripe documents each of these as a read permission and separately describes write permissions for the same resources. `charge_read` includes refunds, while Prices use the permission name `plan_read`. Stripe also requires `event_read` plus the applicable object permission for webhook events. [Permissions reference](https://docs.stripe.com/stripe-apps/reference/permissions) [Events](https://docs.stripe.com/stripe-apps/events)

The launch manifest should grant **no `*_write` permission** and should omit `customer_read`, `payment_method_read`, `file_read`, `checkout_session_read`, and `product_read`. The proposed bundle can calculate and explain cash position, payment/refund activity, failed payments, disputes, payouts, invoice health, active subscriptions, and recurring revenue without fetching customer profiles, payment instruments, uploaded identity/dispute files, Checkout sessions, or the product catalogue.

This is a Connection Access boundary, not an Authority Policy. Because Stripe will reject calls outside the manifest's permissions, withholding write permissions prevents Bruno.Ai from creating or changing payments, refunds, payouts, disputes, invoices, or subscriptions even if an application bug or an overly broad Authority Policy attempts to do so. Stripe's permission model requires an explicit manifest permission for every API object an app reads or writes. [How Stripe Apps work](https://docs.stripe.com/stripe-apps/how-stripe-apps-work) [Permissions reference](https://docs.stripe.com/stripe-apps/reference/permissions)

Connection copy and the privacy policy must also state that Bruno.Ai may send the minimum Stripe-derived evidence needed for an operating loop to the Founder's connected Compatible AI Provider. OAuth codes, access tokens, refresh tokens, payment instruments, and uploaded files must never enter a model prompt. Stripe requires apps to declare non-Stripe services that can receive Stripe data and limits data/API use to functionality clearly communicated to users; it forbids reselling or publishing data obtained through an app. [How Stripe Apps work](https://docs.stripe.com/stripe-apps/how-stripe-apps-work) [Quality requirements](https://docs.stripe.com/stripe-apps/review-requirements)

## Why Stripe Apps OAuth, not Connect OAuth

Stripe describes Connect as its product for multi-party platforms that route payments between sellers, customers, and other recipients. Its Standard-account OAuth interface exposes only broad `read_only` and `read_write` scopes, and `read_only` is limited to extensions. That is a poor fit for a data integration whose initial job is evidence, not payment orchestration. [Connect OAuth reference](https://docs.stripe.com/connect/oauth-reference)

Stripe Apps supports a back-end-only integration that syncs Stripe data to an external system, OAuth tokens managed by the external software, and object-level permissions declared in the app manifest. Stripe's current publishing guide explicitly says the Connect Stripe authentication method is deprecated for published OAuth apps and directs developers to Stripe Apps OAuth instead. [Stripe Apps architecture](https://docs.stripe.com/stripe-apps/how-stripe-apps-work) [API authentication methods](https://docs.stripe.com/stripe-apps/api-authentication) [Publish an app](https://docs.stripe.com/stripe-apps/publish-app)

The Stripe App should have no Dashboard UI extension in the initial release. Stripe's publishing guide permits a data-integration app with an empty `ui_extension`, while Bruno Conversation and Company Connections remain the Founder-facing surfaces. [Publish an app](https://docs.stripe.com/stripe-apps/publish-app)

## Founder account selection and connection receipt

1. Bruno.Ai sends the Founder to Stripe's live-mode OAuth install URL with a unique, non-guessable `state` value and an exact pre-registered HTTPS callback URI.
2. Stripe authenticates the Founder, lets them select the appropriate Stripe account, and shows the app's requested permissions. An account administrator must accept the manifest permissions.
3. Bruno.Ai verifies `state`, exchanges the single-use authorization code on its backend, and binds the returned `stripe_user_id` or `account_id` and `livemode` to exactly one Company Connection.
4. Bruno.Ai reads only enough account metadata under `connected_account_read` to show a connection receipt: the selected business identity, Stripe account ID suffix, live or test mode, granted evidence categories, and connection time.
5. The Founder must confirm the receipt before Bruno.Ai treats the source as company evidence. A sandbox or test-mode installation can support evaluation, but it must not satisfy activation that promises evidence from the Founder's real company.

Stripe's hosted install flow supplies the account selector and permission review. Its OAuth response identifies the selected account and whether it is live mode. The authorization code is single-use and valid for five minutes. [Stripe Apps OAuth](https://docs.stripe.com/stripe-apps/api-authentication/oauth) [Install links](https://docs.stripe.com/stripe-apps/install-links)

The selector is the authoritative resource choice. Bruno.Ai must not infer another Stripe account from the Founder's email address, silently connect every account they can access, or treat an existing Bruno billing customer ID as the connected company resource.

## Token and disconnect behavior

Stripe Apps OAuth access tokens expire after one hour. Refresh tokens expire after one year but roll on every successful exchange: Stripe returns a new refresh token and invalidates the previous one. Bruno.Ai therefore needs automatic server-side refresh, encrypted refresh-token storage, and an atomic single-writer rotation path so concurrent jobs cannot overwrite the newly issued token with an invalidated predecessor. [Stripe Apps OAuth](https://docs.stripe.com/stripe-apps/api-authentication/oauth)

Operational behavior should be:

- Refresh before a scheduled read or after an authentication failure; never ask the Founder to copy a token.
- Checkpoint affected work while a refresh is in flight. If refresh fails, mark only the Stripe Company Connection as `Reconnect required` and preserve its last verified evidence with a visible staleness timestamp.
- Treat `account.application.deauthorized` as authoritative notice that the Founder disconnected or uninstalled the app. Stop new reads immediately and destroy the local OAuth credentials. [Stripe Apps events](https://docs.stripe.com/stripe-apps/events)
- Keep disconnecting access separate from deleting already retained evidence, consistent with the map's retention boundary.

## Progressive consent boundary

Stripe App permissions are versioned in the manifest, not dynamically selected per Founder. Stripe automatically updates ordinary app versions, but a permission-scope change prompts installed users to reauthorize all new permissions; Stripe notifies them by email and in the Dashboard. An app cannot truthfully offer per-Founder, just-in-time Stripe scopes inside one installed version. [Versions and releases](https://docs.stripe.com/stripe-apps/versions-and-releases)

Accordingly:

- The launch consent screen is one fixed Commerce Evidence bundle. Bruno.Ai may explain it in outcome language, but must not claim that individual permissions can be toggled when Stripe does not provide that control.
- Additional read access is allowed only after a shipped feature needs the data, a new app version passes review, and each affected Founder explicitly reauthorizes it in Stripe.
- Any write permission is a separate product decision and release. It requires a concrete operating loop, a narrow action family, Stripe review, Founder reauthorization, and an Authority Policy that defaults the consequential action to approval required. No write permission should be added merely to avoid future consent friction.
- If a requested scope is absent or a Founder has not reauthorized, Bruno.Ai degrades that finding or action explicitly instead of requesting broader access silently.

This makes progressive consent release-based rather than conversational: Bruno.Ai can introduce a new capability in context, but Stripe remains the place where the Founder grants the new Connection Access.

## Publication and release gates

OAuth requires a public-distribution Stripe App. External testing is limited to 25 testers and is explicitly for pre-publication testing; testers need administrator rights. Public OAuth install links do not work for ordinary users until Stripe approves and the developer publishes the app. [Stripe Apps OAuth](https://docs.stripe.com/stripe-apps/api-authentication/oauth) [External testing](https://docs.stripe.com/stripe-apps/test-app)

Before Stripe can be presented as an available Company Connection, Bruno.Ai must therefore have:

- an activated developer Stripe account and a public app submitted through Marketplace review;
- production HTTPS redirect URIs with no localhost or dummy callback;
- precise, plain-language purpose text for every manifest permission;
- a public privacy policy, accurate pricing disclosure if Bruno is paid, support contact and response estimate, and complete onboarding/testing instructions;
- disclosure of the Compatible AI Provider data path and minimization boundary described above;
- sandbox, test-mode, and live-mode coverage across relevant Stripe roles, plus app-review credentials that do not expose real customer data;
- no hard-coded API keys and backend storage/rotation for OAuth secrets;
- explicit loading, empty, stale, reconnect, and deauthorization states; and
- confirmation before any future costly or destructive action.

Stripe estimates an initial review response in four business days, but approval must be treated as an external release gate rather than a schedule guarantee. Permission additions require a new release and reauthorization. Stripe also restricts an activated developer account to publishing one app, so the initial manifest and account ownership need deliberate long-term stewardship. [Publish an app](https://docs.stripe.com/stripe-apps/publish-app) [Quality requirements](https://docs.stripe.com/stripe-apps/review-requirements) [Versions and releases](https://docs.stripe.com/stripe-apps/versions-and-releases)

## Known account boundary

A Stripe App installed by a Connect platform sees the platform's data, not the data of all accounts connected to that platform. A connected account gets full app functionality only when it can install the app directly; Stripe cites Standard accounts with full Dashboard access and Embedded Stripe Apps as supported examples. [How Stripe Apps work](https://docs.stripe.com/stripe-apps/how-stripe-apps-work)

The initial compatibility statement should therefore be: **one directly selected Stripe account with eligible app-install access**. Bruno.Ai must not promise portfolio-wide evidence for Connect platforms, Express accounts, or Custom accounts until a separate compatibility decision proves that account topology and authorization path.

## Decision-ready acceptance contract

The Stripe Company Connection is ready for Founder onboarding only when all of the following are true:

1. Stripe has approved and published the public, back-end-only OAuth app.
2. The manifest contains exactly the Commerce Evidence permissions above and no write permissions.
3. Stripe hosts account selection and permission consent; Bruno verifies `state`, the returned account, and live mode.
4. The connection receipt identifies the selected business and plainly lists what Bruno can read and what it cannot change.
5. Refresh-token rotation, deauthorization handling, reconnection, and stale-evidence behavior pass unattended-operation tests.
6. A permission change cannot activate until Stripe review succeeds and the Founder reauthorizes it.
7. Unsupported Connect account topologies fail with a plain compatibility explanation rather than broader access or an API-key fallback.
