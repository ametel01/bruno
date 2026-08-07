# AI Integration Opportunities

## Purpose

This document captures focused AI/agent-infrastructure integrations that could strengthen plingpling without changing its core product into a generic model wrapper. The product remains a supervised control plane for persistent Hermes agents; integrations should expose that control plane safely, preserve owner boundaries, and produce durable audit evidence.

The opportunities below follow three current market directions:

- Model Context Protocol (MCP) is becoming conventional backend infrastructure for agent tools.
- WebMCP can make authenticated web applications directly addressable by browser agents.
- Production agent platforms increasingly compete on durable execution, approvals, isolation, telemetry, and evidence rather than basic model calls.

These are proposals, not committed roadmap items.

## Recommendation order

1. Build a read-mostly MCP server for plingpling operations.
2. Add one tightly scoped WebMCP operation to the authenticated dashboard.
3. Expose normalized lifecycle and audit events for AI SDK and observability consumers.

The first two are the clearest direct integrations. The third is an enabling boundary that avoids coupling plingpling to one agent framework.

## 1. plingpling MCP server

### Opportunity

Expose a small, owner-scoped set of control-plane capabilities through MCP so compatible assistants and developer tools can inspect and supervise hosted agents without screen scraping or direct database access.

A first release should be read-mostly:

- `list_agents`
- `get_agent_status`
- `get_agent_health`
- `get_recent_events`
- `get_recent_logs`
- `list_pending_approvals`
- `get_runner_health`
- `get_cost_estimate`

Later write tools could include:

- `start_agent`
- `stop_agent`
- `restart_agent`
- `approve_agent_action`
- `deny_agent_action`

### Product value

- Lets operators ask an assistant why an agent is unhealthy and receive structured control-plane evidence.
- Makes plingpling useful inside MCP-capable IDEs and assistants without replacing the dashboard.
- Demonstrates the existing runner, lifecycle, approval, cost, and audit systems as reusable agent infrastructure.

### Safety requirements

- Authenticate every MCP request and resolve the owner server-side; never accept an arbitrary owner ID from the client.
- Keep tools least-privileged and return redacted, bounded results.
- Never expose provider keys, Telegram bot tokens, runner bearer tokens, raw environment variables, or decrypted setup material.
- Separate read tools from mutating tools. Mutations must use the same lifecycle validation and owner-scoped service layer as the dashboard APIs.
- Require explicit confirmation or an existing plingpling approval for destructive or externally consequential operations.
- Add idempotency keys for retries and long-running operations.
- Record every tool invocation, result class, actor, target, and resulting state transition in the durable event timeline without storing secrets.
- Apply rate limits, pagination, timeouts, and response-size limits.

### Thin implementation slice

1. Add a versioned MCP transport endpoint backed by existing application services, not by direct table queries in the transport layer.
2. Implement `list_agents`, `get_agent_status`, `get_recent_events`, and `list_pending_approvals`.
3. Add owner-isolation, redaction, schema, pagination, and authorization tests.
4. Publish a local example configuration for one MCP client using placeholder credentials only.
5. Add structured telemetry for request duration, result status, and tool name.
6. Run a manual smoke test against two users and prove that neither can discover the other's resources.

### Acceptance criteria

- An authenticated client can discover and invoke the four read-only tools.
- Every response is owner-scoped, bounded, structured, and secret-redacted.
- Unauthenticated and cross-owner requests fail closed.
- Invocations create durable audit events with no credential material.
- Existing dashboard and runner contracts remain unchanged.

## 2. WebMCP for the dashboard

### Opportunity

Expose one narrow dashboard operation to browser agents through WebMCP. Start with a low-risk, read-only operation such as summarizing the current agent's operational state. Do not begin with general browser control or arbitrary lifecycle mutations.

Candidate first tool:

- `inspect_agent_operation`: returns status, health, latest bounded events, pending-approval count, and a redacted failure summary for the agent currently open in the authenticated dashboard.

A later supervised mutation could be:

- `request_agent_restart`: creates a pending approval or explicit confirmation step rather than restarting immediately.

### Product value

- Makes the existing web surface agent-addressable while keeping the user inside plingpling's authenticated and audited interface.
- Reuses the product's strongest differentiators: approvals, event history, redaction, lifecycle validation, and human supervision.
- Provides a concrete browser-agent integration without exposing a broad remote-control API.

### Safety requirements

