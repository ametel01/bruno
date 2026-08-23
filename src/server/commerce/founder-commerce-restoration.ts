import "server-only";

import { createHash } from "node:crypto";
import { and, eq, gte } from "drizzle-orm";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  operatorAiConnectionReceipts,
  operatorAiConnections,
  operatorCalendarConnectionReceipts,
  operatorCalendarConnections,
  operatorMailConnectionReceipts,
  operatorMailConnections,
  runners,
} from "@/src/server/db/schema";
import { readDigitalOceanProviderConfig } from "@/src/server/env";
import { createEncryptedFounderRecoveryArchiveProvider } from "@/src/server/founder-product-contract/encrypted-recovery-archive-provider";
import type {
  FounderRestorationInfrastructureIdentity,
  FounderReturningRestorationProvider,
} from "@/src/server/founder-product-contract/returning-founder-restoration";
import type {
  DigitalOceanOwnedSetExpectation,
  DigitalOceanOwnedSetProvider,
  DigitalOceanProvider,
} from "@/src/server/runners/digitalocean-provider";
import {
  createConfiguredDigitalOceanProvider,
  createDigitalOceanRunnerForUser,
  digitalOceanRunnerFirewallName,
} from "@/src/server/runners/runner-provisioning";
import type { LemonSqueezyCommerceProvider } from "./lemon-squeezy-provider";

type InfrastructureOutcome = Awaited<
  ReturnType<FounderReturningRestorationProvider["provisionNewInfrastructure"]>
>;

