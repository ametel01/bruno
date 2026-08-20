# Founder-owned ChatGPT subscription through Hermes

**Research date:** 2026-08-17
**Decision scope:** Whether Bruno can offer a founder-owned ChatGPT/Codex subscription as a model route through Hermes, without Bruno owning or silently funding model capacity.

## Recommendation

Offer this as an **optional, founder-owned connection in a controlled pilot**, not as Bruno's only production model route.

- The user has already demonstrated that ChatGPT device-code OAuth works in their own Hermes agent on a VPS. Hermes also documents this route. Technical feasibility is therefore established for the pilot.
- Default the subscription route to **GPT-5.6 Luna**. It has the largest published message allowance and is explicitly positioned for fast, high-volume automation.
- Start individual founders on **Plus ($20/month)**. Recommend Pro only after Bruno can show that measured usage is repeatedly approaching the founder's five-hour or weekly allowance.
- Recommend **Business** when company-data governance, workspace ownership, or admin controls matter more than price. New Business workspaces require at least two standard seats, so the public minimum is **$40/month billed annually or $50 month-to-month**.
- Require at least one eligible, founder-owned **OpenAI or Anthropic connection** before Bruno can run work. Provider selection and payment remain with the founder.
- Do **not** launch with Bruno-managed AI capacity or a Bruno-paid API fallback, and never silently move work to a metered route. If all authorized provider capacity is unavailable, pause the work and offer three recoveries: connect a second provider, wait or reauthenticate, or upgrade the founder's plan.
- Before selling this as a generally available commercial feature, obtain written clarification from OpenAI about third-party persistent use of a personal ChatGPT OAuth credential. OpenAI documents Codex use under ChatGPT plans, but does not name Hermes or explicitly authorize Bruno to broker or resell this capacity.

## Documented Hermes path

