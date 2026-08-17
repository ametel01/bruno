# Anthropic Founder AI Connection release contract

**Research date:** 2026-08-17

**Decision question:** Can Bruno safely make an existing Founder-owned Claude subscription an
OAuth-style model connection through Hermes, and how does that differ from Anthropic API-key
compatibility?

**Method:** Primary-source review of the current official Hermes provider documentation and
Anthropic's Claude Code authentication documentation, plan and usage guidance, pricing, terms, and
privacy materials. No live OAuth, setup-token, billing, refresh, or failure-recovery test was run.

## Recommendation

**Decision: Anthropic is an initial compatibility target, but it is not an available Compatible AI
Provider.** Anthropic explicitly says third-party developers may not offer Claude.ai login or route
Free, Pro, or Max credentials for users; developers building products must use an API key or a
supported cloud provider. Hermes' technical ability to consume those credentials does not override
Anthropic's rule. Bruno therefore must not ship subscription OAuth or setup-token routing unless
Anthropic gives Bruno written permission or a commercial agreement for the exact route.
([Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance))

Bruno will not fund or silently supply model capacity, and normal onboarding must not ask a
nontechnical Founder for an API key. If Anthropic later approves a Founder AI Connection, the
intended Founder action is one attended Anthropic browser authorization; Bruno coordinates Hermes
on the Owner-isolated runner without showing terminal or model configuration. The rest of the
release contract must then be proven before Anthropic is shown as available.

OpenAI and Anthropic should be the only initial model-account compatibility targets. If neither has
a verified, usable connection for the Founder, Bruno should say that work is paused until a
compatible provider is connected. It must not route to another provider, ask for a raw API key as
the normal recovery path, or imply that Anthropic compatibility is generally available.

That boundary is necessary because the current primary sources do not form one stable contract:

- Anthropic documents subscription login and a one-year, inference-only setup token for CI and
  scripts on Pro, Max, Team, and Enterprise plans.
- Hermes documents a different practical eligibility rule: its Anthropic OAuth path requires Max
  plus purchased extra credits, does not consume the included Max allowance, and does not work on
  Pro.
- Anthropic's current third-party usage notice says third-party app usage still draws from a
  subscription's usage limits after a planned separate-credit change was paused. That conflicts
  with Hermes' statement that the included Max allowance is never consumed.
- Anthropic's Claude Code legal guidance directly prohibits third-party developers from offering
  Claude.ai login or routing Free, Pro, or Max credentials on behalf of their users. Setup-token
  support for scripts and generic third-party usage-credit wording are not permission for Bruno's
  product route.

This is enough evidence for a controlled compatibility investigation, but not enough to promise a
nontechnical Founder that connecting Anthropic will produce a durable 24/7 operator.

## Required release contract

Anthropic may be shown as an available Compatible AI Provider only when every row is evidenced for
the exact Bruno and Hermes release. These are product release gates derived from the confirmed facts
below, not claims that the current implementation already satisfies them.

