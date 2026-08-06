"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, type RefObject, useEffect, useRef, useState } from "react";
import { parseSafeCreate202Body } from "@/src/shared/agent-deployment-presentation";
import {
  type AssistantChoice,
  buildReadyCreateRequest,
  type FieldName,
  type LogicalSubmission,
  type ModelConnectionOption,
} from "./create-agent-form-controller";

type CreateAgentFormProps = {
  maxNameLength: number;
  readyModeEnabled: boolean;
  modelConnections: ModelConnectionOption[];
};

type SubmitState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string; href: string }
  | { status: "error"; message: string; field?: FieldName; definitive: boolean }
  | { status: "ambiguous"; message: string };

export function CreateAgentForm({
  maxNameLength,
  readyModeEnabled,
  modelConnections,
}: CreateAgentFormProps) {
  const router = useRouter();
  const nameRef = useRef<HTMLInputElement | null>(null);
  const modelKeyRef = useRef<HTMLInputElement | null>(null);
  const telegramTokenRef = useRef<HTMLInputElement | null>(null);
  const allowlistRef = useRef<HTMLTextAreaElement | null>(null);
  const statusRef = useRef<HTMLParagraphElement | null>(null);
  const latchRef = useRef(false);
  const logicalSubmissionRef = useRef<LogicalSubmission | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [assistant, setAssistant] = useState<AssistantChoice>(
    modelConnections[0]?.assistant ?? "chatgpt",
  );
  const [state, setState] = useState<SubmitState>({ status: "idle" });
  const selectedConnection = modelConnections.find((item) => item.assistant === assistant);

  useEffect(() => setHydrated(true), []);

  useEffect(() => {
    if (state.status === "error" && state.field) {
      focusField(state.field, { nameRef, modelKeyRef, telegramTokenRef, allowlistRef });
    }

    if (state.status === "success") {
      statusRef.current?.focus();
    }
  }, [state]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (latchRef.current) return;

    const data = new FormData(event.currentTarget);
    const prepared = buildReadyCreateRequest({
      availableConnections: modelConnections,
      createIdempotencyKey: () => crypto.randomUUID().toLowerCase(),
      currentSubmission: logicalSubmissionRef.current,
      form: {
        name: String(data.get("name") ?? ""),
        assistant,
        modelApiKey: modelKeyRef.current?.value ?? "",
        telegramBotToken: telegramTokenRef.current?.value ?? "",
        telegramAllowedUserIds: allowlistRef.current?.value ?? "",
      },
      maxNameLength,
      readyModeEnabled,
    });

    if (!prepared.ok) {
      setState({
        status: "error",
        message: prepared.message,
        field: prepared.field,
        definitive: true,
      });
      return;
    }

    logicalSubmissionRef.current = prepared.nextSubmission;
    latchRef.current = true;
    setState({ status: "submitting" });

    try {
      const response = await fetch("/api/agents", {
        method: "POST",
        credentials: "same-origin",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(prepared.payload),
      });

      await handleReadyResponse(response);
    } catch {
      lockSubmission();
      setState({
        status: "ambiguous",
        message: "Creation response was interrupted. Retry the same submission or start over.",
      });
    } finally {
      clearCredentialFields();
      latchRef.current = false;
    }
  }

  async function handleReadyResponse(response: Response) {
    if (response.status !== 202) {
      const failure = await safeCreateFailureMessage(response);
      const definitive = [400, 409, 503].includes(response.status);

      if (definitive) {
        releaseSubmission();
        setState(errorState(failure.message, true, failure.field));
      } else {
        lockSubmission();
        setState({
          status: "ambiguous",
          message: "Creation response was interrupted. Retry the same submission or start over.",
        });
      }
      return;
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      lockSubmission();
      setState({
        status: "ambiguous",
        message: "Creation was accepted. Retry to confirm it safely.",
      });
      return;
    }

    const parsed = parseSafeCreate202Body(body);
    if (!parsed.ok) {
      lockSubmission();
      setState({
        status: "ambiguous",
        message: "Creation was accepted. Retry to confirm it safely.",
      });
      return;
    }

    logicalSubmissionRef.current = null;
    const href = `/agents/${encodeURIComponent(parsed.agentId)}`;
    setState({ status: "success", message: "Your agent is being set up.", href });
    window.setTimeout(() => router.replace(href), 750);
  }

  function clearCredentialFields() {
    if (modelKeyRef.current) modelKeyRef.current.value = "";
    if (telegramTokenRef.current) telegramTokenRef.current.value = "";
    if (allowlistRef.current) allowlistRef.current.value = "";
  }

  function lockSubmission() {
    if (logicalSubmissionRef.current) {
      logicalSubmissionRef.current = { ...logicalSubmissionRef.current, envelopeLocked: true };
    }
  }

  function releaseSubmission() {
    if (logicalSubmissionRef.current) {
      logicalSubmissionRef.current = { ...logicalSubmissionRef.current, envelopeLocked: false };
    }
  }

  function startOver() {
    logicalSubmissionRef.current = null;
    clearCredentialFields();
    setState({ status: "idle" });
    nameRef.current?.focus();
  }

  const submitting = state.status === "submitting";
  const disabled = !hydrated || submitting || !readyModeEnabled || modelConnections.length === 0;
  const locked =
    state.status === "ambiguous" && logicalSubmissionRef.current?.envelopeLocked === true;

  return (
    <form
      className="agent-form one-click-agent-form"
      onSubmit={handleSubmit}
      aria-busy={submitting}
    >
      {!readyModeEnabled ? (
        <div className="safe-notice">Agent setup is temporarily unavailable.</div>
      ) : null}

      <div className="field-group">
        <label htmlFor="agent-name">What should we call your agent?</label>
        <input
          id="agent-name"
          name="name"
          type="text"
          required
          maxLength={maxNameLength}
          autoComplete="off"
          placeholder="My research assistant"
          readOnly={locked}
          ref={nameRef}
          aria-describedby={fieldDescribedBy("agent-name-hint", "name", state)}
          aria-invalid={fieldHasError("name", state)}
        />
        <p className="form-helper" id="agent-name-hint">
          Choose any friendly name.
        </p>
        <FieldError field="name" state={state} />
      </div>

      <AssistantConnectionFields
        assistant={assistant}
        locked={locked}
        modelConnections={modelConnections}
        modelKeyRef={modelKeyRef}
        onAssistantChange={setAssistant}
        selectedConnection={selectedConnection}
        state={state}
      />

      <TelegramConnectionFields
        allowlistRef={allowlistRef}
        state={state}
        telegramTokenRef={telegramTokenRef}
      />

      <div className="one-click-summary">
        <strong>We handle the rest</strong>
        <span>
          Cloud setup, model configuration, secure storage, launch, and health checks happen
          automatically.
        </span>
      </div>

      <div className="agent-creation-actions">
        {state.status === "ambiguous" ? (
          <>
            <button className="primary-button" type="submit" disabled={disabled}>
              Retry same setup
            </button>
            <button className="secondary-button" type="button" onClick={startOver}>
              Start over
            </button>
          </>
        ) : (
          <button className="primary-button" type="submit" disabled={disabled}>
            {submitting ? "Setting up your agent…" : "Create my agent"}
          </button>
        )}
        {state.status === "error" || state.status === "success" || state.status === "ambiguous" ? (
          <p
            className={`form-message ${state.status === "error" ? "error" : "success"}`}
            role={state.status === "error" ? "alert" : "status"}
            tabIndex={state.status === "success" ? -1 : undefined}
            ref={statusRef}
          >
            {state.message}
            {state.status === "success" ? (
              <>
                {" "}
                <Link href={state.href}>Open agent</Link>
              </>
            ) : null}
          </p>
        ) : null}
      </div>
    </form>
  );
}

