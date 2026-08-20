# Should DeepSeek be Bruno.Ai's managed default model?

> **Superseded architecture alternative:** DeepSeek is not an initial Compatible AI Provider, and
> the current Founder Operator does not use Bruno-managed or Bruno-funded AI capacity. Initial
> General Release requires independently released OpenAI and Anthropic through Founder AI
> Connections. This dated research is retained only for a future provider-expansion decision.

**Research date:** 2026-08-17

**Decision question:** Should Bruno.Ai replace its founder-supplied OpenAI/Anthropic choice with a
Bruno-managed DeepSeek default for its nontechnical-founder operator?

**Method:** Primary-source review of DeepSeek's current API documentation, product policies, status
materials, and the official pricing/privacy materials of Bruno's current model providers. No live
DeepSeek workload benchmark was run, so provider performance claims are not treated as Bruno
product evidence.

## Recommendation

**Do not make DeepSeek's direct API Bruno's unconditional production default yet.** Keep the model
invisible and Bruno-managed, but make model selection a server-side routing concern with a tested
fallback provider. Treat the GA `deepseek-v4-pro` as a production-evaluation candidate and the
public-beta `deepseek-v4-flash` as a provisional low-cost route for low-consequence, read-oriented
work. Do not send connected-company content (email, revenue, customer, analytics, or source-control
data) to DeepSeek by default until the retention, training, data-transfer, and processor terms are
contractually acceptable for Bruno's launch jurisdictions.

If those gates pass, the preferred initial shape is:

- `deepseek-v4-flash`, non-thinking mode, for bounded extraction, classification, summarization,
  and draft preparation where deterministic validation can reject a bad result and public-beta
  model risk is acceptable;
- `deepseek-v4-pro`, or another proven provider, only after task-specific evaluation for complex
  synthesis and multi-step planning;
- no model-generated external action without Bruno's independent authority-policy check, schema
  validation, idempotency boundary, and outcome verification;
- automatic retry and provider failover behind Bruno's own adapter; the founder should never
  choose or troubleshoot a model provider.

The reason is not model nationality or a general claim about quality. It is that Bruno's first
operating loops process sensitive company evidence and may prepare or execute consequential
actions, while DeepSeek's currently published direct-API data and continuity guarantees do not yet
match that risk. V4 Pro's GA status improves model maturity, but it does not resolve those
commercial and operational boundaries.

## Confirmed facts

### Current Bruno baseline

Bruno currently hard-codes two founder-visible choices: GPT-5.4 through OpenAI and Claude Sonnet
4.6 through Anthropic. That is implementation evidence, not the desired product boundary; the
approved product direction already says founders should not administer models or runtimes. See
[`assistant-profiles.ts`](../../src/server/agents/assistant-profiles.ts) and
[`PRODUCT.md`](../../PRODUCT.md).

### Models and API surface

