# Can Bruno use a founder's Claude subscription through Hermes?

**Research date:** 2026-08-17

**Decision question:** Can Bruno safely make an existing founder-owned Claude subscription an
OAuth-style model connection through Hermes, and how does that differ from Anthropic API-key
compatibility?

**Method:** Primary-source review of the current official Hermes provider documentation and
Anthropic's Claude Code authentication documentation, plan and usage guidance, pricing, terms, and
privacy materials. No live OAuth, setup-token, billing, refresh, or failure-recovery test was run.

## Recommendation

**Treat Anthropic as an initial compatibility target, not a generally available connection, until
its release gate passes.** Bruno will not fund or silently supply model capacity, and normal
onboarding must not ask a nontechnical founder for an API key. The intended founder action is an
attended Anthropic browser login on the runner. Keep Claude subscription OAuth and setup-token
support experimental and disabled for unattended production agents until Anthropic confirms in
writing that Hermes' exact third-party request path is permitted and how it is metered.

OpenAI and Anthropic should be the only initial model-account compatibility targets. If neither has
a verified, usable connection for the founder, Bruno should say that work is paused until a
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
- Anthropic's consumer terms prohibit credential sharing and automated access except through an API
  key or where Anthropic explicitly permits it. Anthropic explicitly permits setup tokens for
  scripts, and recognizes third-party products in its usage-credit documentation, but the reviewed
  Anthropic materials do not name Hermes or describe Hermes' direct Claude Code routing.

This is enough evidence for a controlled compatibility investigation, but not enough to promise a
nontechnical founder that connecting Claude will produce a durable 24/7 operator.

## Compatibility matrix

| Path | Confirmed technical support | Billing and plan semantics | Launch status |
| --- | --- | --- | --- |
| Founder-owned Anthropic API key | Technically the same direct API route | Founder's Console organization pays standard API rates; a Pro/Max subscription does not include API use | Optional **advanced** compatibility mode only |
| Founder Claude OAuth through Hermes | Hermes offers `hermes model` or `hermes auth add anthropic --type oauth` and prefers Claude Code's refreshable credential store | Hermes says Max plus extra credits only; Pro unavailable; included Max usage is not consumed | Experimental; billing and contractual confirmation required |
| Founder setup token through Hermes | Anthropic documents `claude setup-token`; Hermes documents a manual setup-token fallback | Anthropic says the token works with Pro, Max, Team, or Enterprise; Hermes' provider section says its subscription route requires Max plus extra credits | Experimental fallback, not primary onboarding |

