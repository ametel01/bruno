---
name: Bruno.Ai
description: An always-on, self-improving operator for a one-person company.
colors:
  deep-charcoal: "#101314"
  warm-espresso: "#6b4d3c"
  signal-mint: "#59d6c5"
  signal-mint-deep: "#2d887d"
  signal-mint-soft: "#dff6f1"
  action-lime: "#b8f34b"
  action-lime-soft: "#e9fbc4"
  stone: "#d8ccbd"
  stone-soft: "#eee7de"
  ivory: "#f7f4ee"
  warm-white: "#fffdfa"
  muted-ink: "#6f6d68"
  espresso-rule: "rgb(107 77 60 / 18%)"
  charcoal-rule: "rgb(16 19 20 / 20%)"
typography:
  display:
    fontFamily: "Satoshi, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(4rem, 6.5vw, 6rem)"
    fontWeight: 650
    lineHeight: 0.94
    letterSpacing: "-0.04em"
  headline:
    fontFamily: "Satoshi, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "clamp(3.2rem, 5.6vw, 5.6rem)"
    fontWeight: 650
    lineHeight: 0.98
    letterSpacing: "-0.04em"
  title:
    fontFamily: "Satoshi, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.72
  label:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.78rem"
    fontWeight: 650
    lineHeight: 1.2
rounded:
  tag: "4px"
  status: "10px"
  card: "12px"
  panel: "22px"
  workspace: "24px"
  section: "26px"
  pill: "999px"
  circle: "50%"
spacing:
  xs: "9px"
  sm: "12px"
  md: "18px"
  lg: "24px"
  xl: "34px"
components:
  button-primary:
    backgroundColor: "{colors.deep-charcoal}"
    textColor: "{colors.warm-white}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0 20px"
    height: "50px"
  button-primary-hover:
    backgroundColor: "{colors.warm-espresso}"
    textColor: "{colors.warm-white}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0 20px"
    height: "50px"
  button-secondary:
    backgroundColor: "rgb(255 253 250 / 58%)"
    textColor: "{colors.deep-charcoal}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0 20px"
    height: "50px"
  nav-link:
    textColor: "{colors.deep-charcoal}"
    typography: "{typography.label}"
  workspace-nav-active:
    backgroundColor: "{colors.deep-charcoal}"
    textColor: "{colors.warm-white}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0 14px"
    height: "44px"
  workspace-primary-action:
    backgroundColor: "{colors.deep-charcoal}"
    textColor: "{colors.warm-white}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0 16px"
    height: "42px"
  workspace-panel:
    backgroundColor: "{colors.warm-white}"
    textColor: "{colors.deep-charcoal}"
    rounded: "{rounded.workspace}"
    padding: "24px"
  workspace-pulse:
    backgroundColor: "{colors.warm-white}"
    textColor: "{colors.deep-charcoal}"
    rounded: "{rounded.workspace}"
    padding: "0 26px"
  workspace-system-appendix:
    backgroundColor: "{colors.stone-soft}"
    textColor: "{colors.deep-charcoal}"
    rounded: "{rounded.section}"
  signal-tag:
    backgroundColor: "{colors.signal-mint-soft}"
    textColor: "{colors.deep-charcoal}"
    rounded: "{rounded.tag}"
    padding: "4px 6px"
  action-inbox-panel:
    backgroundColor: "rgb(255 253 250 / 94%)"
    textColor: "{colors.deep-charcoal}"
    rounded: "{rounded.panel}"
  action-inbox-row:
    backgroundColor: "{colors.warm-white}"
    textColor: "{colors.deep-charcoal}"
    rounded: "{rounded.card}"
    padding: "13px 14px"
  business-graph-core:
    backgroundColor: "{colors.deep-charcoal}"
    textColor: "{colors.warm-white}"
    rounded: "{rounded.circle}"
    padding: "34px"
  policy-row:
    backgroundColor: "{colors.warm-white}"
    textColor: "{colors.deep-charcoal}"
    padding: "16px 0"
---

# Design System: Bruno.Ai

## Overview

**Creative North Star: "Calm Operations Brandboard"**

Bruno.Ai is a calm, always-on AI agent, not an AI spectacle. It runs 24/7 and learns from founder interactions, corrections, approvals, policies, and verified outcomes so each operating loop improves the next. That learning improves execution but never silently expands authority. Ivory and warm-white fields hold deep-charcoal Satoshi arguments, practical Inter copy, espresso rules, and rare mint or lime signals. The mood is capable, proactive, trustworthy, and operational: one quiet system keeping a one-person company in motion.

The system pairs generous open space with softly precise product panels. Circular network geometry links the Bruno.Ai mark, the Business Graph, and the page's orbital linework; rounded controls and fine warm rules make the interface feel approachable without becoming playful. It explicitly rejects AI glow, chatbot theater, glass effects, and ledger spectacle.

