"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type ChangeEvent,
  type FormEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { AgentTemplateSnapshot } from "@/src/server/agents/templates";
import { parseSafeCreate202Body } from "@/src/shared/agent-deployment-presentation";
import { parseCanonicalTelegramAllowlist } from "@/src/shared/telegram-allowlist";

type CreateAgentFormProps = {
  maxNameLength: number;
  readyModeEnabled: boolean;
  openrouterModels: Array<{
    id: string;
    displayName: string;
  }>;
  runners: Array<{
    id: string;
    name: string;
    kind: "manual_vps" | "digitalocean";
    status: "online";
    detail: string;
  }>;
  templates: AgentTemplateSnapshot[];
};

type FormMode = "ready" | "manual";
export type FieldName =
  | "name"
  | "templateKey"
  | "runnerId"
  | "openrouterModel"
  | "openrouterApiKey"
  | "telegramBotToken"
  | "telegramAllowedUserIds";

type SubmitState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string; href: string }
  | {
      status: "error";
      message: string;
      field?: FieldName;
      definitive: boolean;
    }
  | { status: "ambiguous"; message: string };

export type ReadyEnvelope = {
  name: string;
  templateKey: string;
  runnerId: string | null;
  openrouterModel: string;
};

export type LogicalSubmission = {
  idempotencyKey: string;
  envelope: ReadyEnvelope;
  envelopeLocked: boolean;
};

const EMPTY_TEMPLATE_KEY = "research_agent";
export const READY_SECRET_FIELD_NAMES = [
  "openrouterApiKey",
  "telegramBotToken",
  "telegramAllowedUserIds",
] as const;

