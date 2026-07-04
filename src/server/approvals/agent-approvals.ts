import { and, desc, eq, isNull } from "drizzle-orm";
import { isValidAgentId } from "@/src/server/agents/agent-id";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { type agentApprovalStatusEnum, agentApprovals, agents } from "@/src/server/db/schema";
import {
  recordAgentEventInTransaction,
  type AgentEventTransaction,
  type AgentEventWrite,
} from "@/src/server/events/agent-events";
import { getDevelopmentUserId } from "@/src/server/users/development-user";

export const APPROVAL_APPROVED_EVENT_TYPE = "approval.approved";
export const APPROVAL_DENIED_EVENT_TYPE = "approval.denied";

type AgentApprovalStatus = (typeof agentApprovalStatusEnum.enumValues)[number];
type ApprovalDecisionClock = () => Date;
type InsertApprovalDecisionEvent = (
  tx: AgentEventTransaction,
  event: AgentEventWrite,
) => Promise<void>;

export type PendingApprovalDto = {
  id: string;
  agentId: string;
  agentName: string;
  agentHref: string;
  title: string;
  description: string;
  status: "pending";
  requestedBy: string;
  payloadSummary: string;
  createdAt: string;
  expiresAt: string | null;
};

export type CreatePendingApprovalInput = {
  agentId: string;
  title: string;
  description: string;
  payloadJson: Record<string, unknown>;
  requestedBy: string;
  expiresAt?: Date | null;
  createdAt?: Date;
};

export type AgentApprovalDependencies = {
  createConnection?: () => DatabaseConnection;
};

export type ApprovalDecisionStatus = Exclude<AgentApprovalStatus, "pending">;

export type ApprovedApprovalDto = {
  id: string;
  agentId: string;
  agentName: string;
  title: string;
  status: "approved";
  resolvedBy: string;
  resolvedAt: string;
};

export type ApprovePendingApprovalResult =
  | {
      ok: true;
      approval: ApprovedApprovalDto;
      event: {
        type: typeof APPROVAL_APPROVED_EVENT_TYPE;
      };
    }
  | {
      ok: false;
      reason:
        | "missing_approval_id"
        | "malformed_approval_id"
        | "approval_not_found"
        | "approval_already_resolved";
      status?: ApprovalDecisionStatus;
    };

export type ApprovePendingApprovalDependencies = AgentApprovalDependencies & {
  now?: ApprovalDecisionClock;
  recordApprovedEvent?: InsertApprovalDecisionEvent;
};

export class AgentApprovalPersistenceError extends Error {
  constructor() {
    super("Approval request failed.");
    this.name = "AgentApprovalPersistenceError";
  }
}

