import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, gte, isNull, lte, or } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import type * as schema from "@/src/server/db/schema";
import {
  operatorSupportAccessGrants,
  operatorSupportReceipts,
  operatorSupportRepairDecisions,
  operatorSupportRepairProposals,
  operatorSupportToolInvocations,
  operatorTroubleshootingEvidence,
  operatorTroubleshootingIncidents,
} from "@/src/server/db/schema";
import { ensureFounderOperatorForUser } from "@/src/server/operators/founder-operator";

type SupportTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

export const FOUNDER_SUPPORT_SCOPES = [
  "troubleshooting_evidence",
  "capability_status",
  "recovery_checkpoint",
] as const;
export type FounderSupportScope = (typeof FOUNDER_SUPPORT_SCOPES)[number];

export const FOUNDER_SUPPORT_TOOLS = [
  "read_troubleshooting_evidence",
  "read_capability_status",
  "read_recovery_checkpoint",
] as const;
export type FounderSupportTool = (typeof FOUNDER_SUPPORT_TOOLS)[number];

export const FOUNDER_SUPPORT_REPAIRS = [
  "rerun_verification",
  "restart_from_checkpoint",
  "replace_runtime_from_verified_release",
  "rotate_bruno_transport_credential",
] as const;
export type FounderSupportRepairKind = (typeof FOUNDER_SUPPORT_REPAIRS)[number];

const TOOL_SCOPE: Record<FounderSupportTool, FounderSupportScope> = {
  read_troubleshooting_evidence: "troubleshooting_evidence",
  read_capability_status: "capability_status",
  read_recovery_checkpoint: "recovery_checkpoint",
};

export type FounderSupportGrantDto = {
  id: string;
  incidentId: string;
  supportActor: { name: string; identity: string; mfaVerifiedAt: string };
  scope: FounderSupportScope;
  status: "active" | "revoked" | "expired";
  grantedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  receiptDigest: string;
  supportAccessToken?: string;
};