DeepSeek first exposed V4 Preview on 2026-04-24, then released V4 Flash to public beta on
2026-07-31 and V4 Pro to general availability on 2026-08-13. The current aliases resolve to
`DeepSeek-V4-Flash-0731` and `DeepSeek-V4-Pro-0813`. Both advertise a 1 million-token context, up
to 384,000 output tokens, thinking and non-thinking modes, JSON output, tool calls, the Responses
API, and OpenAI- and Anthropic-compatible interfaces. Thinking mode is the default. DeepSeek
describes Flash as the economical model and Pro as the higher-capability model. Its changelog
reports materially stronger agent benchmarks for both post-trained releases, but those remain
provider results; Bruno has not independently verified their quality on its operating loops.
([change log](https://api-docs.deepseek.com/updates/),
[models and pricing](https://api-docs.deepseek.com/quick_start/pricing/))

The API supports the OpenAI Chat Completions shape and an Anthropic-compatible shape, but
compatibility is not identity. In the Anthropic-compatible API, unsupported names are automatically
mapped to V4 Flash, Claude Opus-like names map to V4 Pro, Claude Haiku/Sonnet-like names map to V4
Flash, and `anthropic-version` and `anthropic-beta` are ignored. Bruno therefore needs a
DeepSeek-specific adapter and must assert the returned model rather than assuming that changing a
base URL preserves provider semantics. ([Anthropic API compatibility](https://api-docs.deepseek.com/guides/anthropic_api))

### Tool calling and structured-output constraints

The standard API accepts as many as 128 function definitions and supports `none`, `auto`,
`required`, and a forced named function. However, DeepSeek's API reference explicitly warns that
ordinary function-call arguments may be invalid JSON or contain hallucinated parameters; callers
must validate them before executing a function. Only function tools are supported.
([chat-completion API reference](https://api-docs.deepseek.com/api/create-chat-completion))

Schema-constrained **strict** tool calling exists only on the `/beta` base URL. It supports a
limited JSON Schema subset; every object property must be required and
`additionalProperties: false`, while constraints such as `minLength`, `maxLength`, `minItems`, and
`maxItems` are unsupported. DeepSeek labels the feature Beta, and its terms do not guarantee the
stability of testing-stage features. ([tool-call guide](https://api-docs.deepseek.com/guides/tool_calls),
[Open Platform Terms, sections 7.4-7.6](https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html))

JSON Output guarantees valid JSON syntax, not conformance to Bruno's application schema. It
requires `response_format: {"type":"json_object"}`, an explicit prompt instruction to produce
JSON, and a suitable output limit. DeepSeek warns that the feature may occasionally return empty
content. ([JSON Output guide](https://api-docs.deepseek.com/guides/json_mode/))

In thinking mode, every tool-calling assistant turn's `reasoning_content` must be passed back in
subsequent requests; omitting it produces HTTP 400. The usual sampling controls are ignored in
thinking mode. The current documented effort choices are `low`, `high`, and `max` (with `medium`
and `xhigh` mapped to `high`), so Bruno can trade reasoning cost and latency against task risk. This
is a real state-machine difference that Bruno must test through multi-tool and retry flows.
([thinking-mode guide](https://api-docs.deepseek.com/guides/thinking_mode))

**Implication:** DeepSeek has enough primitives for an agent, but its current safest tool-output
contract is Beta. Regardless of provider, Bruno must keep authorization outside the model. For
DeepSeek in particular, no generated arguments should cross an external-action boundary without
strict application validation.

### Context and caching

DeepSeek's disk context cache is enabled by default. Cache hits require a fully matching persisted
prefix; construction is asynchronous and hits are best-effort. Responses report hit and miss token
counts. Unused entries are normally cleared after hours to days. DeepSeek says cache contents are
isolated per user, and the API's `user_id` can be used for cache, scheduling, and safety-review
isolation; it must not contain personal information. ([context caching](https://api-docs.deepseek.com/guides/kv_cache),
[rate-limit and isolation guide](https://api-docs.deepseek.com/quick_start/rate_limit))

That cache is useful for Bruno's long stable system context, but it is not a durable Business Graph
and its lifetime is nondeterministic. Bruno should persist business state itself, send only the
minimum evidence needed for a task, and never treat a cache hit as a correctness or privacy
boundary.

### Price comparison

The following are public list prices per million text tokens on 2026-08-17. DeepSeek charges peak
rates from 01:00-04:00 and 06:00-10:00 UTC and half-price off-peak rates at all other times. The
figures exclude retries, tool-loop amplification, latency, support, compliance work, and the cost of
a fallback provider.

| Model | Cached input/read | Uncached input | Output |
| --- | ---: | ---: | ---: |
| DeepSeek V4 Flash, off-peak | $0.007 | $0.22 | $0.66 |
| DeepSeek V4 Flash, peak | $0.014 | $0.44 | $1.32 |
| DeepSeek V4 Pro, off-peak | $0.022 | $0.66 | $1.98 |
| DeepSeek V4 Pro, peak | $0.044 | $1.32 | $3.96 |
| OpenAI GPT-5.6 Luna, standard short-context price | $0.02 | $0.20 | $1.20 |
| Anthropic Claude Sonnet 4.6 | $0.30 | $3.00 | $15.00 |

Sources: [DeepSeek models and pricing](https://api-docs.deepseek.com/quick_start/pricing/),
[OpenAI API pricing](https://developers.openai.com/api/docs/pricing), and
[Anthropic pricing](https://claude.com/pricing).

Both DeepSeek models are cheaper than Claude Sonnet 4.6 at list price. DeepSeek is **not uniformly
cheaper than OpenAI's lowest-priced flagship tier shown above**: Flash has higher uncached input at
both times and higher peak output, while it has cheaper cached input and cheaper off-peak output;
Pro is more expensive than Luna on all three token categories. Scheduled background loops can use
off-peak pricing, but founder-triggered or urgent work cannot be delayed solely to obtain it. Cost
per successful, policy-safe operating loop is therefore the metric Bruno needs. Retry rates, extra
reasoning tokens, malformed tool calls, and escalation to a stronger model can erase some of the
headline token advantage. DeepSeek also reserves the right to change prices.

### Availability and operational guarantees

DeepSeek publishes per-account concurrency limits of 2,500 for V4 Flash and 500 for V4 Pro. Above
the limit the API returns 429. Requests may remain connected while waiting; if inference has not
started after ten minutes, the server closes the connection. Its error guide recommends retrying
500/503 failures and explicitly suggests temporarily switching to an alternative provider for
429s. ([rate-limit and isolation guide](https://api-docs.deepseek.com/quick_start/rate_limit),
[error codes](https://api-docs.deepseek.com/quick_start/error_codes/))

DeepSeek has a public [service-status page](https://status.deepseek.com/), but the reviewed
materials do not publish a production SLA. The Open Platform Terms say the service is provided
"as is" and "as available," do not warrant uninterrupted, timely, secure, or error-free use, and
allow services to be modified, suspended, or terminated. They also make no warranty of continued
availability in a jurisdiction. ([Open Platform Terms, sections 1.3-1.4 and 7.4](https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html))

**Implication:** DeepSeek should not be Bruno's only route. A founder-facing 24/7 operator needs
bounded timeouts, circuit breaking, a funded fallback, and business-impact status independent of
the model provider.

### Data use, privacy, and regional posture

DeepSeek's general privacy policy says it collects Inputs, may use personal data and Inputs to
develop and improve services and train or improve models, offers a right to opt out of model
training, and retains account and Input data while an account exists. It says the service is not
designed or intended to process sensitive personal data. It directly collects, processes, and
stores personal data in the People's Republic of China, including for people in the EEA, UK, and
Switzerland. ([DeepSeek Privacy Policy, updated 2026-02-10](https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html))

The Open Platform Terms place the downstream application's end-user disclosures, legal basis,
rights handling, and security controls on the developer. They say the general DeepSeek privacy
policy does **not** cover the processing rules for personal information collected from end users of
the developer's application. The reviewed API-specific terms do not state a default no-training
commitment, a fixed deletion period for API inputs/outputs, or zero-data-retention eligibility.
They are governed by mainland Chinese law and disputes go to the court at DeepSeek's registered
office. They also assign export-control and sanctions compliance to the developer.
([Open Platform Terms, sections 3.2-3.4, 5.5, 10](https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html))

DeepSeek's Open Platform Terms also require the developer to tell end users that AI output may
contain errors and state that output should not form the basis for actions or omissions. Bruno's
planned product does take or prepare business actions, so counsel or an equivalent commercial
review must decide whether that term is compatible with the intended service and its independent
verification controls. ([Open Platform Terms, section 8.1](https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html))

By comparison, OpenAI says API inputs and outputs are not used for training by default, abuse logs
are generally retained for up to 30 days, and qualifying customers can request zero data retention.
Anthropic says commercial API inputs and outputs are not used for training by default, are normally
deleted within 30 days, and qualifying customers can agree zero data retention. These are clearer
published business-data commitments for the kind of connected-company content Bruno intends to
process. ([OpenAI business data](https://openai.com/business-data/),
[OpenAI API data controls](https://platform.openai.com/docs/models/default-usage-policies-by-endpoint),
[Anthropic commercial training policy](https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training),
[Anthropic API retention](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data))

No public DeepSeek DPA, SOC 2 report, ISO 27001 certification, customer-managed retention control,
or API zero-retention program was found in the primary materials reviewed. That is a statement
about this search, not proof that private enterprise terms or certifications do not exist; Bruno
should ask DeepSeek directly before relying on their absence.

### Model and contract stability

V4 Pro is GA; V4 Flash remains public beta. The pricing page identifies their current underlying
versions as `DeepSeek-V4-Pro-0813` and `DeepSeek-V4-Flash-0731`, but the callable `/models` aliases
remain `deepseek-v4-pro` and `deepseek-v4-flash`. The former moving aliases `deepseek-chat` and
`deepseek-reasoner` changed underlying models repeatedly and were retired on 2026-07-24. The
reviewed documentation does not offer callable, date-pinned immutable V4 snapshot IDs. DeepSeek may
change service technology and performance with notice, and amended Open Platform Terms take effect
seven days after publication. ([change log](https://api-docs.deepseek.com/updates/),
[`/models` reference](https://api-docs.deepseek.com/api/list-models/),
[Open Platform Terms, sections 1.3 and 11.1](https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html))

**Implication:** Bruno must record the requested and returned model, system fingerprint, prompt and
policy revision, token/cache accounting, and verified outcome. Every provider/model change needs a
canary and the ability to roll back or route elsewhere; a family name alone is not reproducible
evidence.

## Gates before any DeepSeek default

DeepSeek should graduate from candidate to managed default only when all of these are true:

1. **Commercial-data terms:** Bruno has a documented processor/data-transfer position, acceptable
   retention and training controls, deletion assistance, breach/support contacts, and a clear list
   of launch jurisdictions and prohibited data classes.
2. **Task evaluation:** V4 Flash 0731 and V4 Pro 0813 pass Bruno-owned golden traces for Morning
   Brief, customer-risk detection, lead follow-up, product intelligence, and launch reporting—not
   merely coding benchmarks or the provider's own claims.
3. **Agent safety:** multi-step tool selection, malformed argument rejection, prompt-injection
   resistance, approval boundaries, idempotency, and outcome verification meet explicit thresholds.
4. **Reliability:** measured latency, error, retry, and successful-loop rates meet Bruno's product
   objective under a realistic concurrency mix, with exact evidence for the tested model revision.
5. **Failover:** another provider can continue the operating loop without exposing provider
   selection to the founder, losing policy state, duplicating an external action, or silently
   weakening a permission rule.
6. **Economics:** cost is compared per verified operating-loop outcome, including cache behavior,
   retries, reasoning tokens, fallback calls, and support/compliance overhead.

Until then, "Bruno handles the model" should resolve the founder-experience decision without
prematurely resolving the provider decision: Bruno owns credentials, billing, routing, evaluation,
upgrades, and recovery; DeepSeek is an internal candidate, not a founder setting or a promise.