export async function approvePendingApprovalForDevelopmentUser(
  approvalId: string,
  dependencies: ApprovePendingApprovalDependencies = {},
): Promise<ApprovePendingApprovalResult> {
  if (approvalId.length === 0) {
    return {
      ok: false,
      reason: "missing_approval_id",
    };
  }

  if (!isValidApprovalId(approvalId)) {
    return {
      ok: false,
      reason: "malformed_approval_id",
    };
  }

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  const recordApprovedEvent = dependencies.recordApprovedEvent ?? recordAgentEventInTransaction;

  try {
    return await connection.db.transaction(async (tx) => {
      const developmentUserId = await getDevelopmentUserId(tx);

      if (!developmentUserId) {
        return {
          ok: false as const,
          reason: "approval_not_found" as const,
        };
      }

      const approval = await selectScopedApproval(tx, approvalId, developmentUserId);

      if (!approval) {
        return {
          ok: false as const,
          reason: "approval_not_found" as const,
        };
      }

      if (approval.status !== "pending") {
        return {
          ok: false as const,
          reason: "approval_already_resolved" as const,
          status: approval.status,
        };
      }

      const resolvedAt = now();
      const [updatedApproval] = await tx
        .update(agentApprovals)
        .set({
          status: "approved",
          resolvedBy: developmentUserId,
          resolvedAt,
        })
        .where(and(eq(agentApprovals.id, approval.id), eq(agentApprovals.status, "pending")))
        .returning({
          id: agentApprovals.id,
          agentId: agentApprovals.agentId,
          title: agentApprovals.title,
          status: agentApprovals.status,
          resolvedBy: agentApprovals.resolvedBy,
          resolvedAt: agentApprovals.resolvedAt,
        });

      if (!updatedApproval) {
        const currentApproval = await selectScopedApproval(tx, approvalId, developmentUserId);

        if (!currentApproval) {
          return {
            ok: false as const,
            reason: "approval_not_found" as const,
          };
        }

        if (currentApproval.status !== "pending") {
          return {
            ok: false as const,
            reason: "approval_already_resolved" as const,
            status: currentApproval.status,
          };
        }

        throw new Error("Approval update returned no rows.");
      }

      if (!updatedApproval.resolvedBy || !updatedApproval.resolvedAt) {
        throw new Error("Approval update returned an incomplete row.");
      }

      await recordApprovedEvent(tx, {
        agentId: approval.agentId,
        actorUserId: developmentUserId,
        type: APPROVAL_APPROVED_EVENT_TYPE,
        message: `Approval "${approval.title}" approved for agent "${approval.agentName}".`,
        metadata: {
          approvalId: approval.id,
          agentId: approval.agentId,
          previousStatus: "pending",
          approvalStatus: "approved",
          decision: "approved",
          title: approval.title,
        },
      });

      return {
        ok: true as const,
        approval: {
          id: updatedApproval.id,
          agentId: updatedApproval.agentId,
          agentName: approval.agentName,
          title: updatedApproval.title,
          status: "approved" as const,
          resolvedBy: updatedApproval.resolvedBy,
          resolvedAt: updatedApproval.resolvedAt.toISOString(),
        },
        event: {
          type: APPROVAL_APPROVED_EVENT_TYPE,
        },
      };
    });
  } catch {
    throw new AgentApprovalPersistenceError();
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export type DenyApprovalResult =
  | {
      ok: true;
      approval: DeniedApprovalDto;
      event: {
        type: typeof APPROVAL_DENIED_EVENT_TYPE;
      };
    }
  | {
      ok: false;
      reason:
        | "missing_approval_id"
        | "malformed_approval_id"
        | "approval_not_found"
        | "approval_already_resolved";
      status?: ApprovalDecisionStatus;
    };

export type DeniedApprovalDto = {
  id: string;
  agentId: string;
  status: "denied";
  resolvedBy: string;
  resolvedAt: string;
};

export type DenyApprovalDependencies = AgentApprovalDependencies & {
  now?: ApprovalDecisionClock;
  insertDecisionEvent?: InsertApprovalDecisionEvent;
};

export async function createPendingApprovalForDevelopmentUser(
  input: CreatePendingApprovalInput,
  dependencies: AgentApprovalDependencies = {},
): Promise<PendingApprovalDto | null> {
  if (!isValidAgentId(input.agentId)) {
    return null;
  }

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    return await connection.db.transaction(async (tx) => {
      const developmentUserId = await getDevelopmentUserId(tx);

      if (!developmentUserId) {
        return null;
      }

      const [agent] = await tx
        .select({
          id: agents.id,
          name: agents.name,
        })
        .from(agents)
        .where(
          and(
            eq(agents.id, input.agentId),
            eq(agents.userId, developmentUserId),
            isNull(agents.deletedAt),
          ),
        )
        .limit(1);

      if (!agent) {
        return null;
      }

      const [approval] = await tx
        .insert(agentApprovals)
        .values({
          agentId: agent.id,
          title: input.title,
          description: input.description,
          status: "pending",
          payloadJson: input.payloadJson,
          requestedBy: input.requestedBy,
          resolvedBy: null,
          resolvedAt: null,
          createdAt: input.createdAt,
          expiresAt: input.expiresAt ?? null,
        })
        .returning();

      if (!approval) {
        throw new Error("Approval insert returned no rows.");
      }

      return toPendingApprovalDto(approval, agent);
    });
  } catch {
    throw new AgentApprovalPersistenceError();
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export async function listPendingApprovalsForDevelopmentUser(
  dependencies: AgentApprovalDependencies = {},
): Promise<PendingApprovalDto[]> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    const developmentUserId = await connection.db.transaction((tx) => getDevelopmentUserId(tx));

    if (!developmentUserId) {
      return [];
    }

    const rows = await connection.db
      .select({
        id: agentApprovals.id,
        agentId: agentApprovals.agentId,
        title: agentApprovals.title,
        description: agentApprovals.description,
        status: agentApprovals.status,
        payloadJson: agentApprovals.payloadJson,
        requestedBy: agentApprovals.requestedBy,
        createdAt: agentApprovals.createdAt,
        expiresAt: agentApprovals.expiresAt,
        agentName: agents.name,
      })
      .from(agentApprovals)
      .innerJoin(agents, eq(agents.id, agentApprovals.agentId))
      .where(
        and(
          eq(agentApprovals.status, "pending"),
          eq(agents.userId, developmentUserId),
          isNull(agents.deletedAt),
        ),
      )
      .orderBy(desc(agentApprovals.createdAt), desc(agentApprovals.id));

    return rows.map((row) => ({
      id: row.id,
      agentId: row.agentId,
      agentName: row.agentName,
      agentHref: `/agents/${row.agentId}`,
      title: row.title,
      description: row.description,
      status: "pending",
      requestedBy: row.requestedBy,
      payloadSummary: summarizeApprovalPayload(row.payloadJson),
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt?.toISOString() ?? null,
    }));
  } catch {
    throw new AgentApprovalPersistenceError();
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export async function listPendingApprovalsForDevelopmentUserAgent(
  agentId: string,
  dependencies: AgentApprovalDependencies = {},
): Promise<PendingApprovalDto[]> {
  if (!isValidAgentId(agentId)) {
    return [];
  }

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;

  try {
    const developmentUserId = await connection.db.transaction((tx) => getDevelopmentUserId(tx));

    if (!developmentUserId) {
      return [];
    }

    const rows = await connection.db
      .select({
        id: agentApprovals.id,
        agentId: agentApprovals.agentId,
        title: agentApprovals.title,
        description: agentApprovals.description,
        status: agentApprovals.status,
        payloadJson: agentApprovals.payloadJson,
        requestedBy: agentApprovals.requestedBy,
        createdAt: agentApprovals.createdAt,
        expiresAt: agentApprovals.expiresAt,
        agentName: agents.name,
      })
      .from(agentApprovals)
      .innerJoin(agents, eq(agents.id, agentApprovals.agentId))
      .where(
        and(
          eq(agentApprovals.agentId, agentId),
          eq(agentApprovals.status, "pending"),
          eq(agents.userId, developmentUserId),
          isNull(agents.deletedAt),
        ),
      )
      .orderBy(desc(agentApprovals.createdAt), desc(agentApprovals.id));

    return rows.map((row) => ({
      id: row.id,
      agentId: row.agentId,
      agentName: row.agentName,
      agentHref: `/agents/${row.agentId}`,
      title: row.title,
      description: row.description,
      status: "pending",
      requestedBy: row.requestedBy,
      payloadSummary: summarizeApprovalPayload(row.payloadJson),
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt?.toISOString() ?? null,
    }));
  } catch {
    throw new AgentApprovalPersistenceError();
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

export async function denyApprovalForDevelopmentUser(
  approvalId: string,
  dependencies: DenyApprovalDependencies = {},
): Promise<DenyApprovalResult> {
  const normalizedApprovalId = approvalId.trim();

  if (normalizedApprovalId.length === 0) {
    return { ok: false, reason: "missing_approval_id" };
  }

  if (!isValidAgentId(normalizedApprovalId)) {
    return { ok: false, reason: "malformed_approval_id" };
  }

  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  const insertDecisionEvent = dependencies.insertDecisionEvent ?? recordAgentEventInTransaction;

  try {
    return await connection.db.transaction(async (tx) => {
      const developmentUserId = await getDevelopmentUserId(tx);

      if (!developmentUserId) {
        return { ok: false, reason: "approval_not_found" };
      }

      const current = await selectScopedApproval(tx, normalizedApprovalId, developmentUserId);

      if (!current) {
        return { ok: false, reason: "approval_not_found" };
      }

      if (current.status !== "pending") {
        return {
          ok: false,
          reason: "approval_already_resolved",
          status: current.status,
        };
      }

      const [denied] = await tx
        .update(agentApprovals)
        .set({
          status: "denied",
          resolvedBy: developmentUserId,
          resolvedAt: now(),
        })
        .where(
          and(eq(agentApprovals.id, normalizedApprovalId), eq(agentApprovals.status, "pending")),
        )
        .returning({
          id: agentApprovals.id,
          agentId: agentApprovals.agentId,
          status: agentApprovals.status,
          resolvedBy: agentApprovals.resolvedBy,
          resolvedAt: agentApprovals.resolvedAt,
        });

      if (!denied) {
        const currentApproval = await selectScopedApproval(
          tx,
          normalizedApprovalId,
          developmentUserId,
        );

        if (!currentApproval) {
          return {
            ok: false,
            reason: "approval_not_found",
          };
        }

        if (currentApproval.status !== "pending") {
          return {
            ok: false,
            reason: "approval_already_resolved",
            status: currentApproval.status,
          };
        }

        throw new Error("Approval deny update returned no rows.");
      }

      await insertDecisionEvent(tx, {
        agentId: denied.agentId,
        actorUserId: developmentUserId,
        type: APPROVAL_DENIED_EVENT_TYPE,
        message: `Denied approval "${current.title}" for agent "${current.agentName}".`,
        metadata: {
          approvalId: denied.id,
          agentId: denied.agentId,
          fromStatus: "pending",
          toStatus: "denied",
          previousStatus: "pending",
          newStatus: "denied",
          approvalTitle: current.title,
        },
      });

      if (denied.status !== "denied" || !denied.resolvedBy || !denied.resolvedAt) {
        throw new Error("Approval deny update returned invalid resolution data.");
      }

      return {
        ok: true,
        approval: {
          id: denied.id,
          agentId: denied.agentId,
          status: "denied",
          resolvedBy: denied.resolvedBy,
          resolvedAt: denied.resolvedAt.toISOString(),
        },
        event: {
          type: APPROVAL_DENIED_EVENT_TYPE,
        },
      };
    });
  } catch {
    throw new AgentApprovalPersistenceError();
  } finally {
    if (ownsConnection) {
      await connection.close();
    }
  }
}

function toPendingApprovalDto(
  approval: typeof agentApprovals.$inferSelect,
  agent: { id: string; name: string },
): PendingApprovalDto {
  return {
    id: approval.id,
    agentId: approval.agentId,
    agentName: agent.name,
    agentHref: `/agents/${agent.id}`,
    title: approval.title,
    description: approval.description,
    status: "pending",
    requestedBy: approval.requestedBy,
    payloadSummary: summarizeApprovalPayload(approval.payloadJson),
    createdAt: approval.createdAt.toISOString(),
    expiresAt: approval.expiresAt?.toISOString() ?? null,
  };
}

function summarizeApprovalPayload(payload: Record<string, unknown>): string {
  if (payload.source !== "fake_runner") {
    return "Payload details unavailable.";
  }

  const parts: string[] = [];
  appendSafeField(parts, "Source", payload.source);
  appendSafeField(parts, "Action", payload.actionType);

  if (isRecord(payload.preview)) {
    appendSafeField(parts, "Destination", payload.preview.destination);
    appendSafeField(parts, "Topic", payload.preview.topic);
    appendSafeField(parts, "Mailbox", payload.preview.mailbox);
    appendSafeField(parts, "Summary", payload.preview.summary);
  }

  return parts.length > 0 ? parts.join("; ") : "Payload details unavailable.";
}

function appendSafeField(parts: string[], label: string, value: unknown): void {
  const normalized = normalizeSafePayloadText(value);

  if (normalized) {
    parts.push(`${label}: ${normalized}`);
  }
}

function normalizeSafePayloadText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim().replace(/\s+/g, " ");

  if (trimmed.length === 0) {
    return null;
  }

  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidApprovalId(approvalId: string): boolean {
  return isValidAgentId(approvalId);
}

async function selectScopedApproval(
  tx: AgentEventTransaction,
  approvalId: string,
  developmentUserId: string,
) {
  const [row] = await tx
    .select({
      id: agentApprovals.id,
      agentId: agentApprovals.agentId,
      title: agentApprovals.title,
      status: agentApprovals.status,
      agentName: agents.name,
    })
    .from(agentApprovals)
    .innerJoin(agents, eq(agents.id, agentApprovals.agentId))
    .where(
      and(
        eq(agentApprovals.id, approvalId),
        eq(agents.userId, developmentUserId),
        isNull(agents.deletedAt),
      ),
    )
    .limit(1);

  return row ?? null;
}