- Register tools only within authenticated product pages and bind them to the active owner and current resource.
- Treat page state as untrusted input; re-authorize and reload authoritative state on the server.
- Use typed arguments and constrained enumerations. Reject arbitrary URLs, shell commands, prompts, or resource IDs outside the current owner scope.
- Require a visible confirmation or approval workflow before any state-changing action.
- Preserve CSRF protections, origin checks, rate limits, and existing authorization boundaries.
- Make browser-agent actions visually distinguishable in the event timeline.

### Thin implementation slice

1. Add `inspect_agent_operation` to the agent detail page.
2. Route the tool through an owner-scoped server action or API that shares existing redaction logic.
3. Return only a bounded operational summary; do not return full logs by default.
4. Add browser tests for unauthenticated access, owner isolation, malformed input, and successful inspection.
5. Validate behavior in a supported WebMCP preview client before expanding scope.

### Acceptance criteria

- The tool is discoverable only on an authenticated agent detail page.
- The result matches authoritative server state and contains no secrets.
- Cross-owner and forged-resource requests fail closed.
- The invocation is recorded as a distinct audited action.
- No state-changing capability ships in the first slice.

## 3. Framework-neutral workflow and observability boundary

### Opportunity

Define normalized lifecycle, approval, tool-use, and audit event schemas that can feed AI SDKs, workflow engines, or observability systems. Vercel AI SDK is a relevant TypeScript consumer, but the boundary should remain framework-neutral so plingpling does not depend on one model or orchestration vendor.

Possible outputs:

- Structured lifecycle events for deploy, start, stop, restart, recovery, and failure.
- Approval-request and approval-decision events.
- Redacted tool invocation summaries.
- Correlation IDs spanning control plane, runner, and Hermes workload.
- Signed or hash-linked operation receipts as a future AgentReceipt integration.
- OpenTelemetry-compatible traces and metrics where they add operational value.

### Product value

- Makes troubleshooting and evaluation possible across control-plane and workload boundaries.
- Supports future integrations with AI SDK workflow tooling, LangSmith, or other observability products without embedding vendor-specific concepts into core domain models.
- Strengthens plingpling's positioning around controlled production agent systems.

### Thin implementation slice

1. Document a versioned event envelope with actor, owner, agent, runner, correlation, action, outcome, timestamp, and redacted metadata fields.
2. Map existing durable events into the envelope without rewriting stored history.
3. Export a local JSONL stream or protected webhook to a test sink.
4. Verify retries, ordering expectations, redaction, and duplicate handling.
5. Only then build a vendor adapter, starting with the integration most useful to beta users.

## Shared design principles

- **Control-plane first:** integrations call existing domain services and state machines; they do not create a second lifecycle implementation.
- **Read before write:** ship inspection and diagnosis before remote mutation.
- **Human-governed mutations:** sensitive actions require confirmation or approval and leave a durable receipt.
- **Owner isolation:** authorization is enforced at every boundary and tested with multiple users.
- **Secret minimization:** integration payloads contain references and redacted metadata, never raw credentials.
- **Framework neutrality:** keep core contracts independent of model, SDK, and observability vendors.
- **Operational limits:** use bounded payloads, timeouts, pagination, rate limits, idempotency, and clear error classes.
- **Evidence over claims:** each integration needs contract tests and a real supported-client smoke test before it is described as implemented.

## Explicit non-goals

- Replacing Hermes's own tools or local dashboard.
- Giving external agents unrestricted shell, browser, filesystem, database, or runner access.
- Building a generic multi-model chat UI.
- Adding autonomous state-changing tools without approval and audit controls.
- Claiming MCP, WebMCP, AI SDK, or observability support before an end-to-end integration is verified.
- Expanding the private-beta critical path before current provider, Telegram, billing/payment, and multi-user acceptance gates are complete.

## Suggested decision gate

Prioritize the MCP read-only slice only after it can be implemented without delaying current private-beta acceptance. Proceed to WebMCP after the MCP work establishes reusable owner-scoped schemas, redaction, auditing, and authorization tests. Treat vendor-specific observability adapters as demand-driven follow-on work rather than core MVP scope.

## References

- [MCP July 2026 release](https://blog.modelcontextprotocol.io/posts/2026-07-28/)
- [Cloudflare WebMCP announcement](https://blog.cloudflare.com/webmcp/)
- [Vercel AI SDK 7 announcement](https://vercel.com/blog/ai-sdk-7)
- [Sourcegraph Code Finder for agents](https://sourcegraph.com/blog/code-finder-fast-code-search-for-agents)
- [Cursor research on coding-benchmark reward hacking](https://cursor.com/blog/reward-hacking-coding-benchmarks)