export type FounderSupportProposalDto = {
  id: string;
  incidentId: string;
  grantId: string;
  supportActorName: string;
  kind: FounderSupportRepairKind;
  target: Record<string, unknown>;
  proposalDigest: string;
  state:
    | "proposed"
    | "approved"
    | "declined"
    | "executing"
    | "succeeded"
    | "failed"
    | "outcome_uncertain"
    | "closed_without_recovery";
  decisionKind: "approve" | "decline" | null;
  decidedAt: string | null;
  verification: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

export type FounderSupportDto = {
  grants: FounderSupportGrantDto[];
  proposals: FounderSupportProposalDto[];
  tools: readonly FounderSupportTool[];
  repairs: readonly FounderSupportRepairKind[];
};

export type FounderSupportDependencies = {
  createConnection?: () => DatabaseConnection;
  now?: () => Date;
  randomUUID?: () => string;
  executeRepair?: (input: {
    kind: FounderSupportRepairKind;
    target: Record<string, unknown>;
    operatorId: string;
  }) => Promise<FounderSupportRepairExecution>;
};

export type FounderSupportRepairExecution = {
  liveCheckPassed: boolean;
  capability: string;
  summary: string;
};

export class FounderSupportError extends Error {
  readonly code:
    | "invalid_grant"
    | "grant_not_found"
    | "grant_expired"
    | "grant_revoked"
    | "scope_denied"
    | "proposal_not_found"
    | "decision_conflict"
    | "proposal_not_approved"
    | "invalid_repair";
  readonly status: 400 | 404 | 409;

  constructor(
    code: FounderSupportError["code"],
    message: string,
    status: FounderSupportError["status"] = 400,
  ) {
    super(message);
    this.name = "FounderSupportError";
    this.code = code;
    this.status = status;
  }
}

export async function getFounderSupportForUser(
  userId: string,
  dependencies: FounderSupportDependencies = {},
): Promise<FounderSupportDto> {
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  return withConnection(dependencies, async (connection) =>
    connection.db.transaction(async (tx) => {
      const now = dependencies.now?.() ?? new Date();
      await expireGrants(tx, operator.id, now);
      const grants = await tx
        .select()
        .from(operatorSupportAccessGrants)
        .where(eq(operatorSupportAccessGrants.operatorId, operator.id))
        .orderBy(desc(operatorSupportAccessGrants.createdAt));
      const proposals = await tx
        .select()
        .from(operatorSupportRepairProposals)
        .where(eq(operatorSupportRepairProposals.operatorId, operator.id))
        .orderBy(desc(operatorSupportRepairProposals.createdAt));
      const receiptRows = await tx
        .select({
          grantId: operatorSupportReceipts.grantId,
          digest: operatorSupportReceipts.digest,
        })
        .from(operatorSupportReceipts)
        .where(
          and(
            eq(operatorSupportReceipts.operatorId, operator.id),
            eq(operatorSupportReceipts.kind, "grant_created"),
          ),
        );
      const receiptByGrant = new Map(receiptRows.map((row) => [row.grantId, row.digest]));
      return {
        grants: grants.map((grant) =>
          toGrantDto(grant, receiptByGrant.get(grant.id) ?? `sha256:${"0".repeat(64)}`),
        ),
        proposals: proposals.map(toProposalDto),
        tools: FOUNDER_SUPPORT_TOOLS,
        repairs: FOUNDER_SUPPORT_REPAIRS,
      };
    }),
  );
}

export async function createFounderSupportAccessGrantForUser(
  userId: string,
  input: {
    incidentId: string;
    supportActorName: string;
    supportActorIdentity: string;
    mfaAuthenticated: boolean;
    scope: FounderSupportScope;
    ttlMinutes: number;
  },
  dependencies: FounderSupportDependencies = {},
): Promise<FounderSupportGrantDto> {
  validateScope(input.scope);
  const actorName = normalizeText(input.supportActorName, 160);
  const actorIdentity = normalizeText(input.supportActorIdentity, 240);
  if (!actorName || !actorIdentity || input.mfaAuthenticated !== true) {
    throw new FounderSupportError(
      "invalid_grant",
      "Name one MFA-authenticated support actor before granting access.",
    );
  }
  const ttl = Number(input.ttlMinutes);
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 60) {
    throw new FounderSupportError("invalid_grant", "Support access must expire within 60 minutes.");
  }
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  return withConnection(dependencies, (connection) =>
    connection.db.transaction(async (tx) => {
      const now = dependencies.now?.() ?? new Date();
      const [incident] = await tx
        .select()
        .from(operatorTroubleshootingIncidents)
        .where(
          and(
            eq(operatorTroubleshootingIncidents.id, input.incidentId),
            eq(operatorTroubleshootingIncidents.operatorId, operator.id),
          ),
        )
        .limit(1);
      if (!incident)
        throw new FounderSupportError(
          "grant_not_found",
          "Troubleshooting Incident was not found.",
          404,
        );
      if (!incident.supportCaseApprovedAt || incident.status !== "open") {
        throw new FounderSupportError(
          "invalid_grant",
          "Approve an open Support Case before granting access.",
        );
      }
      const [existing] = await tx
        .select()
        .from(operatorSupportAccessGrants)
        .where(
          and(
            eq(operatorSupportAccessGrants.incidentId, incident.id),
            eq(operatorSupportAccessGrants.status, "active"),
          ),
        )
        .limit(1);
      if (existing && existing.expiresAt > now) {
        return toGrantDto(existing, await grantReceiptDigest(tx, operator.id, existing.id));
      }
      if (existing) {
        await tx
          .update(operatorSupportAccessGrants)
          .set({ status: "expired" })
          .where(eq(operatorSupportAccessGrants.id, existing.id));
      }
      const id = (dependencies.randomUUID ?? randomUUID)();
      const expiresAt = new Date(now.getTime() + ttl * 60_000);
      const supportAccessToken = randomBytes(32).toString("base64url");
      const digest = digestFor({
        kind: "grant",
        id,
        incidentId: incident.id,
        actorName,
        actorIdentity,
        scope: input.scope,
        grantedAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
      });
      const [grant] = await tx
        .insert(operatorSupportAccessGrants)
        .values({
          id,
          operatorId: operator.id,
          incidentId: incident.id,
          supportActorName: actorName,
          supportActorIdentity: actorIdentity,
          supportActorMfaVerifiedAt: now,
          accessTokenHash: hashToken(supportAccessToken),
          accessTokenPrefix: supportAccessToken.slice(0, 12),
          scope: input.scope,
          status: "active",
          grantedAt: now,
          expiresAt,
          createdAt: now,
        })
        .returning();
      if (!grant)
        throw new FounderSupportError("invalid_grant", "Support access could not be created.");
      await tx.insert(operatorSupportReceipts).values({
        id: (dependencies.randomUUID ?? randomUUID)(),
        operatorId: operator.id,
        grantId: id,
        kind: "grant_created",
        digest,
        summary: {
          incidentId: incident.id,
          supportActorName: actorName,
          supportActorIdentity: actorIdentity,
          scope: input.scope,
          grantedAt: now.toISOString(),
          expiresAt: expiresAt.toISOString(),
        },
        createdAt: now,
      });
      return toGrantDto(grant, digest, supportAccessToken);
    }),
  );
}

