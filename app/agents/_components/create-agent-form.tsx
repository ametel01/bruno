"use client";

import { useRouter } from "next/navigation";
import {
  type ChangeEvent,
  type FormEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import type { AgentTemplateSnapshot } from "@/src/server/agents/templates";

type SubmitState =
  | { status: "idle" }
  | { status: "submitting"; stageIndex: number }
  | { status: "success"; message: string }
  | { status: "error"; message: string; showSetupTrace?: boolean };

const SETUP_STAGES = [
  {
    label: "Validate request",
    detail: "Checks the agent name, selected template, and optional runner assignment.",
  },
  {
    label: "Check capacity",
    detail: "Looks for an assignable online runner before provisioning new infrastructure.",
  },
  {
    label: "Create Droplet",
    detail: "Requests a DigitalOcean runner host with the configured region, image, and size.",
  },
  {
    label: "Apply network policy",
    detail: "Records tags and firewall intent so the runner can be managed safely.",
  },
  {
    label: "Inject bootstrap",
    detail: "Prepares the registration token and startup script the Droplet will run.",
  },
  {
    label: "Wait for runner",
    detail: "Waits for registration and the first heartbeat before assignment is complete.",
  },
  {
    label: "Persist agent",
    detail: "Creates the stopped agent record and assigns it to the available runner.",
  },
] as const;

type CreateAgentFormProps = {
  maxNameLength: number;
  runners: Array<{
    id: string;
    name: string;
    kind: "manual_vps" | "digitalocean";
    status: "online";
    detail: string;
  }>;
  templates: AgentTemplateSnapshot[];
};

export function CreateAgentForm({ maxNameLength, runners, templates }: CreateAgentFormProps) {
  const router = useRouter();
  const setupTraceRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<SubmitState>({ status: "idle" });
  const [hydrated, setHydrated] = useState(false);
  const [selectedTemplateKey, setSelectedTemplateKey] = useState<string>(
    templates[0]?.key ?? "research_agent",
  );
  const selectedTemplate =
    templates.find((template) => template.key === selectedTemplateKey) ?? templates[0];

  useEffect(() => {
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (state.status !== "submitting") {
      return;
    }

    const interval = window.setInterval(() => {
      setState((current) => {
        if (current.status !== "submitting") {
          return current;
        }

        return {
          status: "submitting",
          stageIndex: Math.min(current.stageIndex + 1, SETUP_STAGES.length - 2),
        };
      });
    }, 1600);

    return () => window.clearInterval(interval);
  }, [state.status]);

  function handleTemplateChange(event: ChangeEvent<HTMLSelectElement>) {
    setSelectedTemplateKey(event.target.value);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const form = event.currentTarget;
    const formData = new FormData(form);
    const name = String(formData.get("name") ?? "").trim();
    const templateKey = String(formData.get("templateKey") ?? "");
    const runnerId = String(formData.get("runnerId") ?? "").trim();

    if (name.length === 0) {
      setState({ status: "error", message: "Name is required." });
      return;
    }

    setState({ status: "submitting", stageIndex: 0 });

    try {
      const response = await fetch("/api/agents", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name, templateKey, runnerId: runnerId || null }),
      });

      if (!response.ok) {
        const failure = await safeFailureMessage(response);
        setState({
          status: "error",
          message: failure.message,
          ...(failure.showSetupTrace ? { showSetupTrace: true } : {}),
        });
        return;
      }

      form.reset();
      setSelectedTemplateKey(templates[0]?.key ?? "research_agent");
      setState({
        status: "success",
        message: "Agent created. Latest runner setup status is refreshed below.",
      });
      router.refresh();
    } catch {
      setState({
        status: "error",
        message: "Agent could not be created.",
        showSetupTrace: true,
      });
    }
  }

  const submitting = state.status === "submitting";
  const disabled = !hydrated || submitting;
  const showSetupTrace =
    state.status === "submitting" || (state.status === "error" && state.showSetupTrace === true);

  useEffect(() => {
    if (!showSetupTrace) {
      return;
    }

    setupTraceRef.current?.scrollIntoView({ block: "center" });
  }, [showSetupTrace]);

  return (
    <form className="agent-form" onSubmit={handleSubmit}>
      <div className="field-group">
        <label htmlFor="agent-name">Name</label>
        <input
          id="agent-name"
          name="name"
          type="text"
          required
          maxLength={maxNameLength}
          autoComplete="off"
          placeholder="Research Agent"
        />
      </div>
      <div className="field-group">
        <label htmlFor="agent-template">Template</label>
        <select
          id="agent-template"
          name="templateKey"
          onChange={handleTemplateChange}
          value={selectedTemplateKey}
        >
          {templates.map((template) => (
            <option key={template.key} value={template.key}>
              {template.name}
            </option>
          ))}
        </select>
      </div>
      {runners.length > 0 ? (
        <div className="field-group">
          <label htmlFor="agent-runner">Runner</label>
          <select id="agent-runner" name="runnerId" defaultValue="">
            <option value="">No runner</option>
            {runners.map((runner) => (
              <option key={runner.id} value={runner.id}>
                {runner.name} / {runner.kind} / {runner.status} / {runner.detail}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {selectedTemplate ? (
        <div className="selected-template-summary" aria-live="polite">
          <h3>{selectedTemplate.name}</h3>
          <p>{selectedTemplate.description}</p>
          <dl className="template-metadata-list">
            <div>
              <dt>Version</dt>
              <dd>{selectedTemplate.version}</dd>
            </div>
            <div>
              <dt>Schedule</dt>
              <dd>{selectedTemplate.defaultSchedule}</dd>
            </div>
            <div>
              <dt>Required integrations</dt>
              <dd>{formatList(selectedTemplate.requiredIntegrations)}</dd>
            </div>
            <div>
              <dt>Default prompt</dt>
              <dd className="template-default-prompt">
                <p>{selectedTemplate.defaultSystemPrompt}</p>
              </dd>
            </div>
          </dl>
          <TemplateToolList tools={selectedTemplate.defaultTools} />
        </div>
      ) : null}
      <div className="template-option-list">
        {templates.map((template) => (
          <article
            className="template-option-card"
            data-selected={template.key === selectedTemplateKey}
            key={template.key}
          >
            <div>
              <h3>{template.name}</h3>
              <p>{template.description}</p>
            </div>
            <dl className="template-metadata-list">
              <div>
                <dt>Tools</dt>
                <dd>{formatList(template.defaultTools)}</dd>
              </div>
              <div>
                <dt>Schedule</dt>
                <dd>{template.defaultSchedule}</dd>
              </div>
            </dl>
          </article>
        ))}
      </div>
      {showSetupTrace ? (
        <AgentSetupTrace
          activeStageIndex={state.status === "submitting" ? state.stageIndex : null}
          failed={state.status === "error"}
          traceRef={setupTraceRef}
        />
      ) : null}
      <button className="primary-button" type="submit" disabled={disabled}>
        {submitting ? "Creating" : "Create agent"}
      </button>
      {state.status === "error" || state.status === "success" ? (
        <p className={`form-message ${state.status}`} role="status">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

function AgentSetupTrace({
  activeStageIndex,
  failed,
  traceRef,
}: {
  activeStageIndex: number | null;
  failed: boolean;
  traceRef: RefObject<HTMLDivElement | null>;
}) {
  const activeStage =
    activeStageIndex === null
      ? null
      : SETUP_STAGES[Math.min(activeStageIndex, SETUP_STAGES.length - 1)];

  return (
    <section
      className="agent-setup-trace"
      aria-live="polite"
      aria-label="Agent setup progress"
      ref={traceRef}
    >
      <div className="agent-setup-trace-header">
        <h3>{failed ? "Setup stopped" : "Setting up agent"}</h3>
        <span>{failed ? "needs attention" : "in progress"}</span>
      </div>
      {activeStage ? (
        <div className="agent-setup-current-stage">
          <strong>{activeStage.label}</strong>
          <p>{activeStage.detail}</p>
        </div>
      ) : (
        <p>
          AgentBay stopped while checking runner capacity or cloud provisioning. The error below has
          the next action.
        </p>
      )}
      <ol className="agent-setup-stage-list">
        {SETUP_STAGES.map((stage, index) => (
          <li
            key={stage.label}
            data-stage-status={stageStatus({
              activeStageIndex,
              failed,
              index,
            })}
          >
            <span aria-hidden="true" />
            <div>
              <strong>{stage.label}</strong>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function stageStatus({
  activeStageIndex,
  failed,
  index,
}: {
  activeStageIndex: number | null;
  failed: boolean;
  index: number;
}): "pending" | "current" | "completed" | "failed" {
  if (failed && (activeStageIndex === null || index === activeStageIndex)) {
    return "failed";
  }

  if (activeStageIndex === null) {
    return "pending";
  }

  if (index < activeStageIndex) {
    return "completed";
  }

  if (index === activeStageIndex) {
    return "current";
  }

  return "pending";
}

function TemplateToolList({ tools }: { tools: string[] }) {
  return (
    <ul className="template-chip-list" aria-label="Default tools">
      {tools.map((tool) => (
        <li key={tool}>{tool}</li>
      ))}
    </ul>
  );
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "None";
}

async function safeFailureMessage(
  response: Response,
): Promise<{ message: string; showSetupTrace?: boolean }> {
  try {
    const body = (await response.json()) as {
      error?: {
        code?: unknown;
        issues?: Array<{ message?: unknown }>;
      };
    };

    if (body.error?.code === "validation_failed") {
      const messages =
        body.error.issues
          ?.map((issue) => (typeof issue.message === "string" ? issue.message : null))
          .filter((message) => message !== null) ?? [];

      if (messages.length > 0) {
        return { message: messages.join(" ") };
      }

      return { message: "Check the agent name and template." };
    }

    if (body.error?.code === "database_unavailable") {
      return {
        message: "Database is unavailable. Start Postgres and run migrations, then try again.",
      };
    }

    if (body.error?.code === "database_schema_missing") {
      return { message: "Database schema is missing. Run migrations, then try again." };
    }

    if (body.error?.code === "runner_not_assignable") {
      return { message: "Runner could not be assigned. Refresh runners and try again." };
    }

    if (body.error?.code === "runner_provisioning_not_configured") {
      return {
        message:
          "Cloud runner provisioning is not configured. Add DigitalOcean and runner credentials, then try again.",
        showSetupTrace: true,
      };
    }

    if (body.error?.code === "runner_provisioning_failed") {
      return {
        message:
          "Cloud runner provisioning could not be started. Check runner provisioning status.",
        showSetupTrace: true,
      };
    }
  } catch {
    // Keep user-facing failures generic when the response is not safe validation JSON.
  }

  return { message: "Agent could not be created.", showSetupTrace: true };
}
