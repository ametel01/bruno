# Anthropic Connected Acceptance

## Current decision

Anthropic is **not released** in the Founder Operator. The production environment inspected on
20 August 2026 has no Anthropic Connected Acceptance record and no configured Hermes control URL or
control credential. A production-equivalent authorization, restart, inference, capacity, and
recovery run could therefore not begin. Anthropic remains absent from the Founder workspace, and
its read/start/poll/recheck API actions fail closed. An existing connection can still be disconnected.

No Anthropic login was opened, no inference was made, and no credential, prompt, response, account
identifier, or provider artifact was created or retained during this failed preflight. A valid
OpenAI release remains independent and available.

## Exact compatibility policy

The release now accepts only a complete `bruno.founder-anthropic-connected-acceptance.v1` record,
bound to the exact Vercel Git revision, no more than eight days old, and bound to
`bruno.founder-anthropic-compatibility-policy.v1` plus its exact digest. The former deployment
boolean cannot release Anthropic.

The current policy is deliberately stricter than Anthropic's general Claude Code sign-in
documentation. Anthropic documents subscription OAuth for Pro, Max, Team, and Enterprise accounts,
but Hermes documents its own Anthropic OAuth route as requiring Claude Max **and purchased extra
usage credits**; Hermes says this route consumes the purchased extra usage rather than the base Max
allowance and does not work with Pro. Bruno therefore qualifies only that Hermes-specific route and
does not offer raw API-key or setup-token entry. See
[Claude Code authentication](https://code.claude.com/docs/en/authentication) and
[Hermes AI providers](https://hermes-agent.nousresearch.com/docs/integrations/providers/).

## Privacy and credential disclosure

Before release, the attended Founder disclosure must reflect the actual account class. For consumer
Free, Pro, and Max accounts used with Claude Code, Anthropic says coding sessions may be used for
model improvement when the account holder enables that setting or in specified safety/opt-in cases.
When model improvement is enabled, de-identified data may remain in training pipelines for up to
five years. Deleted conversations leave history immediately and are normally deleted from back-end
systems within 30 days, with stated safety, legal, feedback, and training-run exceptions. These are
provider-side controls and are not deletable by Bruno. See
[model-training controls](https://privacy.claude.com/en/articles/10023580-is-my-data-used-for-model-training)
and [consumer retention](https://privacy.claude.com/en/articles/10023548-how-long-do-you-store-my-data).

Hermes owns OAuth and refresh persistence. Bruno receives only the browser handoff and bounded
verification facts. The ordinary Founder UI never collects an Anthropic API key, OAuth token, or
setup token. Anthropic's own key guidance warns that placing an API key in a third-party tool gives
that tool access to the account, which reinforces this boundary. See
[Anthropic API key security](https://support.anthropic.com/en/articles/9767949-api-key-best-practices-keeping-your-keys-safe-and-secure).

## Required gates

One attended run must prove:

- immutable Anthropic account identity and eligible Max-plus-extra-usage billing;
- Hermes-managed authorization persistence after restart with no raw credential crossing Bruno;
- exact approved-model inference and both available and exhausted capacity behavior;
- current permission, credential, privacy, model-improvement, retention, deletion, and Founder
  disclosure review;
- denial, expiry, quota failure, restart, reconnect, revocation, and restored authorization;
- checkpoint-safe routing with no raw credential collection and no hidden Bruno-funded fallback;
  and
- redacted artifact cleanup.

Missing, malformed, stale, mismatched, partial, or failed evidence releases nothing.

## Required rerun

A future run must first expose the production-equivalent Hermes control boundary and use an attended,
Founder-owned eligible account. It must exercise every positive and negative gate, retain only
allowlisted digests and counts, clean up the authorization and test data, and emit the exact-policy,
exact-revision record. Until then, Anthropic stays hidden without affecting OpenAI.
