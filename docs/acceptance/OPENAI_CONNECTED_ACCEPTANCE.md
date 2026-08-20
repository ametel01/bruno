# OpenAI Connected Acceptance

## Current decision

OpenAI is **not released** in the Founder Operator. A real founder-owned ChatGPT Pro account proved
authorization persistence and bounded approved-model inference on 20 August 2026, but the exact
Operator release did not have a production-reachable Hermes authorization or inference transport.
The qualification therefore stopped with a failed result and OpenAI remains hidden.

This is a provider-specific decision. It does not authorize a Bruno-funded API key, a raw-key form,
or a metered fallback, and it does not make another provider eligible.

## Redacted live observations

The live run retained only allowlisted facts:

- Hermes reported a `chatgpt` authorization for a founder-owned `pro` account. Stable provider
  subject, account, and label values were compared only as SHA-256 digests.
- The authorization store inode, size, modification time, and all three identity digests were
  unchanged across a Hermes gateway restart.
- The approved `openai-codex` / `gpt-5.6-sol` route returned each fixed acceptance sentinel exactly
  once before and after restart. No company data, prompt content, response content, credential, or
  provider payload is retained.
- Hermes recovered with its gateway running and Telegram connected after the restart.
- The deployed Operator had neither `BRUNO_HERMES_CONTROL_URL` nor a separate reachable inference
  transport. Current Hermes `/api/status` reports gateway health, not provider capacity or an
  inference receipt. Its OAuth account listing reports login state but not the immutable account
  identity Bruno requires.
- Current capacity was usable, but the released route could not prove quota degradation. The
  account's current model-improvement setting was also not observable, so an actual Provider
  Processing Disclosure could not be completed.
- Revocation was not attempted after the release-boundary preflight failed. Removing a working
  founder credential merely to continue an already-failed run would create disruption without
  making the release eligible.

The account follows the controls of the authorization method used. OpenAI documents that ChatGPT
sign-in uses the ChatGPT workspace's controls and retention, while API-key use follows API
organization controls. It also documents that locally cached authentication material must be
protected like a password. See [Codex authentication](https://learn.chatgpt.com/docs/auth) and
[Codex pricing and plan access](https://learn.chatgpt.com/docs/pricing).

## Release boundary

`BRUNO_OPENAI_CONNECTED_ACCEPTANCE_RELEASE` is not a boolean feature flag. It must contain the
complete `bruno.founder-openai-connected-acceptance.v1` allowlisted record and match:

- the exact Vercel Git revision for both source and Operator release;
- AI compatibility policy version 2;
- the exact Hermes release revision;
- a qualification and expiry window no longer than eight days;
- a SHA-256 evidence digest; and
- every identity, restart, inference, capacity, disclosure, revocation/recovery, no-fallback, and
  cleanup gate.

Missing, malformed, stale, mismatched, or incomplete evidence keeps OpenAI out of routing, hides its
connection card, and rejects new authorization, polling, or recheck requests. Disconnect remains
available so an already-stored connection can still be revoked safely.

## Required rerun

A future passing run must first provide a production-reachable, authenticated Hermes boundary that
exposes only the bounded identity and readiness facts Bruno needs and supports the approved inference
route. The attended run must then verify the actual privacy setting, injected quota failure, safe
checkpoint pause, provider revocation, same-account reauthorization, and cleanup against the exact
Operator release. Only its current release record may make OpenAI visible.