The shipped public landing page is the implementation ground truth for this direction, identified in the authenticated shell by seed `b32744ed`. Its oversized 24/7 promise, exact Bruno.Ai lockup, explicitly illustrative Action Inbox, orbital system, narrative sequence, and authority-policy treatment now extend into Operate mode on `/dashboard`, `/agents`, and `/settings`. Those routes use an opaque 244px warm-white rail, persisted pulse metrics, a founder-work-first reading order, and one finite stone System appendix. Business Graph outcomes remain landing-page direction; authenticated counts, records, and actions come from persisted application data and are never framed as illustrative proof.

The authenticated finish review recorded `ship` with no material fixes after persistence and fidelity passed and the review ceiling was reached. The authoritative captures are `.impeccable/review/authenticated-migration/{dashboard,agents,settings}-{desktop,mobile}-final.png`. Authentication entry points and agent-detail content retain their existing boundaries while inheriting the applicable shared shell.

**Key Characteristics:**

- Ivory and stone material fields with deep-charcoal structure.
- Satoshi display type paired with highly legible Inter body copy.
- Rounded precision panels and pill-shaped actions.
- Mint and lime signals used as evidence-bearing accents, not atmosphere.
- Fine orbital linework and the circular Bruno.Ai signal pattern.
- Written always-on and learning states that show better execution without silently expanding authority.
- Soft ambient depth, restrained motion, and explicit illustrative labels.

## Colors

The palette is a warm operational neutral field sharpened by dark structure and two compact, high-clarity signals.

### Primary