function AssistantConnectionFields({
  assistant,
  locked,
  modelConnections,
  modelKeyRef,
  onAssistantChange,
  selectedConnection,
  state,
}: {
  assistant: AssistantChoice;
  locked: boolean;
  modelConnections: ModelConnectionOption[];
  modelKeyRef: RefObject<HTMLInputElement | null>;
  onAssistantChange: (assistant: AssistantChoice) => void;
  selectedConnection: ModelConnectionOption | undefined;
  state: SubmitState;
}) {
  return (
    <>
      <fieldset className="assistant-choice-fieldset">
        <legend>Choose your assistant</legend>
        <div className="assistant-choice-list">
          {modelConnections.map((connection) => (
            <label
              className="assistant-choice-card"
              data-selected={assistant === connection.assistant}
              key={connection.assistant}
            >
              <input
                type="radio"
                name="assistant"
                value={connection.assistant}
                checked={assistant === connection.assistant}
                disabled={locked}
                onChange={() => {
                  onAssistantChange(connection.assistant);
                  if (modelKeyRef.current) modelKeyRef.current.value = "";
                }}
              />
              <span>
                <strong>{connection.displayName}</strong>
                <small>
                  {connection.status === "connected" ? "Connected — ready to use" : "Connect once"}
                </small>
              </span>
              <span className="connection-status" data-status={connection.status}>
                {connection.status === "connected" ? "Connected" : "Setup needed"}
              </span>
            </label>
          ))}
        </div>
        <FieldError field="assistant" state={state} />
      </fieldset>

      {selectedConnection?.status === "action_required" ? (
        <div className="field-group connection-key-field">
          <label htmlFor="model-api-key">{selectedConnection.credentialLabel}</label>
          <input
            id="model-api-key"
            name="modelApiKey"
            type="password"
            autoComplete="off"
            spellCheck={false}
            ref={modelKeyRef}
            aria-describedby={fieldDescribedBy("model-api-key-hint", "modelApiKey", state)}
            aria-invalid={fieldHasError("modelApiKey", state)}
          />
          <p className="form-helper" id="model-api-key-hint">
            <a
              href={selectedConnection.credentialHelpUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              Get your key
            </a>
            . {selectedConnection.credentialBillingNote} We encrypt it and reuse it only for your
            agents.
          </p>
          <FieldError field="modelApiKey" state={state} />
        </div>
      ) : null}
    </>
  );
}

function TelegramConnectionFields({
  allowlistRef,
  state,
  telegramTokenRef,
}: {
  allowlistRef: RefObject<HTMLTextAreaElement | null>;
  state: SubmitState;
  telegramTokenRef: RefObject<HTMLInputElement | null>;
}) {
  return (
    <fieldset className="ready-credential-fieldset">
      <legend>Connect Telegram</legend>
      <div className="field-group">
        <label htmlFor="telegram-bot-token">Bot token</label>
        <input
          id="telegram-bot-token"
          name="telegramBotToken"
          type="password"
          autoComplete="off"
          spellCheck={false}
          ref={telegramTokenRef}
          aria-describedby={fieldDescribedBy("telegram-bot-token-hint", "telegramBotToken", state)}
          aria-invalid={fieldHasError("telegramBotToken", state)}
        />
        <p className="form-helper" id="telegram-bot-token-hint">
          Open{" "}
          <a href="https://t.me/BotFather" target="_blank" rel="noreferrer noopener">
            BotFather
          </a>
          , create a bot, then paste the token it gives you.
        </p>
        <FieldError field="telegramBotToken" state={state} />
      </div>
      <div className="field-group">
        <label htmlFor="telegram-allowed-user-ids">Who may use this bot?</label>
        <textarea
          id="telegram-allowed-user-ids"
          name="telegramAllowedUserIds"
          rows={3}
          autoComplete="off"
          spellCheck={false}
          placeholder="Your Telegram numeric user ID"
          ref={allowlistRef}
          aria-describedby={fieldDescribedBy(
            "telegram-allowed-user-ids-hint",
            "telegramAllowedUserIds",
            state,
          )}
          aria-invalid={fieldHasError("telegramAllowedUserIds", state)}
        />
        <p className="form-helper" id="telegram-allowed-user-ids-hint">
          Enter one numeric user ID per line. This keeps the bot private.
        </p>
        <FieldError field="telegramAllowedUserIds" state={state} />
      </div>
    </fieldset>
  );
}

async function safeCreateFailureMessage(
  response: Response,
): Promise<{ message: string; field?: FieldName }> {
  try {
    const body: unknown = await response.json();
    const code = isRecord(body) && isRecord(body.error) ? body.error.code : null;
    const issues = isRecord(body) && isRecord(body.error) ? body.error.issues : null;
    if (code === "validation_failed") {
      const field = Array.isArray(issues) ? fixedIssueField(issues) : undefined;
      return {
        message: field ? fixedFieldMessage(field) : "Check the highlighted fields.",
        ...(field ? { field } : {}),
      };
    }
    if (code === "telegram_bot_in_use")
      return { message: "That Telegram bot is already used by another active agent." };
    if (code === "telegram_validation_unavailable")
      return { message: "Telegram is temporarily unavailable. Try again shortly." };
    if (code === "ready_agent_creation_disabled" || code === "ready_agent_creation_invalid_config")
      return { message: "Agent setup is temporarily unavailable." };
    if (code === "database_unavailable" || code === "database_schema_missing")
      return { message: "The service is temporarily unavailable." };
  } catch {
    // Untrusted or malformed responses never reach the page.
  }
  return { message: "Agent could not be created. Please try again." };
}

function fixedIssueField(issues: unknown[]): FieldName | undefined {
  for (const issue of issues) {
    if (isRecord(issue) && typeof issue.field === "string" && isFieldName(issue.field))
      return issue.field;
  }
  return undefined;
}

function fixedFieldMessage(field: FieldName): string {
  return {
    name: "Name is required.",
    assistant: "Choose ChatGPT or Claude.",
    modelApiKey: "A valid API key is required the first time you connect this assistant.",
    telegramBotToken: "Telegram bot token is required.",
    telegramAllowedUserIds: "Telegram user IDs must be canonical decimal strings.",
  }[field];
}

function focusField(
  field: FieldName,
  refs: {
    nameRef: RefObject<HTMLInputElement | null>;
    modelKeyRef: RefObject<HTMLInputElement | null>;
    telegramTokenRef: RefObject<HTMLInputElement | null>;
    allowlistRef: RefObject<HTMLTextAreaElement | null>;
  },
) {
  if (field === "name") refs.nameRef.current?.focus();
  if (field === "modelApiKey") refs.modelKeyRef.current?.focus();
  if (field === "telegramBotToken") refs.telegramTokenRef.current?.focus();
  if (field === "telegramAllowedUserIds") refs.allowlistRef.current?.focus();
}

function errorState(
  message: string,
  definitive: boolean,
  field?: FieldName,
): Extract<SubmitState, { status: "error" }> {
  return { status: "error", message, definitive, ...(field ? { field } : {}) };
}

function fieldHasError(field: FieldName, state: SubmitState): boolean | undefined {
  return state.status === "error" && state.field === field ? true : undefined;
}

function fieldDescribedBy(
  hintId: string | undefined,
  field: FieldName,
  state: SubmitState,
): string | undefined {
  const ids = hintId ? [hintId] : [];
  if (state.status === "error" && state.field === field) ids.push(`agent-create-${field}-error`);
  return ids.join(" ") || undefined;
}

function FieldError({ field, state }: { field: FieldName; state: SubmitState }) {
  if (state.status !== "error" || state.field !== field) return null;
  return (
    <p className="form-helper error" id={`agent-create-${field}-error`}>
      {state.message}
    </p>
  );
}

function isFieldName(value: string): value is FieldName {
  return [
    "name",
    "assistant",
    "modelApiKey",
    "telegramBotToken",
    "telegramAllowedUserIds",
  ].includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
