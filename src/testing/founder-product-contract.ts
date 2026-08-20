/**
 * Public seams used by the deterministic Founder Product Contract.
 *
 * The application boundary is intentionally small: scenarios may drive HTTP
 * requests, an injected clock, and provider-neutral boundaries, but they do
 * not receive database helpers or domain internals.
 */

import type { FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS } from "@/src/shared/founder-product-contract";

export { FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS } from "@/src/shared/founder-product-contract";

export const FOUNDER_PRODUCT_CONTRACT_DEFAULT_TIME = "2026-01-01T00:00:00.000Z" as const;

export type FounderProductContractLifecycleScenario =
  (typeof FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS)[number];

export type FounderProductContractClock = {
  now(): Date;
  set(value: Date | string): Date;
  advance(milliseconds: number): Date;
};

export function createFounderProductContractClock(
  initial: Date | string = FOUNDER_PRODUCT_CONTRACT_DEFAULT_TIME,
): FounderProductContractClock {
  let current = parseInstant(initial);

  return {
    now: () => new Date(current.getTime()),
    set: (value) => {
      current = parseInstant(value);
      return new Date(current.getTime());
    },
    advance: (milliseconds) => {
      if (!Number.isFinite(milliseconds)) {
        throw new Error("Founder Product Contract clock advance must be finite.");
      }
      current = new Date(current.getTime() + milliseconds);
      return new Date(current.getTime());
    },
  };
}

export type FounderProductContractProviderName =
  | "clerk"
  | "lemonSqueezy"
  | "digitalOcean"
  | "openai"
  | "anthropic"
  | "google";

export type FounderProductContractProviderOperations = {
  clerk: "authenticate" | "recover_identity" | "revoke_session" | "read_identity";
  lemonSqueezy:
    | "create_checkout"
    | "read_subscription"
    | "read_portal"
    | "cancel_subscription"
    | "refund_payment"
    | "receive_webhook";
  digitalOcean:
    | "create_droplet"
    | "read_droplet"
    | "read_firewall"
    | "delete_firewall"
    | "delete_droplet"
    | "observe_owned_resources";
  openai: "authorize" | "inference" | "revoke" | "read_account";
  anthropic: "authorize" | "inference" | "revoke" | "read_account";
  google:
    | "authorize_calendar"
    | "read_calendar"
    | "authorize_mail"
    | "read_mail"
    | "send_mail"
    | "revoke";
};

export type FounderProductContractProviderResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; retryable: boolean };

export type FounderProductContractProviderCall<TOperation extends string> = {
  provider: FounderProductContractProviderName;
  operation: TOperation;
  input: unknown;
  at: string;
  idempotencyKey: string | null;
};

export type FounderProductContractProviderDouble<TOperation extends string> = {
  readonly calls: readonly FounderProductContractProviderCall<TOperation>[];
  request<T = unknown>(
    operation: TOperation,
    input?: unknown,
    options?: { idempotencyKey?: string },
  ): Promise<FounderProductContractProviderResult<T>>;
  setResponse<T>(operation: TOperation, response: FounderProductContractProviderResult<T>): void;
  enqueueResponse<T>(
    operation: TOperation,
    response: FounderProductContractProviderResult<T>,
  ): void;
  setFailure(operation: TOperation, response: FounderProductContractProviderResult<never>): void;
  setDefaultResponse<T>(response: FounderProductContractProviderResult<T>): void;
  reset(): void;
};

export type FounderProductContractProviderDoubles = {
  [TProvider in FounderProductContractProviderName]: FounderProductContractProviderDouble<
    FounderProductContractProviderOperations[TProvider]
  >;
};

export type FounderProductContractPublicRequest = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
};

export type FounderProductContractPublicResponse = {
  status: number;
  headers: Readonly<Record<string, string>>;
  json(): Promise<unknown>;
};

export type FounderProductContractApplication = {
  request(
    input: FounderProductContractPublicRequest,
  ): Promise<FounderProductContractPublicResponse>;
};