export function CreateAgentForm({
  maxNameLength,
  readyModeEnabled,
  openrouterModels,
  runners,
  templates,
}: CreateAgentFormProps) {
  const router = useRouter();
  const nameRef = useRef<HTMLInputElement | null>(null);
  const modelRef = useRef<HTMLSelectElement | null>(null);
  const openrouterKeyRef = useRef<HTMLInputElement | null>(null);
  const telegramTokenRef = useRef<HTMLInputElement | null>(null);
  const allowlistRef = useRef<HTMLTextAreaElement | null>(null);
  const statusRef = useRef<HTMLParagraphElement | null>(null);
  const latchRef = useRef(false);
  const logicalSubmissionRef = useRef<LogicalSubmission | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [mode, setMode] = useState<FormMode>(readyModeEnabled ? "ready" : "manual");
  const [state, setState] = useState<SubmitState>({ status: "idle" });
  const [selectedTemplateKey, setSelectedTemplateKey] = useState<string>(
    templates[0]?.key ?? EMPTY_TEMPLATE_KEY,
  );
  const selectedTemplate =
    templates.find((template) => template.key === selectedTemplateKey) ?? templates[0];

  useEffect(() => {
    setHydrated(true);
  }, []);

  const focusField = useCallback((field: FieldName) => {
    if (field === "name") {
      nameRef.current?.focus();
    } else if (field === "openrouterModel") {
      modelRef.current?.focus();
    } else if (field === "openrouterApiKey") {
      openrouterKeyRef.current?.focus();
    } else if (field === "telegramBotToken") {
      telegramTokenRef.current?.focus();
    } else if (field === "telegramAllowedUserIds") {
      allowlistRef.current?.focus();
    }
  }, []);

  useEffect(() => {
    if (state.status === "error" && state.field) {
      focusField(state.field);
    }

    if (state.status === "success") {
      statusRef.current?.focus();
    }
  }, [focusField, state]);

  function handleTemplateChange(event: ChangeEvent<HTMLSelectElement>) {
    setSelectedTemplateKey(event.target.value);
  }

  function handleModeChange(nextMode: FormMode) {
    clearCredentialFields();
    logicalSubmissionRef.current = null;
    setMode(nextMode);
    setState({ status: "idle" });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (latchRef.current) {
      return;
    }

    const form = event.currentTarget;
    const prepared =
      mode === "ready" ? prepareReadyRequest(form) : prepareManualRequest(new FormData(form));

    if (!prepared.ok) {
      setState({
        status: "error",
        message: prepared.message,
        field: prepared.field,
        definitive: true,
      });
      return;
    }

    latchRef.current = true;
    setState({ status: "submitting" });

    try {
      const response = await fetch("/api/agents", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(prepared.payload),
      });

      if (mode === "ready") {
        await handleReadyResponse(response);
      } else {
        await handleManualResponse(response);
      }
    } catch {
      lockCurrentLogicalSubmission();
      setState({
        status: "ambiguous",
        message: "Creation response was interrupted. Retry the same submission or start over.",
      });
    } finally {
      clearCredentialFields();
      latchRef.current = false;
    }
  }

  function prepareReadyRequest(form: HTMLFormElement):
    | {
        ok: true;
        payload: {
          name: string;
          templateKey: string;
          runnerId: string | null;
          launchMode: "ready";
          idempotencyKey: string;
          openrouterModel: string;
          openrouterApiKey: string;
          telegramBotToken: string;
          telegramAllowedUserIds: string[];
        };
      }
    | { ok: false; message: string; field: FieldName } {
    const formData = new FormData(form);
    const prepared = buildReadyCreateRequest({
      approvedModelIds: openrouterModels.map((model) => model.id),
      createIdempotencyKey: () => crypto.randomUUID().toLowerCase(),
      currentSubmission: logicalSubmissionRef.current,
      form: {
        name: String(formData.get("name") ?? ""),
        templateKey: String(formData.get("templateKey") ?? ""),
        runnerId: String(formData.get("runnerId") ?? ""),
        openrouterModel: String(formData.get("openrouterModel") ?? ""),
        openrouterApiKey: openrouterKeyRef.current?.value ?? "",
        telegramBotToken: telegramTokenRef.current?.value ?? "",
        telegramAllowedUserIds: allowlistRef.current?.value ?? "",
      },
      maxNameLength,
      readyModeEnabled,
      runnerIds: runners.map((runner) => runner.id),
      templateKeys: templates.map((template) => template.key),
    });

    if (!prepared.ok) {
      return {
        ok: false,
        message: prepared.message,
        field: prepared.field,
      };
    }

    logicalSubmissionRef.current = prepared.nextSubmission;

    return {
      ok: true,
      payload: prepared.payload,
    };
  }

  function prepareManualRequest(
    formData: FormData,
  ):
    | { ok: true; payload: { name: string; templateKey: string; runnerId: string | null } }
    | { ok: false; message: string; field: FieldName } {
    const common = readCommonEnvelope(formData);

    if (!common.ok) {
      return common;
    }

    logicalSubmissionRef.current = null;

    return {
      ok: true,
      payload: {
        name: common.name,
        templateKey: common.templateKey,
        runnerId: common.runnerId,
      },
    };
  }

  function readCommonEnvelope(formData: FormData):
    | {
        ok: true;
        name: string;
        templateKey: string;
        runnerId: string | null;
      }
    | { ok: false; message: string; field: FieldName } {
    const name = String(formData.get("name") ?? "").trim();
    const templateKey = String(formData.get("templateKey") ?? "");
    const runnerId = String(formData.get("runnerId") ?? "").trim();

    if (name.length === 0) {
      return { ok: false, message: "Name is required.", field: "name" };
    }

    if (name.length > maxNameLength) {
      return {
        ok: false,
        message: `Name must be ${maxNameLength} characters or fewer.`,
        field: "name",
      };
    }

    if (!templates.some((template) => template.key === templateKey)) {
      return {
        ok: false,
        message: "Choose a supported template.",
        field: "templateKey",
      };
    }

    if (runnerId.length > 0 && !runners.some((runner) => runner.id === runnerId)) {
      return {
        ok: false,
        message: "Runner could not be assigned. Refresh runners and try again.",
        field: "runnerId",
      };
    }

    return {
      ok: true,
      name,
      templateKey,
      runnerId: runnerId || null,
    };
  }

  async function handleReadyResponse(response: Response) {
    if (response.status !== 202) {
      const failure = await safeCreateFailureMessage(response);
      const definitive = [400, 409, 503].includes(response.status);

      if (definitive) {
        releaseCurrentLogicalSubmission();
        setState(errorState(failure.message, true, failure.field));
      } else {
        lockCurrentLogicalSubmission();
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
      lockCurrentLogicalSubmission();
      setState({
        status: "ambiguous",
        message: "Creation response was interrupted. Retry the same submission or start over.",
      });
      return;
    }

    const parsed = parseSafeCreate202Body(body);

    if (!parsed.ok) {
      lockCurrentLogicalSubmission();
      setState({
        status: "ambiguous",
        message: "Creation response was interrupted. Retry the same submission or start over.",
      });
      return;
    }

    logicalSubmissionRef.current = null;
    const href = `/agents/${encodeURIComponent(parsed.agentId)}`;
    setState({ status: "success", message: "Creation accepted.", href });
    window.setTimeout(() => {
      router.replace(href);
    }, 750);
  }

  async function handleManualResponse(response: Response) {
    if (response.status !== 201) {
      const failure = await safeCreateFailureMessage(response);
      setState(errorState(failure.message, true, failure.field));
      return;
    }

    let body: unknown;

    try {
      body = await response.json();
    } catch {
      setState({
        status: "error",
        message: "Agent was created, but the response could not be opened safely.",
        definitive: true,
      });
      router.refresh();
      return;
    }

    const href = parseManualCreatedHref(body);

    if (!href) {
      setState({
        status: "error",
        message: "Agent was created, but the response could not be opened safely.",
        definitive: true,
      });
      router.refresh();
      return;
    }

    setState({ status: "success", message: "Manual agent created.", href });
    router.replace(href);
  }

  function startOver() {
    logicalSubmissionRef.current = null;
    clearCredentialFields();
    setState({ status: "idle" });
    nameRef.current?.focus();
  }

  function clearCredentialFields() {
    if (openrouterKeyRef.current) {
      openrouterKeyRef.current.value = "";
    }

    if (telegramTokenRef.current) {
      telegramTokenRef.current.value = "";
    }

    if (allowlistRef.current) {
      allowlistRef.current.value = "";
    }
  }

  function lockCurrentLogicalSubmission() {
    if (logicalSubmissionRef.current) {
      logicalSubmissionRef.current = {
        ...logicalSubmissionRef.current,
        envelopeLocked: true,
      };
    }
  }

  function releaseCurrentLogicalSubmission() {
    if (logicalSubmissionRef.current) {
      logicalSubmissionRef.current = {
        ...logicalSubmissionRef.current,
        envelopeLocked: false,
      };
    }
  }

  const submitting = state.status === "submitting";
  const disabled = !hydrated || submitting;
  const readyAvailable = readyModeEnabled && openrouterModels.length > 0;
  const sameSubmissionLocked =
    mode === "ready" &&
    state.status === "ambiguous" &&
    logicalSubmissionRef.current?.envelopeLocked === true;

  return (
    <form className="agent-form" onSubmit={handleSubmit} aria-busy={submitting}>
      <fieldset className="agent-create-mode-fieldset">
        <legend>Creation mode</legend>
        {readyAvailable ? (
          <div className="segmented-control">
            <button
              type="button"
              className={mode === "ready" ? "selected" : ""}
              aria-pressed={mode === "ready"}
              onClick={() => handleModeChange("ready")}
            >
              Automatic setup
            </button>
            <button
              type="button"
              className={mode === "manual" ? "selected" : ""}
              aria-pressed={mode === "manual"}
              onClick={() => handleModeChange("manual")}
            >
              Manual
            </button>
          </div>
        ) : (
          <div className="safe-notice">Automatic setup is unavailable.</div>
        )}
      </fieldset>

      <div className="agent-creation-fields">
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
            aria-describedby={fieldDescribedBy("agent-name-hint", "name", state)}
            aria-invalid={fieldHasError("name", state)}
            readOnly={sameSubmissionLocked}
            ref={nameRef}
          />
          <p className="form-helper" id="agent-name-hint">
            Use a short name for this persisted agent.
          </p>
          <FieldError field="name" state={state} />
        </div>
        <div className="field-group">
          <label htmlFor="agent-template">Template</label>
          <select
            id="agent-template"
            name="templateKey"
            onChange={handleTemplateChange}
            value={selectedTemplateKey}
            disabled={sameSubmissionLocked}
            aria-describedby={fieldDescribedBy(undefined, "templateKey", state)}
            aria-invalid={fieldHasError("templateKey", state)}
          >
            {templates.map((template) => (
              <option key={template.key} value={template.key}>
                {template.name}
              </option>
            ))}
          </select>
          <FieldError field="templateKey" state={state} />
        </div>
        {mode === "ready" && readyAvailable ? (
          <ReadyCredentialFields
            allowlistRef={allowlistRef}
            errorState={state}
            locked={sameSubmissionLocked}
            modelRef={modelRef}
            models={openrouterModels}
            openrouterKeyRef={openrouterKeyRef}
            telegramTokenRef={telegramTokenRef}
          />
        ) : null}
        {runners.length > 0 ? (
          <details className="advanced-runner-select">
            <summary>Advanced runner selection</summary>
            <div className="field-group">
              <label htmlFor="agent-runner">Runner</label>
              <select
                id="agent-runner"
                name="runnerId"
                defaultValue=""
                disabled={sameSubmissionLocked}
                aria-describedby={fieldDescribedBy(undefined, "runnerId", state)}
                aria-invalid={fieldHasError("runnerId", state)}
              >
                <option value="">No runner</option>
                {runners.map((runner) => (
                  <option key={runner.id} value={runner.id}>
                    {runner.name} / {runner.kind} / {runner.status} / {runner.detail}
                  </option>
                ))}
              </select>
              <FieldError field="runnerId" state={state} />
            </div>
          </details>
        ) : null}
      </div>

      <div className="agent-template-workspace">
        {selectedTemplate ? <SelectedTemplateSummary selectedTemplate={selectedTemplate} /> : null}
        <TemplateCatalogue selectedTemplateKey={selectedTemplateKey} templates={templates} />
      </div>

      <div className="agent-creation-actions">
        {state.status === "ambiguous" ? (
          <>
            <button className="primary-button" type="submit" disabled={disabled}>
              Retry same submission
            </button>
            <button className="secondary-button" type="button" onClick={startOver}>
              Start over
            </button>
          </>
        ) : (
          <button className="primary-button" type="submit" disabled={disabled}>
            {submitting
              ? "Creating"
              : mode === "ready" && readyAvailable
                ? "Create and set up"
                : "Create agent"}
          </button>
        )}
        {state.status === "error" || state.status === "success" || state.status === "ambiguous" ? (
          <p
            className={`form-message ${state.status === "error" ? "error" : "success"}`}
            role={state.status === "error" && !state.definitive ? "alert" : "status"}
            tabIndex={state.status === "success" ? -1 : undefined}
            ref={statusRef}
          >
            {state.message}
            {state.status === "success" ? (
              <>
                {" "}
                <Link href={state.href}>Open agent detail</Link>
              </>
            ) : null}
          </p>
        ) : null}
      </div>
    </form>
  );
}

