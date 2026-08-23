# Clerk and Lemon Squeezy Production Qualification

This runbook defines the human-attended evidence boundary for qualifying Clerk as Identity Provider
and Lemon Squeezy as Commerce Provider before an Initial General Release Decision. It does not
authorize a provider operation. The owner must separately approve and attend every production login,
real charge, cancellation, refund, and cleanup action.

Implementation, an existing provider account, deterministic CI, a configured webhook, or a visible
provider dashboard is not qualification. The Founder Product Contract only validates and consumes a
sanitized summary of separately reviewed source evidence. It never calls Clerk or Lemon Squeezy and
cannot synthesize an attended session, real payment, refund, or cleanup result.

## Candidate identity

Freeze one candidate before any provider run:

- the exact 40-character application revision;
- the exact immutable Operator runtime revision;
- the intended production Clerk instance;
- a sanitized digest of the intended live Lemon Squeezy store reference; and
- a separate sanitized digest of the intended live Lemon Squeezy product reference.

The store and product digests must be different. A test-mode store, product, webhook, or checkout
cannot be relabeled as live evidence. If either revision or intended live reference changes, discard
the summary and repeat the affected external qualification against the new candidate.

## Source-evidence boundary

Keep the reviewed source evidence outside the retained Founder Product Contract artifacts. Never put
any of the following in the workflow input, repository, issue, pull request, logs, or retained
release artifact:

- Clerk subjects, email addresses, names, sessions, tokens, authorization codes, or profiles;
- API keys, webhook secrets, signed URLs, credentials, or recovery codes;
- card, bank, payment, tax, receipt, invoice, or customer details;
- message content, provider payloads, raw webhook bodies, or unrestricted metadata; or
- raw Lemon Squeezy store, product, variant, order, subscription, or customer identifiers.

The attended operator reviews source evidence privately, confirms every required result, sanitizes
it, and produces only the fixed summary fields and SHA-256 digests below. A `true` checklist value is
an assertion about that separately reviewed source evidence, not source proof by itself.

## Required runs

### 1. Attended Clerk production

Against the frozen application and runtime candidate, verify all of these in the intended production
Clerk environment:

- production authentication completes;
- the same internal Owner's session boundary works across desktop and phone;
- verified identity loss denies access and Identity Recovery restores only that exact Owner; and
- Account Closure remains the separately reauthenticated destructive coordinator rather than an
  automatic effect of identity loss or recovery.

Record `result: "passed"` only when every check passed in one bounded attended qualification window.
Every qualification also records `attempts: 1`, `failures: 0`, `flakes: 0`, and `skips: 0`;
any retry, failure, flake, or skip denies the candidate.

### 2. Lemon Squeezy test mode

In Lemon Squeezy test mode, prove checkout, signature verification, Checkout Correlation, reconciled
Product Entitlement, Customer Portal access, cancellation, full refund, duplicate delivery,
reordered delivery, and reconciliation. Test mode is real provider-bound integration evidence, but
it is never a real-charge or live-store result.

### 3. Attended Lemon Squeezy live canary

With explicit owner authorization and the intended live store and product, prove one bounded real
charge, signed webhook processing, Checkout Correlation, Product Entitlement, Customer Portal access,
cancellation, a full refund, duplicate delivery, reordered delivery, reconciliation, and sanitized
cleanup. Hash the independently resolved intended and observed live store references and require the
digests to match; do the same independently for the product reference.

Do not report success until the refund and cleanup have been authoritatively observed. A checkout
page, provider account, test-mode configuration, webhook receipt alone, cancellation request, or
refund request does not satisfy the canary.

## Allowlisted handoff

The shape below is illustrative only. Placeholder values and `false` checks are intentionally
release-denied and are not provider evidence.

