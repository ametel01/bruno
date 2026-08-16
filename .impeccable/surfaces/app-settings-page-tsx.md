---
version: 1
slug: "app-settings-page-tsx"
primary_target: "app/settings/page.tsx"
related_targets: ["app/settings/_components/runner-management-controls.tsx","app/_components/product-shell.tsx","app/globals.css","app/layout.tsx"]
---

## Scope and mode

- Target: `app/settings/page.tsx`, the authenticated workspace settings surface.
- Mode: Operate.
- Build path: code-led.
- Surface concept: Workspace Settings in the Calm Operations Brandboard's dense Operate mode shared with the landing page, `/dashboard`, and `/agents`.

## Visitor and job

- A solo SaaS founder checking the operational capacity behind Bruno.Ai and managing the access needed to keep it running.
- Let the founder scan live runner state, provision capacity, register a runner, rotate or revoke credentials, and distinguish shipped controls from planned company settings.
- Keep the reading order stable: Workspace Settings, Runner Fleet, Runner Management, then one bounded System Appendix.

## Proof and constraints

- Show only persisted implementation truth. Runner counts, readiness, failures, capacity, versions, timestamps, cost context, and provisioning phases remain explicit.
- Preserve authentication gating, load failures, cloud-runner creation, one-time registration tokens, registered-runner detail, credential rotation and revocation confirmation, empty states, and every safe error or success message.
- Keep infrastructure visible because it is the shipped settings capability, but subordinate future product controls in a clearly labeled planned appendix. Do not imply that application, billing, integration, secret, or policy controls are implemented.
- Essential monitoring and credential actions remain usable on mobile, and risk or readiness never depends on color alone.

## Direction and memorable moment

- Chosen direction: Workspace Settings within Calm Operations Brandboard, using seed `b32744ed`.
- Use the exact Bruno.Ai lockup, ivory and warm-white fields, Satoshi titles, Inter operational copy, espresso rules, rounded precision panels, and restrained mint/lime signals established by `design/a.png` and the landing page.
- Runner Fleet is a warm-white four-measure persisted-state panel. Runner Management is a rounded two-column work surface: cloud provisioning and registered access sit side by side on wide screens, then become one continuous vertical flow on smaller screens.
- A subdued stone System Appendix closes the page with planned settings disclosed in place and a single System health route.

## Unresolved decisions

- Replace runner-first settings with business policies and connectors only when those capabilities have persisted implementation evidence.
- Revisit planned labels as application, billing, integration, and secret-management surfaces ship.