export async function revokeFounderSupportAccessGrantForUser(
  userId: string,
  grantId: string,
  dependencies: FounderSupportDependencies = {},
): Promise<FounderSupportGrantDto> {
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  return withConnection(dependencies, (connection) =>
    connection.db.transaction(async (tx) => {
      const now = dependencies.now?.() ?? new Date();
      const [grant] = await tx
        .select()
        .from(operatorSupportAccessGrants)
        .where(
          and(
            eq(operatorSupportAccessGrants.id, grantId),
            eq(operatorSupportAccessGrants.operatorId, operator.id),
          ),
        )
        .limit(1);
      if (!grant)
        throw new FounderSupportError(
          "grant_not_found",
          "Support Access Grant was not found.",
          404,
        );
      if (grant.status === "active") {
        await tx
          .update(operatorSupportAccessGrants)
          .set({ status: "revoked", revokedAt: now })
          .where(eq(operatorSupportAccessGrants.id, grant.id));
        await tx.insert(operatorSupportReceipts).values({
          id: (dependencies.randomUUID ?? randomUUID)(),
          operatorId: operator.id,
          grantId: grant.id,
          kind: "grant_revoked",
          digest: digestFor({ kind: "revoke", grantId: grant.id, at: now.toISOString() }),
          summary: { grantId: grant.id, revokedAt: now.toISOString() },
          createdAt: now,
        });
        return toGrantDto(
          { ...grant, status: "revoked", revokedAt: now },
          await grantReceiptDigest(tx, operator.id, grant.id),
        );
      }
      return toGrantDto(grant, await grantReceiptDigest(tx, operator.id, grant.id));
    }),
  );
}