| Gate | Required truth and release evidence | Current status |
| --- | --- | --- |
| Commercial permission | Before any runtime testing, Anthropic gives Bruno written permission or a commercial agreement for the exact third-party OAuth/setup-token route, eligible plans, unattended business use, and launch jurisdictions. | **Fails:** Anthropic expressly prohibits third parties from offering Claude.ai login or routing Free, Pro, or Max credentials. Team/Enterprise OAuth is described for ordinary native-app use, not Bruno's product route. |
| Account eligibility | After permission exists, Bruno recognizes only plan/account combinations demonstrated to work through Hermes. An acceptance matrix covers each plan Bruno advertises and records the Anthropic account type, enabled usage credits, returned model, and provider billing entry. | **Blocked:** Hermes says Max plus extra credits only; Anthropic documents broader token eligibility and third-party subscription usage. |
| Attended authorization | The Founder chooses Anthropic and completes Anthropic's own browser authorization. Bruno never asks for a raw API key or setup token in ordinary onboarding, and the Founder sees which Anthropic account will pay before activation. | Documented provider flow; product acceptance evidence not yet produced. |
| Credential custody | Refresh/access tokens stay only in the Owner-isolated runner's protected credential store; Bruno's control plane receives connection status and sanitized evidence, not bearer material. Tests prove restrictive file permissions, encryption where available, log/redaction boundaries, one-click disconnect, and runner-destruction cleanup. | Hermes documents local stores and refresh behavior; Bruno custody/cleanup evidence is absent. |
| Billing and exhaustion | Bruno shows the actual source of usable capacity, remaining credit or provider-reported limit, spend cap, and reset/reload recovery. Tests reconcile calls to Anthropic's usage dashboard. Exhaustion checkpoints and pauses work; it never switches payer, credential, or provider silently. | **Blocked:** primary sources conflict on whether Hermes consumes included subscription capacity or only extra credits. |
| Data use and privacy | The applicable account- and jurisdiction-specific terms are identified; model-improvement choice, retention, deletion, safety-review exceptions, subprocessors, and business-data suitability are disclosed and accepted for the intended Company Connection data. | **Blocked:** the reviewed sources do not state how Hermes-originated Claude Code traffic appears in deletion controls, and consumer treatment differs from the commercial API. |
| Reconnect and revocation | A 401 first attempts the documented refresh path. Terminal refresh failure checkpoints work, marks Anthropic `Reconnect required`, and gives the Founder one attended reauthorization action. Revocation, expiry, password change, disconnect, and reconnect are tested without losing the work checkpoint or routing to an unconnected provider. | Hermes documents refresh/retry mechanics; end-to-end Bruno recovery evidence is absent. |
| Release evidence | A versioned, production-like cohort proves authorization, first inference, unattended operation, billing attribution, privacy setting capture, expiry, refresh, revocation, 401/402/429 handling, exhaustion pause, disconnect, and reauthorization against the exact Bruno/Hermes revisions. Evidence records requested/returned provider and model without storing prompts or secrets. | Not run in this research ticket. |

Until all rows pass, Anthropic must not appear as a connection choice. The internal product state is
`Anthropic compatibility is blocked pending provider permission`, not `Connect Anthropic`. If no
other Founder-connected Compatible AI Provider is usable, affected work checkpoints and pauses.

## Compatibility matrix

| Path | Confirmed technical support | Billing and plan semantics | Launch status |
| --- | --- | --- | --- |
| Founder-owned Anthropic API key | Technically the same direct API route | Founder's Console organization pays standard API rates; a Pro/Max subscription does not include API use | Optional **advanced** compatibility mode only |
| Founder Claude OAuth through Hermes | Hermes offers `hermes model` or `hermes auth add anthropic --type oauth` and prefers Claude Code's refreshable credential store | Hermes says Max plus extra credits only; Pro unavailable; included Max usage is not consumed | **Do not release:** Anthropic prohibits third-party Free/Pro/Max credential routing; written approval is required before other gates matter |
| Founder setup token through Hermes | Anthropic documents `claude setup-token`; Hermes documents a manual setup-token fallback | Anthropic says the token works with Pro, Max, Team, or Enterprise; Hermes' provider section says its subscription route requires Max plus extra credits | **Do not release:** a script credential is not permission for Bruno to route a user's subscription |