function ReadyCredentialFields({
  allowlistRef,
  errorState,
  locked,
  modelRef,
  models,
  openrouterKeyRef,
  telegramTokenRef,
}: {
  allowlistRef: RefObject<HTMLTextAreaElement | null>;
  errorState: SubmitState;
  locked: boolean;
  modelRef: RefObject<HTMLSelectElement | null>;
  models: Array<{ id: string; displayName: string }>;
  openrouterKeyRef: RefObject<HTMLInputElement | null>;
  telegramTokenRef: RefObject<HTMLInputElement | null>;
}) {
  return (
    <fieldset className="ready-credential-fieldset">
      <legend>Managed provider credentials</legend>
      <div className="field-group">
        <label htmlFor="openrouter-model">Model</label>
        <select
          id="openrouter-model"
          name="openrouterModel"
          ref={modelRef}
          disabled={locked}
          aria-describedby={fieldDescribedBy(undefined, "openrouterModel", errorState)}
          aria-invalid={fieldHasError("openrouterModel", errorState)}
        >
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.displayName}
            </option>
          ))}
        </select>
        <FieldError field="openrouterModel" state={errorState} />
      </div>
      <div className="field-group">
        <label htmlFor="openrouter-api-key">OpenRouter API key</label>
        <input
          id="openrouter-api-key"
          name="openrouterApiKey"
          type="password"
          autoComplete="off"
          spellCheck={false}
          aria-describedby={fieldDescribedBy(
            "openrouter-api-key-hint",
            "openrouterApiKey",
            errorState,
          )}
          aria-invalid={fieldHasError("openrouterApiKey", errorState)}
          ref={openrouterKeyRef}
        />
        <p className="form-helper" id="openrouter-api-key-hint">
          Paste a key for the approved OpenRouter model.
        </p>
        <FieldError field="openrouterApiKey" state={errorState} />
      </div>
      <div className="field-group">
        <label htmlFor="telegram-bot-token">Telegram bot token</label>
        <input
          id="telegram-bot-token"
          name="telegramBotToken"
          type="password"
          autoComplete="off"
          spellCheck={false}
          aria-describedby={fieldDescribedBy(
            "telegram-bot-token-hint",
            "telegramBotToken",
            errorState,
          )}
          aria-invalid={fieldHasError("telegramBotToken", errorState)}
          ref={telegramTokenRef}
        />
        <p className="form-helper" id="telegram-bot-token-hint">
          Create or select a dedicated bot in{" "}
          <a href="https://t.me/BotFather" target="_blank" rel="noreferrer noopener">
            BotFather
          </a>
          , copy its token once, and stop or delete any existing agent before reusing that bot.
        </p>
        <FieldError field="telegramBotToken" state={errorState} />
      </div>
      <div className="field-group field-group-full">
        <label htmlFor="telegram-allowed-user-ids">Telegram allowed user IDs</label>
        <textarea
          id="telegram-allowed-user-ids"
          name="telegramAllowedUserIds"
          autoComplete="off"
          spellCheck={false}
          rows={4}
          aria-describedby={fieldDescribedBy(
            "telegram-allowed-user-ids-hint",
            "telegramAllowedUserIds",
            errorState,
          )}
          aria-invalid={fieldHasError("telegramAllowedUserIds", errorState)}
          ref={allowlistRef}
        />
        <p className="form-helper" id="telegram-allowed-user-ids-hint">
          Enter one decimal user ID per line. Groups, usernames, CSV, wildcard access, and BotFather
          automation are unsupported.
        </p>
        <FieldError field="telegramAllowedUserIds" state={errorState} />
      </div>
    </fieldset>
  );
}