export type FounderProductContractHarness = {
  readonly clock: FounderProductContractClock;
  readonly providers: FounderProductContractProviderDoubles;
  readonly application: FounderProductContractApplication;
  readonly scenarioResults: FounderProductContractScenarioResult[];
  readonly sourceRevision?: string;
};

export type FounderProductContractScenario = (
  harness: FounderProductContractHarness,
) => Promise<void> | void;

export type FounderProductContractScenarioResult = {
  id: string;
  status: "passed" | "failed" | "skipped";
  attempts: number;
  sourceRevision: string | null;
  observedAt: string;
};

export function createFounderProductContractProviderDoubles(input: {
  clock: FounderProductContractClock;
}): FounderProductContractProviderDoubles {
  return {
    clerk: createProviderDouble("clerk", input.clock),
    lemonSqueezy: createProviderDouble("lemonSqueezy", input.clock),
    digitalOcean: createProviderDouble("digitalOcean", input.clock),
    openai: createProviderDouble("openai", input.clock),
    anthropic: createProviderDouble("anthropic", input.clock),
    google: createProviderDouble("google", input.clock),
  } as FounderProductContractProviderDoubles;
}

export function createFounderProductContractHarness(input: {
  application: FounderProductContractApplication;
  clock?: FounderProductContractClock;
  providers?: FounderProductContractProviderDoubles;
  sourceRevision?: string;
}): FounderProductContractHarness {
  const clock = input.clock ?? createFounderProductContractClock();
  const providers = input.providers ?? createFounderProductContractProviderDoubles({ clock });
  const scenarioResults: FounderProductContractScenarioResult[] = [];
  return Object.freeze({
    application: input.application,
    clock,
    providers,
    scenarioResults,
    ...(input.sourceRevision ? { sourceRevision: input.sourceRevision } : {}),
  });
}

export function runFounderProductContractScenario<T>(
  harness: FounderProductContractHarness,
  scenario: (harness: FounderProductContractHarness) => Promise<T> | T,
): Promise<T>;

export async function runFounderProductContractScenario(
  harness: FounderProductContractHarness,
  id: string,
  scenario: (harness: FounderProductContractHarness) => Promise<void> | void,
): Promise<FounderProductContractScenarioResult>;

export async function runFounderProductContractScenario<T>(
  harness: FounderProductContractHarness,
  idOrScenario: string | ((harness: FounderProductContractHarness) => Promise<T> | T),
  recordedScenario?: (harness: FounderProductContractHarness) => Promise<void> | void,
): Promise<T | FounderProductContractScenarioResult> {
  if (typeof idOrScenario === "string") {
    if (!recordedScenario) {
      throw new Error("A Founder Product Contract scenario callback is required.");
    }
    return runRecordedFounderProductContractScenario(harness, idOrScenario, recordedScenario);
  }
  return idOrScenario(harness);
}

export async function runRecordedFounderProductContractScenario(
  harness: FounderProductContractHarness,
  id: string,
  scenario: (harness: FounderProductContractHarness) => Promise<void> | void,
): Promise<FounderProductContractScenarioResult> {
  if (!/^[a-z][a-z0-9_:-]{0,127}$/.test(id)) {
    throw new Error("Founder Product Contract scenario ID is invalid.");
  }
  const result: FounderProductContractScenarioResult = {
    id,
    status: "failed",
    attempts: 1,
    sourceRevision: getHarnessSourceRevision(harness),
    observedAt: harness.clock.now().toISOString(),
  };
  try {
    await scenario(harness);
    result.status = "passed";
  } catch (error) {
    harness.scenarioResults.push(result);
    throw error;
  }
  harness.scenarioResults.push(result);
  return result;
}