Sources: [Hermes AI Providers](https://hermes-agent.nousresearch.com/docs/integrations/providers),
[Claude Code authentication](https://code.claude.com/docs/en/authentication), and
[Anthropic's authentication rule](https://code.claude.com/docs/en/legal-and-compliance).

## Technical authentication paths

### Subscription browser login

Hermes exposes Anthropic OAuth through `hermes model` and
`hermes auth add anthropic --type oauth`. It says this route acts as Claude Code against the
Founder's Anthropic account. When Claude Code credentials already exist, Hermes prefers that
credential store instead of copying the token into `~/.hermes/.env`, preserving refresh behavior.
Hermes can also auto-detect Claude Code credential files.
([Hermes AI Providers](https://hermes-agent.nousresearch.com/docs/integrations/providers))

Anthropic's supported Claude Code login is an attended browser flow. Claude Code accepts Pro, Max,
Team, Enterprise, and Console accounts; subscription OAuth is the default after higher-priority
credential sources have been checked. Anthropic stores the credential in the encrypted macOS
Keychain on macOS and a user-readable credential file with mode `0600` on Linux. Anthropic also
warns that unattended sessions stop when a login expires and cannot refresh, requiring the person
to sign in again. ([Claude Code authentication](https://code.claude.com/docs/en/authentication))

**Product implication:** if this path is released, the Bruno interface should start the
Founder-attended authorization while the Owner-isolated runner performs the Hermes setup behind the
scenes. Bruno must never ask the Founder to run `hermes model` or paste a bearer token, and it must
surface a plain-language `Reconnect Anthropic` state when refresh fails. A consumer connection is
not an infrastructure-free model route; it introduces account eligibility, credit balance, token
refresh, and reauthorization failure states.

### Long-lived setup token

Anthropic documents `claude setup-token` for CI pipelines, scripts, and environments without an
interactive browser login. It opens the browser once and returns a token valid for one year. The
token is inference-only, requires Pro, Max, Team, or Enterprise, cannot use Remote Control or fetch
Claude.ai connectors, and is supplied to Claude Code as `CLAUDE_CODE_OAUTH_TOKEN`.
([Claude Code authentication](https://code.claude.com/docs/en/authentication))

Hermes separately documents a setup-token or manual OAuth fallback supplied as `ANTHROPIC_TOKEN`,
and labels that path fallback/legacy. Its preferred path is the interactive model setup and Claude
Code credential store. Hermes' runtime documentation also recognizes
`CLAUDE_CODE_OAUTH_TOKEN` as an explicit override. The reviewed documentation does not explain
whether Hermes changes the setup token's scope or billing classification once it sends requests
directly.
([Hermes AI Providers](https://hermes-agent.nousresearch.com/docs/integrations/providers),
[Hermes provider runtime](https://hermes-agent.nousresearch.com/docs/developer-guide/provider-runtime))

**Product implication:** a setup token is a credential, not ordinary OAuth consent metadata. Bruno
should not normalize copying it into a hosted settings form. If a later compatibility release uses
it, secret custody must stay on the isolated runner, be encrypted at rest, never enter logs or
support tooling, and have explicit disconnect/revocation and expiry handling.

### API key

Hermes supports direct Anthropic inference with `ANTHROPIC_API_KEY`. Anthropic's own authentication
order gives an API key precedence over subscription credentials, and Anthropic warns that this
causes API charges instead of subscription usage. Hermes likewise says API-key requests are billed
pay-per-token to the key's organization and are independent of Pro or Max.
([Hermes AI Providers](https://hermes-agent.nousresearch.com/docs/integrations/providers),
[Claude Code authentication](https://code.claude.com/docs/en/authentication))

This is a clearer technical and commercial contract than the subscription route: a scoped Console
workspace, explicit pay-per-token billing, measurable usage, and a stable provider API. It does not
fit Bruno's normal Founder onboarding, because the Founder must create, fund, copy, rotate, and
revoke a secret. Keep it available only as an explicitly chosen troubleshooting or advanced
compatibility path; never substitute it automatically when OAuth fails.

## Plans, prices, and usage limits

Anthropic's individual plan prices on the research date are:

| Plan | Public price | Published capacity description |
| --- | ---: | --- |
| Pro | $20/month or $200/year | Standard individual capacity |
| Max 5x | $100/month | 5x Pro capacity per session |
| Max 20x | $200/month | 20x Pro capacity per session |

These are individual subscriptions, not API credits. Anthropic states that Pro and Max usage is
shared across Claude and Claude Code and that an `ANTHROPIC_API_KEY` switches use to separately
billed API capacity. Usage varies with model, workload, and other product activity, so none of
these subscriptions is a fixed production throughput entitlement.
([Choose a Claude plan](https://support.claude.com/en/articles/11049762-choose-a-claude-plan),
[Use Claude Code with Pro or Max](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan))

Anthropic also sells usage bundles to Pro, Max, and Team accounts. Current bundle prices are $45
for $50 of usage, $200 for $250, and $700 for $1,000. Pro and Max subscribers may buy up to $2,000
of discounted bundle value per month, after which usage is billed at standard rates. Anthropic says
the same balance can be used by Claude, Claude Code, Cowork, and third-party products using the
Claude account, after included plan limits are exhausted.
([Buy usage bundles](https://support.claude.com/en/articles/14246112-buy-usage-bundles))

Hermes' current rule is narrower and materially different: it says only Claude Max with purchased
extra credits can use Hermes OAuth; Pro cannot; and Hermes consumes the extra credits while leaving
the included Max allowance untouched. Meanwhile, Anthropic's June 2026 notice says a planned
separate Agent SDK credit was paused and, for now, Agent SDK, `claude -p`, and third-party app usage
still draw from subscription limits.
([Hermes AI Providers](https://hermes-agent.nousresearch.com/docs/integrations/providers),
[Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan))

**Confirmed conclusion:** the sources disagree about both eligible plans and which balance Hermes
usage consumes. Bruno must not infer that Pro works from Anthropic's generic token eligibility, or
that Max base allowance is available from Anthropic's generic third-party wording. A release gate
needs successful account tests for each advertised plan plus matching entries in Anthropic's usage
dashboard and written provider confirmation.

For comparison, direct Anthropic API billing is explicit. Anthropic's Claude Sonnet 4.6 API model
costs $3 per million base input tokens, $0.30 per million cache reads, and $15 per million
output tokens. The current API pricing page also lists newer models and price changes, so Bruno
should read prices into its cost controls rather than hard-code a subscription-equivalent promise.
([Anthropic API pricing](https://platform.claude.com/docs/en/about-claude/pricing))

## Data use and privacy posture

The auth choice also changes the data contract.

### Consumer subscription path

Anthropic classifies Free, Pro, Max, and their use with Claude Code as consumer products. Its
consumer terms allow Anthropic to use submitted materials to improve services and train models
unless the user opts out; feedback and safety-review exceptions remain. Its privacy guidance says
deleted conversations are removed from backend storage within 30 days. If the user enables model
improvement, de-identified chats or coding sessions may remain in training pipelines for up to five
years. Content flagged for a usage-policy violation can be retained for up to two years, with safety
classification scores retained up to seven years.
([Consumer Terms](https://www.anthropic.com/legal/consumer-terms),
[consumer data retention](https://privacy.claude.com/en/articles/10023548-how-long-do-you-store-my-data))

The reviewed sources do not explain whether prompts Hermes sends under a Claude Code credential
appear as deletable Claude conversations, or which product control deletes them. Bruno therefore
cannot promise a 30-day deletion period merely because the account owner can delete ordinary Claude
chats. It also cannot enforce the Founder's model-improvement setting from Hermes documentation.

### Commercial API path

Anthropic's commercial terms say the customer retains its inputs, owns outputs to the extent
permitted by law, and that Anthropic may not train on customer content from the services. Anthropic
also incorporates a DPA and expressly permits customers to use the services to power products for
their own users. Its privacy guidance says API inputs and outputs are automatically deleted from
Anthropic's backend within 30 days by default, subject to documented exceptions such as
customer-controlled longer-retention features, an agreed zero-data-retention arrangement, policy
enforcement, or law.
([Commercial Terms](https://www.anthropic.com/legal/commercial-terms),
[commercial training policy](https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training),
[API retention](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data))

**Recommendation:** make the consumer privacy posture part of the Anthropic release gate before
Bruno sends email, customer, finance, analytics, or source-control evidence through a subscription
connection. A Founder's consumer privacy setting is not equivalent to a product-wide processing
agreement or retention control. If the posture is not acceptable for the intended data, pause the
work rather than route it through a different credential or provider.

## Terms and third-party automation uncertainty

Anthropic's Claude Code-specific rule is decisive for the proposed product path. OAuth is intended
for subscription purchasers' ordinary use of Claude Code and other native Anthropic applications.
Developers building products should use API-key authentication through Claude Console or a
supported cloud provider. Anthropic does not permit third-party developers to offer Claude.ai login
or route Free, Pro, or Max credentials for users, reserves the right to enforce that restriction
without notice, and directs other use cases to sales.
([Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance))

That rule resolves the commercial-permission question for Bruno's current proposal: it is **not
permitted for release**. The generic setup-token and usage-bundle pages establish technical and
billing capabilities, not an exception for Bruno. Team and Enterprise are governed by Commercial
Terms, but the same Claude Code legal page describes their OAuth as ordinary native-app use and
tells product developers to use API keys or a supported cloud provider. Bruno needs an affirmative
Anthropic agreement before treating any subscription tier as eligible.

The Consumer Terms page served during this review applies to consumers in the EEA and Switzerland.
It says an account holder may not share account login information or make the account available to
anyone else, prohibits automated or non-human access except through an API key or where Anthropic
explicitly permits it, and says those consumer services may not be used for commercial or business
purposes. Anthropic now explicitly documents setup tokens for CI and scripts and describes usage
credits working in third-party products, so automated subscription use is not categorically
forbidden. However, the reviewed Anthropic materials do not identify Hermes, document Hermes as an
approved OAuth client, or explain whether a Bruno-hosted, unattended Hermes runner qualifies for
that permission. Bruno must verify the applicable regional terms rather than generalize the
EEA/Swiss contract to every Founder.
([Consumer Terms](https://www.anthropic.com/legal/consumer-terms),
[Claude Code authentication](https://code.claude.com/docs/en/authentication),
[Buy usage bundles](https://support.claude.com/en/articles/14246112-buy-usage-bundles))

By contrast, Anthropic's Commercial Terms explicitly allow its API to power customer-facing
products. That does not fit Bruno's accepted ordinary onboarding because the Founder would have to
administer a raw API key and Bruno supplies no model capacity. It remains evidence that Anthropic
distinguishes product-development authentication from subscription login, not a fallback Bruno may
activate silently. This is not legal advice.

## Reconnect and disconnect behavior

Hermes' credential-pool documentation says a 401 first attempts OAuth refresh and rotates only if
refresh fails; its native Anthropic runtime preflights credential refresh and retries once after
rebuilding the client. Hermes can source Anthropic credentials from Claude Code or its own OAuth
store, and `hermes auth logout anthropic` clears stored Anthropic auth state. If every credential is
exhausted, stock Hermes may use a configured cross-provider fallback.
([Hermes credential pools](https://hermes-agent.nousresearch.com/docs/user-guide/features/credential-pools/),
[Hermes provider runtime](https://hermes-agent.nousresearch.com/docs/developer-guide/provider-runtime),
[Hermes CLI reference](https://hermes-agent.nousresearch.com/docs/reference/cli-commands/))

Bruno's release configuration must disable any fallback to a provider the Founder did not connect.
After the documented refresh attempt fails, the Bruno.Ai Operator checkpoints affected work, exposes the
sanitized reason and `Reconnect Anthropic` action, and waits. A successful attended reconnect may
resume from that checkpoint; a disconnect removes the credential and leaves work paused if no other
Founder-connected provider is usable.

## Recommended Bruno launch boundary

1. **Target boundary:** support only OpenAI and Anthropic model-account compatibility initially. Do
   not advertise a generic provider catalog or silently route to an unselected provider.
2. **Founder experience:** when Anthropic is released, the Founder selects it and completes an
   attended browser authorization on the isolated runner. Normal onboarding never requests a raw
   API key or setup token.
3. **Permission first:** do not run a customer-facing subscription pilot until Anthropic grants a
   written exception or commercial agreement covering Hermes' exact OAuth/setup-token path,
   unattended third-party automation, credential custody, eligible plans, billing precedence,
   launch jurisdictions, and applicable privacy/retention terms.
4. **Compatibility validation after permission:** run bounded tests only for approved plans. For
   each one, verify the model and consumed balance on every call; test refresh, expiry, revocation,
   401/402/429 recovery, account suspension, and hard spend caps. Resolve the eligibility and
   base-allowance contradictions rather than inferring behavior from either provider's generic
   documentation.
5. **Release truthfully:** expose `Connect Anthropic` only after those gates pass. Show the connected
   account, usage source, remaining credit, expiry/reconnect state, and a one-click disconnect. If
   the connection is unavailable or exhausts its usable capacity, say `Work paused — reconnect or
   fund Anthropic to continue`; do not silently change who pays or which provider receives the data.
6. **Troubleshooting only:** a Founder-owned Anthropic API key may remain an advanced diagnostic
   path with explicit API-billing language, workspace scoping, spend limits, rotation, and
   revocation. It is not an onboarding fallback.

Until those gates pass, describing Anthropic OAuth as a normal account connection would be false.
The Founder's Google, GitHub, Stripe, or other selected integrations grant Bruno scoped business
permissions; a Claude consumer credential changes Bruno's core inference capacity, billing,
privacy, and availability. It belongs behind a separate experimental boundary.

## Facts versus recommendations

**Confirmed by current primary sources:** Anthropic's prohibition on third-party Free/Pro/Max
credential routing, the auth mechanisms, token lifetime and scope, credential precedence, Hermes'
Max/extra-credit rule, current plan and bundle prices, current subscription/API billing separation,
the conflicting third-party usage guidance, the published consumer versus commercial data
treatment, and Hermes' refresh/retry/logout mechanics.

**Recommendations/inferences by this review:** limiting initial compatibility to OpenAI and
Anthropic, keeping API-key support troubleshooting-only, treating Hermes subscription support as
experimental, requiring written Anthropic confirmation, and pausing work when no verified provider
connection is usable.
