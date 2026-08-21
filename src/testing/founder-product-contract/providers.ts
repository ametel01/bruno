import type { FounderProductContractClock } from "./clock";

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