export function validateFounderProductContractScenarios(input: {
  required: readonly string[];
  results: readonly FounderProductContractScenarioResult[];
  sourceRevision: string;
  observedAt: string;
  maxAgeMilliseconds?: number;
}): void {
  const expectedAt = parseInstant(input.observedAt).getTime();
  const maxAge = input.maxAgeMilliseconds ?? 0;
  if (!Number.isFinite(maxAge) || maxAge < 0) {
    throw new Error("Founder Product Contract scenario max age must be non-negative.");
  }
  const required = new Set(input.required);
  if (required.size !== input.required.length) {
    throw new Error("Founder Product Contract scenario requirements must be unique.");
  }
  const resultsById = new Map<string, FounderProductContractScenarioResult>();
  for (const result of input.results) {
    if (resultsById.has(result.id)) {
      throw new Error(`Founder Product Contract scenario ${result.id} was retried.`);
    }
    if (result.status !== "passed") {
      throw new Error(`Founder Product Contract scenario ${result.id} did not pass.`);
    }
    if (result.attempts !== 1) {
      throw new Error(`Founder Product Contract scenario ${result.id} was retried.`);
    }
    if (result.sourceRevision !== input.sourceRevision) {
      throw new Error(`Founder Product Contract scenario ${result.id} has a revision mismatch.`);
    }
    const observedAt = parseInstant(result.observedAt).getTime();
    if (observedAt > expectedAt || expectedAt - observedAt > maxAge) {
      throw new Error(`Founder Product Contract scenario ${result.id} is stale.`);
    }
    resultsById.set(result.id, result);
  }
  for (const id of required) {
    if (!resultsById.has(id)) {
      throw new Error(`Required Founder Product Contract scenario ${id} was not present.`);
    }
  }
}

export function providerFailure(
  code: string,
  retryable = false,
): FounderProductContractProviderResult<never> {
  if (!/^[a-z][a-z0-9_:-]{0,79}$/.test(code)) {
    throw new Error("Founder Product Contract provider failure code is invalid.");
  }
  return { ok: false, code, retryable };
}

function createProviderDouble<TOperation extends string>(
  provider: FounderProductContractProviderName,
  clock: FounderProductContractClock,
): FounderProductContractProviderDouble<TOperation> {
  const calls: FounderProductContractProviderCall<TOperation>[] = [];
  const responses = new Map<TOperation, FounderProductContractProviderResult<unknown>>();
  const queuedResponses = new Map<
    TOperation,
    Array<FounderProductContractProviderResult<unknown>>
  >();
  let defaultResponse: FounderProductContractProviderResult<unknown> = providerFailure(
    "unconfigured_provider_operation",
  );

  const double: FounderProductContractProviderDouble<TOperation> = {
    calls,
    async request<T = unknown>(
      operation: TOperation,
      input?: unknown,
      options?: { idempotencyKey?: string },
    ): Promise<FounderProductContractProviderResult<T>> {
      calls.push({
        provider,
        operation,
        input: input === undefined ? null : input,
        at: clock.now().toISOString(),
        idempotencyKey: options?.idempotencyKey ?? null,
      });
      const queued = queuedResponses.get(operation)?.shift();
      return (queued ??
        responses.get(operation) ??
        defaultResponse) as FounderProductContractProviderResult<T>;
    },
    setResponse(operation, response) {
      responses.set(operation, response);
    },
    enqueueResponse(operation, response) {
      const queue = queuedResponses.get(operation) ?? [];
      queue.push(response);
      queuedResponses.set(operation, queue);
    },
    setFailure(operation, response) {
      if (response.ok) {
        throw new Error("Founder Product Contract failure responses must be unsuccessful.");
      }
      responses.set(operation, response);
    },
    setDefaultResponse(response) {
      defaultResponse = response;
    },
    reset() {
      calls.length = 0;
      responses.clear();
      queuedResponses.clear();
    },
  };

  return double;
}

function parseInstant(value: Date | string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) {
    throw new Error("Founder Product Contract clock value must be a valid instant.");
  }
  return parsed;
}

function getHarnessSourceRevision(harness: FounderProductContractHarness): string | null {
  return harness.sourceRevision ?? null;
}
