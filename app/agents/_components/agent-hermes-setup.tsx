"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import type { AgentSecretStatus, AgentSecretKind } from "@/src/server/agents/agent-secrets";
import type {
  HermesSetupReadiness,
  OPENROUTER_MODEL_OPTIONS,
} from "@/src/server/agents/hermes-readiness";

type OpenRouterModelOption = (typeof OPENROUTER_MODEL_OPTIONS)[number];

type AgentHermesSetupProps = {
  agentId: string;
  modelProvider: string;
  modelName: string;
  modelOptions: readonly OpenRouterModelOption[];
  readiness: HermesSetupReadiness;
  secrets: AgentSecretStatus[];
};

type FormState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

type SecretDrafts = {
  openrouter_api_key: string;
  telegram_bot_token: string;
  telegram_allowed_users: string;
};

const USER_SECRET_FIELDS = [
  {
    kind: "openrouter_api_key",
    label: "OpenRouter API key",
    inputType: "password",
    autoComplete: "off",
    placeholder: "sk-or-v1-...",
  },
  {
    kind: "telegram_bot_token",
    label: "Telegram bot token",
    inputType: "password",
    autoComplete: "off",
    placeholder: "123456:ABC...",
  },
  {
    kind: "telegram_allowed_users",
    label: "Telegram allowed users",
    inputType: "text",
    autoComplete: "off",
    placeholder: "123456789,987654321",
  },
] as const;

