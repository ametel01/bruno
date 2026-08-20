# OpenAI API cost and limits for Bruno.Ai's managed agent route

> **Superseded architecture alternative:** The current Founder Operator does not use Bruno-managed
> or Bruno-funded AI capacity. It uses Founder AI Connections for independently released OpenAI and
> Anthropic under the canonical domain model and release-stage contract. This dated research remains
> useful for provider economics and a future deliberately reopened managed-capacity decision; its
> recommendation is not launch guidance.

**Research date:** 2026-08-17

**Decision question:** What current OpenAI API models, prices, limits, service tiers, and data
controls are suitable for Bruno.Ai's 24/7 company operator, and how should Bruno route work between
them?

**Method:** Review of the current Bruno implementation and first-party OpenAI model, pricing,
production, data-control, reliability, and commercial documentation. Prices are public list prices;
no live Bruno/OpenAI account, workload benchmark, or negotiated order form was available.

## Recommendation

Offer OpenAI as a **Bruno-managed provider**, not as a founder-selected “ChatGPT” setup requiring a
personal key. Start with this internal route, subject to Bruno-owned task evaluations:

- **Base route: `gpt-5.6-luna`** for bounded classification, extraction, summarization, drafting,
  connection receipts, and ordinary conversational turns. Its public standard price is $0.20 input,
  $0.02 cached input, and $1.20 output per million tokens. It has the full 1.05M context, 128K output,
  function calling, structured outputs, and Responses API tools. Treat it as a cost route, not an
  authority boundary: application code still validates every tool argument and enforces permissions.
- **Premium route: `gpt-5.6-terra`** for multi-source synthesis, ambiguous founder requests,
  planning, and tool loops that fail a Luna quality or confidence gate. It costs 10 times Luna at
  public standard token rates ($2 / $0.20 / $12) but OpenAI positions it as the family member that
  balances intelligence and cost.
- **Exceptional escalation: `gpt-5.6-sol`** for the hardest, high-consequence reasoning after a
  measured quality benefit. It costs $5 / $0.50 / $30. Do not make Sol the always-on default. For an
  urgent founder-facing escalation, Fast mode is available at twice standard token rates; its public
  99.9% uptime and token-velocity SLAs apply only to Enterprise customers.
- Keep **GPT-5.4 as a temporary compatibility route**, pinned to its dated snapshot where possible,
  while replaying Bruno's golden operating loops against the new family. The current hard-coded
  `gpt-5.4` alias costs $2.50 / $0.25 / $15, so it is 12.5 times Luna's input price and 12.5 times its
  output price without being OpenAI's current recommended production family.

Use Standard processing for interactive work, Batch for scheduled offline aggregation that can wait
up to 24 hours, and Flex only for retryable low-priority work. Build a provider-neutral fallback;
public pay-as-you-go Standard processing has no guaranteed latency, and a 24/7 product must not make
one provider or one service tier its availability boundary.