export async function invokeFounderSupportTool(
  grantId: string,
  input: {
    tool: FounderSupportTool;
    incidentId: string;
    supportActorIdentity: string;
    supportAccessToken: string;
    arguments?: Record<string, unknown>;
  },
  dependencies: FounderSupportDependencies = {},
): Promise<Record<string, unknown>> {
  if (!FOUNDER_SUPPORT_TOOLS.includes(input.tool))
    throw new FounderSupportError("scope_denied", "Support tool is not allowlisted.");
  const requiredScope = TOOL_SCOPE[input.tool];
  let expired = false;
  const result = await withConnection(dependencies, (connection) =>
    connection.db.transaction(async (tx) => {
      const now = dependencies.now?.() ?? new Date();
      const [grant] = await tx
        .select()
        .from(operatorSupportAccessGrants)
        .where(eq(operatorSupportAccessGrants.id, grantId))
        .limit(1);
      if (!grant)
        throw new FounderSupportError(
          "grant_not_found",
          "Support Access Grant was not found.",
          404,
        );
      if (grant.status === "active" && grant.expiresAt <= now) {
        await tx
          .update(operatorSupportAccessGrants)
          .set({ status: "expired" })
          .where(eq(operatorSupportAccessGrants.id, grant.id));
        expired = true;
        return {};
      }
      if (grant.status === "expired")
        throw new FounderSupportError("grant_expired", "Support Access Grant has expired.", 409);
      if (grant.status === "revoked")
        throw new FounderSupportError(
          "grant_revoked",
          "Support Access Grant has been revoked.",
          409,
        );
      if (
        input.supportActorIdentity !== grant.supportActorIdentity ||
        hashToken(input.supportAccessToken) !== grant.accessTokenHash
      )
        throw new FounderSupportError(
          "scope_denied",
          "The named MFA-authenticated support actor is required.",
          409,
        );
      if (grant.scope !== requiredScope)
        throw new FounderSupportError(
          "scope_denied",
          "This Support Access Grant does not include that read-only scope.",
          409,
        );
      if (grant.incidentId !== input.incidentId)
        throw new FounderSupportError(
          "scope_denied",
          "Support access is limited to the named Troubleshooting Incident.",
          409,
        );
      const args = input.arguments ?? {};
      await tx.insert(operatorSupportToolInvocations).values({
        id: (dependencies.randomUUID ?? randomUUID)(),
        operatorId: grant.operatorId,
        grantId: grant.id,
        tool: input.tool,
        argumentDigest: digestFor(args),
        outcome: "allowlisted",
        createdAt: now,
      });
      await tx.insert(operatorSupportReceipts).values({
        id: (dependencies.randomUUID ?? randomUUID)(),
        operatorId: grant.operatorId,
        grantId: grant.id,
        kind: "tool_invoked",
        digest: digestFor({ grantId, tool: input.tool, args }),
        summary: { tool: input.tool, incidentId: input.incidentId, scope: grant.scope },
        createdAt: now,
      });
      // The returned surface is intentionally sanitized and never exposes raw rows.
      if (input.tool === "read_troubleshooting_evidence") {
        const view = await getFounderTroubleshootingForUserByOperator(
          tx,
          grant.operatorId,
          input.incidentId,
          now,
        );
        return { incidentId: input.incidentId, evidence: view };
      }
      if (input.tool === "read_capability_status")
        return { incidentId: input.incidentId, status: "available_for_founder_verification" };
      return { incidentId: input.incidentId, checkpoint: "checkpoint_identity_is_founder_only" };
    }),
  );
  if (expired)
    throw new FounderSupportError("grant_expired", "Support Access Grant has expired.", 409);
  return result;
}

