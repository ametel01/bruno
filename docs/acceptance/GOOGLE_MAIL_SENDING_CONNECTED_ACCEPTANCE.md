# Gmail Sending Connected Acceptance

## Current decision

Gmail sending is **not released** in the Founder Operator. The production environment inspected on
20 August 2026 has no send-only Google OAuth client configuration and no release-bound Connected
Acceptance record. A production-equivalent authorization and real controlled message could
therefore not be attempted. The connection card and contextual offer remain hidden, and all new
authorization and verification requests fail closed.

No message was sent, no delivery was claimed, and no production credential or message content was
created or retained during this failed preflight. Existing disconnect actions remain available so a
stored send-only grant can still be revoked without affecting Calendar or Gmail reading.

## Release preflight

The allowlisted production environment inventory contains none of:

- `BRUNO_GOOGLE_MAIL_SENDING_CLIENT_ID`;
- `BRUNO_GOOGLE_MAIL_SENDING_CLIENT_SECRET`;
- `BRUNO_GOOGLE_MAIL_SENDING_REDIRECT_URI`; or
- `BRUNO_GOOGLE_MAIL_SENDING_CONNECTED_ACCEPTANCE_RELEASE`.

The production release now accepts only a complete
`bruno.founder-google-mail-sending-connected-acceptance.v1` record bound to the exact Vercel Git
revision and no more than eight days old. The former boolean release switch cannot release the
capability.

## Policy and delivery gates

The record must prove all of the following from one attended run:

- the separate send-only grant uses the same immutable Google subject identity as Gmail reading;
- the only returned scope is `https://www.googleapis.com/auth/gmail.send` and the grant persists
  after a restart;
- one founder-approved, unique message is sent to the controlled synthetic recipient through
  `users.messages.send`;
- a provider acknowledgement and independent recipient-side delivery observation are both bound
  to redacted evidence digests;
- the recipient has exactly one copy;
- an ambiguous network outcome is shown as `Outcome uncertain` and is not speculatively resent;
- revoking sending blocks later sends while Gmail reading and Calendar remain usable, and attended
  reauthorization restores sending; and
- the controlled message and temporary grants are cleaned up.

Google classifies `gmail.send` as a sensitive scope, distinct from restricted Gmail read scopes.
The web-server OAuth flow should request offline access when ongoing server-side use is required,
and the Gmail send method accepts the `gmail.send` scope. See
[Choose Gmail API scopes](https://developers.google.com/workspace/gmail/api/auth/scopes),
[OAuth 2.0 for web server applications](https://developers.google.com/identity/protocols/oauth2/web-server),
and [users.messages.send](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send).

Missing, malformed, stale, mismatched, partial, or failed evidence releases nothing.

## Required rerun

A future run must first configure the production send-only OAuth client and exact HTTPS callback.
The attended acceptance must use the same Founder-owned Google identity as the released reading
grant, send only the single approved controlled message, independently verify exactly one delivery,
exercise ambiguity and revocation isolation, clean up, and produce the exact-revision record. Until
then, Gmail sending stays unavailable.