- **Deep Charcoal** (#101314): The main text, dark action, graph-core, icon, and high-contrast structural color.
- **Warm Espresso** (#6b4d3c): A warmer active state for dark actions and the semantic color for judgment, policy, and quiet emphasis.

### Secondary

- **Signal Mint** (#59d6c5): The primary system signal for focus, orbital activity, logo detail, connectors, and positive operating motion.
- **Deep Signal Mint** (#2d887d): Legible mint-family text and active borders on pale signal fields in the authenticated workspace.
- **Soft Signal Mint** (#dff6f1): A low-intensity field behind mint-coded icons and tags.

### Tertiary

- **Action Lime** (#b8f34b): The resolved action field, closing surface, selection color, and high-energy logo detail.
- **Soft Action Lime** (#e9fbc4): A restrained field behind lime-coded analytics and status cues.

### Neutral

- **Stone** (#d8ccbd): Orbital lines, nodes, and material boundaries that should remain visible but quiet.
- **Soft Stone** (#eee7de): The finite authenticated System appendix field that visually closes each route.
- **Ivory** (#f7f4ee): The default page canvas and the warm space between operational objects.
- **Warm White** (#fffdfa): Product-panel and row surfaces, plus text on charcoal.
- **Muted Ink** (#6f6d68): Supporting copy, metadata, and secondary status language.
- **Espresso Rule** (rgb(107 77 60 / 18%)): Fine dividers and panel outlines on ivory or warm white.
- **Charcoal Rule** (rgb(16 19 20 / 20%)): Stronger table, list, and control outlines when structure needs more contrast.

**The Signal Pair Rule.** Mint means activity, connection, or positive operating state; lime means action, completion, or concentrated emphasis. Neither is ambient decoration.

**The Warm Structure Rule.** Use espresso and stone for supporting structure so charcoal remains authoritative rather than visually relentless.

## Typography

**Display Font:** Satoshi (with Inter and system sans-serif fallbacks)

**Body Font:** Inter (with ui-sans-serif and system sans-serif fallbacks)

**Character:** Satoshi gives Bruno.Ai a geometric, contemporary voice with enough warmth for oversized promises. Inter carries operational details, labels, policies, and proof with clarity at compact sizes.

### Hierarchy

- **Display** (weight 650, fluid 4–6rem, line-height 0.94, tracking -0.04em): Oversized promises and closing statements; keep the measure near ten characters per line where the copy allows.
- **Headline** (weight 650, fluid 3.2–5.6rem, line-height 0.98, tracking -0.04em): Section arguments and the major operating model transitions.
- **Title** (weight 650, 1rem, line-height 1.2, tracking -0.02em): Panel headings, loop names, and compact operational titles.
- **Body** (weight 400, 1rem, line-height 1.72): Explanations and narrative copy, usually constrained to about 61–66 characters.
- **Label** (weight 650, 0.78rem, line-height 1.2): Navigation, actions, metadata, tags, policy states, and compact proof labels. Uppercase is reserved for status or evidence labels, not applied by default.

**The Two-Speed Rule.** Satoshi sets the direction; Inter explains the work. Do not substitute display drama for operational legibility.

## Layout

Use a centered landing content frame capped at 1360px with 24px desktop gutters. Major passages are spacious, often separated by 120–210px of vertical breathing room, while product proof stays compact inside panels. Wide layouts pair a focused argument with an operational model, using asymmetric columns rather than equal card grids.

At 1120px, navigation simplifies and two-column hero, mechanism, loop, trust, and closing compositions stack or reflow. At 720px, outer gutters reduce to 14px; primary and secondary hero actions become full-width; proof metrics, inbox rows, graph sources, policy tables, outcome lists, and the footer collapse without hiding status or truth labels.

Authenticated Operate routes use a 244px rail and a workspace up to 1480px wide. The rail narrows at 1120px, becomes a sticky brand-and-route header at 860px, and centers the lockup above a three-route grid at 620px. Pulse measures move from four columns to two below 860px; only the Agents roster pulse becomes one continuous vertical ledger at phone width. Cards, controls, and System appendices reflow without hiding actions, state labels, or persisted evidence.

**The One-Loop Rule.** Every composition should clarify one continuous operating loop between company signal, founder interaction, Bruno.Ai learning and action, and a verified outcome that improves the next attempt.

**The Proof-Before-Decoration Rule.** Give the product panel enough scale and breathing room to be read as proof; orbital geometry supports that proof without competing with it.

## Elevation & Depth

Depth is ambient and selective. Ivory remains flat; warm-white product panels receive broad low-contrast shadows, small orbit nodes receive a lighter contact shadow, and dark graph cores receive controlled lift. Borders and tonal contrast do most of the structural work.

### Shadow Vocabulary

- **Action lift** (`0 14px 28px rgb(16 19 20 / 14%)` or `0 16px 32px rgb(16 19 20 / 16%)`): Appears only when a primary dark action rises on hover.
- **Proof panel** (`0 34px 74px rgb(71 56 45 / 14%)`): Gives the illustrative Action Inbox its high-fidelity product depth.
- **Section panel** (`0 34px 74px rgb(71 56 45 / 12%)`): Separates a large two-part operating panel from the ivory canvas.
- **Graph core** (`0 26px 48px rgb(16 19 20 / 18%)`): Focuses the circular center of the Business Graph.
- **Orbit contact** (`0 10px 20px rgb(71 56 45 / 8%)`): Keeps small orbit labels legible above linework.
- **Workspace panel** (`0 18px 48px rgb(16 19 20 / 6%)`): Gives major authenticated work panels quiet separation from the ivory canvas.
- **Workspace pulse** (`0 24px 64px rgb(16 19 20 / 8%)`): Gives the persisted four-measure pulse one level of emphasis above ordinary panels.

**The Ambient-Only Rule.** Shadows should feel like diffuse room light. Never use glow, hard offset shadows, or elevation on every row.

## Shapes

The form language combines highly rounded rectangular panels with exact circles. Primary sections use 22–26px corners, operational rows use 10–12px corners, tags use 4px corners, and actions or compact source labels use full pill shapes. The Bruno.Ai mark and Business Graph core introduce circular nodes and rings; fine one-pixel espresso or stone lines connect them.

**The Orbital Geometry Rule.** Circles express connected state, ongoing work, and verification. Use them for marks, graph systems, signals, and icon fields—not as arbitrary decoration on every surface.

**The Rounded Precision Rule.** Rounded forms stay clean and quiet: thin borders, no bubbly stacking, and no decorative radius changes between equivalent components.

## Components

### Buttons

- **Shape:** Full pill with a 50px default height and 20px horizontal padding; the compact header variant is 44px high.
- **Primary:** Deep charcoal with warm-white text, a rounded line arrow, and one clear destination.
- **Hover / Focus:** Shift to warm espresso, rise 2px, and gain an ambient action shadow over 180ms. Keyboard focus is a 3px mint outline with a 4px offset; active returns to the baseline.
- **Secondary:** A translucent warm-white field with a charcoal rule. Hover resolves to solid warm white, strengthens the border, and rises 2px.

### Chips

- **Style:** Compact mint-soft or lime-soft fields with dark text. Small operational tags use a 4px radius; source, state, and orbit labels use pill geometry.
- **State:** Color always accompanies a written label. Mint and lime variants retain the Signal Pair Rule.

### Cards / Containers

- **Corner Style:** Product panels use 22–26px radii; compact metrics and records use 10–12px radii.
- **Background:** Warm white over ivory, with deep charcoal reserved for the Business Graph core and outcome-bearing contrast panels.
- **Shadow Strategy:** Broad, low-opacity ambient shadows only on major proof or section panels; ordinary rows rely on thin rules.
- **Border:** One-pixel espresso rules, with stronger charcoal rules for tables and controls.
- **Internal Padding:** Compact records use 12–18px; major panels use 24–88px according to hierarchy and viewport.

### Navigation

Navigation is quiet Inter at compact size and medium-heavy weight. Links are unboxed at rest, move to espresso with an underline on hover, and keep a visible mint focus outline. The Bruno.Ai lockup anchors the left edge; the dark pill action anchors the path into the shipped dashboard. On narrow screens, in-page links and sign-in yield while the brand and dashboard route remain.

### Authenticated Workspace

The authenticated shell applies the landing system in Operate mode rather than repeating its marketing composition. A 244px opaque warm-white rail carries the exact Bruno.Ai lockup, three pill routes, the written “Working 24/7” state, and the promise that Bruno.Ai learns from each founder decision. At 860px the rail becomes a compact sticky header; at 620px the lockup centers above a three-route grid.

Route titles use Satoshi at a maximum 4.6rem, followed by a 70-character Inter description. The first operating panel is a four-measure pulse on warm white with written state labels and small mint, lime, or stone signals; it becomes a two-by-two grid below 860px. On the agent roster, those measures become one continuous vertical ledger at phone width so capacity reads as one operating account. Founder work stays ahead of infrastructure: approvals, active agents, roster creation, and runner management use 24–26px panels, while logs, provisioning, planned controls, and health routes close inside one subdued stone System appendix.

The product shell states “Bruno.Ai is on” and “Working 24/7” as orientation, not simulated runtime proof. Auth gates, loading, error, and empty states remain intact. The desktop and mobile roster preserve all three agents; approvals, lifecycle and configuration controls, creation, assistant choice, Telegram setup, runner and cloud provisioning, registration, endpoint, version, timestamps, credential rotation and revocation, logs, and health routes remain available. Counts, state, and actions come from persisted application data and always retain non-color labels.

### Bruno.Ai Mark

The mark is a rounded monoline `B` with an internal chevron and lower loop, punctuated by mint and lime circular signals. Render it in deep charcoal on light fields or warm white in the graph core; preserve round stroke caps and the two signal colors. It may appear as a lockup or as the compact icon, but its geometry should not be redrawn as a generic sparkle or bot face.

`app/_components/bruno-logo.tsx` is the canonical in-product mark and `app/icon.svg` is its favicon rendering. Use the shared component for every visible Bruno.Ai brand mark, including landing, authenticated, authentication, loading, empty, and failure surfaces; do not substitute a letter tile or redraw the paths locally.

### Action Inbox

The Action Inbox is the canonical proof panel: a rounded warm-white shell, quiet top bar, explicit “Illustrative data” label, three status summaries, and compact decision rows. Each row combines a circular signal icon, clear title and evidence, a written tag, and a written timing or authority state. Illustrative product direction must remain visibly labeled and must not be presented as shipped functionality.

### Business Graph

The graph is a circular operating model with a deep-charcoal core, mint system label, nested stone rings, written Observe, Learn, Act, and Verify nodes, and one moving mint signal. Source systems and founder interactions enter on one side; decisions, actions, and verified outcomes leave on the other and improve the next cycle. The orbit runs for 11 seconds linearly and becomes static under reduced-motion preference.

### Authority Policies

Policy rows pair each legible business action with one written authority state: always allow, ask, or never allow. Learning improves execution but never silently expands authority; permissions remain explicit, readable, and separate from what Bruno.Ai learns through founder interactions, corrections, approvals, policies, and verified outcomes.

**The Explicit Authority Rule.** Never use a learning, confidence, or completion signal to imply broader permission. Show authority as a written business policy independent of the Observe, Learn, Act, and Verify cycle.

## Do's and Don'ts

### Do:

- **Do** use the shipped landing as the ground truth and its authenticated Operate translation for `/dashboard`, `/agents`, and `/settings`.
- **Do** let Satoshi, open ivory space, and one substantial proof panel establish the first visual impression.
- **Do** preserve the Bruno.Ai mark, circular signal geometry, and written labels whenever mint or lime communicates state.
- **Do** make 24/7 operation and learning from founder interaction explicit near the first product promise.
- **Do** show that learning improves execution while authority stays an explicit always allow, ask, or never allow policy.
- **Do** label illustrative product direction explicitly and keep routes to the shipped dashboard and agent creation clear.
- **Do** disable orbital animation and state transitions when reduced motion is requested.

### Don't:

- **Don't** use AI glow, chatbot-window theater, glassmorphism, or generic sparkle imagery.
- **Don't** revive the Company Daybook's ruled paper, compressed type, square controls, electric blue, citron tabs, or red-pencil annotations.
- **Don't** turn the circular system into decorative noise or place mint and lime everywhere.
- **Don't** imply that authenticated pulse metrics are future Business Graph outcomes or that illustrative landing-page operating loops have shipped.
- **Don't** fabricate customers, testimonials, outcomes, availability, or other product proof.
