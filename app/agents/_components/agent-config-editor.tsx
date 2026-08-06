"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AgentDetailConfigUi } from "@/src/shared/agent-ui-types";

type PersistedAgentConfig = {
  name: string;
  config: AgentDetailConfigUi;
};

type AgentConfigEditorProps = {
  agentId: string;
  maxNameLength: number;
  persisted: PersistedAgentConfig;
};

type DraftConfig = {
  name: string;
  systemPrompt: string;
  modelProvider: string;
  modelName: string;
  maxDailySpend: string;
  scheduleMode: "manual" | "cron";
  scheduleCron: string;
  timezone: string;
};

type SubmitState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

const REQUIRED_FIELDS = [
  ["name", "Name is required."],
  ["systemPrompt", "System prompt is required."],
  ["modelProvider", "Model provider is required."],
  ["modelName", "Model name is required."],
  ["timezone", "Timezone is required."],
] as const;

const subscribeToHydration = () => () => {};
const getHydratedSnapshot = () => true;
const getServerHydratedSnapshot = () => false;

export function AgentConfigEditor({ agentId, maxNameLength, persisted }: AgentConfigEditorProps) {
  const router = useRouter();
  const submittingRef = useRef(false);
  const [draft, setDraft] = useState<DraftConfig>(() => persistedToDraft(persisted));
  const [state, setState] = useState<SubmitState>({ status: "idle" });
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    getHydratedSnapshot,
    getServerHydratedSnapshot,
  );
  const persistedDraft = useMemo(() => persistedToDraft(persisted), [persisted]);

  useEffect(() => {
    setDraft(persistedDraft);
    setState({ status: "idle" });
  }, [persistedDraft]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (submittingRef.current) {
      return;
    }

    const payloadResult = buildPayload(draft, persisted, maxNameLength);

    if (!payloadResult.ok) {
      setState({ status: "error", message: payloadResult.message });
      return;
    }

    if (Object.keys(payloadResult.payload).length === 0) {
      setState({ status: "success", message: "No config changes to save." });
      return;
    }

    submittingRef.current = true;
    setState({ status: "submitting" });

    try {
      const response = await fetch(`/api/agents/${encodeURIComponent(agentId)}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payloadResult.payload),
      });

      if (!response.ok) {
        setState({ status: "error", message: await safeFailureMessage(response) });
        return;
      }

      const body = (await response.json()) as unknown;

      if (!isAcceptedConfigResponse(body)) {
        setState({
          status: "error",
          message:
            "Agent config save response could not be verified. Refresh and check the saved values.",
        });
        return;
      }

      setState({
        status: "success",
        message: body.noOp ? "No config changes to save." : "Agent config saved.",
      });
      router.refresh();
    } catch {
      setState({ status: "error", message: "Agent config could not be saved." });
    } finally {
      submittingRef.current = false;
    }
  }

  const submitting = state.status === "submitting";
  const disabled = !hydrated || submitting;
  const scheduleDescription =
    draft.scheduleMode === "cron"
      ? "A valid cron schedule has five fields."
      : "Manual schedules keep cron blank.";

  return (
    <div className="config-editor">
      <fieldset className="config-saved-summary">
        <legend>Saved config</legend>
        <dl className="definition-list">
          <div>
            <dt>Saved model</dt>
            <dd>
              {persisted.config.modelProvider} / {persisted.config.modelName}
            </dd>
          </div>
          <div>
            <dt>Saved max daily spend</dt>
            <dd>{formatMoney(persisted.config.maxDailySpendCents)}</dd>
          </div>
          <div>
            <dt>Saved schedule</dt>
            <dd>
              {persisted.config.scheduleMode === "manual"
                ? "Manual"
                : `Cron ${persisted.config.scheduleCron}`}
            </dd>
          </div>
          <div>
            <dt>Saved timezone</dt>
            <dd>{persisted.config.timezone}</dd>
          </div>
        </dl>
      </fieldset>
      <form className="agent-form config-form" onSubmit={handleSubmit}>
        <div className="config-form-grid">
          <div className="field-group">
            <label htmlFor="config-name">Name</label>
            <input
              id="config-name"
              name="name"
              type="text"
              required
              maxLength={maxNameLength}
              autoComplete="off"
              value={draft.name}
              onChange={(event) => updateDraft("name", event.currentTarget.value)}
            />
          </div>
          <div className="field-group">
            <label htmlFor="config-model-provider">Model provider</label>
            <input
              id="config-model-provider"
              name="modelProvider"
              type="text"
              required
              autoComplete="off"
              value={draft.modelProvider}
              onChange={(event) => updateDraft("modelProvider", event.currentTarget.value)}
            />
          </div>
          <div className="field-group">
            <label htmlFor="config-model-name">Model name</label>
            <input
              id="config-model-name"
              name="modelName"
              type="text"
              required
              autoComplete="off"
              value={draft.modelName}
              onChange={(event) => updateDraft("modelName", event.currentTarget.value)}
            />
          </div>
          <div className="field-group">
            <label htmlFor="config-max-daily-spend">Max daily spend</label>
            <input
              id="config-max-daily-spend"
              name="maxDailySpend"
              type="text"
              inputMode="decimal"
              required
              autoComplete="off"
              value={draft.maxDailySpend}
              onChange={(event) => updateDraft("maxDailySpend", event.currentTarget.value)}
            />
          </div>
          <div className="field-group">
            <label htmlFor="config-schedule-mode">Schedule mode</label>
            <select
              id="config-schedule-mode"
              name="scheduleMode"
              value={draft.scheduleMode}
              onChange={(event) => {
                const value = event.currentTarget.value === "cron" ? "cron" : "manual";
                setDraft((current) => ({
                  ...current,
                  scheduleMode: value,
                  scheduleCron: value === "manual" ? "" : current.scheduleCron,
                }));
              }}
            >
              <option value="manual">Manual</option>
              <option value="cron">Cron</option>
            </select>
          </div>
          <div className="field-group">
            <label htmlFor="config-schedule-cron">Schedule cron</label>
            <input
              id="config-schedule-cron"
              name="scheduleCron"
              type="text"
              autoComplete="off"
              disabled={draft.scheduleMode === "manual"}
              value={draft.scheduleCron}
              onChange={(event) => updateDraft("scheduleCron", event.currentTarget.value)}
              aria-describedby="config-schedule-hint"
            />
            <p className="field-hint" id="config-schedule-hint">
              {scheduleDescription}
            </p>
          </div>
          <div className="field-group">
            <label htmlFor="config-timezone">Timezone</label>
            <input
              id="config-timezone"
              name="timezone"
              type="text"
              required
              autoComplete="off"
              value={draft.timezone}
              onChange={(event) => updateDraft("timezone", event.currentTarget.value)}
            />
          </div>
          <div className="field-group config-system-prompt-field">
            <label htmlFor="config-system-prompt">System prompt</label>
            <textarea
              id="config-system-prompt"
              name="systemPrompt"
              required
              rows={5}
              value={draft.systemPrompt}
              onChange={(event) => updateDraft("systemPrompt", event.currentTarget.value)}
            />
          </div>
        </div>
        <div className="config-form-actions">
          <button className="primary-button" type="submit" disabled={disabled}>
            {submitting ? "Saving" : "Save config"}
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={disabled}
            onClick={() => {
              setDraft(persistedDraft);
              setState({ status: "idle" });
            }}
          >
            Reset edits
          </button>
        </div>
        {state.status === "error" || state.status === "success" ? (
          <p className={`form-message ${state.status}`} role="status">
            {state.message}
          </p>
        ) : null}
      </form>
    </div>
  );

  function updateDraft(field: Exclude<keyof DraftConfig, "scheduleMode">, value: string) {
    setDraft((current) => ({
      ...current,
      [field]: value,
    }));
  }
}

function persistedToDraft(persisted: PersistedAgentConfig): DraftConfig {
  return {
    name: persisted.name,
    systemPrompt: persisted.config.systemPrompt,
    modelProvider: persisted.config.modelProvider,
    modelName: persisted.config.modelName,
    maxDailySpend: formatSpendInput(persisted.config.maxDailySpendCents),
    scheduleMode: persisted.config.scheduleMode,
    scheduleCron: persisted.config.scheduleCron ?? "",
    timezone: persisted.config.timezone,
  };
}

function buildPayload(
  draft: DraftConfig,
  persisted: PersistedAgentConfig,
  maxNameLength: number,
):
  | {
      ok: true;
      payload: Record<string, string | null>;
    }
  | {
      ok: false;
      message: string;
    } {
  for (const [field, message] of REQUIRED_FIELDS) {
    if (draft[field].trim().length === 0) {
      return { ok: false, message };
    }
  }

  if (draft.name.trim().length > maxNameLength) {
    return { ok: false, message: `Name must be ${maxNameLength} characters or fewer.` };
  }

  const spend = parseSpendCents(draft.maxDailySpend);

  if (!spend.ok) {
    return { ok: false, message: spend.message };
  }

  if (spend.value <= 0 && persisted.config.maxDailySpendCents !== 0) {
    return { ok: false, message: "Max daily spend must be greater than zero." };
  }

  if (spend.value <= 0 && draft.maxDailySpend.trim() !== formatSpendInput(0)) {
    return { ok: false, message: "Max daily spend must be greater than zero." };
  }

  if (draft.scheduleMode !== "manual" && draft.scheduleMode !== "cron") {
    return { ok: false, message: "Schedule mode must be manual or cron." };
  }

  if (draft.scheduleMode === "manual" && draft.scheduleCron.trim().length > 0) {
    return { ok: false, message: "Manual schedule mode cannot persist a cron expression." };
  }

  if (draft.scheduleMode === "cron" && draft.scheduleCron.trim().length === 0) {
    return { ok: false, message: "Schedule cron is required for cron mode." };
  }

  if (draft.scheduleMode === "cron" && !isValidCronExpression(draft.scheduleCron)) {
    return { ok: false, message: "Schedule cron must be a valid 5-field cron expression." };
  }

  if (!isValidTimezone(draft.timezone.trim())) {
    return { ok: false, message: "Timezone must be a valid IANA timezone." };
  }

  const payload: Record<string, string | null> = {};
  const trimmedName = draft.name.trim();
  const trimmedSystemPrompt = draft.systemPrompt.trim();
  const trimmedModelProvider = draft.modelProvider.trim();
  const trimmedModelName = draft.modelName.trim();
  const trimmedTimezone = draft.timezone.trim();
  const trimmedScheduleCron = draft.scheduleCron.trim();

  if (trimmedName !== persisted.name) {
    payload.name = trimmedName;
  }

  if (trimmedSystemPrompt !== persisted.config.systemPrompt) {
    payload.systemPrompt = trimmedSystemPrompt;
  }

  if (trimmedModelProvider !== persisted.config.modelProvider) {
    payload.modelProvider = trimmedModelProvider;
  }

  if (trimmedModelName !== persisted.config.modelName) {
    payload.modelName = trimmedModelName;
  }

  if (spend.value !== persisted.config.maxDailySpendCents) {
    payload.maxDailySpend = formatSpendInput(spend.value);
  }

  if (draft.scheduleMode !== persisted.config.scheduleMode) {
    payload.scheduleMode = draft.scheduleMode;
  }

  const persistedScheduleCron = persisted.config.scheduleCron ?? "";

  if (draft.scheduleMode === "manual") {
    if (
      persisted.config.scheduleCron !== null ||
      draft.scheduleMode !== persisted.config.scheduleMode
    ) {
      payload.scheduleCron = null;
    }
  } else if (trimmedScheduleCron !== persistedScheduleCron) {
    payload.scheduleCron = trimmedScheduleCron;
  }

  if (trimmedTimezone !== persisted.config.timezone) {
    payload.timezone = trimmedTimezone;
  }

  return { ok: true, payload };
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
          .filter((message) => message !== null && !looksUnsafe(message)) ?? [];

      if (messages.length > 0) {
        return messages.join(" ");
      }

      return "Check the config fields and try again.";
    }

    if (body.error?.code === "database_unavailable") {
      return "Database is unavailable. Start Postgres and run migrations, then try again.";
    }

    if (body.error?.code === "database_schema_missing") {
      return "Database schema is missing. Run migrations, then try again.";
    }
  } catch {
    // Keep failures generic when the response body is malformed or not safe JSON.
  }

  return "Agent config could not be saved.";
}

function parseSpendCents(value: string):
  | {
      ok: true;
      value: number;
    }
  | {
      ok: false;
      message: string;
    } {
  const text = value.trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);

  if (!match) {
    return {
      ok: false,
      message: "Max daily spend must be a positive dollar amount with whole cents.",
    };
  }

  const dollars = Number(match[1]);
  const centsText = (match[2] ?? "").padEnd(2, "0");
  const cents = dollars * 100 + Number(centsText);

  if (!Number.isSafeInteger(cents)) {
    return { ok: false, message: "Max daily spend must be a dollar amount." };
  }

  return { ok: true, value: cents };
}

function formatMoney(cents: number): string {
  return `$${formatSpendInput(cents)}`;
}

function formatSpendInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

function isAcceptedConfigResponse(value: unknown): value is { ok: true; noOp: boolean } {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    value.ok === true &&
    "noOp" in value &&
    typeof value.noOp === "boolean"
  );
}

function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function isValidCronExpression(cron: string): boolean {
  const fields = cron.trim().split(/\s+/);

  if (fields.length !== 5) {
    return false;
  }

  const ranges = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ] as const;

  return fields.every((field, index) => {
    const range = ranges[index];

    if (!range) {
      return false;
    }

    return isValidCronField(field, range[0], range[1]);
  });
}

function isValidCronField(field: string, min: number, max: number): boolean {
  return field.split(",").every((part) => isValidCronFieldPart(part, min, max));
}

function isValidCronFieldPart(part: string, min: number, max: number): boolean {
  const [rangePart, stepPart] = part.split("/");

  if (!rangePart || (stepPart !== undefined && !isPositiveInteger(stepPart))) {
    return false;
  }

  if (rangePart === "*") {
    return true;
  }

  if (rangePart.includes("-")) {
    const [start, end] = rangePart.split("-");

    if (!start || !end || !isIntegerInRange(start, min, max) || !isIntegerInRange(end, min, max)) {
      return false;
    }

    return Number(start) <= Number(end);
  }

  return isIntegerInRange(rangePart, min, max);
}

function isPositiveInteger(value: string): boolean {
  return /^\d+$/.test(value) && Number(value) > 0;
}

function isIntegerInRange(value: string, min: number, max: number): boolean {
  if (!/^\d+$/.test(value)) {
    return false;
  }

  const numberValue = Number(value);

  return numberValue >= min && numberValue <= max;
}

function looksUnsafe(message: string): boolean {
  return /(postgres:\/\/|stack|trace|sql|password|secret|token|ECONN|driver)/i.test(message);
}