function SelectedTemplateSummary({
  selectedTemplate,
}: {
  selectedTemplate: AgentTemplateSnapshot;
}) {
  return (
    <section className="selected-template-summary" aria-live="polite">
      <div className="selected-template-heading">
        <div>
          <p>Selected template</p>
          <h3>{selectedTemplate.name}</h3>
        </div>
        <span>{selectedTemplate.version}</span>
      </div>
      <p>{selectedTemplate.description}</p>
      <dl className="template-metadata-list selected-template-metadata">
        <div>
          <dt>Schedule</dt>
          <dd>
            {formatList(selectedTemplate.defaultSchedule ? [selectedTemplate.defaultSchedule] : [])}
          </dd>
        </div>
        <div>
          <dt>Required integrations</dt>
          <dd>{formatList(selectedTemplate.requiredIntegrations)}</dd>
        </div>
      </dl>
      <TemplateToolList tools={selectedTemplate.defaultTools} />
      <details className="template-prompt-details">
        <summary>Default prompt</summary>
        <p>{selectedTemplate.defaultSystemPrompt}</p>
      </details>
    </section>
  );
}

function TemplateCatalogue({
  selectedTemplateKey,
  templates,
}: {
  selectedTemplateKey: string;
  templates: AgentTemplateSnapshot[];
}) {
  return (
    <fieldset className="template-catalogue">
      <legend>Template catalogue</legend>
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
    </fieldset>
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

export type ReadyCreateFormSnapshot = {
  name: string;
  templateKey: string;
  runnerId: string;
  openrouterModel: string;
  openrouterApiKey: string;
  telegramBotToken: string;
  telegramAllowedUserIds: string;
};

export type ReadyCreateRequestResult =
  | {
      ok: true;
      payload: {
        name: string;
        templateKey: string;
        runnerId: string | null;
        launchMode: "ready";
        idempotencyKey: string;
        openrouterModel: string;
        openrouterApiKey: string;
        telegramBotToken: string;
        telegramAllowedUserIds: string[];
      };
      nextSubmission: LogicalSubmission;
      credentialFieldNames: typeof READY_SECRET_FIELD_NAMES;
    }
  | { ok: false; message: string; field: FieldName };

export function buildReadyCreateRequest(input: {
  approvedModelIds: string[];
  createIdempotencyKey: () => string;
  currentSubmission: LogicalSubmission | null;
  form: ReadyCreateFormSnapshot;
  maxNameLength: number;
  readyModeEnabled: boolean;
  runnerIds: string[];
  templateKeys: string[];
}): ReadyCreateRequestResult {
  if (!input.readyModeEnabled || input.approvedModelIds.length === 0) {
    return {
      ok: false,
      message: "Automatic setup is unavailable.",
      field: "openrouterModel",
    };
  }

  const openrouterApiKey = input.form.openrouterApiKey.trim();
  const telegramBotToken = input.form.telegramBotToken.trim();
  const allowlist = parseTelegramAllowlistInput(input.form.telegramAllowedUserIds);
  let envelope: ReadyEnvelope;

  if (input.currentSubmission?.envelopeLocked) {
    envelope = input.currentSubmission.envelope;
  } else {
    const common = readCommonEnvelopeSnapshot({
      form: input.form,
      maxNameLength: input.maxNameLength,
      runnerIds: input.runnerIds,
      templateKeys: input.templateKeys,
    });

    if (!common.ok) {
      return common;
    }

    const model = input.form.openrouterModel.trim();

    if (!input.approvedModelIds.includes(model)) {
      return { ok: false, message: "Choose an approved model.", field: "openrouterModel" };
    }

    envelope = {
      name: common.name,
      templateKey: common.templateKey,
      runnerId: common.runnerId,
      openrouterModel: model,
    };
  }

  if (openrouterApiKey.length === 0) {
    return {
      ok: false,
      message: "OpenRouter API key is required.",
      field: "openrouterApiKey",
    };
  }

  if (telegramBotToken.length === 0) {
    return {
      ok: false,
      message: "Telegram bot token is required.",
      field: "telegramBotToken",
    };
  }

  if (!allowlist.ok) {
    return allowlist;
  }

  const idempotencyKey =
    input.currentSubmission?.idempotencyKey ?? input.createIdempotencyKey().toLowerCase();
  const nextSubmission: LogicalSubmission = {
    idempotencyKey,
    envelope,
    envelopeLocked: input.currentSubmission?.envelopeLocked ?? false,
  };

  return {
    ok: true,
    credentialFieldNames: READY_SECRET_FIELD_NAMES,
    nextSubmission,
    payload: {
      name: envelope.name,
      templateKey: envelope.templateKey,
      runnerId: envelope.runnerId,
      launchMode: "ready",
      idempotencyKey,
      openrouterModel: envelope.openrouterModel,
      openrouterApiKey,
      telegramBotToken,
      telegramAllowedUserIds: allowlist.values,
    },
  };
}

export function buildManualCreateRequest(input: {
  form: Pick<ReadyCreateFormSnapshot, "name" | "templateKey" | "runnerId">;
  maxNameLength: number;
  runnerIds: string[];
  templateKeys: string[];
}):
  | { ok: true; payload: { name: string; templateKey: string; runnerId: string | null } }
  | { ok: false; message: string; field: FieldName } {
  const common = readCommonEnvelopeSnapshot(input);

  if (!common.ok) {
    return common;
  }

  return {
    ok: true,
    payload: {
      name: common.name,
      templateKey: common.templateKey,
      runnerId: common.runnerId,
    },
  };
}

function readCommonEnvelopeSnapshot(input: {
  form: Pick<ReadyCreateFormSnapshot, "name" | "templateKey" | "runnerId">;
  maxNameLength: number;
  runnerIds: string[];
  templateKeys: string[];
}):
  | {
      ok: true;
      name: string;
      templateKey: string;
      runnerId: string | null;
    }
  | { ok: false; message: string; field: FieldName } {
  const name = input.form.name.trim();
  const templateKey = input.form.templateKey;
  const runnerId = input.form.runnerId.trim();

  if (name.length === 0) {
    return { ok: false, message: "Name is required.", field: "name" };
  }

  if (name.length > input.maxNameLength) {
    return {
      ok: false,
      message: `Name must be ${input.maxNameLength} characters or fewer.`,
      field: "name",
    };
  }

  if (!input.templateKeys.includes(templateKey)) {
    return {
      ok: false,
      message: "Choose a supported template.",
      field: "templateKey",
    };
  }

  if (runnerId.length > 0 && !input.runnerIds.includes(runnerId)) {
    return {
      ok: false,
      message: "Runner could not be assigned. Refresh runners and try again.",
      field: "runnerId",
    };
  }

  return {
    ok: true,
    name,
    templateKey,
    runnerId: runnerId || null,
  };
}

function parseTelegramAllowlistInput(
  value: string,
):
  | { ok: true; values: string[] }
  | { ok: false; message: string; field: "telegramAllowedUserIds" } {
  const result = parseCanonicalTelegramAllowlist(value);

  if (result.ok) {
    return result;
  }

  return {
    ok: false,
    field: "telegramAllowedUserIds",
    message:
      result.reason === "empty" || result.reason === "too_many"
        ? "Enter one to 100 Telegram user IDs."
        : "Telegram user IDs must be canonical decimal strings.",
  };
}

export function parseManualCreatedHref(value: unknown): string | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["agent", "event"]) ||
    !isRecord(value.agent) ||
    !isRecord(value.event) ||
    !hasExactKeys(value.event, ["type"]) ||
    value.event.type !== "agent.created" ||
    !hasSafeManualAgentEnvelope(value.agent) ||
    typeof value.agent.id !== "string"
  ) {
    return null;
  }

  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.agent.id,
    )
  ) {
    return null;
  }

  return `/agents/${encodeURIComponent(value.agent.id)}`;
}

