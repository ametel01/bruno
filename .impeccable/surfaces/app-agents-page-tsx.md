---
version: 1
slug: "app-agents-page-tsx"
primary_target: "app/agents/page.tsx"
related_targets: ["app/agents/_components/create-agent-form.tsx","app/_components/product-shell.tsx","app/globals.css"]
---

## Scope and mode

- Target: `app/agents/page.tsx`, the authenticated agent roster and creation surface.
- Mode: Operate.
- Build path: code-led.
- Surface concept: Agent Roster in the Calm Operations Brandboard's dense Operate mode shared with the landing page, `/dashboard`, and `/settings`.

## Visitor and job

- A solo SaaS founder building and directing the operating team behind Bruno.Ai while retaining access to the shipped control-plane capabilities.
- Let the founder scan persisted roster state and capacity, operate existing agents, add an agent through guided setup, and reach technical provisioning only when an exception or audit requires it.
- Keep the founder-facing reading order fixed: Agent Roster title and promise, Roster Pulse, Operating Roster, Add an Agent, then the bounded System Appendix.

## Proof and constraints

- Roster Pulse reports only persisted implementation truth: active agent records, the implemented role/profile count, assignable capacity, cloud readiness, and automatic recovery when replacement capacity is being prepared. Unknown values remain explicit em dashes rather than inferred outcomes.
- Preserve the complete existing workflow: authentication gating, roster load failures, desktop table and mobile agent records, lifecycle controls, deployment status, configuration and identity links, empty-state creation route, assistant selection, one-time model credential connection, Telegram bot token and user allowlist, safe retry/start-over behavior, cloud provisioning detail, and the System health route.
- Keep technical provisioning subordinate to the founder's roster and setup outcomes. The primary topbar intentionally omits System health on `/agents`; the route appears only as the operator link that closes the System Appendix.
- Every unavailable creation state must name the observed cause and recovery: invalid or disabled ready-creation configuration, failed assistant-connection loading, or no connected assistant. The notice must also warn against entering secrets and disclose that draft values are not saved.
- Do not imply that the future Business Graph, business operating loops, Action Inbox, or Bruno.Ai Impact outcomes are already present on this surface. This redesign changes visual and information hierarchy, not workflow availability.

## Direction and memorable moment

- Chosen direction: Agent Roster within Calm Operations Brandboard, using seed `b32744ed`.
- Use the exact Bruno.Ai lockup, ivory and warm-white fields, Satoshi titles, Inter operational copy, espresso rules, rounded precision panels, and restrained mint/lime signals established by `design/a.png` and the landing page.
- Roster Pulse is a warm-white four-measure operating panel. Operating Roster is the primary persisted-data enclosure; Add an Agent becomes the page's single charcoal contrast section with a lime guided-setup label and a warm-white form body.
- A subdued stone System Appendix closes the page. Cloud provisioning expands in place, and the single System health operator route remains outside the topbar.

## Responsive behavior

- At narrow tablet widths, the Calm Operations rail becomes a compact brand-and-route header, the four pulse measures become a two-column panel, and the wide roster table yields to the existing mobile agent records.
- The assistant choices and Telegram credential fields collapse to one column before phone width. At phone width, the pulse becomes one continuous vertical ledger; section headings, empty-state action, creation body, mobile metadata, and appendix route stack without removing status, recovery, lifecycle, or setup information.
- Preserve rounded precision, visible mint focus treatment, explicit labels, and non-color state language across every breakpoint.

## Review evidence

- Authoritative migration captures are `.impeccable/review/authenticated-migration/dashboard-desktop-final.png`, `dashboard-mobile-final.png`, `agents-desktop-final.png`, `agents-mobile-final.png`, `settings-desktop-final.png`, and `settings-mobile-final.png`.
- The first complete authenticated review returned `revise`: the visual direction matched, while the evidence fixture, phone roster pulse, opaque-material rule, product-truth boundary, and canonical migration record required correction. The corrected evidence must receive a fresh full review before shipment is recorded.
- The Impeccable detector was run exactly once after the complete build. It reported legacy and overridden `app/globals.css` rules across the whole historical stylesheet; rendered evidence and source review, not a false clean claim, determine which findings remain material.

## Unresolved decisions

- Replace roster and capacity proxies with business outcomes only when those outcomes have real persisted implementation evidence.
- If future operator details are added, keep them inside the one finite System Appendix unless a founder-critical exception genuinely belongs earlier in the reading order.
