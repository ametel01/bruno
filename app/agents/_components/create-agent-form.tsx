"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

const TEMPLATE_LABELS = {
  research_agent: "Research Agent",
  inbox_triage_agent: "Inbox Triage Agent",
  github_issue_agent: "GitHub Issue Agent",
  social_content_agent: "Social Content Agent",
} as const;

type SubmitState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

type CreateAgentFormProps = {
  maxNameLength: number;
  templateKeys: Array<keyof typeof TEMPLATE_LABELS>;
};

export function CreateAgentForm({ maxNameLength, templateKeys }: CreateAgentFormProps) {
  const router = useRouter();
  const [state, setState] = useState<SubmitState>({ status: "idle" });

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

  const disabled = state.status === "submitting";

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
        <select id="agent-template" name="templateKey" defaultValue="research_agent">
          {templateKeys.map((templateKey) => (
            <option key={templateKey} value={templateKey}>
              {TEMPLATE_LABELS[templateKey]}
            </option>
          ))}
        </select>
      </div>
      <button className="primary-button" type="submit" disabled={disabled}>
        {disabled ? "Creating" : "Create agent"}
      </button>
      {state.status === "error" || state.status === "success" ? (
        <p className={`form-message ${state.status}`} role="status">
          {state.message}
        </p>
      ) : null}
    </form>
  );
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
  } catch {
    // Keep user-facing failures generic when the response is not safe validation JSON.
  }

  return "Agent could not be created.";
}