```json
{
  "schemaVersion": "bruno.production-provider-qualification-summary.v1",
  "applicationRevision": "<exact-40-character-revision>",
  "runtimeRevision": "<exact-immutable-runtime-revision>",
  "evidenceDigest": "sha256:<aggregate-sanitized-evidence-digest>",
  "qualifications": [
    {
      "kind": "clerk_production",
      "evidenceClass": "attended_production",
      "providerEnvironment": "production",
      "applicationRevision": "<same-application-revision>",
      "runtimeRevision": "<same-runtime-revision>",
      "observedAt": "<exact-ISO-8601-instant>",
      "expiresAt": "<exact-ISO-8601-instant-no-more-than-eight-days-later>",
      "result": "failed",
      "attempts": 1,
      "failures": 1,
      "flakes": 0,
      "skips": 0,
      "evidenceDigest": "sha256:<independent-sanitized-digest>",
      "sanitized": true,
      "checks": {
        "productionAuthentication": false,
        "crossDeviceSession": false,
        "identityRecovery": false,
        "accountClosureBoundary": false
      }
    },
    {
      "kind": "lemon_squeezy_test_mode",
      "evidenceClass": "provider_test_mode",
      "providerEnvironment": "test",
      "applicationRevision": "<same-application-revision>",
      "runtimeRevision": "<same-runtime-revision>",
      "observedAt": "<exact-ISO-8601-instant>",
      "expiresAt": "<exact-ISO-8601-instant-no-more-than-eight-days-later>",
      "result": "failed",
      "attempts": 1,
      "failures": 1,
      "flakes": 0,
      "skips": 0,
      "evidenceDigest": "sha256:<independent-sanitized-digest>",
      "sanitized": true,
      "checks": {
        "checkout": false,
        "signedWebhook": false,
        "checkoutCorrelation": false,
        "productEntitlement": false,
        "customerPortal": false,
        "cancellation": false,
        "fullRefund": false,
        "duplicateDelivery": false,
        "reorderedDelivery": false,
        "reconciliation": false
      }
    },
    {
      "kind": "lemon_squeezy_live_canary",
      "evidenceClass": "attended_live_canary",
      "providerEnvironment": "live",
      "applicationRevision": "<same-application-revision>",
      "runtimeRevision": "<same-runtime-revision>",
      "observedAt": "<exact-ISO-8601-instant>",
      "expiresAt": "<exact-ISO-8601-instant-no-more-than-eight-days-later>",
      "result": "failed",
      "attempts": 1,
      "failures": 1,
      "flakes": 0,
      "skips": 0,
      "evidenceDigest": "sha256:<independent-sanitized-digest>",
      "sanitized": true,
      "intendedStoreDigest": "sha256:<sanitized-intended-store-reference>",
      "observedStoreDigest": "sha256:<sanitized-observed-store-reference>",
      "intendedProductDigest": "sha256:<sanitized-intended-product-reference>",
      "observedProductDigest": "sha256:<sanitized-observed-product-reference>",
      "checks": {
        "checkout": false,
        "realCharge": false,
        "signedWebhook": false,
        "checkoutCorrelation": false,
        "productEntitlement": false,
        "customerPortal": false,
        "cancellation": false,
        "fullRefund": false,
        "duplicateDelivery": false,
        "reorderedDelivery": false,
        "reconciliation": false,
        "sanitizedCleanup": false
      }
    }
  ]
}
```

Every record digest and the aggregate digest must be distinct from each other and from all
capability-decision evidence digests used by the same release decision. Missing, duplicate, malformed,
failed, incomplete, future-dated, expired, stale, application-mismatched, runtime-mismatched,
test-as-live, live-reference-mismatched, or live store/product-aliased evidence denies the decision.
Unknown fields are discarded and never echoed into retained artifacts.

## Release dispatch

Use the protected Founder Product Contract workflow only after all source evidence has been reviewed
and sanitized. Configure `BRUNO_FOUNDER_RELEASE_RUNTIME_REVISION`,
`BRUNO_FOUNDER_EXPECTED_LIVE_STORE_DIGEST`, and
`BRUNO_FOUNDER_EXPECTED_LIVE_PRODUCT_DIGEST` as protected release-environment variables. They are
the independent candidate authority and cannot be supplied or overridden through dispatch JSON.
Supply `mode: release` and the allowlisted JSON as
`production_provider_qualification_summary_json`, together with the separately required capability,
Founder Usability Acceptance, VoiceOver, and TalkBack summaries.

The workflow emits an Initial General Release Decision; it does not enter Initial General Release.
An absent or invalid production-provider summary produces `outcome: "denied"`. The sanitized denial
is attested and retained before the workflow fails terminally; its durable exact
source-and-protected-runtime GitHub Actions Check Run blocks a replacement dispatch. The retained
artifact is evidence, while repository Check Run history is rerun authority. Do not retry a failed
exact candidate to conceal a provider failure, and do not claim attended, production, payment,
refund, accessibility, cleanup, or release evidence that was not actually observed.
