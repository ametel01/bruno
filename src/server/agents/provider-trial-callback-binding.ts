export type ProviderTrialCallbackProof = {
  endpointUrl: string;
  registrationToken: string;
  tokenId: string;
};

export type ProviderTrialRegistrationTokenStatus = "expired" | "pending" | "revoked" | "used";

export function isProviderTrialRegistrationTokenStatus(
  value: string,
): value is ProviderTrialRegistrationTokenStatus {
  return value === "expired" || value === "pending" || value === "revoked" || value === "used";
}

export async function cleanupProviderTrialCallbackAttribution(input: {
  findAttributableRunner: (runnerId: string, proof: ProviderTrialCallbackProof) => Promise<boolean>;
  observedRunnerId: string | null;
  proof: ProviderTrialCallbackProof;
  revokeAndDeleteRunner: (runnerId: string) => Promise<void>;
  revokePendingToken: () => Promise<void>;
  token: {
    runnerId: string | null;
    status: ProviderTrialRegistrationTokenStatus;
  };
}): Promise<void> {
  const attributableRunnerIds = new Set<string>();
  if (input.token.runnerId) attributableRunnerIds.add(input.token.runnerId);
  if (
    input.observedRunnerId &&
    input.observedRunnerId !== input.token.runnerId &&
    (await input.findAttributableRunner(input.observedRunnerId, input.proof))
  ) {
    attributableRunnerIds.add(input.observedRunnerId);
  }
  for (const runnerId of attributableRunnerIds) {
    await input.revokeAndDeleteRunner(runnerId);
  }
  switch (input.token.status) {
    case "pending":
      await input.revokePendingToken();
      return;
    case "expired":
    case "revoked":
    case "used":
      return;
    default:
      input.token.status satisfies never;
  }
}

type ProviderTrialCallbackBindingDependencies = {
  cleanupProof: (
    proof: ProviderTrialCallbackProof,
    observedRunnerId: string | null,
  ) => Promise<void>;
  createProof: () => Promise<ProviderTrialCallbackProof>;
  fetchImpl?: typeof fetch;
  isLocalRunner: (runnerId: string, proof: ProviderTrialCallbackProof) => Promise<boolean>;
  timeoutMs?: number;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function observeProviderTrialCallbackDatabaseBinding(
  baseUrl: string,
  dependencies: ProviderTrialCallbackBindingDependencies,
): Promise<boolean> {
  let proof: ProviderTrialCallbackProof | null = null;
  let observedRunnerId: string | null = null;
  let bindingMatches = false;
  let cleanupSucceeded = false;

  try {
    proof = await dependencies.createProof();
    const response = await (dependencies.fetchImpl ?? fetch)(
      new URL("/runner/v1/register", baseUrl),
      {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          registrationToken: proof.registrationToken,
          endpointUrl: proof.endpointUrl,
          name: "Provider Trial callback binding proof",
        }),
        signal: AbortSignal.timeout(dependencies.timeoutMs ?? 10_000),
      },
    );
    const body = await response.json().catch(() => null);
    observedRunnerId = readRegisteredRunnerId(response.status, body);
    bindingMatches = Boolean(
      observedRunnerId && (await dependencies.isLocalRunner(observedRunnerId, proof)),
    );
  } catch {
    bindingMatches = false;
  } finally {
    if (proof) {
      try {
        await dependencies.cleanupProof(proof, observedRunnerId);
        cleanupSucceeded = true;
      } catch {
        cleanupSucceeded = false;
      }
    }
  }

  return bindingMatches && cleanupSucceeded;
}

function readRegisteredRunnerId(status: number, body: unknown): string | null {
  if (status !== 201 || !body || typeof body !== "object") return null;
  const result = body as Record<string, unknown>;
  if (result.ok !== true || !result.runner || typeof result.runner !== "object") return null;
  const runnerId = (result.runner as Record<string, unknown>).id;
  return typeof runnerId === "string" && UUID.test(runnerId) ? runnerId : null;
}