Hermes lists **OpenAI Codex** as a built-in provider configured through `hermes model` → **ChatGPT or Codex Subscription**. It uses ChatGPT device-code OAuth and Codex models. The flow opens a URL, asks the founder to enter a code, and stores the resulting credential in `~/.hermes/auth.json`. It can also import existing Codex CLI credentials from `~/.codex/auth.json`; the Codex CLI itself is not required. Reauthentication is available through `hermes auth add openai-codex` or the model wizard. [Hermes provider documentation](https://hermes-agent.nousresearch.com/docs/integrations/providers)

This creates an important Bruno security boundary: the founder authorizes OpenAI, while Bruno operates Hermes. Each founder's OAuth material should be isolated, encrypted at rest, excluded from logs and backups, revocable, and never shared across founders.

Hermes explicitly says two commercial details are **not currently documented**:

1. Which ChatGPT plan tiers are eligible through Hermes.
2. How Hermes requests consume a plan's Codex allowance.

Hermes therefore establishes the auth mechanism, not the subscription economics. The user's working VPS setup is useful operator evidence, but it is not a provider guarantee about future entitlement, quotas, or terms.

## Public plans and prices

OpenAI currently says Codex is included in Free, Go, Plus, Pro, Business, Edu, and Enterprise. The public US-dollar prices below are from OpenAI's current [Codex pricing page](https://developers.openai.com/codex/pricing).

| Plan | Public price | Suitability for Bruno route |
| --- | ---: | --- |
| Free | $0/month | Formally includes Codex, but no comparable public Luna message band is shown; not a dependable 24/7 route. |
| Go | $8/month | Formally includes Codex, but no comparable public Luna message band is shown; treat as evaluation-only. |
| Plus | $20/month | Best initial founder-owned pilot route. |
| Pro 5x | $100/month | Higher allowance; justify only with measured sustained demand. |
| Pro 20x | $200/month | Highest public individual tier; still subject to plan controls. |
| Business standard | $20/user/month annually or $25/user/month monthly; 2-seat minimum | Company workspace, admin controls, and no training on business data by default. Public minimum is $40 or $50 per month. |
| Enterprise / Edu | Contact sales | Relevant where contracted controls, flexible pricing, or enterprise governance are required. |

OpenAI's current [Business plan documentation](https://help.openai.com/en/articles/8792828-what-is-chatgpt-business) says standard Business seats include ChatGPT and Codex. It also says usage-based Codex-only seats are unavailable to new Business workspaces after June 24, 2026; previously eligible workspaces are grandfathered. That restriction does **not** remove Codex from standard Business seats.

## Published limits are ranges, not task guarantees

For local GPT-5.6 Luna messages, OpenAI publishes these rolling five-hour bands:

| Plan | Luna local messages / 5 hours |
| --- | ---: |
| Plus | 250–2,000 |
| Pro 5x | 1,250–10,000 |
| Pro 20x | 5,000–40,000 |
| Business standard | 250–2,000 |
| Enterprise / Edu without flexible pricing | Generally the Plus per-seat limit |
| Enterprise / Edu with flexible pricing | No fixed rate limit; scales with credits |

OpenAI warns that task size, context, reasoning, tools, retrieval, and caching change consumption. Local and cloud activity share a five-hour window, and additional weekly limits may apply. Similar-looking tasks may therefore consume different amounts. [Codex plan limits](https://developers.openai.com/codex/pricing)

These are **not verified Hermes limits**. Hermes says the mapping between its requests and the ChatGPT plan allowance is undocumented. Bruno should read and display the founder's actual Codex usage dashboard rather than promise a message count.

OpenAI's token-based Codex rate card assigns GPT-5.6 Luna **5 credits per 1M input tokens, 0.5 per 1M cached input tokens, and 30 per 1M output tokens**. A 50,000-input plus 3,000-output uncached task would be about **0.34 Codex credits**. This does not reveal how many credits are included in a subscription, and it does not prove Hermes usage is charged by that exact path. [Codex credit rate card](https://developers.openai.com/codex/pricing)

## Illustrative API comparison — research context, not the launch route

The OpenAI API price for GPT-5.6 Luna is **$0.20 per 1M input tokens, $0.02 per 1M cached input tokens, and $1.20 per 1M output tokens**. [GPT-5.6 Luna API model page](https://developers.openai.com/api/docs/models/gpt-5.6-luna)

For an uncached task with 50,000 input and 3,000 output tokens:

```text
input  = 0.050 × $0.20 = $0.0100
output = 0.003 × $1.20 = $0.0036
total                  = $0.0136 per task
```

If the entire subscription price were attributed only to tasks of this shape, the nominal monthly break-even against the API would be:

| Subscription | Fixed monthly cost | API-equivalent tasks at $0.0136 |
| --- | ---: | ---: |
| Plus | $20 | about 1,471 |
| Pro 5x | $100 | about 7,353 |
| Pro 20x | $200 | about 14,706 |
| Business minimum, annual billing | $40 | about 2,941 |
| Business minimum, monthly billing | $50 | about 3,676 |

This is only a price illustration. It is **not** an achievable-throughput forecast: the subscription may reach a five-hour or weekly allowance first, the founder may use the same shared allowance in ChatGPT/Codex elsewhere, and Hermes consumption semantics are undocumented. Conversely, the founder also receives the rest of the ChatGPT plan, so attributing its full price to Bruno overstates Bruno's marginal cost.

The accepted destination explicitly rejects Bruno-managed AI and API spend at launch. The calculation is retained only to explain the relative economics and inform a future decision if the founder deliberately reopens that boundary.

## Ownership, resale, and account boundaries

OpenAI's individual [Terms of Use](https://openai.com/policies/row-terms-of-use/) say an account holder may not share account credentials or make the account available to anyone else, sell or lease the service, automatically or programmatically extract data or output, or circumvent rate limits. OpenAI separately says ChatGPT credits are non-transferable and cannot be resold or gifted. [ChatGPT credit terms summary](https://help.openai.com/en/articles/12642688-using-credits-for-flexible-usage-in-chatgpt-free-go-plus-pro-sora)

Those documents do not directly answer whether a founder may authorize a persistent third-party Hermes process to act only for that same founder. OpenAI's own Codex materials support CLI and other agentic workflows under ChatGPT plans, while the reviewed OpenAI sources do not mention Hermes. This note therefore makes no legal conclusion.

Product constraints pending written clarification:

- The subscription and OpenAI account remain owned and paid for by the founder or their company.
- Bruno must not pool one subscription across customers, share credentials, sell credits, or describe subscription capacity as Bruno-owned inference.
- One OAuth authorization maps to one founder/workspace and one isolated Hermes environment.
- Bruno should disclose that OpenAI, not Bruno, controls eligibility and may change or revoke plan access.
- A commercial launch should obtain OpenAI confirmation that this third-party OAuth usage pattern is permitted for the intended plan and workload.

## Data controls and privacy

| Route | Training default | Retention/control facts established by public docs |
| --- | --- | --- |
| Plus / Pro personal workspace | Data sharing is enabled by default; the founder can turn off “Improve the model for everyone.” | OpenAI says ChatGPT training controls apply to Codex content. The reviewed sources do not specify Hermes-specific retention or whether every Hermes request appears as an ordinary Codex interaction. |
| Business | Inputs and outputs are not used for training by default. | Dedicated workspace and admin controls. Self-serve Business does not include Zero Data Retention, a BAA, or other sales-led options. |
| API | Inputs and outputs are not used for training by default unless the organization opts in. | Abuse-monitoring logs may contain content and are retained up to 30 days by default. Eligible approved customers can obtain Modified Abuse Monitoring or Zero Data Retention; endpoint-specific application-state rules still apply. |

Sources: [Codex plan data controls](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan), [personal and business training defaults](https://help.openai.com/en/articles/8983130-how-does-chatgpt-use-my-data), [OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data), and [Business privacy and plan boundaries](https://help.openai.com/en/articles/8792828-what-is-chatgpt-business).

For connected-company data, Plus is therefore an opt-out consumer route, not an enterprise privacy control. Business improves the training default and governance, but self-serve Business still does not provide ZDR or a BAA. Sensitive or regulated workloads should use a contracted OpenAI offering or an approved API organization with the required controls, subject to the relevant endpoint limitations.

Bruno must also treat Hermes and the connected services as additional processors in the data path. OpenAI's guarantees do not cover data that Bruno sends to OAuth-connected company services, tools, or other third parties.

## Launch routing and recovery decision

Hermes documents direct OpenAI API access with `OPENAI_API_KEY` and provider `openai-api`; `OPENAI_BASE_URL` is optional. [Hermes provider documentation](https://hermes-agent.nousresearch.com/docs/integrations/providers)

OpenAI states that ChatGPT and API billing are separate. A paid ChatGPT or Business subscription does not include API usage. [OpenAI billing separation](https://help.openai.com/en/articles/9039756-billing-settings-in-chatgpt-vs-platform)

That technical API path is **not** the Bruno launch fallback. The accepted launch policy is:

1. Onboarding cannot finish until the founder connects at least one eligible OpenAI or Anthropic account they own or are authorized to use.
2. Bruno routes work only through providers the founder explicitly connected and selected.
3. Detect OAuth expiry, provider outages, reauthentication requirements, and plan-limit errors; checkpoint the task and explain the interruption in plain language.
4. When every authorized provider is unavailable, pause. Do not retry indefinitely, charge a Bruno account, or switch to an undisclosed provider.
5. Offer the founder three recovery actions: **connect a second provider**, **wait or reauthenticate**, or **upgrade the existing provider plan**.
6. Resume from the checkpoint only after authorized capacity returns, and record which founder-owned provider handled the task.

Anthropic eligibility, pricing, quota, and privacy are outside this OpenAI-focused note and require their own primary-source assessment before that connection is offered.

## Explicit uncertainties to resolve in the pilot

- Which Free, Go, Plus, Pro, and Business entitlements Hermes actually receives for each model.
- Whether one Hermes tool loop is counted as one message, multiple messages, or token-based credits.
- Whether Hermes exposes reliable remaining-quota and reset metadata, or whether Bruno must rely on the OpenAI usage dashboard and errors.
- The precise data-retention treatment of Hermes-issued ChatGPT OAuth requests.
- Whether OpenAI permits Bruno's intended persistent commercial orchestration of a founder-owned personal subscription.
- Whether consumer-plan capacity has any uptime, availability, or support commitment suitable for a 24/7 operator; none was found in the reviewed public plan material.
- Regional price, tax, currency, and entitlement differences for the founder's actual account.

Until these are resolved, the subscription route should be labeled **“Uses your ChatGPT plan; availability and limits are controlled by OpenAI.”** If no authorized provider has capacity, Bruno pauses and offers connect-second-provider, wait/reauthenticate, or upgrade recovery; it does not use Bruno-managed AI or API spend.