export async function createFounderRepairProposalForSupport(
  grantId: string,
  input: {
    incidentId: string;
    kind: FounderSupportRepairKind;
    target: Record<string, unknown>;
    supportActorIdentity: string;
    supportAccessToken: string;
  },
  dependencies: FounderSupportDependencies = {},
): Promise<FounderSupportProposalDto> {
  if (!FOUNDER_SUPPORT_REPAIRS.includes(input.kind))
    throw new FounderSupportError("invalid_repair", "Repair is not in the typed catalogue.");
  const operator = await loadActiveGrant(grantId, input.incidentId, dependencies);
  return withConnection(dependencies, (connection) =>
    connection.db.transaction(async (tx) => {
      const now = dependencies.now?.() ?? new Date();
      const [grant] = await tx
        .select()
        .from(operatorSupportAccessGrants)
        .where(eq(operatorSupportAccessGrants.id, grantId))
        .limit(1);
      if (!grant || grant.operatorId !== operator.operatorId)
        throw new FounderSupportError(
          "grant_not_found",
          "Support Access Grant was not found.",
          404,
        );
      if (grant.status !== "active" || grant.expiresAt <= now)
        throw new FounderSupportError(
          "grant_expired",
          "Support Access Grant is no longer active.",
          409,
        );
      if (
        input.supportActorIdentity !== grant.supportActorIdentity ||
        hashToken(input.supportAccessToken) !== grant.accessTokenHash
      )
        throw new FounderSupportError(
          "scope_denied",
          "The named MFA-authenticated support actor is required.",
          409,
        );
      const target = sanitizeTarget(input.kind, input.target);
      const proposalDigest = digestFor({ kind: input.kind, incidentId: input.incidentId, target });
      const [existing] = await tx
        .select()
        .from(operatorSupportRepairProposals)
        .where(
          and(
            eq(operatorSupportRepairProposals.grantId, grantId),
            eq(operatorSupportRepairProposals.proposalDigest, proposalDigest),
          ),
        )
        .limit(1);
      if (existing) return toProposalDto(existing);
      const id = (dependencies.randomUUID ?? randomUUID)();
      const [proposal] = await tx
        .insert(operatorSupportRepairProposals)
        .values({
          id,
          operatorId: grant.operatorId,
          incidentId: input.incidentId,
          grantId,
          supportActorName: grant.supportActorName,
          kind: input.kind,
          target,
          proposalDigest,
          state: "proposed",
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!proposal)
        throw new FounderSupportError("invalid_repair", "Repair Proposal could not be created.");
      await tx.insert(operatorSupportReceipts).values({
        id: (dependencies.randomUUID ?? randomUUID)(),
        operatorId: grant.operatorId,
        grantId,
        repairProposalId: id,
        kind: "proposal_created",
        digest: proposalDigest,
        summary: { proposalId: id, kind: input.kind, target },
        createdAt: now,
      });
      return toProposalDto(proposal);
    }),
  );
}

export async function decideFounderRepairProposalForUser(
  userId: string,
  input: { proposalId: string; proposalDigest: string; decision: "approve" | "decline" },
  dependencies: FounderSupportDependencies = {},
): Promise<FounderSupportProposalDto> {
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  return withConnection(dependencies, (connection) =>
    connection.db.transaction(async (tx) => {
      const now = dependencies.now?.() ?? new Date();
      const [proposal] = await tx
        .select()
        .from(operatorSupportRepairProposals)
        .where(
          and(
            eq(operatorSupportRepairProposals.id, input.proposalId),
            eq(operatorSupportRepairProposals.operatorId, operator.id),
          ),
        )
        .limit(1);
      if (!proposal)
        throw new FounderSupportError("proposal_not_found", "Repair Proposal was not found.", 404);
      if (proposal.proposalDigest !== input.proposalDigest)
        throw new FounderSupportError(
          "decision_conflict",
          "The Repair Proposal changed; review the exact proposal again.",
          409,
        );
      if (proposal.state !== "proposed")
        throw new FounderSupportError(
          "decision_conflict",
          "The first Founder decision already won.",
          409,
        );
      try {
        await tx.insert(operatorSupportRepairDecisions).values({
          id: (dependencies.randomUUID ?? randomUUID)(),
          proposalId: proposal.id,
          operatorId: operator.id,
          kind: input.decision,
          proposalDigest: proposal.proposalDigest,
          createdAt: now,
        });
      } catch {
        throw new FounderSupportError(
          "decision_conflict",
          "The first Founder decision already won.",
          409,
        );
      }
      const state = input.decision === "approve" ? "approved" : "declined";
      const [updated] = await tx
        .update(operatorSupportRepairProposals)
        .set({ state, decisionKind: input.decision, decidedAt: now, updatedAt: now })
        .where(
          and(
            eq(operatorSupportRepairProposals.id, proposal.id),
            eq(operatorSupportRepairProposals.state, "proposed"),
          ),
        )
        .returning();
      if (!updated)
        throw new FounderSupportError(
          "decision_conflict",
          "The first Founder decision already won.",
          409,
        );
      await tx.insert(operatorSupportReceipts).values({
        id: (dependencies.randomUUID ?? randomUUID)(),
        operatorId: operator.id,
        grantId: proposal.grantId,
        repairProposalId: proposal.id,
        kind: "decision_recorded",
        digest: digestFor({
          proposalId: proposal.id,
          decision: input.decision,
          proposalDigest: proposal.proposalDigest,
        }),
        summary: {
          proposalId: proposal.id,
          decision: input.decision,
          decidedAt: now.toISOString(),
        },
        createdAt: now,
      });
      return toProposalDto(updated);
    }),
  );
}

export async function executeFounderRepairProposalForUser(
  userId: string,
  proposalId: string,
  dependencies: FounderSupportDependencies = {},
): Promise<FounderSupportProposalDto> {
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    const proposal = await connection.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(operatorSupportRepairProposals)
        .where(
          and(
            eq(operatorSupportRepairProposals.id, proposalId),
            eq(operatorSupportRepairProposals.operatorId, operator.id),
          ),
        )
        .limit(1);
      if (!current)
        throw new FounderSupportError("proposal_not_found", "Repair Proposal was not found.", 404);
      if (current.state !== "approved")
        throw new FounderSupportError(
          "proposal_not_approved",
          "Only an approved Repair Proposal can run.",
          409,
        );
      const [claimed] = await tx
        .update(operatorSupportRepairProposals)
        .set({ state: "executing", updatedAt: dependencies.now?.() ?? new Date() })
        .where(
          and(
            eq(operatorSupportRepairProposals.id, proposalId),
            eq(operatorSupportRepairProposals.state, "approved"),
          ),
        )
        .returning();
      if (!claimed)
        throw new FounderSupportError(
          "proposal_not_approved",
          "Repair Proposal is already executing or complete.",
          409,
        );
      return claimed;
    });
    let execution: FounderSupportRepairExecution;
    let executionUncertain = false;
    try {
      execution = dependencies.executeRepair
        ? await dependencies.executeRepair({
            kind: proposal.kind,
            target: proposal.target,
            operatorId: operator.id,
          })
        : {
            liveCheckPassed: false,
            capability: "unknown",
            summary: "No live recovery adapter was available.",
          };
    } catch {
      executionUncertain = true;
      execution = {
        liveCheckPassed: false,
        capability: "unknown",
        summary: "Repair execution outcome is uncertain; no recovery is claimed.",
      };
    }
    const now = dependencies.now?.() ?? new Date();
    const liveCheckPassed =
      execution.liveCheckPassed === true &&
      typeof execution.capability === "string" &&
      execution.capability.trim().length > 0 &&
      typeof execution.summary === "string" &&
      execution.summary.trim().length > 0;
    const state = executionUncertain
      ? "outcome_uncertain"
      : liveCheckPassed
        ? "succeeded"
        : "closed_without_recovery";
    const verification = {
      liveCheckPassed,
      capability: execution.capability,
      summary: execution.summary,
    };
    const result = await connection.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(operatorSupportRepairProposals)
        .set({ state, verification, closedAt: now, updatedAt: now })
        .where(
          and(
            eq(operatorSupportRepairProposals.id, proposalId),
            eq(operatorSupportRepairProposals.state, "executing"),
          ),
        )
        .returning();
      if (!updated)
        throw new FounderSupportError(
          "proposal_not_found",
          "Repair Proposal could not be finalized.",
          404,
        );
      await tx.insert(operatorSupportReceipts).values({
        id: (dependencies.randomUUID ?? randomUUID)(),
        operatorId: operator.id,
        grantId: updated.grantId,
        repairProposalId: updated.id,
        kind: "repair_executed",
        digest: digestFor({ proposalId: updated.id, state, verification }),
        summary: { proposalId: updated.id, state, verification },
        createdAt: now,
      });
      return updated;
    });
    return toProposalDto(result);
  } finally {
    if (ownsConnection) await connection.close();
  }
}