Sources: [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna),
[GPT-5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra),
[GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol),
[GPT-5.4](https://developers.openai.com/api/docs/models/gpt-5.4),
[current model guidance](https://developers.openai.com/api/docs/guides/latest-model), and
[Fast mode](https://openai.com/api-fast-mode/).

## Current Bruno baseline

Bruno currently exposes “ChatGPT” as a founder-visible assistant choice, asks for an OpenAI API key,
and hard-codes `gpt-5.4` with a declared 1,050,000-token context. See
[`assistant-profiles.ts`](../../src/server/agents/assistant-profiles.ts). This is compatible with the
current public GPT-5.4 context limit, but not with the agreed product boundary in which Bruno owns
model selection, credentials, routing, reliability, and billing.

The model name is an alias, even though OpenAI also publishes the dated
`gpt-5.4-2026-03-05` snapshot. A managed production route should record the requested model, returned
model, reasoning settings, service tier, token/cache accounting, prompt and policy revisions, and
verified outcome. Snapshot changes should pass Bruno's canary and golden traces before broad
rollout. The current GPT-5.6 model pages do not list distinct dated snapshots, so Bruno cannot assume
that the family aliases provide the same reproducibility boundary as the dated GPT-5.4 snapshot.

Source: [GPT-5.4 model and snapshot](https://developers.openai.com/api/docs/models/gpt-5.4).

## Model and API comparison

Public Standard prices are USD per 1M text tokens as of the research date.

| Model | Intended role | Input | Cached input | Output | Context | Max output |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| GPT-5.6 Luna | Cost-sensitive, high-volume; roughly the earlier nano tier | $0.20 | $0.02 | $1.20 | 1.05M | 128K |
| GPT-5.6 Terra | Intelligence/cost balance; roughly the earlier mini tier | $2.00 | $0.20 | $12.00 | 1.05M | 128K |
| GPT-5.6 Sol | Frontier complex professional work | $5.00 | $0.50 | $30.00 | 1.05M | 128K |
| GPT-5.4 | Bruno's present frontier baseline | $2.50 | $0.25 | $15.00 | 1.05M | 128K |
| GPT-5.4 mini | Older high-volume mini alternative | $0.75 | $0.075 | $4.50 | 400K | 128K |
| GPT-5.4 nano | Older simple high-volume route | $0.20 | $0.02 | $1.25 | 400K | 128K |

All six support streaming, function calling, structured outputs, Chat Completions, Responses, and
Batch. The three GPT-5.6 models and GPT-5.4/mini expose the current Responses tool set including web
search, file search, code interpreter, hosted shell, computer use, MCP, and tool search. GPT-5.4 nano
does not support computer use or tool search. Tool availability is not a reason to let the model
authorize actions: Bruno's own authority policy, schema validation, idempotency boundary, and
outcome verification remain mandatory.

The GPT-5.6 family supports reasoning efforts from `none` through `max`, with `medium` the default.
Reasoning level must be part of the route and evaluation; comparing only model list price ignores
reasoning-token and retry amplification. Prompts above 272K input tokens are long-context requests:
the entire request is charged at 2x input and 1.5x output rates. Bruno should retrieve and compact
company evidence rather than treating the 1.05M window as a default payload size.

Sources: [OpenAI API pricing](https://developers.openai.com/api/docs/pricing),
[GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna),
[GPT-5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra),
[GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol),
[GPT-5.4](https://developers.openai.com/api/docs/models/gpt-5.4),
[GPT-5.4 mini](https://developers.openai.com/api/docs/models/gpt-5.4-mini), and
[GPT-5.4 nano](https://developers.openai.com/api/docs/models/gpt-5.4-nano).

## Illustrative cost per task

These calculations use Standard short-context list prices and count only the shown text tokens.
They exclude reasoning tokens, retries, failed validations, provider failover, tool-call fees,
regional-processing uplift, and cache-write charges. They are planning examples, not measured Bruno
costs.

| Task shape | Luna | Terra | Sol | Current GPT-5.4 |
| --- | ---: | ---: | ---: | ---: |
| Bounded extraction: 10K uncached input + 500 output | $0.0026 | $0.0260 | $0.0650 | $0.0325 |
| Morning brief: 50K uncached input + 3K output | $0.0136 | $0.1360 | $0.3400 | $0.1700 |
| Morning brief with 40K cached + 10K uncached input + 3K output | $0.0064 | $0.0640 | $0.1600 | $0.0800 |
| Tool-heavy synthesis: 100K uncached input + 10K output | $0.0320 | $0.3200 | $0.8000 | $0.4000 |

At these public rates, 1,000 uncached example Morning Briefs cost about $13.60 on Luna, $136 on
Terra, $340 on Sol, or $170 on GPT-5.4 before operational overhead. The correct metric is cost per
verified, policy-safe operating-loop outcome: if Luna causes enough retries or Terra/Sol escalation,
its headline token saving narrows.

## Caching, Batch, Flex, and Fast opportunities

### Prompt caching

Prompt caching is available automatically for eligible prompts of at least 1,024 tokens. Cache hits
require an exact reusable prefix, so Bruno should put stable instructions, tool definitions,
schemas, and shared policy first and variable company evidence later. For GPT-5.6, use stable
`prompt_cache_key` partitioning and explicit breakpoints where it improves measured reuse.

GPT-5.6 cache reads cost 0.1x ordinary input, while cache writes cost 1.25x ordinary input. The only
documented TTL setting is 30 minutes, refreshed on reuse. A cache is therefore an optimization, not
Bruno's business memory or evidence store. Track `cached_tokens` and `cache_write_tokens`; repeated
writes without later reads can increase rather than reduce cost. Cached tokens still count toward
TPM limits.

Source: [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).

### Batch

The Batch API charges 50% less than synchronous Standard processing, uses a separate pool with
substantially more rate-limit headroom, and completes within 24 hours. It fits scheduled
classification, enrichment, backfills, evaluations, and non-urgent brief preparation. It does not
fit a live founder conversation, approval decision, or time-sensitive recovery loop.

Source: [Batch API](https://developers.openai.com/api/docs/guides/batch).

### Flex

Flex charges Batch rates for synchronous Responses or Chat Completions requests in exchange for
slower responses and occasional resource unavailability. It is beta with limited model support.
Use it only for idempotent, retryable, lower-priority jobs with a long timeout; do not make it the
interactive Bruno Conversation route or a dependency of a promised deadline.

Source: [Flex processing](https://developers.openai.com/api/docs/guides/flex-processing).

### Fast and Reserved tiers

Fast mode is pay-as-you-go premium processing for user-facing latency. For GPT-5.6 it currently
costs twice Standard rates. It shares the same rate limits with Standard, and rapid traffic ramps
can be downgraded to Standard speed and billing. OpenAI publishes a 99.9% uptime SLA for Enterprise
Fast mode plus token-velocity SLAs of 99% above 100 tokens/sec for Luna, 70 for Terra, and 80 for
Sol. This is not a general SLA for every pay-as-you-go account.

Reserved Tier is an Enterprise purchase of capacity denominated in dollars per minute for a
specific model. It is incremental to ordinary rate limits, covers Standard and Fast traffic, and is
not available for Batch or Flex. OpenAI says Reserved traffic is rejected after other traffic
during peak-load scarcity. Its commercial price and order-form terms require sales/account access.

Sources: [Fast mode guide](https://developers.openai.com/api/docs/guides/fast-mode),
[Fast mode commercial terms](https://openai.com/api-fast-mode/), and
[Reserved Tier](https://openai.com/api-reserved-tier/).

### Tool costs

Hosted tools add separate costs. Current public prices include $10 per 1,000 web-search calls plus
search-content tokens at the selected model rate, $2.50 per 1,000 file-search calls plus $0.10/GB/day
storage after the free allowance, and hosted shell/code-interpreter containers starting at $0.03
per 20-minute 1GB session. Bruno should meter provider tokens and tool fees under the same business
operation rather than presenting token cost as total cost.

Source: [OpenAI API pricing](https://developers.openai.com/api/docs/pricing).

## Rate limits and account-specific limits

Rate limits can apply on RPM, TPM, daily requests/tokens, Batch queue size, or another modality, and
the first exhausted dimension wins. They are organization/project scoped and model-specific. OpenAI
automatically graduates accounts through usage tiers as paid spend rises.

Public model defaults include:

| Model route | Tier 1 | Tier 5 |
| --- | --- | --- |
| GPT-5.6 Luna | 500 RPM, 500K TPM, 5M Batch queued tokens | 30K RPM, 180M TPM, 15B Batch queued tokens |
| GPT-5.6 Terra or Sol | 500 RPM, 500K TPM, 1.5M Batch queued tokens | 15K RPM, 40M TPM, 15B Batch queued tokens |
| GPT-5.4 | 500 RPM, 500K TPM, 1.5M Batch queued tokens | 15K RPM, 40M TPM, 15B Batch queued tokens |

Tier qualification and OpenAI-assigned monthly usage ceilings are also public at a high level: Tier
1 begins after $5 paid with a $100/month usage limit; Tier 5 begins after $1,000 paid with a
$200,000/month usage limit. These are not proof of Bruno's current entitlement. The live account's
Limits page is authoritative for the organization and can differ by model, project, approved usage,
or commercial agreement.

Bruno should consume the response rate-limit headers, including remaining/reset request and token
capacity and `Retry-After`, use bounded jittered backoff, and set response-token limits close to the
expected output because the documented calculation can use the greater of requested output tokens
and estimated input tokens. Retries must preserve tool-call and external-action idempotency.

Sources: [Rate limits](https://developers.openai.com/api/docs/guides/rate-limits),
[GPT-5.6 Luna limits](https://developers.openai.com/api/docs/models/gpt-5.6-luna),
[GPT-5.6 Terra limits](https://developers.openai.com/api/docs/models/gpt-5.6-terra), and
[GPT-5.6 Sol limits](https://developers.openai.com/api/docs/models/gpt-5.6-sol).

## Spend controls Bruno needs

OpenAI supports organization- and project-level spend alerts and enforceable monthly hard limits.
At a hard limit, affected requests return a specific 429 error; enforcement is not instantaneous,
so spend can slightly overshoot. A provider hard limit is a final circuit breaker, not a graceful
product budget because it can stop every founder's production work at once.

Bruno should add its own controls in front of the provider:

1. per-company daily and monthly token/tool budgets with alert thresholds;
2. per-operation maximum input, output, reasoning, tool turns, retries, and escalation count;
3. route budgets that prevent silent Luna-to-Sol amplification;
4. concurrency queues and reserved capacity for founder conversation, approvals, and recovery;
5. a degraded mode that continues cached/read-only business capabilities when model spend or rate
   capacity is exhausted;
6. operation-level cost attribution, including cache reads/writes, tools, retries, and failed work;
7. organization and production-project OpenAI alerts below a hard limit, with the hard limit kept
   high enough for deliberate graceful degradation and a separately funded fallback.

Source: [Spend limits](https://developers.openai.com/api/docs/guides/spend-limits).

## Connected-company data boundary

OpenAI's published API posture is materially clearer than the reviewed DeepSeek direct-API posture
for Bruno's connected-company data:

- API inputs and outputs are not used for model training by default unless the customer opts in.
- Default abuse-monitoring logs may retain customer content for up to 30 days.
- Chat Completions and Responses are eligible for approved Zero Data Retention, which forces
  `store=false`; eligibility requires prior OpenAI approval and additional requirements.
- Responses application state is stored for at least 30 days by default. Background mode writes
  response data to disk for roughly ten minutes to support polling.
- `/v1/conversations` and ChatKit threads retain state until deleted and are not ZDR-eligible, so
  Bruno should keep the durable conversation/business record in its own reviewed store if ZDR or
  strict deletion semantics are required.
- Prompt caches may store encrypted key/value state on GPU-local storage for up to 24 hours. Remote
  MCP servers and other network destinations are third parties with their own data-retention terms;
  hosted container files are temporary but still application state during container life.
- Non-US data residency requires approval for abuse-monitoring controls and a retention amendment;
  supported regional processing adds a 10% price uplift for eligible models released on or after
  2026-03-05. Endpoint and model coverage varies by region.

Bruno may send only the minimum connected-company evidence needed for an authorized task, must not
put secrets in prompts, and must keep OAuth scope, business-action authority, retrieval filtering,
and deletion semantics outside the model. Before launch, execute the appropriate Services
Agreement/DPA, decide launch jurisdictions and prohibited data classes, obtain ZDR or Modified
Abuse Monitoring if the product claim requires it, and review every hosted tool or third-party MCP
data path. OpenAI publishes SOC 2 Type 2 and ISO 27001/27017/27018/27701 coverage for its API, but
those certifications do not remove Bruno's controller/processor, consent, minimization, or security
obligations.

Sources: [API data controls](https://developers.openai.com/api/docs/guides/your-data),
[OpenAI business data](https://openai.com/business-data/),
[OpenAI security and privacy](https://openai.com/security-and-privacy/), and
[OpenAI Data Processing Addendum](https://openai.com/policies/data-processing-addendum/).

## Reliability boundary

OpenAI publishes an aggregate status page, but it warns that individual availability varies by
tier, model, and feature. Official troubleshooting guidance says Standard processing has no
guaranteed latency; defined latency SLAs apply to paid premium tiers such as Fast or older Scale
Tier. Fast's public 99.9% uptime and token-velocity SLA is Enterprise-only. Reserved Tier protects
provisioned capacity but still inherits the selected service tier's SLA.

Therefore, Bruno should measure its own successful operating-loop SLO, not treat the provider's
aggregate status or HTTP success as product evidence. Use timeouts, circuit breaking, queue-age
limits, provider/model failover, replay-safe operation IDs, and founder-visible business-impact
status. Escalating from Luna to Terra/Sol may improve task quality; it does not constitute a
provider-availability fallback.

Sources: [OpenAI Status](https://status.openai.com/),
[API errors and latency](https://help.openai.com/en/articles/1000499),
[Fast mode](https://openai.com/api-fast-mode/), and
[Reserved Tier](https://openai.com/api-reserved-tier/).

## What requires Bruno's live OpenAI account or a sales conversation

Public documentation cannot confirm these deployment facts:

1. Bruno's current usage tier, exact RPM/TPM/daily limits, Batch queue allowance, model access, and
   project-specific limits shown on the live **Limits** page;
2. the approved monthly usage ceiling, credit balance, payment history, production-project spend
   alerts, and hard-limit configuration;
3. whether the organization is eligible and approved for ZDR, Modified Abuse Monitoring, regional
   processing, and the exact endpoint/model coverage for the chosen region;
4. Fast, Reserved Tier, support, uptime/latency SLA, service-credit, or negotiated discount terms in
   Bruno's actual order form;
5. actual cache-hit/write ratio, reasoning tokens, tool fees, retries, latency, error rate, and cost
   per verified Bruno operating loop;
6. whether Luna meets Bruno's quality, prompt-injection, structured-output, multi-tool, and recovery
   thresholds, and when Terra or Sol materially improves the outcome.

These should become measured acceptance gates before an OpenAI route is called production-ready.

## Decision gates

1. Replay Bruno-owned golden traces for Morning Brief, Bruno Conversation, customer/revenue risk,
   product and release intelligence, permissions explanation, tool argument generation, and
   reconnect/recovery across Luna, Terra, Sol, and the current GPT-5.4 baseline.
2. Set minimum task-success, evidence completeness, schema validity, prompt-injection resistance,
   latency, retry, and cost-per-success thresholds before defining routing rules.
3. Inspect the live Limits, Usage, Billing, and Data Controls pages; record exact entitlements and
   set production project spend/rate controls.
4. Make the Responses requests stateless from OpenAI's perspective where product retention requires
   it, and complete the DPA/ZDR/regional-processing review for launch jurisdictions.
5. Fund and prove a provider-neutral failover that preserves policy and idempotency without silently
   weakening the connected-company data boundary.
