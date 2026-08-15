---
name: Bruno
description: The Company Daybook for a one-person company.
colors:
  editorial-blue: "#155eef"
  editorial-blue-deep: "#0b3ea8"
  citron-tab: "#dfff3f"
  red-pencil: "#a92b2b"
  ledger-ink: "#172018"
  body-ink: "#4b544c"
  paper: "#f2f0e8"
  white: "#ffffff"
  rule: "rgb(23 32 24 / 20%)"
  rule-soft: "rgb(23 32 24 / 10%)"
typography:
  display:
    fontFamily: "League Gothic, sans-serif"
    fontSize: "clamp(3.5rem, 6.5vw, 6rem)"
    fontWeight: 400
    lineHeight: 0.88
    letterSpacing: "-0.025em"
  headline:
    fontFamily: "League Gothic, sans-serif"
    fontSize: "clamp(3rem, 6vw, 5.8rem)"
    fontWeight: 400
    lineHeight: 0.96
    letterSpacing: "-0.02em"
  title:
    fontFamily: "Avenir Next, Avenir, Segoe UI, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.02rem"
    fontWeight: 900
    lineHeight: 1.2
  body:
    fontFamily: "Avenir Next, Avenir, Segoe UI, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.65
  label:
    fontFamily: "Avenir Next, Avenir, Segoe UI, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.72rem"
    fontWeight: 900
    lineHeight: 1.2
    letterSpacing: "0.06em"
rounded:
  square: "0"
spacing:
  xs: "6px"
  sm: "10px"
  md: "18px"
  lg: "28px"
  xl: "48px"
  ledger: "76px"
components:
  button-primary:
    backgroundColor: "{colors.editorial-blue}"
    textColor: "{colors.white}"
    typography: "{typography.label}"
    rounded: "{rounded.square}"
    padding: "0 19px"
    height: "50px"
  button-primary-hover:
    backgroundColor: "{colors.editorial-blue-deep}"
    textColor: "{colors.white}"
    typography: "{typography.label}"
    rounded: "{rounded.square}"
    padding: "0 19px"
    height: "50px"
  editorial-tab:
    backgroundColor: "{colors.citron-tab}"
    textColor: "{colors.ledger-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.square}"
    padding: "7px 10px 6px"
    height: "34px"
  nav-link:
    textColor: "{colors.ledger-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.square}"
    padding: "5px 3px 3px"
  decision-row:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ledger-ink}"
    rounded: "{rounded.square}"
    padding: "22px 0 20px"
  graph-card:
    backgroundColor: "{colors.editorial-blue}"
    textColor: "{colors.white}"
    rounded: "{rounded.square}"
    padding: "28px"
  policy-row:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ledger-ink}"
    rounded: "{rounded.square}"
    padding: "15px 0"
---

# Design System: Bruno

## Overview

**Creative North Star: "The Company Daybook"**

Bruno looks like the working daybook of a disciplined founder: grid-ruled paper, dark ledger ink, compressed display type, editorial annotations, and a small set of decisive signals. The mood is capable, candid, and operational rather than futuristic. Information feels edited into a daily record, not generated into a dashboard.

The system is dense but calm. Square rules and tabular alignment make decisions, policies, and outcomes easy to audit; electric blue carries the active operating route, citron marks navigation and status, and dark red behaves like a corrective pencil. It rejects the generic AI hero, gradient atmosphere, glass cards, and floating chat screenshot.

**Key Characteristics:**

- Warm grid-ruled stock with visible ledger structure.
- Compressed League Gothic headlines against practical Avenir Next text.
- Square corners, hard rules, and tabular alignment.
- Electric editorial blue for action and system flow.
- Citron tabs and red-pencil annotations used as rare signals.

## Colors

The palette reads as an annotated company ledger: warm paper and near-black ink carry most of the page, with three editorial signals reserved for meaning.

### Primary