export function createConfiguredFounderReturningRestorationProvider(input: {
  commerceProvider: LemonSqueezyCommerceProvider;
  createConnection?: () => DatabaseConnection;
  createDigitalOcean?: (
    config: NonNullable<ReturnType<typeof readDigitalOceanProviderConfig>>,
  ) => DigitalOceanProvider & DigitalOceanOwnedSetProvider;
  env?: Record<string, string | undefined>;
}): FounderReturningRestorationProvider | null {
  const env = input.env ?? process.env;
  const archive = createEncryptedFounderRecoveryArchiveProvider(env);
  const config = readDigitalOceanProviderConfig(env);
  if (!archive && !config) return null;
  if (!archive || !config) {
    throw new Error("Returning Founder restoration providers must be configured together.");
  }
  const digitalOcean =
    input.createDigitalOcean?.(config) ??
    (createConfiguredDigitalOceanProvider(config) as DigitalOceanProvider &
      DigitalOceanOwnedSetProvider);
  if (!isOwnedSetProvider(digitalOcean)) {
    throw new Error("Returning Founder restoration requires exact owned-resource operations.");
  }
  const calls: string[] = [];
  const withConnection = async <T>(run: (connection: DatabaseConnection) => Promise<T>) => {
    const connection = input.createConnection?.() ?? createDatabaseConnection();
    const ownsConnection = !input.createConnection;
    try {
      return await run(connection);
    } finally {
      if (ownsConnection) await connection.close();
    }
  };
  const readInfrastructure = (runnerId: string, idempotencyKey: string) =>
    withConnection((connection) =>
      readRestorationInfrastructure(connection, runnerId, idempotencyKey),
    );

  return {
    verifyRecoveryArchive: (archiveInput) => archive.verifyRecoveryArchive(archiveInput),
    async provisionNewInfrastructure(provisioning) {
      calls.push("digitalOcean.create_restoration_runner");
      let result: Awaited<ReturnType<typeof createDigitalOceanRunnerForUser>>;
      try {
        result = await createDigitalOceanRunnerForUser(
          provisioning.userId,
          { provider: "digitalocean", name: `Restored Operator ${provisioning.operatorId}` },
          {
            provider: digitalOcean,
            readConfig: () => config,
            ...(input.createConnection ? { createConnection: input.createConnection } : {}),
          },
        );
      } catch {
        return { state: "pending", value: null };
      }
      if (!result.ok) {
        return { state: "failed", code: "restoration_provider_unavailable", partial: null };
      }
      return await readInfrastructure(result.runner.id, provisioning.idempotencyKey);
    },
    async observeNewInfrastructure(provisioning) {
      calls.push("digitalOcean.observe_restoration_runner");
      return await readInfrastructure(provisioning.runnerId, provisioning.idempotencyKey);
    },
    async reauthorizeAiProviders({ operatorId, requiredAfter }) {
      calls.push("providers.verify_ai_reauthorization");
      return await withConnection(async (connection) => ({
        openAI: await hasFreshAiReauthorization(connection, operatorId, "openai", requiredAfter),
        anthropic: await hasFreshAiReauthorization(
          connection,
          operatorId,
          "anthropic",
          requiredAfter,
        ),
      }));
    },
    async reauthorizeCompanyProviders({ operatorId, requiredAfter }) {
      calls.push("providers.verify_company_reauthorization");
      return await withConnection(async (connection) => ({
        calendar: await hasFreshCalendarReauthorization(connection, operatorId, requiredAfter),
        mail: await hasFreshMailReauthorization(connection, operatorId, requiredAfter),
      }));
    },
    async retireRestorationInfrastructure(infrastructure) {
      const expectation = restorationExpectation(infrastructure);
      calls.push("digitalOcean.observe_restoration_owned_set");
      let observed = await digitalOcean.observeOwnedSet(expectation);
      if (!observed.ok) throw new Error("Restoration Infrastructure ownership was inconclusive.");
      if (observed.value.firewall === "present") {
        calls.push("digitalOcean.delete_restoration_firewall");
        const deleted = await digitalOcean.deleteFirewall(expectation);
        if (!deleted.ok) throw new Error("Restoration firewall deletion was not confirmed.");
      }
      if (observed.value.droplet === "present") {
        calls.push("digitalOcean.delete_restoration_droplet");
        const deleted = await digitalOcean.deleteDroplet(expectation);
        if (!deleted.ok) throw new Error("Restoration Droplet deletion was not confirmed.");
      }
      calls.push("digitalOcean.verify_restoration_absence");
      observed = await digitalOcean.observeOwnedSet(expectation);
      if (
        !observed.ok ||
        observed.value.state !== "absent" ||
        observed.value.droplet !== "absent" ||
        observed.value.firewall !== "absent"
      ) {
        throw new Error("Restoration Infrastructure absence was not verified.");
      }
      return { dropletAbsent: true, firewallAbsent: true };
    },
    async refundRestorationPayment({ subscriptionId, orderId }) {
      calls.push("lemonSqueezy.refund_restoration");
      await input.commerceProvider.cancelSubscription({ subscriptionId });
      let order = await input.commerceProvider.readOrder({ orderId });
      if (order.status !== "refunded" || order.refundedAmount < order.total) {
        order = await input.commerceProvider.refundOrder({ orderId });
      }
      if (order.status !== "refunded" || order.refundedAmount < order.total) {
        throw new Error("Full restoration refund was not confirmed.");
      }
      return { fullRefundConfirmed: true };
    },
    calls: () => [...calls],
  };
}

async function readRestorationInfrastructure(
  connection: DatabaseConnection,
  runnerId: string,
  idempotencyKey: string,
): Promise<InfrastructureOutcome> {
  const [runner] = await connection.db
    .select()
    .from(runners)
    .where(eq(runners.id, runnerId))
    .limit(1);
  if (!runner) {
    return { state: "failed", code: "restoration_runner_missing", partial: null };
  }
  if (
    !runner.providerResourceId ||
    !runner.providerFirewallId ||
    !runner.endpointUrl ||
    !runner.provisioningOperationKey ||
    !runner.region ||
    !runner.sizeSlug ||
    !runner.image
  ) {
    return runner.provisioningStatus === "failed" || runner.provisioningStatus === "deleted"
      ? { state: "failed", code: "restoration_infrastructure_failed", partial: null }
      : { state: "pending", value: null };
  }
  const identity: FounderRestorationInfrastructureIdentity = {
    runnerId: runner.id,
    persistedRunner: true,
    providerResourceId: runner.providerResourceId,
    providerFirewallId: runner.providerFirewallId,
    endpointUrl: runner.endpointUrl,
    runtimeIdentity: `restored-runtime-${createHash("sha256")
      .update(`${idempotencyKey}:${runner.id}`)
      .digest("hex")
      .slice(0, 24)}`,
    operationTag: runner.provisioningOperationKey,
    name: runner.name,
    region: runner.region,
    sizeSlug: runner.sizeSlug,
    image: runner.image,
    createdAt: runner.createdAt,
  };
  if (runner.provisioningStatus === "failed" || runner.provisioningStatus === "deleted") {
    return { state: "failed", code: "restoration_infrastructure_failed", partial: identity };
  }
  return { state: runner.provisioningStatus === "ready" ? "ready" : "pending", value: identity };
}