export function AgentHermesSetup({
  agentId,
  modelProvider,
  modelName,
  modelOptions,
  readiness,
  secrets,
}: AgentHermesSetupProps) {
  const router = useRouter();
  const [selectedModel, setSelectedModel] = useState(modelName);
  const [secretDrafts, setSecretDrafts] = useState<SecretDrafts>({
    openrouter_api_key: "",
    telegram_bot_token: "",
    telegram_allowed_users: "",
  });
  const [state, setState] = useState<FormState>({ status: "idle" });
  const secretsByKind = new Map(secrets.map((secret) => [secret.kind, secret]));
  const configuredCount = readiness.requirements.filter(
    (requirement) => requirement.status === "ready",
  ).length;

  async function saveModel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!selectedModel.trim()) {
      setState({ status: "error", message: "Select an OpenRouter model." });
      return;
    }

    setState({ status: "submitting" });

    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelProvider: "openrouter",
          modelName: selectedModel.trim(),
        }),
      });

      if (!response.ok) {
        setState({ status: "error", message: await safeFailureMessage(response) });
        return;
      }

      setState({ status: "success", message: "Hermes model saved." });
      router.refresh();
    } catch {
      setState({ status: "error", message: "Hermes model could not be saved." });
    }
  }

  async function saveSecret(kind: keyof SecretDrafts) {
    const value = secretDrafts[kind].trim();

    if (!value) {
      setState({ status: "error", message: "Enter a value before saving this secret." });
      return;
    }

    setState({ status: "submitting" });

    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/secrets`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, value }),
      });

      if (!response.ok) {
        setState({ status: "error", message: await safeFailureMessage(response) });
        return;
      }

      setSecretDrafts((current) => ({ ...current, [kind]: "" }));
      setState({ status: "success", message: "Secret status updated." });
      router.refresh();
    } catch {
      setState({ status: "error", message: "Secret status could not be updated." });
    }
  }

  async function revokeSecret(kind: AgentSecretKind) {
    setState({ status: "submitting" });

    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/secrets`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind }),
      });

      if (!response.ok) {
        setState({ status: "error", message: await safeFailureMessage(response) });
        return;
      }

      setState({ status: "success", message: "Secret revoked." });
      router.refresh();
    } catch {
      setState({ status: "error", message: "Secret could not be revoked." });
    }
  }

  async function generateApiServerKey() {
    setState({ status: "submitting" });

    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}/secrets`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "api_server_key", generate: true }),
      });

      if (!response.ok) {
        setState({ status: "error", message: await safeFailureMessage(response) });
        return;
      }

      setState({ status: "success", message: "Agent API server key generated." });
      router.refresh();
    } catch {
      setState({ status: "error", message: "Agent API server key could not be generated." });
    }
  }

  const submitting = state.status === "submitting";
  const apiServerKey = secretsByKind.get("api_server_key");

  return (
    <section className="hermes-setup-panel" aria-labelledby="hermes-setup-title">
      <div className="section-heading">
        <h2 id="hermes-setup-title">Hermes setup</h2>
        <span>
          {configuredCount}/{readiness.requirements.length} ready
        </span>
      </div>
      <div className="hermes-readiness-grid">
        <ol className="hermes-readiness-list" aria-label="Hermes start readiness">
          {readiness.requirements.map((requirement) => (
            <li data-status={requirement.status} key={requirement.id}>
              <span aria-hidden="true" />
              <div>
                <strong>{requirement.label}</strong>
                <p>{requirement.message}</p>
                {requirement.updatedAt ? (
                  <time dateTime={requirement.updatedAt}>{requirement.updatedAt}</time>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
        <div className="hermes-setup-actions">
          <form className="agent-form hermes-model-form" onSubmit={saveModel}>
            <div className="field-group">
              <label htmlFor="hermes-model">OpenRouter model</label>
              <select
                id="hermes-model"
                value={selectedModel === "not_configured" ? "" : selectedModel}
                onChange={(event) => setSelectedModel(event.currentTarget.value)}
              >
                <option value="">Select a model</option>
                {modelOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label} · {option.context}
                  </option>
                ))}
              </select>
              <p className="field-hint">
                Saved provider: {modelProvider === "openrouter" ? "OpenRouter" : "not configured"}
              </p>
            </div>
            <button className="secondary-button" disabled={submitting} type="submit">
              Save model
            </button>
          </form>
          <div className="hermes-secret-list">
            {USER_SECRET_FIELDS.map((field) => {
              const secret = secretsByKind.get(field.kind);
              const configured = secret?.configured === true;

              return (
                <div className="hermes-secret-row" key={field.kind}>
                  <div>
                    <strong>{field.label}</strong>
                    <p>
                      {configured
                        ? `Configured${secret.updatedAt ? ` ${secret.updatedAt}` : ""}`
                        : "Missing"}
                    </p>
                  </div>
                  <div className="hermes-secret-controls">
                    <input
                      aria-label={field.label}
                      autoComplete={field.autoComplete}
                      placeholder={field.placeholder}
                      type={field.inputType}
                      value={secretDrafts[field.kind]}
                      onChange={(event) =>
                        setSecretDrafts((current) => ({
                          ...current,
                          [field.kind]: event.currentTarget.value,
                        }))
                      }
                    />
                    <button
                      className="secondary-button"
                      disabled={submitting}
                      type="button"
                      onClick={() => saveSecret(field.kind)}
                    >
                      {configured ? "Replace" : "Save"}
                    </button>
                    {configured ? (
                      <button
                        className="secondary-button danger"
                        disabled={submitting}
                        type="button"
                        onClick={() => revokeSecret(field.kind)}
                      >
                        Revoke
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
            <div className="hermes-secret-row">
              <div>
                <strong>Agent API server key</strong>
                <p>
                  {apiServerKey?.configured
                    ? `Generated${apiServerKey.updatedAt ? ` ${apiServerKey.updatedAt}` : ""}`
                    : "Missing"}
                </p>
              </div>
              <button
                className="secondary-button"
                disabled={submitting}
                type="button"
                onClick={generateApiServerKey}
              >
                {apiServerKey?.configured ? "Rotate" : "Generate"}
              </button>
            </div>
          </div>
          {state.status === "error" || state.status === "success" ? (
            <p className={`form-message ${state.status}`} role="status">
              {state.message}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}

async function safeFailureMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: {
        code?: unknown;
        message?: unknown;
        issues?: Array<{ message?: unknown }>;
      };
    };

    if (body.error?.code === "validation_failed") {
      const messages =
        body.error.issues
          ?.map((issue) => (typeof issue.message === "string" ? issue.message : null))
          .filter((message) => message !== null && !looksUnsafe(message)) ?? [];

      return messages.length > 0 ? messages.join(" ") : "Check the setup fields and try again.";
    }

    if (typeof body.error?.message === "string" && !looksUnsafe(body.error.message)) {
      return body.error.message;
    }
  } catch {
    // Keep failures generic when the response body is malformed or not safe JSON.
  }

  return "Hermes setup could not be saved.";
}

function looksUnsafe(message: string): boolean {
  return /(sk-|token=|postgres:\/\/|authorization|bearer|\d{6,}:[A-Za-z0-9_-]{10,})/i.test(message);
}