async function loadActiveGrant(
  grantId: string,
  incidentId: string,
  dependencies: FounderSupportDependencies,
): Promise<{ operatorId: string }> {
  let expired = false;
  const result = await withConnection(dependencies, (connection) =>
    connection.db.transaction(async (tx) => {
      const now = dependencies.now?.() ?? new Date();
      const [grant] = await tx
        .select()
        .from(operatorSupportAccessGrants)
        .where(
          and(
            eq(operatorSupportAccessGrants.id, grantId),
            eq(operatorSupportAccessGrants.incidentId, incidentId),
          ),
        )
        .limit(1);
      if (!grant)
        throw new FounderSupportError(
          "grant_not_found",
          "Support Access Grant was not found.",
          404,
        );
      if (grant.status === "active" && grant.expiresAt <= now) {
        await tx
          .update(operatorSupportAccessGrants)
          .set({ status: "expired" })
          .where(eq(operatorSupportAccessGrants.id, grant.id));
        expired = true;
        return { operatorId: grant.operatorId };
      }
      if (grant.status === "expired")
        throw new FounderSupportError("grant_expired", "Support Access Grant has expired.", 409);
      if (grant.status === "revoked")
        throw new FounderSupportError(
          "grant_revoked",
          "Support Access Grant has been revoked.",
          409,
        );
      return { operatorId: grant.operatorId };
    }),
  );
  if (expired)
    throw new FounderSupportError("grant_expired", "Support Access Grant has expired.", 409);
  return result;
}

