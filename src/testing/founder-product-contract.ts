/**
 * Public seams used by the deterministic Founder Product Contract.
 *
 * The application boundary is intentionally small: scenarios may drive HTTP
 * requests, an injected clock, and provider-neutral boundaries, but they do
 * not receive database helpers or domain internals.
 */

import { FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS } from "@/src/shared/founder-product-contract";

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

export type FounderProductContractApplicationContext = {
  clock: FounderProductContractClock;
  providers: FounderProductContractProviderDoubles;
};

export type FounderProductContractPublicResponse = {
  status: number;
  headers: Readonly<Record<string, string>>;
  json(): Promise<unknown>;
};

export type FounderProductContractApplication = {
  request(
    input: FounderProductContractPublicRequest,
    context?: FounderProductContractApplicationContext,
  ): Promise<FounderProductContractPublicResponse>;
};

export type FounderProductContractHarness = {
  readonly clock: FounderProductContractClock;
  readonly providers: FounderProductContractProviderDoubles;
  readonly application: FounderProductContractApplication;
  readonly scenarioResults: FounderProductContractScenarioResult[];
  readonly requestCount: number;
  readonly sourceRevision?: string;
};

export type FounderProductContractScenario = (
  harness: FounderProductContractHarness,
) => Promise<FounderProductContractCleanupOutcome> | FounderProductContractCleanupOutcome;

export type FounderProductContractCleanupOutcome = {
  status: "passed" | "failed";
  verified: boolean;
  resourcesBefore: number;
  resourcesAfter: number;
  observedAt: string;
};

export type FounderProductContractScenarioResult = {
  id: FounderProductContractLifecycleScenario;
  status: "passed" | "failed" | "skipped";
  attempts: number;
  sourceRevision: string | null;
  observedAt: string;
  cleanup: FounderProductContractCleanupOutcome;
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
  let requestCount = 0;
  const application: FounderProductContractApplication = {
    request: (request, context = { clock, providers }) => {
      requestCount += 1;
      return input.application.request(request, context);
    },
  };
  return Object.freeze({
    application,
    clock,
    providers,
    scenarioResults,
    get requestCount() {
      return requestCount;
    },
    ...(input.sourceRevision ? { sourceRevision: input.sourceRevision } : {}),
  });
}

export function runFounderProductContractScenario<T>(
  harness: FounderProductContractHarness,
  scenario: (harness: FounderProductContractHarness) => Promise<T> | T,
): Promise<T>;

export async function runFounderProductContractScenario(
  harness: FounderProductContractHarness,
  id: FounderProductContractLifecycleScenario,
  scenario: (
    harness: FounderProductContractHarness,
  ) => Promise<FounderProductContractCleanupOutcome> | FounderProductContractCleanupOutcome,
): Promise<FounderProductContractScenarioResult>;

export async function runFounderProductContractScenario<T>(
  harness: FounderProductContractHarness,
  idOrScenario:
    | FounderProductContractLifecycleScenario
    | ((harness: FounderProductContractHarness) => Promise<T> | T),
  recordedScenario?: (
    harness: FounderProductContractHarness,
  ) => Promise<FounderProductContractCleanupOutcome> | FounderProductContractCleanupOutcome,
): Promise<T | FounderProductContractScenarioResult> {
  if (typeof idOrScenario !== "function") {
    if (!recordedScenario) {
      throw new Error("A Founder Product Contract scenario callback is required.");
    }
    return runRecordedFounderProductContractScenario(harness, idOrScenario, recordedScenario);
  }
  return idOrScenario(harness);
}

export async function runRecordedFounderProductContractScenario(
  harness: FounderProductContractHarness,
  id: FounderProductContractLifecycleScenario,
  scenario: (
    harness: FounderProductContractHarness,
  ) => Promise<FounderProductContractCleanupOutcome> | FounderProductContractCleanupOutcome,
): Promise<FounderProductContractScenarioResult> {
  if (!FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS.includes(id)) {
    throw new Error("Founder Product Contract scenario ID is invalid.");
  }
  const requestCount = harness.requestCount;
  const result: FounderProductContractScenarioResult = {
    id,
    status: "failed",
    attempts: 1,
    sourceRevision: getHarnessSourceRevision(harness),
    observedAt: harness.clock.now().toISOString(),
    cleanup: failedCleanup(harness.clock),
  };
  try {
    const cleanup = await scenario(harness);
    if (harness.requestCount === requestCount) {
      throw new Error(
        `Founder Product Contract scenario ${id} made no public application request.`,
      );
    }
    result.cleanup = validateCleanupOutcome(cleanup);
    result.status = "passed";
  } catch (error) {
    harness.scenarioResults.push(result);
    throw error;
  }
  harness.scenarioResults.push(result);
  return result;
}

function failedCleanup(clock: FounderProductContractClock): FounderProductContractCleanupOutcome {
  return {
    status: "failed",
    verified: false,
    resourcesBefore: 0,
    resourcesAfter: 0,
    observedAt: clock.now().toISOString(),
  };
}

