---
version: 1
slug: "app-dashboard-page-tsx"
primary_target: "app/dashboard/page.tsx"
related_targets: ["app/globals.css","app/dashboard/_components/cost-summary.tsx","app/dashboard/_components/cost-summary.module.css"]
---

## Scope and mode

- Target: `app/dashboard/page.tsx`, the authenticated Bruno operating dashboard.
- Mode: Operate.
- Build path: code-led.
- Surface concept: Founder Dispatch, an ordinary whole-surface extension of the existing Company Daybook rather than a replacement visual world.

## Visitor and job

- A solo SaaS founder checking what changed, what needs judgment, what Bruno is doing, and whether the underlying system is healthy.
- Let the founder scan live company-operating state, resolve approvals, direct active agents, and audit persisted activity without learning agent-runtime vocabulary first.
- Keep the reading order stable: Company pulse, Needs you, Agents at work beside Recent record, then one bounded System appendix.

## Proof and constraints

- Show only persisted implementation truth. Company pulse currently summarizes agents, approvals, runner capacity or recovery, and recent events; it must not imply that the future Business Graph, operating loops, or Bruno Impact reporting are already shipped.
- Preserve the complete existing operating surface: authentication gate, agent lifecycle controls, approval decisions, activity history, process logs, manual and cloud runner state, cost estimates, system notes, and links to detail and health routes.
- Preserve every loading failure, authorization failure, action failure, unavailable estimate, empty state, and recovery state. Primary status and risk must remain understandable without color alone.
- Keep infrastructure visible but subordinate. Logs, runners, cost, readiness, and implementation notes belong inside the single System appendix rather than competing with founder decisions and active work.
- Essential monitoring and approval actions remain usable on mobile. Use the compact mobile agent list in place of the wide table, stack the workbench and appendix, and remove scroll caps when the layout collapses.

## Direction and memorable moment

- Chosen direction: Founder Dispatch.
- Seed: `c9dd9100`.
- Extend the Company Daybook with warm grid-ruled paper, square ledger rules, ledger ink, electric editorial blue, citron emphasis, and red-pencil warnings. League Gothic argues; Avenir Next carries facts and controls.
- The first operating read is a saturated-blue Company pulse followed immediately by a citron-headed Needs you ledger. This makes live state and founder judgment visually unavoidable before the page reveals active work.
- Agents at work and Recent record form the working spread: the wider column supports lifecycle action and the narrower column preserves an auditable event trail. Use ruled rows, sticky ledger headings, and tabular alignment instead of independent dashboard cards.
- The System appendix closes the document with a dark header and one contiguous ruled enclosure for logs, runner health, cloud provisioning, cost, and collapsible notes. It is intentionally finite and visually secondary.

## Unresolved decisions

- Replace infrastructure-proxy pulse metrics with company outcomes only when the Business Graph and outcome reporting have real persisted data.
- Revisit the appendix labels when production runner, billing, and secret-storage capabilities ship; until then, keep availability and estimate caveats explicit.
