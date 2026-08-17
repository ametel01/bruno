# OpenAI Founder AI Connection release contract

**Research date:** 2026-08-17

**Wayfinder ticket:** [Validate the OpenAI Founder AI Connection release contract](https://github.com/ametel01/bruno/issues/312)

**Scope:** OpenAI through Hermes only. Anthropic needs its own release contract.

## Decision

**Do not show OpenAI as an available Compatible AI Provider in ordinary onboarding yet.** Keep it behind an operator-only trial gate until the commercial-permission and unattended-authentication blockers below are closed.

The founder has demonstrated that ChatGPT device-code OAuth works in a Hermes agent on a VPS, and Hermes documents that route. This establishes technical feasibility, not permission or production readiness. Hermes still says that eligible ChatGPT tiers and the way Hermes requests consume plan quota are undocumented. [Hermes AI provider documentation](https://hermes-agent.nousresearch.com/docs/integrations/providers)

There are two possible release paths:

1. **Preferred business path:** ChatGPT Business or Enterprise using OpenAI's documented Codex access token for trusted non-interactive local automation. This path has an explicit unattended-use contract and workspace governance, but Hermes does not currently document accepting this credential type. OpenAI can become available on this path only after Hermes supports it or Bruno uses another supported Codex client boundary and that exact integration passes the release evidence below. [OpenAI Codex access-token documentation](https://learn.chatgpt.com/docs/enterprise/access-tokens)
2. **Conditional personal path:** ChatGPT Plus or Pro through Hermes device-code OAuth. This path can become available only after OpenAI gives written confirmation that a founder may authorize Bruno's persistent third-party Hermes runtime under the applicable terms, and the exact tier's quota and data behavior pass the release evidence below.

Free and Go formally include Codex, but should not be launch-eligible: OpenAI positions them for quick or lightweight tasks and does not publish the same production-use message bands shown for Plus, Pro, and Business. Enterprise and Edu require a separately validated workspace contract and admin configuration. [OpenAI Codex pricing](https://developers.openai.com/codex/pricing)

Bruno supplies no model capacity. If every Founder AI Connection is unavailable, affected work checkpoints and pauses; recovery is connect a second provider, wait or reauthenticate, or upgrade the founder's provider plan. There is no Bruno-funded or silent API fallback.

## What the providers document

### Hermes authorization and reconnect behavior

Hermes lists OpenAI Codex as a built-in provider configured through `hermes model` → **ChatGPT or Codex Subscription**. It uses a device-code flow, stores the resulting credentials under `~/.hermes/auth.json`, and can import Codex CLI credentials from `~/.codex/auth.json`. No Codex CLI installation is required. [Hermes AI provider documentation](https://hermes-agent.nousresearch.com/docs/integrations/providers)

When refresh fails terminally—such as an HTTP 4xx, `invalid_grant`, or revoked grant—Hermes marks the refresh token dead, stops replaying it, and returns a typed reauthentication message on the next request. A fresh device-code login through `hermes auth add openai-codex` or the model wizard clears the quarantine after a successful exchange. [Hermes AI provider documentation](https://hermes-agent.nousresearch.com/docs/integrations/providers)

Hermes warns that some tools can use a separate auxiliary model. Its `auto` default routes those calls to the selected main provider, but explicit overrides can route elsewhere. Release evidence must therefore cover the main loop, summarization, vision, mixture-of-agents, and any other enabled auxiliary path—not just one chat request. [Hermes AI provider documentation](https://hermes-agent.nousresearch.com/docs/integrations/providers)

### OpenAI's documented unattended credential

OpenAI documents Codex access tokens for trusted, non-interactive local workflows, including scripts, scheduled jobs, CI runners, Codex CLI, and app-server automation. They are currently supported for ChatGPT Business and Enterprise workspaces. Tokens represent the creating workspace identity and are reflected in workspace governance data. [OpenAI Codex access tokens](https://learn.chatgpt.com/docs/enterprise/access-tokens)

OpenAI instructs customers to use trusted runners, store these tokens in a secret manager, keep them out of logs, avoid sharing one identity across unrelated teams, prefer finite expiration, rotate regularly, and revoke stale tokens. Workspace owners can govern token creation and expiration; revoked or expired tokens cannot start new runs. [OpenAI Codex access tokens](https://learn.chatgpt.com/docs/enterprise/access-tokens)

This is stronger production evidence than a consumer browser session, but it is not yet a Hermes path: Hermes's provider documentation describes ChatGPT device OAuth and its own auth store, not `CODEX_ACCESS_TOKEN` ingestion. That compatibility must be documented or proven against a supported integration before release.

## Account eligibility contract

OpenAI may be shown to a specific founder only when all of the following are true:

- The founder and the runner operate from a country on OpenAI's current supported-country list. OpenAI warns that offering access outside supported countries can lead to account blocking or suspension. [ChatGPT supported countries](https://help.openai.com/en/articles/7947663-chatgpt-supported-countries)
- The founder owns the account or is authorized by the company workspace to connect it; no credential or workspace identity is reused across owners.
- The account has a launch-approved plan:
  - **Business or Enterprise:** preferred when a documented Codex access-token path is supported end to end.
  - **Plus or Pro:** conditional on written permission for Bruno's Hermes device-OAuth use and tier-specific release evidence.
  - **Free and Go:** excluded from initial unattended operation.
  - **Edu:** excluded until separately contracted and validated.
- Billing is current, Codex is enabled, and the selected workspace role permits local Codex use. Workspace administrators can independently control Codex local use and access-token creation. [Using Codex with a ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan), [OpenAI Codex access tokens](https://learn.chatgpt.com/docs/enterprise/access-tokens)
- A live entitlement canary through the exact Bruno → Hermes → OpenAI path succeeds with the production model and an ordinary tool call. Plan name alone is not proof of entitlement.
- The founder acknowledges that their ChatGPT plan, credits, and provider limits fund the work; ChatGPT and OpenAI API billing are separate. [OpenAI billing separation](https://help.openai.com/en/articles/9039756-billing-settings-in-chatgpt-vs-platform)

## Public plan and quota facts

OpenAI currently says Codex is included in Free, Go, Plus, Pro, Business, Edu, and Enterprise. Public US prices are $0 for Free, $8/month for Go, $20/month for Plus, $100/month for Pro 5x, and $200/month for Pro 20x. Business standard seats are $20/user/month billed annually or $25/user/month billed monthly, with a two-seat minimum; Enterprise and Edu are contact-sales plans. [OpenAI Codex pricing](https://developers.openai.com/codex/pricing)

New Business workspaces receive standard seats that include ChatGPT and Codex. Usage-based Codex-only seats stopped being available to new Business workspaces after June 24, 2026; previously eligible workspaces are grandfathered. [What is ChatGPT Business?](https://help.openai.com/en/articles/8792828-what-is-chatgpt-business)

For local GPT-5.6 Luna messages, OpenAI publishes these rolling five-hour bands:

| Plan | Luna local messages / five hours |
| --- | ---: |
| Plus | 250–2,000 |
| Pro 5x | 1,250–10,000 |
| Pro 20x | 5,000–40,000 |
| Business standard | 250–2,000 |
| Enterprise / Edu without flexible pricing | Generally the Plus per-seat limits |
| Enterprise / Edu with flexible pricing | No fixed rate limit; usage scales with credits |

These are ranges, not task guarantees. OpenAI says model choice, task size, context, reasoning, retrieval, tools, and caching all affect consumption; local and cloud usage share a five-hour window and additional weekly limits may apply. Codex, ChatGPT Work, ChatGPT for Excel, and Workspace Agents can also share an agentic pool. The usage dashboard and `/status` are OpenAI's documented places to inspect current capacity. [OpenAI Codex pricing](https://developers.openai.com/codex/pricing), [Using Codex with a ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)

Hermes explicitly does **not** document which plan tiers work or how a Hermes tool loop maps to these limits. Bruno must not promise any message count until the production path exposes a reliable usage signal and passes an exhaustion test. [Hermes AI provider documentation](https://hermes-agent.nousresearch.com/docs/integrations/providers)

### API cost comparison only

The accepted product boundary rejects a Bruno-managed API fallback. The following arithmetic is retained only as economic context.

GPT-5.6 Luna API pricing is $0.20 per million input tokens, $0.02 per million cached input tokens, and $1.20 per million output tokens. [GPT-5.6 Luna API model](https://developers.openai.com/api/docs/models/gpt-5.6-luna)

An uncached 50,000-input plus 3,000-output task costs:

```text
0.050 × $0.20 + 0.003 × $1.20 = $0.0136
```

At that shape, nominal API-equivalent monthly task counts are about 1,471 for Plus, 7,353 for Pro 5x, 14,706 for Pro 20x, 2,941 for the $40 Business annual-billing minimum, and 3,676 for the $50 Business month-to-month minimum. These are not throughput forecasts: subscription use can hit a five-hour or weekly limit first, other OpenAI agentic features share capacity, and Hermes consumption is undocumented.

## Data-use contract

| Connection | OpenAI training default | Bruno release requirement |
| --- | --- | --- |
| Plus / Pro personal workspace | Conversations may be used to improve models unless the founder disables training. ChatGPT training controls apply to Codex content. | Plain disclosure before authorization; require the founder to choose whether company data may use this route. If they opt out, record only the decision, not a screenshot containing account data. |
| Business / Enterprise | OpenAI does not train on business inputs or outputs by default. | Verify the work occurs in the intended company workspace and the member has the required role and local-use permission. |
| Self-serve Business | No training by default, but self-serve Business does not include Zero Data Retention, a BAA, or other sales-led controls. | Do not present it as ZDR, HIPAA-ready, or equivalent to a contracted enterprise offering. |

Sources: [Using Codex with a ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan), [OpenAI training controls](https://help.openai.com/en/articles/8983130-how-does-chatgpt-use-my-data), and [ChatGPT Business privacy boundaries](https://help.openai.com/en/articles/8792828-what-is-chatgpt-business).

OpenAI's API has a different data contract: API inputs and outputs are not used for training by default, abuse-monitoring logs may retain customer content for up to 30 days, and approved customers can request Modified Abuse Monitoring or Zero Data Retention subject to endpoint limitations. That contract does not automatically apply to a ChatGPT OAuth connection. [OpenAI API data controls](https://developers.openai.com/api/docs/guides/your-data)

Before release, Bruno's consent screen must also explain that selected Company Connection data may pass through Hermes and OpenAI. OpenAI's controls do not govern copies sent to connected company services or retained by Bruno.

## Commercial-permission contract

OpenAI's individual Terms of Use prohibit sharing account credentials or making an account available to another person, selling or leasing the service, automatically extracting output, and circumventing rate limits. OpenAI's Codex documentation simultaneously supports scriptable Codex workflows under eligible plans and provides a dedicated Business/Enterprise token for trusted automation. The reviewed OpenAI sources do not mention Hermes or answer whether a founder can authorize Bruno's persistent third-party runtime using personal device OAuth. [OpenAI Terms of Use](https://openai.com/policies/row-terms-of-use/), [OpenAI Codex pricing and feature matrix](https://developers.openai.com/codex/pricing), [OpenAI Codex access tokens](https://learn.chatgpt.com/docs/enterprise/access-tokens)

Therefore:

- No Plus/Pro general release without written OpenAI confirmation for the intended Hermes/Bruno use.
- No pooling, credential reuse, credit transfer, or resale across founders. OpenAI says ChatGPT credits are non-transferable and cannot be resold or gifted. [OpenAI ChatGPT credit terms summary](https://help.openai.com/en/articles/12642688-using-credits-for-flexible-usage-in-chatgpt-free-go-plus-pro-sora)
- The account and plan remain founder- or founder-company-owned and paid.
- Bruno describes itself as operating the founder's authorized connection, never as reselling OpenAI capacity.
- Business/Enterprise uses the workspace's governing agreement and a workflow-specific identity; it does not inherit permission from a personal-account pilot.

This is a product release gate, not a legal conclusion.

## Credential-custody contract

The authorization design passes only when evidence shows:

1. The founder completes OpenAI authorization directly; Bruno never asks for a password or raw API key in ordinary onboarding.
2. A credential belongs to one Owner and one isolated runner. It is never copied to another founder, pooled, or placed in the control-plane database.
3. Device-OAuth credentials in `~/.hermes/auth.json`, or an approved replacement credential, live on an encrypted runner volume with least-privilege file permissions. Secret values are absent from application logs, support bundles, telemetry, crash reports, shell history, snapshots, and ordinary backups.
4. Business/Enterprise automation tokens use a secret manager, a workflow-specific identity, finite expiration, and a documented rotation owner, consistent with OpenAI's access-token guidance. [OpenAI Codex access tokens](https://learn.chatgpt.com/docs/enterprise/access-tokens)
5. Disconnect revokes the provider credential where supported, removes local credential material and routing configuration, and prevents new work. Deleting a connection remains distinct from deleting already-retained business records.
6. Support cannot reveal or export the credential. Any exceptional support access is time-limited, least-privileged, approved, and audited.

## Quota, pause, and reconnect contract

Bruno may mark OpenAI **Connected** only after a live canary succeeds. It transitions to **Attention needed** for an expired or revoked credential and to **Capacity paused** for an exhausted limit or provider outage.

- A terminal refresh error checkpoints affected work, stops replay, and presents **Reconnect OpenAI**. A successful fresh authorization resumes from the checkpoint; failure leaves work paused.
- Capacity exhaustion does not trigger unbounded retries or Bruno-funded capacity. The founder is offered: connect Anthropic, wait for the displayed or provider-reported reset, or upgrade/add credits in OpenAI.
- If both authorized providers exist, Provider Routing may use the second provider only because the founder explicitly connected it. The receipt records which provider handled the resumed work.
- A revoked or disconnected OpenAI connection cannot receive new tasks, including auxiliary model calls.
- Bruno must distinguish invalid credentials, insufficient workspace permission, quota exhaustion, provider outage, and unsupported plan. A generic “agent failed” state does not pass.

## Required release evidence

OpenAI remains hidden until one immutable evidence bundle for the exact production Hermes version and auth path contains all of the following:

| Gate | Evidence required |
| --- | --- |
| Provider authority | Current primary-source links plus written OpenAI confirmation for a personal Hermes path, or documented Business/Enterprise Codex access-token compatibility. |
| Account matrix | Successful and rejected canaries for every advertised plan class, workspace role, and supported region cohort; no inference from the plan name alone. |
| Authorization | Founder-observed device or workspace authorization showing OpenAI as the grant recipient and the exact Bruno explanation; no password or raw API-key collection. |
| Custody | Automated proof of owner isolation, encrypted storage, restrictive permissions, log/snapshot/back-up redaction, and credential removal on disconnect. |
| Runtime | Main model plus every enabled auxiliary path uses only that founder's authorized provider; no hidden Bruno credential or provider. |
| Refresh and revocation | Valid refresh, terminal refresh failure, revoked grant, expired token, rotation, reconnect, and disconnect tests with bounded retry counts. |
| Quota | Near-limit and exhausted-limit tests prove the correct classification, checkpoint, pause, reset/upgrade guidance, and absence of a Bruno-funded fallback. |
| Data posture | Plan-specific consent copy and recorded training-choice/workspace posture; sensitive-data restrictions match the actual contract. |
| Operations | Provider outage, timeout, restart, and runner replacement tests preserve the checkpoint without leaking or duplicating credentials or actions. |
| Audit | Sanitized receipt records owner, provider, route, model family, authorization state, and recovery outcome without secret material or raw company payloads. |

The bundle records the Hermes commit/release, Bruno release, runner image identity, provider path, plan cohort, test timestamp, source-document review date, and evidence hashes. Any change to Hermes auth, credential storage, provider transport, or OpenAI's governing docs invalidates the relevant gate and returns OpenAI to operator-only status until revalidated.

## Founder-facing states

- **Unavailable:** OpenAI has not passed the global release contract; do not display it as a connectable provider.
- **Available:** Global gates pass and the founder's country/workspace is eligible; show “Connect OpenAI,” not models or infrastructure.
- **Checking:** Authorization succeeded and Bruno is verifying entitlement, workspace permission, and an end-to-end canary.
- **Connected:** The canary passed. Show the plan owner, data-use summary, and capacity status without exposing tokens or model configuration.
- **Attention needed:** Reauthentication, workspace permission, billing, or plan eligibility must be fixed.
- **Capacity paused:** Work is checkpointed because the provider has no usable capacity; offer connect-second-provider, wait, or upgrade.
- **Disconnected:** No new OpenAI work or auxiliary calls can start; retained company records follow their separate retention policy.

## Unresolved external facts

These are blockers, not assumptions:

- Written OpenAI permission for Bruno-operated Hermes device OAuth under Plus/Pro.
- A documented or validated Hermes path for Business/Enterprise Codex access tokens.
- Exact Hermes-to-Codex quota accounting and a machine-readable remaining-capacity/reset signal.
- ChatGPT retention behavior specifically for Hermes-issued device-OAuth requests.
- Any consumer-plan availability or support commitment suitable for a 24/7 operator; none appears in the reviewed public plan material.

Until these are closed and the evidence bundle passes, OpenAI can remain an internal trial connection but is not a released Compatible AI Provider.