async function hasFreshAiReauthorization(
  connection: DatabaseConnection,
  operatorId: string,
  provider: "openai" | "anthropic",
  requiredAfter: Date,
): Promise<boolean> {
  const [receipt] = await connection.db
    .select({ id: operatorAiConnectionReceipts.id })
    .from(operatorAiConnections)
    .innerJoin(
      operatorAiConnectionReceipts,
      eq(operatorAiConnectionReceipts.connectionId, operatorAiConnections.id),
    )
    .where(
      and(
        eq(operatorAiConnections.operatorId, operatorId),
        eq(operatorAiConnections.provider, provider),
        eq(operatorAiConnections.status, "ready"),
        eq(operatorAiConnectionReceipts.kind, "reauthorized"),
        eq(operatorAiConnectionReceipts.status, "ready"),
        gte(operatorAiConnectionReceipts.createdAt, requiredAfter),
      ),
    )
    .limit(1);
  return receipt !== undefined;
}

async function hasFreshCalendarReauthorization(
  connection: DatabaseConnection,
  operatorId: string,
  requiredAfter: Date,
): Promise<boolean> {
  const [receipt] = await connection.db
    .select({ id: operatorCalendarConnectionReceipts.id })
    .from(operatorCalendarConnections)
    .innerJoin(
      operatorCalendarConnectionReceipts,
      eq(operatorCalendarConnectionReceipts.connectionId, operatorCalendarConnections.id),
    )
    .where(
      and(
        eq(operatorCalendarConnections.operatorId, operatorId),
        eq(operatorCalendarConnections.status, "ready"),
        eq(operatorCalendarConnectionReceipts.kind, "reauthorized"),
        eq(operatorCalendarConnectionReceipts.status, "ready"),
        gte(operatorCalendarConnectionReceipts.createdAt, requiredAfter),
      ),
    )
    .limit(1);
  return receipt !== undefined;
}

async function hasFreshMailReauthorization(
  connection: DatabaseConnection,
  operatorId: string,
  requiredAfter: Date,
): Promise<boolean> {
  const [receipt] = await connection.db
    .select({ id: operatorMailConnectionReceipts.id })
    .from(operatorMailConnections)
    .innerJoin(
      operatorMailConnectionReceipts,
      eq(operatorMailConnectionReceipts.connectionId, operatorMailConnections.id),
    )
    .where(
      and(
        eq(operatorMailConnections.operatorId, operatorId),
        eq(operatorMailConnections.status, "ready"),
        eq(operatorMailConnectionReceipts.kind, "reauthorized"),
        eq(operatorMailConnectionReceipts.status, "ready"),
        gte(operatorMailConnectionReceipts.createdAt, requiredAfter),
      ),
    )
    .limit(1);
  return receipt !== undefined;
}

function restorationExpectation(
  identity: FounderRestorationInfrastructureIdentity,
): DigitalOceanOwnedSetExpectation {
  return {
    operationTag: identity.operationTag,
    providerResourceId: identity.providerResourceId,
    providerFirewallId: identity.providerFirewallId,
    expectedName: identity.name,
    expectedRegion: identity.region,
    expectedSizeSlug: identity.sizeSlug,
    expectedFirewallName: digitalOceanRunnerFirewallName(identity.providerResourceId),
  };
}

function isOwnedSetProvider(
  provider: DigitalOceanProvider,
): provider is DigitalOceanProvider & DigitalOceanOwnedSetProvider {
  const candidate = provider as Partial<DigitalOceanOwnedSetProvider>;
  return (
    typeof candidate.observeOwnedSet === "function" &&
    typeof candidate.deleteFirewall === "function" &&
    typeof candidate.deleteDroplet === "function"
  );
}