async function expireGrants(tx: SupportTransaction, operatorId: string, now: Date): Promise<void> {
  await tx
    .update(operatorSupportAccessGrants)
    .set({ status: "expired" })
    .where(
      and(
        eq(operatorSupportAccessGrants.operatorId, operatorId),
        eq(operatorSupportAccessGrants.status, "active"),
        lte(operatorSupportAccessGrants.expiresAt, now),
      ),
    );
}

async function grantReceiptDigest(
  tx: SupportTransaction,
  operatorId: string,
  grantId: string,
): Promise<string> {
  const [row] = await tx
    .select({ digest: operatorSupportReceipts.digest })
    .from(operatorSupportReceipts)
    .where(
      and(
        eq(operatorSupportReceipts.operatorId, operatorId),
        eq(operatorSupportReceipts.grantId, grantId),
        eq(operatorSupportReceipts.kind, "grant_created"),
      ),
    )
    .limit(1);
  return row?.digest ?? `sha256:${"0".repeat(64)}`;
}

async function getFounderTroubleshootingForUserByOperator(
  tx: SupportTransaction,
  operatorId: string,
  incidentId: string,
  now: Date,
): Promise<Record<string, unknown>> {
  const [incident] = await tx
    .select({
      id: operatorTroubleshootingIncidents.id,
      impactSummary: operatorTroubleshootingIncidents.impactSummary,
      affectedCapabilities: operatorTroubleshootingIncidents.affectedCapabilities,
      unaffectedCapabilities: operatorTroubleshootingIncidents.unaffectedCapabilities,
      status: operatorTroubleshootingIncidents.status,
    })
    .from(operatorTroubleshootingIncidents)
    .where(
      and(
        eq(operatorTroubleshootingIncidents.id, incidentId),
        eq(operatorTroubleshootingIncidents.operatorId, operatorId),
      ),
    )
    .limit(1);
  if (!incident)
    throw new FounderSupportError(
      "grant_not_found",
      "Troubleshooting Incident was not found.",
      404,
    );
  const evidence = await tx
    .select({
      kind: operatorTroubleshootingEvidence.kind,
      payload: operatorTroubleshootingEvidence.payload,
      capturedAt: operatorTroubleshootingEvidence.capturedAt,
      expiresAt: operatorTroubleshootingEvidence.expiresAt,
    })
    .from(operatorTroubleshootingEvidence)
    .where(
      and(
        eq(operatorTroubleshootingEvidence.incidentId, incident.id),
        or(
          isNull(operatorTroubleshootingEvidence.expiresAt),
          gte(operatorTroubleshootingEvidence.expiresAt, now),
        ),
      ),
    )
    .orderBy(operatorTroubleshootingEvidence.capturedAt);
  return {
    ...incident,
    evidence: evidence.map((item) => ({
      kind: item.kind,
      payload: item.payload,
      capturedAt: item.capturedAt.toISOString(),
      expiresAt: item.expiresAt?.toISOString() ?? null,
    })),
  };
}

