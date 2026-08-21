import { and, eq } from "drizzle-orm";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { appMetadata, operatorPreparations, operators } from "@/src/server/db/schema";

export type FounderProductContractLifecycleAction =
  | "release_stage_admission"
  | "product_entitlement_lifecycle"
  | "recovery_archive_lifecycle"
  | "infrastructure_retirement";

export type FounderProductContractLifecycleState = {
  runId: string;
  sourceRevision: string;
  userId: string;
  releaseStage: "owner_preview" | null;
  entitlement: "verified" | "expired" | null;
  archive: "verified" | "failed" | null;
  infrastructure: "present" | "retired";
  providerCalls: string[];
  updatedAt: string;
};

export type FounderProductContractLifecycleProviders = {
  clerkAuthenticate(): Promise<void>;
  reconcileEntitlement(): Promise<void>;
  verifyArchive(): Promise<void>;
  observeResources(): Promise<void>;
  disableCredentials(): Promise<void>;
  deleteFirewall(): Promise<void>;
  deleteDroplet(): Promise<void>;
  verifyResourcesAbsent(): Promise<void>;
};

export async function applyFounderProductContractLifecycleAction(
  input: {
    action: FounderProductContractLifecycleAction;
    runId: string;
    sourceRevision: string;
    userId: string;
    now: Date;
    providers: FounderProductContractLifecycleProviders;
  },
  dependencies: { createConnection?: () => DatabaseConnection } = {},
): Promise<FounderProductContractLifecycleState> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    return await connection.db.transaction(async (tx) => {
      const key = lifecycleMetadataKey(input.runId, input.userId);
      const [existing] = await tx
        .select({ value: appMetadata.value })
        .from(appMetadata)
        .where(eq(appMetadata.key, key))
        .limit(1);
      const state = existing ? parseState(existing.value) : initialState(input);
      const providerCalls = state.providerCalls;

      const [operator] = await tx
        .select({ id: operators.id, status: operators.status })
        .from(operators)
        .where(and(eq(operators.userId, input.userId), eq(operators.status, "active")))
        .limit(1);
      if (!operator) throw new Error("An active persisted Operator is required.");
      const [preparation] = await tx
        .select({ status: operatorPreparations.status })
        .from(operatorPreparations)
        .where(eq(operatorPreparations.operatorId, operator.id))
        .limit(1);
      if (preparation?.status !== "ready") {
        throw new Error("A ready persisted Operator preparation is required.");
      }

      if (state.sourceRevision !== input.sourceRevision || state.userId !== input.userId) {
        throw new Error("Founder Product Contract lifecycle identity does not match.");
      }

      switch (input.action) {
        case "release_stage_admission":
          if (state.releaseStage) throw new Error("Release Stage is already admitted.");
          await input.providers.clerkAuthenticate();
          providerCalls.push("clerk.authenticate");
          state.releaseStage = "owner_preview";
          break;
        case "product_entitlement_lifecycle":
          if (!state.releaseStage) throw new Error("Release Stage must be admitted first.");
          if (state.entitlement) throw new Error("Product Entitlement is already reconciled.");
          await input.providers.reconcileEntitlement();
          providerCalls.push("lemonSqueezy.receive_webhook", "lemonSqueezy.read_subscription");
          state.entitlement = "verified";
          break;
        case "recovery_archive_lifecycle":
          if (state.entitlement !== "verified") {
            throw new Error("Verified Product Entitlement is required before archiving.");
          }
          if (state.archive) throw new Error("Recovery Archive is already recorded.");
          try {
            await input.providers.verifyArchive();
            providerCalls.push("application.verify_recovery_archive");
            state.archive = "verified";
          } catch {
            providerCalls.push("application.verify_recovery_archive_failed");
            state.archive = "failed";
          }
          break;
        case "infrastructure_retirement":
          if (!state.archive)
            throw new Error("Recovery Archive attempt is required before retirement.");
          if (state.infrastructure === "retired")
            throw new Error("Infrastructure is already retired.");
          await input.providers.observeResources();
          await input.providers.disableCredentials();
          await input.providers.deleteFirewall();
          await input.providers.deleteDroplet();
          await input.providers.verifyResourcesAbsent();
          providerCalls.push(
            "digitalOcean.observe_owned_resources",
            "digitalOcean.disable_runtime_credentials",
            "digitalOcean.delete_firewall",
            "digitalOcean.delete_droplet",
            "digitalOcean.observe_owned_resources_absent",
          );
          state.infrastructure = "retired";
          break;
      }

      state.updatedAt = input.now.toISOString();
      await tx
        .insert(appMetadata)
        .values({ key, value: JSON.stringify(state), updatedAt: input.now })
        .onConflictDoUpdate({
          target: appMetadata.key,
          set: { value: JSON.stringify(state), updatedAt: input.now },
        });
      return state;
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

function lifecycleMetadataKey(runId: string, userId: string): string {
  return `founder_product_contract_lifecycle:${runId}:${userId}`;
}

function initialState(input: {
  runId: string;
  sourceRevision: string;
  userId: string;
  now: Date;
}): FounderProductContractLifecycleState {
  return {
    runId: input.runId,
    sourceRevision: input.sourceRevision,
    userId: input.userId,
    releaseStage: null,
    entitlement: null,
    archive: null,
    infrastructure: "present",
    providerCalls: [],
    updatedAt: input.now.toISOString(),
  };
}

function parseState(value: string): FounderProductContractLifecycleState {
  const parsed = JSON.parse(value) as Partial<FounderProductContractLifecycleState>;
  if (
    typeof parsed.runId !== "string" ||
    typeof parsed.sourceRevision !== "string" ||
    typeof parsed.userId !== "string" ||
    !Array.isArray(parsed.providerCalls) ||
    !parsed.providerCalls.every((call) => typeof call === "string") ||
    ![null, "owner_preview"].includes(parsed.releaseStage ?? null) ||
    ![null, "verified", "expired"].includes(parsed.entitlement ?? null) ||
    ![null, "verified", "failed"].includes(parsed.archive ?? null) ||
    !["present", "retired"].includes(parsed.infrastructure ?? "") ||
    typeof parsed.updatedAt !== "string"
  ) {
    throw new Error("Persisted Founder Product Contract lifecycle state is invalid.");
  }
  return parsed as FounderProductContractLifecycleState;
}
