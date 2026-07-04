"use client";

import { useRouter } from "next/navigation";
import { type ChangeEvent, type FormEvent, useEffect, useState } from "react";
import type { AgentTemplateSnapshot } from "@/src/server/agents/templates";

type SubmitState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

type CreateAgentFormProps = {
  maxNameLength: number;
  templates: AgentTemplateSnapshot[];
};

export function CreateAgentForm({ maxNameLength, templates }: CreateAgentFormProps) {
  const router = useRouter();
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

  function handleTemplateChange(event: ChangeEvent<HTMLSelectElement>) {
    setSelectedTemplateKey(event.target.value);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const form = event.currentTarget;
    const formData = new FormData(form);
    const name = String(formData.get("name") ?? "").trim();
    const templateKey = String(formData.get("templateKey") ?? "");

    if (name.length === 0) {
      setState({ status: "error", message: "Name is required." });
      return;
    }

    setState({ status: "submitting" });

    try {
      const response = await fetch("/api/agents", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name, templateKey }),
      });

      if (!response.ok) {
        setState({ status: "error", message: await safeFailureMessage(response) });
        return;
      }

      form.reset();
      setState({ status: "success", message: "Agent created." });
      router.refresh();
    } catch {
      setState({ status: "error", message: "Agent could not be created." });
    }
  }

  const submitting = state.status === "submitting";
  const disabled = !hydrated || submitting;

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

async function safeFailureMessage(response: Response): Promise<string> {
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
        return messages.join(" ");
      }

      return "Check the agent name and template.";
    }

    if (body.error?.code === "database_unavailable") {
      return "Database is unavailable. Start Postgres and run migrations, then try again.";
    }

    if (body.error?.code === "database_schema_missing") {
      return "Database schema is missing. Run migrations, then try again.";
    }
  } catch {
    // Keep user-facing failures generic when the response is not safe validation JSON.
  }

  return "Agent could not be created.";
}
