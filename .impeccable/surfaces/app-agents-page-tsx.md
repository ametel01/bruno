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
- Surface concept: Agent Roster, a Founder Dispatch extension of the established Company Daybook world shared with `/dashboard`; it does not replace or fork the global visual system.

## Visitor and job

- A solo SaaS founder building and directing the operating team behind Bruno while retaining access to the shipped control-plane capabilities.
- Let the founder scan persisted roster state and capacity, operate existing agents, add an agent through guided setup, and reach technical provisioning only when an exception or audit requires it.
- Keep the founder-facing reading order fixed: Agent Roster title and promise, Roster Pulse, Operating Roster, Add an Agent, then the bounded System Appendix.

## Proof and constraints

- Roster Pulse reports only persisted implementation truth: active agent records, the implemented role/profile count, assignable capacity, cloud readiness, and automatic recovery when replacement capacity is being prepared. Unknown values remain explicit em dashes rather than inferred outcomes.
- Preserve the complete existing workflow: authentication gating, roster load failures, desktop table and mobile agent records, lifecycle controls, deployment status, configuration and identity links, empty-state creation route, assistant selection, one-time model credential connection, Telegram bot token and user allowlist, safe retry/start-over behavior, cloud provisioning detail, and the System health route.
- Keep technical provisioning subordinate to the founder's roster and setup outcomes. The primary topbar intentionally omits System health on `/agents`; the route appears only as the operator link that closes the System Appendix.
- Every unavailable creation state must name the observed cause and recovery: invalid or disabled ready-creation configuration, failed assistant-connection loading, or no connected assistant. The notice must also warn against entering secrets and disclose that draft values are not saved.
- Do not imply that the future Business Graph, business operating loops, Action Inbox, or Bruno Impact outcomes are already present on this surface. This redesign changes visual and information hierarchy, not workflow availability.

## Direction and memorable moment

- Chosen direction: Agent Roster within Founder Dispatch.
- Extend the Company Daybook with warm grid paper, ledger ink, electric Bruno blue, citron emphasis, red-pencil exception states, League Gothic display type, square geometry, hard rules, and flat structural borders.
- The saturated-blue Roster Pulse is the first operational block. Its four ruled measures turn infrastructure-backed data into a concise founder read without hiding what the values actually represent.
- Operating Roster is a finite ruled enclosure, followed by a citron-headed Add an Agent section. The contrast makes guided creation the main action while keeping form labels, credentials, recovery states, and disabled controls plain and auditable.
- A dark System Appendix closes the page. Cloud provisioning expands in place, and the single System health operator route sits in the closing ruled row rather than competing in the topbar.

## Responsive behavior

- At narrow tablet widths, the Company Daybook sidebar becomes a compact brand-and-route header, the four pulse measures become a two-column ledger, and the wide roster table yields to the existing mobile agent records.
- The assistant choices and Telegram credential fields collapse to one column before phone width. At phone width, the pulse becomes one continuous vertical ledger; section headings, empty-state action, creation body, mobile metadata, and appendix route stack without removing status, recovery, lifecycle, or setup information.
- Preserve square rules, visible focus treatment, explicit labels, and non-color state language across every breakpoint.

## Review evidence

- Final captures: `.impeccable/review/desktop.png` and `.impeccable/review/mobile.png` show the implemented empty-roster and unavailable-setup state at both shipped layout classes.
- The final review resolved all three requested fixes and returned the disposition `ship`.
- The Impeccable detector returned no findings after the first complete build.

## Unresolved decisions

- Replace roster and capacity proxies with business outcomes only when those outcomes have real persisted implementation evidence.
- If future operator details are added, keep them inside the one finite System Appendix unless a founder-critical exception genuinely belongs earlier in the reading order.