- **Electric Editorial Blue** (#155eef): Use for primary actions, process routes, graph cores, active outcomes, and keyboard focus.
- **Deep Editorial Blue** (#0b3ea8): Use for hovered actions and quieter blue text that still needs stronger contrast.

### Secondary

- **Citron Tab** (#dfff3f): Use for adhesive-tab navigation, development status, the terminal step of a process, and text selection.

### Tertiary

- **Dark Red Pencil** (#a92b2b): Use for illustrative stamps, prohibitions, and corrective underlines; it signals caution rather than brand action.

### Neutral

- **Ledger Ink** (#172018): The dominant text, rule, and dark-surface color.
- **Body Ink** (#4b544c): Long-form explanatory copy that should sit behind headlines.
- **Grid-Ruled Paper** (#f2f0e8): The default canvas and the material basis of the system.
- **White** (#ffffff): Text on saturated action and graph surfaces.
- **Ledger Rule** (rgb(23 32 24 / 20%)): Structural dividers rather than decorative framing.
- **Soft Ledger Rule** (rgb(23 32 24 / 10%)): Baseline-grid lines and quiet internal structure.

**The Three-Marks Rule.** Blue means action or operating flow, citron means a tab or resolved emphasis, and red means annotation or prohibition; do not interchange them.

## Typography

**Display Font:** League Gothic (with sans-serif fallback)

**Body Font:** Avenir Next (with Avenir, Segoe UI, and system sans-serif fallbacks)

**Label Font:** Avenir Next (with the same practical fallback stack)

**Character:** League Gothic gives Bruno the urgency of a marked-up business front page. Avenir Next keeps operational copy, policy rows, labels, and navigation compact and matter-of-fact.

### Hierarchy

- **Display** (League Gothic, weight 400, fluid 3.5–6rem, line-height 0.88): The single dominant promise or closing statement; balance line breaks and keep the measure short.
- **Headline** (League Gothic, weight 400, fluid 3–5.8rem, line-height 0.96): Section arguments and spread titles.
- **Title** (Avenir Next, weight 900, 1.02rem, line-height 1.2): Decisions, loops, and row headings.
- **Body** (Avenir Next, weight 400, 1rem, line-height 1.65): Explanations kept to around 58–65 characters where practical.
- **Label** (Avenir Next, weight 900, 0.72rem, tracking 0.06em, uppercase): Metadata, policies, tabs, and process steps.

**The Two-Voice Rule.** League Gothic makes arguments; Avenir Next carries facts, actions, and evidence.

## Layout

Use a centered page frame with narrow outer gutters and a maximum width near 1500px. Build composition from ruled spreads, ledger rows, and asymmetric editorial grids rather than floating card stacks. A 28px baseline grid is the recurring paper texture; primary section spacing is generous so dense records arrive in finite, legible groups.

At wide widths, pair related arguments in two columns and allow a central fold or route to connect them. Below 980px, spreads become a single column and graph structures stack. Below 700px, preserve the paper rules, reduce gutters to 12px per side, collapse navigation to the essential action, and turn horizontal process sequences into vertical ledgers. Do not hide status labels or rely on color alone.

**The Finite Ledger Rule.** Every group needs an explicit start and end: a top rule, numbered rows, a closing rule, or a terminal highlighted step.

## Elevation & Depth

The system is flat by default. Depth comes from overlapping ruled paper, a visible center fold, and occasional restrained ambient shadows on an entire spread or the active Business Graph core. Interactive lift is limited to the primary action; ordinary rows, tabs, and panels remain flush.

### Shadow Vocabulary

- **Spread shadow** (`0 30px 70px rgb(23 32 24 / 10%)`): separates a complete ledger spread from the surrounding paper.
- **Action lift** (`0 12px 28px rgb(21 94 239 / 24%)`): appears only when the primary action rises on hover.
- **Graph emphasis** (`0 22px 44px rgb(21 94 239 / 18%)`): gives the operating model one controlled focal plane.

**The Flat Ledger Rule.** Elevate a whole spread or one active system object, never every record.

## Shapes

Corners are square. One-pixel ledger rules, two-pixel emphasis rules, square number boxes, rectangular tabs, and clipped page edges provide the form language. Icons use thin square-ended strokes. The only irregular gesture is the slightly rotated red-pencil stamp, which should feel manually applied rather than playful.

**The Square Rule.** Do not round buttons, cards, tabs, tables, or status marks in the Company Daybook world.

## Components

### Buttons

- **Shape:** Square, compact, and typographically heavy.
- **Primary:** Electric blue with white uppercase label text and a small rightward line arrow.
- **Hover / Focus:** Darken to deep blue, lift by 2px, and add the action shadow. Keyboard focus is a 3px blue outline with a 4px offset.
- **Text action:** Ledger ink, heavy body type, and a simple underline; keep it visually subordinate to the primary action.

### Editorial Tabs

- **Style:** Citron rectangle, uppercase heavy label, square edges, and a dark red-pencil bottom rule.
- **State:** On hover, the label shifts to editorial blue; the tab does not lift or gain a shadow.

### Cards / Containers

- **Corner Style:** Square.
- **Background:** Paper for records and saturated blue for the central Business Graph object.
- **Shadow Strategy:** Flat unless the container is the whole spread or the singular active graph core.
- **Border:** One-pixel ledger rules; use two pixels only for a strong sectional boundary or graph core.
- **Internal Padding:** Compact rows use the medium rhythm; major graph objects use the large rhythm.

### Navigation

Use heavy uppercase labels with wide spacing between destinations. Links remain ink-colored and unboxed at rest; hover adds a citron field and red underline. The application bridge is the exception: “Open dashboard” uses the blue action field so the shipped product is always findable. On small screens, retain the wordmark and dashboard action while in-page destinations and the separate sign-in link yield to the document flow.

### Decision Ledger

Each decision is a numbered row with a square index, heavy title, plain-language evidence, and an explicit outcome plus policy label. Rules—not card backgrounds—separate records. Illustrative or unverified content receives a visible red-pencil stamp or text label.

### Business Graph Core

The graph core is the singular saturated-blue object inside a ruled field. It pairs a simple loop mark with one concise explanation, while a blue route connects sources to decisions, actions, and verified outcomes.

## Do's and Don'ts

### Do:

- **Do** build hierarchy with paper rules, spacing, type contrast, and explicit labels.
- **Do** keep policy, evidence, and verification states legible without color.
- **Do** reserve saturated color for actions, routes, tabs, and annotations.
- **Do** preserve the ruled-paper texture and square geometry across responsive layouts.

### Don't:

- **Don't** use generic AI gradients, glassmorphism, glowing orbs, or a floating chat-window hero.
- **Don't** turn every record into a rounded card or elevated tile.
- **Don't** use blue, citron, or red as interchangeable decoration.
- **Don't** fabricate dashboards, outcomes, testimonials, or implied product availability as visual proof.