Sources: [Hermes AI Providers](https://hermes-agent.nousresearch.com/docs/integrations/providers),
[Claude Code authentication](https://code.claude.com/docs/en/authentication), and
[Anthropic's subscription/API billing explanation](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-or-max-plan).

## Technical authentication paths

### Subscription browser login

Hermes exposes Anthropic OAuth through `hermes model` and
`hermes auth add anthropic --type oauth`. It says this route acts as Claude Code against the
founder's Anthropic account. When Claude Code credentials already exist, Hermes prefers that
credential store instead of copying the token into `~/.hermes/.env`, preserving refresh behavior.
Hermes can also auto-detect Claude Code credential files.
([Hermes AI Providers](https://hermes-agent.nousresearch.com/docs/integrations/providers))

Anthropic's supported Claude Code login is an attended browser flow. Claude Code accepts Pro, Max,
Team, Enterprise, and Console accounts; subscription OAuth is the default after higher-priority
credential sources have been checked. Anthropic stores the credential in the encrypted macOS
Keychain on macOS and a user-readable credential file with mode `0600` on Linux. Anthropic also
warns that unattended sessions stop when a login expires and cannot refresh, requiring the person
to sign in again. ([Claude Code authentication](https://code.claude.com/docs/en/authentication))

**Product implication:** if this path is ever enabled, Bruno must run the founder-attended login on
the founder's isolated runner, never ask the founder to paste a bearer token into the Bruno web UI,
and surface a plain-language `Reconnect Claude` state when refresh fails. A consumer connection is
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
Code credential store. The reviewed documentation does not explain the environment-variable
translation, scopes, refresh behavior, or revocation behavior of a setup token once Hermes sends
requests directly. ([Hermes AI Providers](https://hermes-agent.nousresearch.com/docs/integrations/providers))

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
fit Bruno's normal founder onboarding, because the founder must create, fund, copy, rotate, and
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
chats. It also cannot enforce the founder's model-improvement setting from Hermes documentation.

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
connection. A founder's consumer privacy setting is not equivalent to a product-wide processing
agreement or retention control. If the posture is not acceptable for the intended data, pause the
work rather than route it through a different credential or provider.

## Terms and third-party automation uncertainty

Anthropic's Consumer Terms say an account holder may not share account login information or make
the account available to anyone else. They also prohibit automated or non-human access except when
using an Anthropic API key or where Anthropic explicitly permits it. Anthropic now explicitly
documents setup tokens for CI and scripts and describes usage credits working in third-party
products, so automated subscription use is not categorically forbidden. However, the reviewed
Anthropic materials do not identify Hermes, document Hermes as an approved OAuth client, or explain
whether a Bruno-hosted, unattended Hermes runner qualifies for that permission.
([Consumer Terms](https://www.anthropic.com/legal/consumer-terms),
[Claude Code authentication](https://code.claude.com/docs/en/authentication),
[Buy usage bundles](https://support.claude.com/en/articles/14246112-buy-usage-bundles))

By contrast, Anthropic's Commercial Terms explicitly allow its API to power customer-facing
products. This is not legal advice, but it is a clear product-design asymmetry: Bruno should not
base availability, customer promises, or unit economics on an undocumented interpretation of a
consumer credential route.

## Recommended Bruno launch boundary

1. **Target boundary:** support only OpenAI and Anthropic model-account compatibility initially. Do
   not advertise a generic provider catalog or silently route to an unselected provider.
2. **Founder experience:** when Anthropic is released, the founder selects it and completes an
   attended browser authorization on the isolated runner. Normal onboarding never requests a raw
   API key or setup token.
3. **Compatibility validation:** before release, run bounded tests with every advertised plan. For
   Max plus extra credits, verify the model and consumed balance on every call; test refresh,
   expiry, revocation, 401/403 recovery, account suspension, and hard spend caps. Resolve the Pro
   and base-allowance contradiction rather than inferring behavior from either provider's generic
   documentation.
4. **Permission and privacy gate:** obtain Anthropic confirmation covering Hermes' exact
   OAuth/setup-token path, unattended third-party automation, account credential custody, eligible
   plan types, billing precedence, and applicable privacy/retention terms.
5. **Release truthfully:** expose `Connect Claude` only after those gates pass. Show the connected
   account, usage source, remaining credit, expiry/reconnect state, and a one-click disconnect. If
   the connection is unavailable or exhausts its usable capacity, say `Work paused — reconnect or
   fund Claude to continue`; do not silently change who pays or which provider receives the data.
6. **Troubleshooting only:** a founder-owned Anthropic API key may remain an advanced diagnostic
   path with explicit API-billing language, workspace scoping, spend limits, rotation, and
   revocation. It is not an onboarding fallback.

Until those gates pass, describing Claude OAuth as a normal account connection would be misleading.
The founder's Google, GitHub, Stripe, or other selected integrations grant Bruno scoped business
permissions; a Claude consumer credential changes Bruno's core inference capacity, billing,
privacy, and availability. It belongs behind a separate experimental boundary.

## Facts versus recommendations

**Confirmed by current primary sources:** the auth mechanisms, token lifetime and scope, credential
precedence, Hermes' Max/extra-credit rule, current plan and bundle prices, current subscription/API
billing separation, the conflicting third-party usage guidance, and the published consumer versus
commercial data treatment.

**Recommendations/inferences by this review:** limiting initial compatibility to OpenAI and
Anthropic, keeping API-key support troubleshooting-only, treating Hermes subscription support as
experimental, requiring written Anthropic confirmation, and pausing work when no verified provider
connection is usable.
