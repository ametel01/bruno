# Google Reading Connected Acceptance

## Current decision

Google Calendar and Gmail reading are **not released** in the Founder Operator. The production
environment inspected on 20 August 2026 has no Calendar or Gmail OAuth client configuration and no
release-bound Connected Acceptance records. A real production-equivalent authorization run could
therefore not start, so both capabilities remain hidden and new authorization requests fail closed.

This is two independent decisions. Calendar evidence cannot release Gmail reading, Gmail evidence
cannot release Calendar, and neither decision authorizes Gmail sending.

## Release preflight

The allowlisted production environment inventory contains none of:

- `BRUNO_GOOGLE_CALENDAR_CLIENT_ID`, `BRUNO_GOOGLE_CALENDAR_CLIENT_SECRET`, or
  `BRUNO_GOOGLE_CALENDAR_REDIRECT_URI`;
- `BRUNO_GOOGLE_MAIL_CLIENT_ID`, `BRUNO_GOOGLE_MAIL_CLIENT_SECRET`, or
  `BRUNO_GOOGLE_MAIL_REDIRECT_URI`; or
- either exact Connected Acceptance release record.

No OAuth request, account data, Calendar event, Gmail message, or credential was created or retained
during this failed preflight. Existing disconnect actions remain available at the API boundary so a
stored authorization can still be revoked safely.

## Policy gates

Each capability requires its own complete `bruno.founder-google-connected-acceptance.v1` record,
bound to the exact Vercel Git revision and no more than eight days old. Both records must prove:

- returned scopes and immutable Google subject identity;
- founder-selected resource narrowing and both zero-result and populated-result reads;
- refresh persistence across restart and preservation when a later exchange omits a refresh token;
- denial, partial consent, expiry, administrator policy, stale evidence, revocation, and
  reauthorization behavior;
- isolation when the sibling capability is revoked; and
- redacted evidence cleanup.

Gmail reading additionally requires current restricted-scope verification, the applicable CASA
disposition, AI Limited Use compliance, and the actual retention, deletion, and in-product disclosure
controls. `gmail.readonly` is a restricted scope; Google says production apps requesting restricted
scopes require verification and server-side access or transmission can require an annual security
assessment. Google also limits Workspace API data to the prominent user-facing feature, restricts
transfers and human access, and prohibits using it to train or improve generalized AI models. See
[Choose Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes),
[Restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification),
and the [Google Workspace API user data and developer policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy).

Missing, malformed, stale, mismatched, partial, or failed evidence releases neither capability.

## Required rerun

A future run must first configure separate production OAuth clients and exact HTTPS callbacks. The
attended acceptance must use real Founder-owned accounts, exercise every positive and negative gate,
record only digests and allowlisted counts, clean up test grants and data, and produce separate
Calendar and Gmail release records for the exact Operator revision. Until then, both connection cards
and all non-disconnect authorization actions stay unavailable.