async function safeCreateFailureMessage(response: Response): Promise<{
  message: string;
  field?: FieldName;
}> {
  try {
    const body: unknown = await response.json();
    const code = isRecord(body) && isRecord(body.error) ? body.error.code : null;
    const issues = isRecord(body) && isRecord(body.error) ? body.error.issues : null;

    if (code === "validation_failed") {
      const field = Array.isArray(issues) ? fixedIssueField(issues) : undefined;
      return {
        message: field ? fixedFieldMessage(field) : "Check the request fields.",
        ...(field ? { field } : {}),
      };
    }

    if (code === "telegram_bot_in_use") {
      return { message: "Telegram bot is already assigned to an active agent." };
    }

    if (
      code === "ready_agent_creation_disabled" ||
      code === "ready_agent_creation_invalid_config"
    ) {
      return { message: "Automatic setup is unavailable." };
    }

    if (code === "telegram_validation_unavailable") {
      return { message: "Telegram bot validation is temporarily unavailable." };
    }

    if (code === "runner_not_assignable") {
      return {
        message: "Runner could not be assigned. Refresh runners and try again.",
        field: "runnerId",
      };
    }

    if (code === "database_unavailable") {
      return {
        message: "Database is unavailable. Start Postgres and run migrations, then try again.",
      };
    }

    if (code === "database_schema_missing") {
      return { message: "Database schema is missing. Run migrations, then try again." };
    }
  } catch {
    // Keep user-facing failures generic when the response is not safe validation JSON.
  }

  return { message: "Agent could not be created." };
}