function validateScope(scope: string): asserts scope is FounderSupportScope {
  if (!FOUNDER_SUPPORT_SCOPES.includes(scope as FounderSupportScope))
    throw new FounderSupportError("invalid_grant", "Choose one exact read-only support scope.");
}

function sanitizeTarget(
  kind: FounderSupportRepairKind,
  target: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = new Set(
    kind === "restart_from_checkpoint"
      ? ["checkpointId"]
      : kind === "replace_runtime_from_verified_release"
        ? ["releaseId", "checkpointId"]
        : kind === "rerun_verification"
          ? ["capability"]
          : ["transport"],
  );
  const result: Record<string, unknown> = {};
  for (const key of allowed) {
    const value = target[key];
    if (typeof value === "string" && value.trim().length > 0 && value.length <= 240)
      result[key] = value.trim();
  }
  if (
    kind === "rerun_verification" &&
    ![
      "ai",
      "calendar",
      "mail",
      "mail_sending",
      "brief",
      "conversation",
      "external_effect",
    ].includes(String(result.capability))
  ) {
    throw new FounderSupportError(
      "invalid_repair",
      "Verification must name one affected business capability.",
    );
  }
  if (
    kind === "replace_runtime_from_verified_release" &&
    result.releaseId &&
    !/^verified(?:-release)?:[A-Za-z0-9._-]+$/.test(String(result.releaseId))
  ) {
    throw new FounderSupportError(
      "invalid_repair",
      "Runtime replacement requires a Verified Release identity.",
    );
  }
  if (
    kind === "replace_runtime_from_verified_release" &&
    result.checkpointId &&
    !/^checkpoint[:_-][A-Za-z0-9._-]+$/.test(String(result.checkpointId))
  ) {
    throw new FounderSupportError(
      "invalid_repair",
      "Runtime replacement requires a named checkpoint identity.",
    );
  }
  if (
    kind === "rotate_bruno_transport_credential" &&
    !["bruno_transport", "hermes_qstash"].includes(String(result.transport))
  ) {
    throw new FounderSupportError(
      "invalid_repair",
      "Credential rotation is limited to a Bruno-owned transport.",
    );
  }
  if (Object.keys(result).length === 0)
    throw new FounderSupportError(
      "invalid_repair",
      "A precise typed Repair Proposal target is required.",
    );
  return result;
}

function normalizeText(value: string, max: number): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length > 0 && normalized.length <= max ? normalized : null;
}

function digestFor(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(value, Object.keys((value ?? {}) as object).sort()))
    .digest("hex")}`;
}

function hashToken(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function toGrantDto(
  row: typeof operatorSupportAccessGrants.$inferSelect,
  receiptDigest: string,
  supportAccessToken?: string,
): FounderSupportGrantDto {
  return {
    id: row.id,
    incidentId: row.incidentId,
    supportActor: {
      name: row.supportActorName,
      identity: row.supportActorIdentity,
      mfaVerifiedAt: row.supportActorMfaVerifiedAt.toISOString(),
    },
    scope: row.scope,
    status: row.status,
    grantedAt: row.grantedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    receiptDigest,
    ...(supportAccessToken ? { supportAccessToken } : {}),
  };
}

function toProposalDto(
  row: typeof operatorSupportRepairProposals.$inferSelect,
): FounderSupportProposalDto {
  return {
    id: row.id,
    incidentId: row.incidentId,
    grantId: row.grantId,
    supportActorName: row.supportActorName,
    kind: row.kind,
    target: row.target,
    proposalDigest: row.proposalDigest,
    state: row.state,
    decisionKind: row.decisionKind,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    verification: row.verification,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function withConnection<T>(
  dependencies: FounderSupportDependencies,
  operation: (connection: DatabaseConnection) => Promise<T>,
): Promise<T> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    return await operation(connection);
  } finally {
    if (ownsConnection) await connection.close();
  }
}