function validateCleanupOutcome(
  cleanup: FounderProductContractCleanupOutcome,
): FounderProductContractCleanupOutcome {
  const observedAt = new Date(cleanup.observedAt);
  if (
    cleanup.status !== "passed" ||
    !cleanup.verified ||
    !Number.isSafeInteger(cleanup.resourcesBefore) ||
    cleanup.resourcesBefore < 0 ||
    !Number.isSafeInteger(cleanup.resourcesAfter) ||
    cleanup.resourcesAfter !== 0 ||
    Number.isNaN(observedAt.valueOf()) ||
    observedAt.toISOString() !== cleanup.observedAt
  ) {
    throw new Error("Founder Product Contract cleanup was not verified.");
  }
  return cleanup;
}

export function validateFounderProductContractScenarios(input: {
  required: readonly FounderProductContractLifecycleScenario[];
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
  if (
    required.size !== input.required.length ||
    required.size !== FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS.length ||
    FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS.some((id) => !required.has(id))
  ) {
    throw new Error("Founder Product Contract scenario requirements must be unique.");
  }
  if (input.results.length > FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS.length) {
    throw new Error("Founder Product Contract lifecycle scenarios contain unexpected results.");
  }
  const resultsById = new Map<string, FounderProductContractScenarioResult>();
  for (const result of input.results) {
    if (!FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS.includes(result.id)) {
      throw new Error(`Founder Product Contract scenario ${result.id} is not canonical.`);
    }
    if (resultsById.has(result.id)) {
      throw new Error(`Founder Product Contract scenario ${result.id} was retried.`);
    }
    if (result.status !== "passed") {
      throw new Error(`Founder Product Contract scenario ${result.id} did not pass.`);
    }
    if (result.attempts !== 1) {
      throw new Error(`Founder Product Contract scenario ${result.id} was retried.`);
    }
    validateCleanupOutcome(result.cleanup);
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

export function createFounderProductContractLifecycleApplication(input: {
  clock: FounderProductContractClock;
  providers: FounderProductContractProviderDoubles;
}): FounderProductContractApplication {
  const defaultProviderResponse = { ok: true as const, value: { accepted: true } };
  input.providers.clerk.setDefaultResponse(defaultProviderResponse);
  input.providers.lemonSqueezy.setDefaultResponse(defaultProviderResponse);
  input.providers.digitalOcean.setDefaultResponse(defaultProviderResponse);
  input.providers.openai.setDefaultResponse(defaultProviderResponse);
  input.providers.anthropic.setDefaultResponse(defaultProviderResponse);
  input.providers.google.setDefaultResponse(defaultProviderResponse);
  let releaseStage: "candidate" | "admitted" = "candidate";
  let entitlement: "inactive" | "active" = "inactive";
  let recoveryArchive: "open" | "archived" = "open";
  let infrastructure: "provisioned" | "retired" = "provisioned";
  let resources = 2;

  return {
    async request(request) {
      const at = input.clock.now().toISOString();
      if (request.method === "POST" && request.path === "/api/founder-contract/release/admit") {
        const identity = await input.providers.clerk.request("authenticate", { subject: "owner" });
        if (!identity.ok) return jsonResponse(502, identity);
        releaseStage = "admitted";
        return jsonResponse(200, { releaseStage, at });
      }
      if (
        request.method === "POST" &&
        request.path === "/api/founder-contract/entitlement/activate"
      ) {
        if (releaseStage !== "admitted") return jsonResponse(409, { code: "release_not_admitted" });
        const subscription = await input.providers.lemonSqueezy.request("read_subscription", {
          subscriptionId: "contract-subscription",
        });
        if (!subscription.ok) return jsonResponse(502, subscription);
        entitlement = "active";
        return jsonResponse(200, { entitlement, at });
      }
      if (request.method === "POST" && request.path === "/api/founder-contract/recovery/archive") {
        if (entitlement !== "active") return jsonResponse(409, { code: "entitlement_inactive" });
        const [openai, anthropic, google] = await Promise.all([
          input.providers.openai.request("read_account", { account: "contract" }),
          input.providers.anthropic.request("read_account", { account: "contract" }),
          input.providers.google.request("read_calendar", { calendar: "contract" }),
        ]);
        if (!openai.ok || !anthropic.ok || !google.ok) {
          return jsonResponse(502, { code: "recovery_provider_unavailable" });
        }
        recoveryArchive = "archived";
        return jsonResponse(200, { recoveryArchive, at });
      }
      if (
        request.method === "POST" &&
        request.path === "/api/founder-contract/infrastructure/retire"
      ) {
        if (recoveryArchive !== "archived") return jsonResponse(409, { code: "archive_not_ready" });
        const firewall = await input.providers.digitalOcean.request("delete_firewall", {
          resource: "contract",
        });
        const droplet = await input.providers.digitalOcean.request("delete_droplet", {
          resource: "contract",
        });
        if (!firewall.ok || !droplet.ok) return jsonResponse(502, { code: "retirement_failed" });
        infrastructure = "retired";
        resources = 0;
        return jsonResponse(200, { infrastructure, at });
      }
      if (request.method === "GET" && request.path === "/api/founder-contract/lifecycle") {
        return jsonResponse(200, {
          releaseStage,
          entitlement,
          recoveryArchive,
          infrastructure,
          at,
        });
      }
      if (request.method === "DELETE" && request.path === "/api/founder-contract/cleanup") {
        const scenario = readScenarioId(request.body);
        const resourcesBefore = scenario === "infrastructure_retirement" ? resources : 0;
        const cleanupPassed =
          scenario !== "infrastructure_retirement" || infrastructure === "retired";
        const resourcesAfter = cleanupPassed ? 0 : resources;
        if (cleanupPassed && scenario === "infrastructure_retirement") resources = 0;
        return jsonResponse(200, {
          cleanup: {
            status: cleanupPassed ? "passed" : "failed",
            verified: cleanupPassed && resourcesAfter === 0,
            resourcesBefore,
            resourcesAfter,
            observedAt: at,
          } satisfies FounderProductContractCleanupOutcome,
        });
      }
      return jsonResponse(404, { code: "not_found" });
    },
  };
}

export async function runFounderProductContractLifecycleScenarios(
  harness: FounderProductContractHarness,
): Promise<readonly FounderProductContractScenarioResult[]> {
  await runRecordedFounderProductContractScenario(harness, "release_stage_admission", async () => {
    await expectPublicStatus(harness, {
      method: "POST",
      path: "/api/founder-contract/release/admit",
    });
    await expectLifecycleState(harness, "releaseStage", "admitted");
    return cleanupForScenario(harness, "release_stage_admission");
  });
  await runRecordedFounderProductContractScenario(
    harness,
    "product_entitlement_lifecycle",
    async () => {
      await expectPublicStatus(harness, {
        method: "POST",
        path: "/api/founder-contract/entitlement/activate",
      });
      await expectLifecycleState(harness, "entitlement", "active");
      return cleanupForScenario(harness, "product_entitlement_lifecycle");
    },
  );
  await runRecordedFounderProductContractScenario(
    harness,
    "recovery_archive_lifecycle",
    async () => {
      await expectPublicStatus(harness, {
        method: "POST",
        path: "/api/founder-contract/recovery/archive",
      });
      await expectLifecycleState(harness, "recoveryArchive", "archived");
      return cleanupForScenario(harness, "recovery_archive_lifecycle");
    },
  );
  await runRecordedFounderProductContractScenario(
    harness,
    "infrastructure_retirement",
    async () => {
      await expectPublicStatus(harness, {
        method: "POST",
        path: "/api/founder-contract/infrastructure/retire",
      });
      await expectLifecycleState(harness, "infrastructure", "retired");
      return cleanupForScenario(harness, "infrastructure_retirement");
    },
  );
  return harness.scenarioResults;
}

async function expectPublicStatus(
  harness: FounderProductContractHarness,
  request: FounderProductContractPublicRequest,
): Promise<unknown> {
  const response = await harness.application.request(request);
  const body = await response.json();
  if (response.status !== 200) {
    throw new Error(
      `Founder Product Contract lifecycle request failed with status ${response.status}.`,
    );
  }
  return body;
}

async function expectLifecycleState(
  harness: FounderProductContractHarness,
  field: "releaseStage" | "entitlement" | "recoveryArchive" | "infrastructure",
  expected: string,
): Promise<void> {
  const response = await harness.application.request({
    method: "GET",
    path: "/api/founder-contract/lifecycle",
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (response.status !== 200 || body[field] !== expected) {
    throw new Error(`Founder Product Contract lifecycle state ${field} was not persisted.`);
  }
}

async function cleanupForScenario(
  harness: FounderProductContractHarness,
  scenario: FounderProductContractLifecycleScenario,
): Promise<FounderProductContractCleanupOutcome> {
  const response = await harness.application.request({
    method: "DELETE",
    path: "/api/founder-contract/cleanup",
    body: { scenario },
  });
  const body = (await response.json()) as { cleanup?: FounderProductContractCleanupOutcome };
  if (response.status !== 200 || !body.cleanup) {
    throw new Error("Founder Product Contract cleanup response was invalid.");
  }
  return body.cleanup;
}

function readScenarioId(value: unknown): FounderProductContractLifecycleScenario {
  if (
    typeof value !== "object" ||
    value === null ||
    !("scenario" in value) ||
    typeof value.scenario !== "string" ||
    !FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS.includes(
      value.scenario as FounderProductContractLifecycleScenario,
    )
  ) {
    throw new Error("Founder Product Contract cleanup scenario is invalid.");
  }
  return value.scenario as FounderProductContractLifecycleScenario;
}

function jsonResponse(status: number, value: unknown): FounderProductContractPublicResponse {
  return {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    json: async () => value,
  };
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