function fixedIssueField(issues: unknown[]): FieldName | undefined {
  for (const issue of issues) {
    if (!isRecord(issue) || typeof issue.field !== "string") {
      continue;
    }

    if (isFieldName(issue.field)) {
      return issue.field;
    }
  }

  return undefined;
}

function errorState(
  message: string,
  definitive: boolean,
  field?: FieldName,
): Extract<SubmitState, { status: "error" }> {
  return {
    status: "error",
    message,
    definitive,
    ...(field ? { field } : {}),
  };
}

function fixedFieldMessage(field: FieldName): string {
  const messages: Record<FieldName, string> = {
    name: "Name is required.",
    templateKey: "Choose a supported template.",
    runnerId: "Runner could not be assigned. Refresh runners and try again.",
    openrouterModel: "Choose an approved model.",
    openrouterApiKey: "OpenRouter API key is required.",
    telegramBotToken: "Telegram bot token is required.",
    telegramAllowedUserIds: "Telegram user IDs must be canonical decimal strings.",
  };

  return messages[field];
}

function fieldHasError(field: FieldName, state: SubmitState): boolean | undefined {
  return state.status === "error" && state.field === field ? true : undefined;
}

function fieldDescribedBy(
  hintId: string | undefined,
  field: FieldName,
  state: SubmitState,
): string | undefined {
  const ids = [hintId];

  if (state.status === "error" && state.field === field) {
    ids.push(fieldErrorId(field));
  }

  return ids.filter((id): id is string => typeof id === "string").join(" ") || undefined;
}

function FieldError({ field, state }: { field: FieldName; state: SubmitState }) {
  if (state.status !== "error" || state.field !== field) {
    return null;
  }

  return (
    <p className="form-helper error" id={fieldErrorId(field)}>
      {state.message}
    </p>
  );
}

function fieldErrorId(field: FieldName): string {
  return `agent-create-${field}-error`;
}

function isFieldName(value: string): value is FieldName {
  return [
    "name",
    "templateKey",
    "runnerId",
    "openrouterModel",
    "openrouterApiKey",
    "telegramBotToken",
    "telegramAllowedUserIds",
  ].includes(value);
}

function hasSafeManualAgentEnvelope(value: Record<string, unknown>): boolean {
  const forbidden = [
    "secret",
    "secrets",
    "idempotencyKey",
    "openrouterApiKey",
    "telegramBotToken",
    "telegramAllowedUserIds",
    "leaseOwner",
    "leaseExpiresAt",
    "runnerOperationId",
    "canaryOutput",
    "errorDetail",
  ];

  return forbidden.every((field) => !(field in value));
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();

  if (keys.length !== expectedKeys.length) {
    return false;
  }

  return keys.every((key, index) => key === expectedKeys[index]);
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "None";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
