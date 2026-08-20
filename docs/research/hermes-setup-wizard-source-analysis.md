# Hermes setup wizard: pinned-source analysis for Bruno

Status: research only. No implementation decision is implied by this document.

## Scope and source pin

This analysis traces the current `NousResearch/hermes-agent` `main` branch at commit [`b779fbf4237fee171f9bad0f2d4680705fb57280`](https://github.com/NousResearch/hermes-agent/commit/b779fbf4237fee171f9bad0f2d4680705fb57280) (2026-08-17). Every upstream source link below is pinned to that SHA. The public documentation was also checked at [User Stories](https://hermes-agent.nousresearch.com/docs/user-stories), [Quickstart](https://hermes-agent.nousresearch.com/docs/getting-started/quickstart), [AI Providers](https://hermes-agent.nousresearch.com/docs/integrations/providers), [CLI Commands](https://hermes-agent.nousresearch.com/docs/reference/cli-commands), and [Web Dashboard](https://hermes-agent.nousresearch.com/docs/user-guide/features/web-dashboard).

## Executive findings

Facts:

- The canonical complete first-run entrypoint is `hermes setup`. The parser calls it an interactive wizard and also exposes section commands plus `--reset`, `--quick`, `--reconfigure`, `--portal`, and `--non-interactive` ([parser](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/subcommands/setup.py#L12-L67)).
- A real stdin TTY is required. Despite the help text saying “use defaults/env vars,” `--non-interactive` does **not** run the wizard or write defaults: the orchestrator prints config/env guidance and returns ([TTY check and guidance](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/setup.py#L172-L199), [orchestrator guard](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/setup.py#L2888-L2897)). There is no machine-readable output mode or complete setup state-machine API.
- A fresh `hermes setup` offers three branches in this default order: Quick Setup through Nous Portal, Full setup, and Blank Slate ([mode prompt](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/setup.py#L3001-L3031)). This means the canonical wizard is not a Bruno/OpenAI/Anthropic preset; the default first choice is Nous.
- OpenAI Codex subscription authentication is a browser/device-code flow. It prints `https://auth.openai.com/codex/device` and a user code, then polls for up to 15 minutes ([device flow](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/auth.py#L8204-L8321)). It can first reuse Hermes credentials or import `~/.codex/auth.json` ([login orchestration](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/auth.py#L7877-L7948)). User attendance in an external browser is required for a fresh login.
- The CLI Anthropic subscription branch runs `claude setup-token`, expects a browser authorization, and may require the user to paste the resulting token; without the Claude CLI it offers install instructions or a manual token paste ([CLI flow](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/main.py#L5168-L5258)). Anthropic API-key entry is the other supported path ([provider flow](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/model_setup_flows.py#L3026-L3175)). Current official provider docs say Claude OAuth requires Max plus purchased extra-usage credits, cannot use the base Max allowance, and does not work with Pro; ChatGPT-plan quota semantics for Codex are not documented ([official provider and billing notes](https://hermes-agent.nousresearch.com/docs/integrations/providers#subscription-plans-what-your-plan-pays-for)).
- Messaging is not required to obtain a working CLI agent. Quick can skip it; Blank Slate defaults to no messaging; Full always opens the messaging checklist, but selecting nothing is valid. Hermes nevertheless tries to install/start its gateway service even with zero configured platforms so cron can run ([Quick prompt](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/setup.py#L3131-L3150), [gateway behavior](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/setup.py#L2154-L2290), [Blank prompt](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/setup.py#L3381-L3386)).
- Bruno already runs the canonical `hermes setup` in an actual Docker PTY and streams its bytes to xterm.js. It does not emulate the prompt flow. The important mismatch is ownership: immediately after the wizard succeeds Bruno applies fixed terminal/browser/guardrail settings, and a later managed Start/Restart projects additional Bruno-owned model, platform, and secret values over wizard choices.
- Upstream does expose useful structured web APIs: provider status, OpenAI device-code start/poll/cancel, Anthropic PKCE start/submit, model assignment, config, env, and messaging-platform endpoints. These are **components**, not an API for running the complete canonical `hermes setup` flow ([OAuth API contract](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/web_server.py#L10687-L10723), [OAuth routes](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/web_server.py#L11586-L11688), [model/config routes](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/web_server.py#L6704-L6732)). Upstream’s `/api/pty` cannot be repurposed by request to run setup: it resolves and spawns the chat TUI (`hermes --tui`) ([PTY contract](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/web_server.py#L15463-L15480), [fixed argv resolution](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/web_server.py#L15847-L15896)).

## End-to-end canonical execution path

### CLI registration, TTY, and preflight

1. `hermes setup` is registered by `build_setup_parser()` and dispatched through `cmd_setup()` directly into `run_setup_wizard()` ([registration](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/subcommands/setup.py#L12-L67), [dispatch](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/main.py#L3484-L3488)). Unlike `hermes model`, `cmd_setup()` has no separate `_require_tty()` call; the setup orchestrator checks stdin itself.
2. If Hermes is in upstream managed mode, setup prints a managed-mode error and returns ([managed guard](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/setup.py#L2843-L2860)).
3. `--reset` writes `DEFAULT_CONFIG` before the TTY check. Existing `config.yaml` is then timestamp-backed up. Only after that does the noninteractive guard return ([reset, backup, TTY order](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/setup.py#L2862-L2897)). Therefore `hermes setup --reset --non-interactive` is not read-only even though no prompts run.
4. `--portal` is a Nous-only one-shot. A positional section runs only that section and saves it. Otherwise the wizard considers the installation existing when it sees `OPENROUTER_API_KEY`, `OPENAI_BASE_URL`, or any active auth provider ([branch selection](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/setup.py#L2899-L2941)).
5. On a fresh installation, an existing `~/.openclaw` triggers a preview-first migration offer. Preview defaults yes; actual migration defaults no ([migration prompts](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/setup.py#L2611-L2641), [confirmation](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/setup.py#L2683-L2713)).

### Fresh branches and prompt order

| Branch | Ordered stages and defaults | Result |
| --- | --- | --- |
| Quick Setup (default) | Nous Portal OAuth/model; terminal backend; silent recommended agent defaults; “Set up messaging now” is the default, while skip is available | Nous-specific provider choice; tool defaults come from the Nous flow; setup can finish without messaging ([implementation](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/setup.py#L3084-L3160)) |
| Full setup | Provider/model; terminal; silent recommended agent defaults; messaging checklist; tools checklist and provider/API-key prompts; final save and summary | User controls provider and tools; messaging checklist may be empty ([orchestrator](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/setup.py#L3033-L3081)) |
| Blank Slate | Required provider/model; terminal; force only file + terminal toolsets; disable compression, memory, checkpoints, smart routing, and automatic reset; default to finish minimal or optionally enter the walkthrough | Minimal agent; finish-now also opts out of future bundled-skill injection ([baseline and fork](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/setup.py#L3236-L3313)) |

The Blank Slate walkthrough defaults every optional item off: bundled skills, extra-tool selector, plugin review, MCP, and messaging. “Review plugins” and “Add MCP” currently only print follow-up commands; they do not launch another configuration UI ([walkthrough](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/setup.py#L3316-L3396)).

### Full-setup details

Provider/model: `setup_model_provider()` delegates to the same `select_provider_and_model()` function as `hermes model`, then reloads config from disk to avoid overwriting provider changes ([delegation](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/setup.py#L873-L922)). The picker is catalog-driven. With no active provider its first dynamic catalog row is the default; with an active provider that provider/group is the default. It appends custom endpoint, auxiliary models, and leave-unchanged actions ([picker construction](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/main.py#L3758-L3853)).

OpenAI Codex: after login or credential reuse/import, the user chooses a Codex model. Hermes writes the chosen model and `model.provider: openai-codex` ([model flow](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/model_setup_flows.py#L623-L709)). The device flow does not try to launch a browser itself; it prints a URL and code. It retries initial HTTP 429 responses and waits a maximum of 15 minutes.

Anthropic: existing API key or valid Claude Code credentials can be reused. Otherwise the prompt is: subscription OAuth, API key, or cancel. The CLI text says “Claude Pro/Max subscription,” but the current official docs explicitly say Pro is unsupported and Max requires extra-use credits; Bruno must not repeat the broader CLI label without correction. After auth, the user selects an Anthropic model and Hermes writes `model.provider: anthropic` ([implementation](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/model_setup_flows.py#L3026-L3175)).

Terminal: choices are Local, Docker, Modal, SSH, Daytona, Vercel Sandbox, Linux-only Singularity/Apptainer, then `Keep current`; **Keep current** is the default even on a fresh config, whose effective current backend is Local ([choices](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/setup.py#L1323-L1369)). Non-local branches can install SDKs, prompt for cloud or SSH credentials, test connections, and in the Docker branch optionally enable an egress firewall (default no). It writes `terminal.backend` to config and mirrors it as `TERMINAL_ENV` in `.env` ([persistence](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/setup.py#L1643-L1652)).

Agent defaults on first install are not prompts: `max_turns=150`, all tool progress, compression enabled at `0.50`, and no automatic session reset ([defaults](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/setup.py#L1660-L1685)). `hermes setup agent` is a separate detailed prompt flow.

Messaging: Hermes dynamically lists built-in/plugin platforms, preselects configured ones, and configures only selected rows. Zero is allowed. Gateway service installation/start still happens unconditionally ([implementation](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/setup.py#L2154-L2290)). This step may therefore attempt platform service-manager work even when the user does not want Telegram, Discord, or another channel.

Tools: a fresh Full setup skips the platform-menu loop and shows one checklist per enabled platform (CLI always; messaging platforms only when their credentials are present). Defaults are the effective current toolsets minus the explicit default-off set (`homeassistant`, `spotify`, Discord administration, video, X search, A2A, etc.). It then prompts through provider/API-key configuration for selected toolsets and may install dependencies such as browser components or SDKs ([first-install tool flow](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/tools_config.py#L5181-L5288), [enabled platform detection](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/tools_config.py#L2235-L2248)).

### Persistence, rerun, resume, and exits

- Nonsecret selections are written to `~/.hermes/config.yaml`; ordinary credentials go to `~/.hermes/.env`; OAuth provider state such as Codex goes to `~/.hermes/auth.json`. Config uses atomic YAML writing; a new `.env` is secured and subsequent writes preserve its existing mode; `auth.json` is atomically created with owner-only `0600` and its parent tightened to `0700` ([config writer](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/config.py#L3730-L3775), [.env writer](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/config.py#L4090-L4172), [auth writer](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/auth.py#L1349-L1400)).
- Setup is incrementally persistent, not transactional. Provider/model, terminal, agent defaults, Blank baseline, tools, and credentials save during their stages. Ctrl+C/EOF commonly raises exit 1 from prompt helpers, so an interrupted run can leave a valid partial configuration ([prompt exit](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/setup.py#L202-L219), [choice exit](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/setup.py#L239-L279)).
- There is no wizard checkpoint/session token and no “resume at step N.” Rerunning is the supported recovery. Once any active provider makes the install “existing,” bare `hermes setup` runs the entire reconfigure path with current values as defaults; `--quick` only fills missing items ([existing-install behavior](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/setup.py#L2933-L3000), [missing-only flow](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/setup.py#L3399-L3432)).
- Provider setup deliberately catches cancellation/failure and can continue with a warning, so “wizard reached the final summary” is not by itself proof that provider auth and inference work ([catch behavior](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/setup.py#L891-L902)). Bruno needs an independent readiness check after exit.

## Structured upstream surfaces Bruno can reuse

These are factual capabilities at the pinned SHA, not a statement that Bruno should switch to them:

| Surface | Capability | Limitation |
| --- | --- | --- |
| `run_setup_wizard(args)` | Complete canonical orchestration | Direct Python call still uses curses/input/stdout, requires a TTY, has no event schema, and writes incrementally ([function](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/setup.py#L2843-L3081)) |
| `select_provider_and_model()` and section functions | Same internal functions used by setup and section commands | Still prompt-driven; these are Python internals, not a stable remote API ([provider function](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/main.py#L3519-L3526)) |
| Hermes OAuth REST | Structured OpenAI device-code start/poll/cancel and Anthropic PKCE start/submit; in-memory sessions expire after 15 minutes | Auth only; it does not select a model, terminal, tools, messaging, or agent defaults. The CLI Anthropic path and web PKCE path are different implementations ([flow contract](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/web_server.py#L10687-L10723), [Anthropic PKCE](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/web_server.py#L10857-L10961), [OpenAI device start](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/web_server.py#L11026-L11059)) |
| Config/env/model/messaging REST | Structured reads and writes for dashboard forms | Exposes primitives, not canonical setup ordering/defaults or an atomic completion contract ([model assignment](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/web_server.py#L7121-L7127), [config update](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/web_server.py#L7505-L7527), [env update](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/web_server.py#L7706-L7729), [messaging routes](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/web_server.py#L9922-L10077)) |
| `/api/pty` | Browser xterm transport with keep-alive/reattach support | Fixed to the chat TUI; no command parameter for `hermes setup` ([PTY session registry](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/web_server.py#L15511-L15520), [WebSocket route](https://github.com/NousResearch/hermes-agent/blob/b779fbf4237fee171f9bad0f2d4680705fb57280/hermes_cli/web_server.py#L16731-L16805)) |

There is consequently no supported way to embed the entire canonical wizard as semantic web controls without either retaining a PTY or implementing a separate Bruno onboarding state machine from the structured primitives.

## Bruno’s current integration

Facts from the current Bruno worktree:

- Bruno’s fixed command begins with the genuine `hermes setup`, then—only when that returns exit 0—sets `/workspace`, disables browser, and enables three hard-stop guardrail values ([`SETUP_COMMAND`](../../src/runner-service/hermes-setup-sessions.ts#L17-L24)). This is already canonical execution, not ANSI prompt scraping or a facsimile.
- Bruno starts the fixed command in an ephemeral Docker container with `--interactive --tty`, persistent Hermes and workspace bind mounts, network access, resource limits, dropped capabilities, and an xterm-compatible `TERM` ([container command](../../src/runner-service/hermes-setup-sessions.ts#L285-L328)). That satisfies upstream’s TTY and persistent-filesystem assumptions. External browser/device-code actions still happen on the founder’s computer from URLs shown in the terminal.
- The setup session lasts 15 minutes—the same duration as OpenAI’s device flow—and allows only one global Bruno setup session. It refuses while the target agent is running ([session creation](../../src/runner-service/hermes-setup-sessions.ts#L12-L16), [admission](../../src/runner-service/hermes-setup-sessions.ts#L123-L171)). A slow pre-auth wizard can consume part of the same deadline before OpenAI polling begins.
- Bruno’s WebSocket forwards base64 PTY output and raw terminal input/resize events. It marks only process exit 0 as complete ([streaming](../../src/runner-service/hermes-setup-sessions.ts#L199-L278), [exit mapping](../../src/runner-service/hermes-setup-sessions.ts#L331-L356)). Browser disconnect calls `close()`, kills the process, and removes the container; the token is one-use, so Bruno does not currently support reattachment even though upstream’s chat PTY does ([server close](../../src/runner-service/server.ts#L248-L260), [cleanup](../../src/runner-service/hermes-setup-sessions.ts#L381-L407)). Rerunning setup is the recovery path; partial Hermes writes persist.
- The UI accurately labels this surface “Advanced Hermes setup” and warns that managed provider, model, API server, Telegram, terminal, browser, safety, and environment settings are reapplied on next Start/Restart ([component](../../app/agents/_components/agent-hermes-setup.tsx#L185-L225)).

### What Bruno overwrites or supplements

The setup command itself supplements successful wizard output with:

| Setting | Bruno post-command value |
| --- | --- |
| `terminal.cwd` | `/workspace` |
| `browser.enabled` | `false` |
| `tool_loop_guardrails.hard_stop_enabled` | `true` |
| `tool_loop_guardrails.hard_stop_after.exact_failure` | `5` |
| `tool_loop_guardrails.hard_stop_after.idempotent_no_progress` | `5` |

On a later Start/Restart, `projectHermesHome()` behaves differently by launch-spec version:

- A managed launch spec rewrites `model.provider`, `model.default`, terminal backend/cwd, browser, guardrails, API-server enablement, and Telegram enablement/policy while preserving unrelated YAML ([managed projection](../../src/runner-service/hermes-projection.ts#L253-L286)). It also owns/replaces model key variables, Telegram credentials/allowlist, API-server credentials/settings, and allow-all flags, while preserving unrelated `.env` lines ([managed env keys](../../src/runner-service/hermes-projection.ts#L63-L80), [render and merge](../../src/runner-service/hermes-projection.ts#L289-L347)). A provider/model or terminal selected in the canonical wizard can therefore be overwritten.
- A native/non-managed launch spec requires an existing Hermes config and preserves it; its environment projection owns only API-server enablement/host/key ([native branch](../../src/runner-service/hermes-projection.ts#L150-L161), [native env](../../src/runner-service/hermes-projection.ts#L312-L347)). In that mode, wizard provider/model and most credentials remain authoritative.

The product decision must therefore specify the launch-spec mode. “Run the canonical wizard” and “Bruno owns provider/model/Telegram” are contradictory for a managed launch unless the UI plainly marks those wizard sections as temporary or Bruno stops projecting them.

## Integration options and recommended boundary

The following are recommendations, not claims about upstream support.

### Option A — Canonical PTY as the whole first-run experience

Keep the existing architecture and promote the xterm wizard to first-run. Add only a nonterminal shell around it: plain-language preparation, “open/copy code” affordances for detected URLs, progress/help, and post-exit readiness checks. Do not synthesize keystrokes or parse ANSI to drive hidden decisions.

Advantages: exact upstream behavior and defaults; future providers/tools appear automatically. Costs: default Nous positioning, technical terminal/tool choices, service-manager side effects, no semantic resume, and upstream text such as the inaccurate Claude Pro label leak into founder UX.

### Option B — Bruno-native onboarding using upstream structured primitives

Build a small founder flow for only the settled Bruno scope (OpenAI Codex and Anthropic, model selection, local terminal, no external messaging required), using Hermes OAuth/model/config APIs or equivalent pinned functions, then retain canonical `hermes setup` as Advanced setup.

Advantages: plain language, proper browser handoff, selected services, semantic progress/resume, and no irrelevant provider/terminal/tool questions. Costs: this is a separate onboarding product that must track upstream schemas/defaults; it is not literally the canonical complete wizard.

### Option C — Hybrid, recommended

Use Bruno-native structured onboarding for the founder’s minimum viable agent, then offer **Review in Hermes setup** as an optional canonical PTY step before first Start and keep **Advanced Hermes setup** for later troubleshooting. The boundary should be explicit:

1. Bruno owns account choice/auth handoff, model compatibility, workspace path, browser policy, API-server transport, safety guardrails, and the in-app chat channel.
2. Hermes owns its provider OAuth token format, provider/model catalog, agent defaults, optional tools/skills, and optional external messaging configuration.
3. Anything Bruno will project on Start must not be presented as a durable choice inside the canonical terminal. Either stop projecting provider/model in the native launch path or label those terminal sections as overridden.
4. Readiness is a Bruno check after setup: usable provider credentials, compatible model selected, config readable, and a bounded inference probe—not merely PTY exit 0.
5. Keep secrets inside the runner’s persistent Hermes home. Send only authorization URLs/codes and redacted status to the browser; never relay full OAuth tokens into Bruno’s application database.

This hybrid honors the canonical wizard without making a nontechnical founder understand every Hermes infrastructure seam. It also uses the structured OAuth paths that upstream already maintains instead of scraping terminal output, while preserving the full wizard unchanged for users who want it.

## Open integration risks to resolve before implementation

- Pin or record the Hermes image digest/version alongside this contract. `latest` wizard prompts and REST shapes can change independently of Bruno.
- Decide whether first-run agents use managed or native launch specs. That determines whether wizard provider/model choices survive Start.
- Give setup its own reattachable session and a deadline longer than provider auth; the current one-use WebSocket and shared 15-minute TTL are fragile during browser authorization.
- Decide whether Bruno should suppress gateway-service installation in its container. Canonical Full setup runs it even with no messaging; changing that means an explicit Bruno/upstream integration patch, not pretending canonical behavior differs.
- Surface the official Anthropic Max/extra-usage limitation and OpenAI’s undocumented quota semantics before login. Do not rely on the CLI’s broader “Pro/Max” prompt.
- Validate that the workload image contains the Claude CLI before offering CLI `setup-token`; otherwise prefer upstream’s structured Anthropic PKCE path or the API-key path.
