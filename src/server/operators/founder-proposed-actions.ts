import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import type * as schema from "@/src/server/db/schema";
import {
  operatorActionAuthorizations,
  operatorActionDecisions,
  operatorActionExecutionAttempts,
  operatorAuthorityPolicies,
  operatorCalendarConnections,
  operatorCalendarResources,
  operatorGovernanceReceipts,
  operatorMailConnections,
  operatorMailResources,
  operatorProcessingConsents,
  operatorProductGuardrails,
  operatorProposedActions,
} from "@/src/server/db/schema";
import { FOUNDER_OWNER_PREVIEW_WORK_REQUIREMENTS } from "@/src/server/founder-product-contract/preview-qualification";
import {
  type FounderOwnerPreviewWorkAuthorityDependencies,
  withFounderOwnerPreviewWorkAuthority,
} from "@/src/server/founder-product-contract/work-authority";
import { assertFounderExternalActionsNotPausedInTransaction } from "@/src/server/operators/founder-ai-work";
import {
  ensureFounderOperatorForUser,
  getFounderOperatorForUser,
} from "@/src/server/operators/founder-operator";
import {
  deriveFounderRecovery,
  type FounderRecoveryDto,
} from "@/src/server/operators/founder-recovery";

export type ProposedActionTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

export const FOUNDER_ACTION_FAMILIES = [
  "observe_evidence",
  "relationship_maintenance",
  "prepare_work",
  "external_communication",
  "meeting_management",
  "commercial_commitment",
  "data_control",
] as const;

export type FounderActionFamily = (typeof FOUNDER_ACTION_FAMILIES)[number];
export type FounderAuthorityMode = "always" | "approval_required" | "never";
export type FounderActionDecisionKind = "approve" | "request_changes" | "decline";
export type FounderProposedActionState =
  | "proposed"
  | "awaiting_approval"
  | "authorized"
  | "executing"
  | "succeeded"
  | "failed"
  | "outcome_uncertain"
  | "declined"
  | "expired"
  | "superseded"
  | "cancelled"
  | "blocked";

export const FOUNDER_ACTION_FAMILY_DEFAULTS: Readonly<
  Record<FounderActionFamily, FounderAuthorityMode>
> = {
  observe_evidence: "always",
  relationship_maintenance: "always",
  prepare_work: "always",
  external_communication: "approval_required",
  meeting_management: "approval_required",
  commercial_commitment: "approval_required",
  data_control: "approval_required",
};

export const PRODUCT_GUARDRAILS_VERSION = 1;
const BLOCKED_ACTION_SUBTYPES = new Set([
  "bulk_outreach",
  "unknown_recipient_prospecting",
  "broad_export",
  "destructive_provider_change",
  "broad_company_data_export",
  "policy_administration",
  "credential_access",
  "payment",
  "legal_acceptance",
]);

export type FounderActionPrecondition = {
  key: string;
  description: string;
};

export type FounderProposedActionDraft = {
  actionFamily: FounderActionFamily;
  actionSubtype?: string | null;
  businessOutcome: string;
  companyConnectionId?: string | null;
  connectionResourceId?: string | null;
  connectionAccessVersion?: number | null;
  processingConsentId?: string | null;
  destination: Record<string, unknown>;
  materialContent: Record<string, unknown>;
  sideEffects?: string[];
  preconditions?: FounderActionPrecondition[];
  validUntil: Date | string;
  executionWindowStart?: Date | string | null;
  executionWindowEnd?: Date | string | null;
  idempotencyKey?: string | null;
};

export type FounderProposedActionDecisionDto = {
  id: string;
  kind: FounderActionDecisionKind;
  proposedActionId: string;
  proposedActionVersion: number;
  createdAt: string;
};

export type FounderProposedActionDto = {
  id: string;
  version: number;
  supersedesId: string | null;
  actionFamily: FounderActionFamily;
  actionSubtype: string | null;
  businessOutcome: string;
  connection: {
    companyConnectionId: string | null;
    connectionResourceId: string | null;
    accessVersion: number | null;
    processingConsentId: string | null;
    consentVersion: number | null;
  };
  destination: Record<string, unknown>;
  materialContent: Record<string, unknown>;
  sideEffects: string[];
  policy: {
    id: string | null;
    version: number;
    mode: FounderAuthorityMode;
  };
  productGuardrails: {
    version: number;
    blocked: boolean;
    reason: string | null;
  };
  preconditions: FounderActionPrecondition[];
  validUntil: string;
  executionWindow: { start: string | null; end: string | null };
  idempotencyKey: string;
  state: FounderProposedActionState;
  decision: FounderProposedActionDecisionDto | null;
  authorization: { id: string; claimedAt: string | null } | null;
  recovery?: FounderRecoveryDto | null;
  createdAt: string;
  updatedAt: string;
};

export type FounderActionExecutionClaimDto = {
  action: FounderProposedActionDto;
  authorization: { id: string; claimedAt: string };
  duplicate: boolean;
};

export type FounderProposedActionDependencies = FounderOwnerPreviewWorkAuthorityDependencies & {
  createConnection?: () => DatabaseConnection;
  now?: () => Date;
  randomUUID?: () => string;
};

export type FounderAuthorityPolicyDto = {
  version: number;
  actionFamilies: Record<FounderActionFamily, FounderAuthorityMode>;
  governanceReceiptId: string;
  createdAt: string;
};

export class FounderProposedActionError extends Error {
  readonly code:
    | "invalid_action"
    | "action_not_found"
    | "decision_conflict"
    | "stale_proposal"
    | "proposal_expired"
    | "proposal_blocked"
    | "action_unavailable";
  readonly status: 400 | 404 | 409 | 503;

  constructor(
    code: FounderProposedActionError["code"],
    message: string,
    status: FounderProposedActionError["status"] = 400,
  ) {
    super(message);
    this.name = "FounderProposedActionError";
    this.code = code;
    this.status = status;
  }
}

export async function createFounderProposedActionForUser(
  userId: string,
  draft: FounderProposedActionDraft,
  dependencies: FounderProposedActionDependencies = {},
): Promise<FounderProposedActionDto> {
  const now = dependencies.now ?? (() => new Date());
  const normalized = normalizeDraft(draft, now());
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  return withFounderOwnerPreviewWorkAuthority(
    {
      userId,
      now,
      requiredCapabilities: FOUNDER_OWNER_PREVIEW_WORK_REQUIREMENTS.conversation,
    },
    dependencies,
    async (tx, at) => {
      await lockOperator(tx, operator.id);
      const policy = await ensureAuthorityPolicy(tx, operator.id, at);
      const guardrails = await ensureProductGuardrails(tx, operator.id, at);
      const existing = normalized.idempotencyKey
        ? await findByIdempotency(tx, operator.id, normalized.idempotencyKey)
        : null;
      if (existing) return projectProposedAction(tx, existing);
      const bound = await validateActionBindings(tx, operator.id, normalized);
      const state = evaluateState(normalized, policy, guardrails);
      const [created] = await tx
        .insert(operatorProposedActions)
        .values({
          id: (dependencies.randomUUID ?? randomUUID)(),
          operatorId: operator.id,
          version: 1,
          actionFamily: normalized.actionFamily,
          actionSubtype: normalized.actionSubtype,
          businessOutcome: normalized.businessOutcome,
          companyConnectionId: normalized.companyConnectionId,
          connectionResourceId: normalized.connectionResourceId,
          connectionAccessVersion: bound.connectionAccessVersion,
          processingConsentVersion: bound.processingConsentVersion,
          processingConsentId: normalized.processingConsentId,
          destination: normalized.destination,
          materialContent: normalized.materialContent,
          sideEffects: normalized.sideEffects,
          authorityPolicyId: policy?.id ?? null,
          authorityPolicyVersion: policy?.version ?? 1,
          authorityMode: state.mode,
          productGuardrailsVersion: guardrails.version,
          preconditions: normalized.preconditions,
          validUntil: normalized.validUntil,
          executionWindowStart: normalized.executionWindowStart,
          executionWindowEnd: normalized.executionWindowEnd,
          idempotencyKey: normalized.idempotencyKey ?? (dependencies.randomUUID ?? randomUUID)(),
          state: state.state,
          createdAt: at,
          updatedAt: at,
        })
        .returning();
      if (!created) {
        throw new FounderProposedActionError(
          "action_unavailable",
          "The Proposed Action could not be saved.",
          503,
        );
      }
      if (state.mode === "always" && !state.blocked) {
        await tx
          .insert(operatorActionAuthorizations)
          .values({
            id: (dependencies.randomUUID ?? randomUUID)(),
            operatorId: operator.id,
            proposedActionId: created.id,
            decisionId: null,
            createdAt: at,
          })
          .onConflictDoNothing({ target: operatorActionAuthorizations.proposedActionId });
      }
      return projectProposedAction(tx, created);
    },
  );
}

/** A policy change is a structured Founder decision, never a Conversation side effect. */
export async function changeFounderAuthorityPolicyForUser(
  userId: string,
  actionFamilies: Record<FounderActionFamily, FounderAuthorityMode>,
  dependencies: FounderProposedActionDependencies = {},
): Promise<{ before: FounderAuthorityPolicyDto | null; after: FounderAuthorityPolicyDto }> {
  const normalized = normalizeActionFamilies(actionFamilies);
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  return withConnection(dependencies, (connection) =>
    connection.db.transaction(async (tx) => {
      const now = dependencies.now?.() ?? new Date();
      await lockOperator(tx, operator.id);
      const current = await ensureAuthorityPolicy(tx, operator.id, now);
      const guardrails = await ensureProductGuardrails(tx, operator.id, now);
      const [created] = await tx
        .insert(operatorAuthorityPolicies)
        .values({
          operatorId: operator.id,
          version: (current?.version ?? 0) + 1,
          actionFamilies: normalized,
          observation: "always",
          preparation: "always",
          externalEffects: "approval_required",
          mailIncluded: false,
          confirmedAt: now,
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning();
      if (!created) {
        throw new FounderProposedActionError(
          "action_unavailable",
          "The Authority Policy change could not be saved.",
          503,
        );
      }
      const [receipt] = await tx
        .insert(operatorGovernanceReceipts)
        .values({
          operatorId: operator.id,
          kind: "authority_policy",
          authorityPolicyId: created.id,
          evidenceDigest: digest({
            kind: "authority_policy",
            policyId: created.id,
            version: created.version,
            actionFamilies: normalized,
            productGuardrailsVersion: guardrails.version,
          }),
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning();
      if (!receipt) {
        throw new FounderProposedActionError(
          "action_unavailable",
          "The Authority Policy Governance Receipt could not be saved.",
          503,
        );
      }
      const [beforeReceipt] = current
        ? await tx
            .select()
            .from(operatorGovernanceReceipts)
            .where(
              and(
                eq(operatorGovernanceReceipts.operatorId, operator.id),
                eq(operatorGovernanceReceipts.authorityPolicyId, current.id),
              ),
            )
            .limit(1)
        : [];
      const pending = await tx
        .select()
        .from(operatorProposedActions)
        .where(
          and(
            eq(operatorProposedActions.operatorId, operator.id),
            inArray(operatorProposedActions.state, ["proposed", "awaiting_approval", "authorized"]),
          ),
        );
      for (const action of pending) {
        const mode = effectiveAuthorityMode(created, action.actionFamily, action.actionSubtype);
        if (
          mode === "never" ||
          (action.state === "authorized" && action.authorityPolicyVersion !== created.version)
        ) {
          await tx
            .update(operatorProposedActions)
            .set({ state: "blocked", updatedAt: now })
            .where(eq(operatorProposedActions.id, action.id));
          if (action.state === "authorized") {
            await tx
              .delete(operatorActionAuthorizations)
              .where(eq(operatorActionAuthorizations.proposedActionId, action.id));
          }
        }
      }
      return {
        before: current ? policyDto(current, beforeReceipt?.id ?? "") : null,
        after: policyDto(created, receipt.id),
      };
    }),
  );
}

export async function getFounderProposedActionsForUser(
  userId: string,
  dependencies: FounderProposedActionDependencies = {},
): Promise<FounderProposedActionDto[]> {
  const operator = await getFounderOperatorForUser(userId, dependencies);
  if (!operator) return [];
  return withConnection(dependencies, (connection) =>
    connection.db.transaction(async (tx) => {
      const rows = await currentRows(tx, operator.id);
      return Promise.all(rows.map((row) => projectProposedAction(tx, row)));
    }),
  );
}

export async function getFounderProposedActionForUser(
  userId: string,
  dependencies: FounderProposedActionDependencies = {},
): Promise<FounderProposedActionDto | null> {
  const actions = await getFounderProposedActionsForUser(userId, dependencies);
  return actions[0] ?? null;
}

/** Material edits never mutate a version that a Founder may have seen or approved. */
export async function reviseFounderProposedActionForUser(
  userId: string,
  actionId: string,
  expectedVersion: number,
  draft: FounderProposedActionDraft,
  dependencies: FounderProposedActionDependencies = {},
): Promise<FounderProposedActionDto> {
  const now = dependencies.now ?? (() => new Date());
  const normalized = normalizeDraft(draft, now());
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  return withFounderOwnerPreviewWorkAuthority(
    {
      userId,
      now,
      requiredCapabilities: FOUNDER_OWNER_PREVIEW_WORK_REQUIREMENTS.conversation,
    },
    dependencies,
    async (tx, at) => {
      await lockOperator(tx, operator.id);
      const [action] = await tx
        .select()
        .from(operatorProposedActions)
        .where(
          and(
            eq(operatorProposedActions.id, actionId),
            eq(operatorProposedActions.operatorId, operator.id),
          ),
        )
        .limit(1)
        .for("update");
      if (!action) {
        throw new FounderProposedActionError("action_not_found", "Proposed Action not found.", 404);
      }
      if (action.version !== expectedVersion) {
        throw new FounderProposedActionError(
          "stale_proposal",
          "This Proposed Action version is no longer current.",
          409,
        );
      }
      const existing = normalized.idempotencyKey
        ? await findByIdempotency(tx, operator.id, normalized.idempotencyKey)
        : null;
      if (existing) return projectProposedAction(tx, existing);
      const policy = await ensureAuthorityPolicy(tx, operator.id, at);
      const guardrails = await ensureProductGuardrails(tx, operator.id, at);
      const bound = await validateActionBindings(tx, operator.id, normalized);
      await tx
        .update(operatorProposedActions)
        .set({ state: "superseded", updatedAt: at })
        .where(eq(operatorProposedActions.id, action.id));
      const revised = await insertActionVersion(
        tx,
        operator.id,
        action.version + 1,
        action.id,
        normalized,
        bound.connectionAccessVersion,
        bound.processingConsentVersion,
        policy,
        guardrails,
        at,
        dependencies.randomUUID,
      );
      return projectProposedAction(tx, revised);
    },
  );
}

/** Shared projection seam for Conversation, Morning Brief, and Action Inbox. */
export async function projectFounderProposedAction(
  tx: ProposedActionTransaction,
  operatorId: string,
): Promise<FounderProposedActionDto | null> {
  const rows = await currentRows(tx, operatorId);
  const row = rows[0];
  return row ? projectProposedAction(tx, row) : null;
}

export async function decideFounderProposedActionForUser(
  userId: string,
  actionId: string,
  kind: FounderActionDecisionKind,
  expectedVersion: number,
  changes: FounderProposedActionDraft | null = null,
  dependencies: FounderProposedActionDependencies = {},
): Promise<{
  action: FounderProposedActionDto;
  decision: FounderProposedActionDecisionDto;
  duplicate: boolean;
}> {
  if (!isUuid(actionId) || !Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new FounderProposedActionError(
      "invalid_action",
      "A valid Proposed Action and version are required.",
    );
  }
  if (kind === "request_changes" && !changes) {
    throw new FounderProposedActionError(
      "invalid_action",
      "Request changes must include the new material action details.",
    );
  }
  const now = dependencies.now ?? (() => new Date());
  const normalizedChanges = changes ? normalizeDraft(changes, now()) : null;
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  const decide = async (tx: ProposedActionTransaction, at: Date) => {
    await lockOperator(tx, operator.id);
    const [action] = await tx
      .select()
      .from(operatorProposedActions)
      .where(
        and(
          eq(operatorProposedActions.id, actionId),
          eq(operatorProposedActions.operatorId, operator.id),
        ),
      )
      .limit(1)
      .for("update");
    if (!action) {
      throw new FounderProposedActionError("action_not_found", "Proposed Action not found.", 404);
    }
    if (action.version !== expectedVersion) {
      throw new FounderProposedActionError(
        "stale_proposal",
        "This Proposed Action version is no longer current.",
        409,
      );
    }
    const [recorded] = await tx
      .select()
      .from(operatorActionDecisions)
      .where(eq(operatorActionDecisions.proposedActionId, action.id))
      .limit(1);
    if (recorded) {
      return {
        action: await projectProposedAction(tx, action),
        decision: toDecisionDto(recorded),
        duplicate: true,
      };
    }
    if (action.state !== "awaiting_approval" && action.state !== "proposed") {
      throw new FounderProposedActionError(
        "decision_conflict",
        "This Proposed Action is no longer awaiting a Founder decision.",
        409,
      );
    }
    if (action.validUntil <= at) {
      await tx
        .update(operatorProposedActions)
        .set({ state: "expired", updatedAt: at })
        .where(eq(operatorProposedActions.id, action.id))
        .returning();
      throw new FounderProposedActionError(
        "proposal_expired",
        "This Proposed Action expired and needs a fresh proposal.",
        409,
      );
    }
    const policy = await ensureAuthorityPolicy(tx, operator.id, at);
    const guardrails = await ensureProductGuardrails(tx, operator.id, at);
    const boundChanges = normalizedChanges
      ? await validateActionBindings(tx, operator.id, normalizedChanges)
      : null;
    const staleBindingReason = await validateStoredActionBindings(tx, operator.id, action);
    if (staleBindingReason) {
      await tx
        .update(operatorProposedActions)
        .set({ state: "blocked", updatedAt: at })
        .where(eq(operatorProposedActions.id, action.id));
      throw new FounderProposedActionError("proposal_blocked", staleBindingReason, 409);
    }
    const evaluation = evaluateStoredState(action, policy, guardrails);
    if (evaluation.blocked) {
      await tx
        .update(operatorProposedActions)
        .set({ state: "blocked", updatedAt: at })
        .where(eq(operatorProposedActions.id, action.id));
      throw new FounderProposedActionError(
        "proposal_blocked",
        evaluation.reason ?? "Product Guardrails block this Proposed Action.",
        409,
      );
    }
    const decisionId = (dependencies.randomUUID ?? randomUUID)();
    const [decision] = await tx
      .insert(operatorActionDecisions)
      .values({
        id: decisionId,
        operatorId: operator.id,
        proposedActionId: action.id,
        proposedActionVersion: action.version,
        kind,
        createdAt: at,
      })
      .onConflictDoNothing({ target: operatorActionDecisions.proposedActionId })
      .returning();
    if (!decision) {
      const [afterConflict] = await tx
        .select()
        .from(operatorActionDecisions)
        .where(eq(operatorActionDecisions.proposedActionId, action.id))
        .limit(1);
      if (!afterConflict) {
        throw new FounderProposedActionError(
          "action_unavailable",
          "The Founder decision could not be recorded.",
          503,
        );
      }
      return {
        action: await projectProposedAction(tx, action),
        decision: toDecisionDto(afterConflict),
        duplicate: true,
      };
    }

    if (kind === "request_changes" && normalizedChanges) {
      await tx
        .update(operatorProposedActions)
        .set({ state: "superseded", updatedAt: at })
        .where(eq(operatorProposedActions.id, action.id));
      const next = await insertActionVersion(
        tx,
        operator.id,
        action.version + 1,
        action.id,
        normalizedChanges,
        boundChanges?.connectionAccessVersion ?? null,
        boundChanges?.processingConsentVersion ?? null,
        policy,
        guardrails,
        at,
        dependencies.randomUUID,
      );
      return {
        action: await projectProposedAction(tx, next),
        decision: toDecisionDto(decision),
        duplicate: false,
      };
    }

    const nextState = kind === "approve" ? "authorized" : "declined";
    const [updated] = await tx
      .update(operatorProposedActions)
      .set({ state: nextState, updatedAt: at })
      .where(eq(operatorProposedActions.id, action.id))
      .returning();
    if (!updated) {
      throw new FounderProposedActionError(
        "action_unavailable",
        "The Proposed Action could not be updated.",
        503,
      );
    }
    if (kind === "approve") {
      await tx
        .insert(operatorActionAuthorizations)
        .values({
          id: (dependencies.randomUUID ?? randomUUID)(),
          operatorId: operator.id,
          proposedActionId: action.id,
          decisionId: decision.id,
          createdAt: at,
        })
        .onConflictDoNothing({ target: operatorActionAuthorizations.proposedActionId });
    }
    return {
      action: await projectProposedAction(tx, updated),
      decision: toDecisionDto(decision),
      duplicate: false,
    };
  };

  if (kind === "request_changes") {
    return withFounderOwnerPreviewWorkAuthority(
      {
        userId,
        now,
        requiredCapabilities: FOUNDER_OWNER_PREVIEW_WORK_REQUIREMENTS.conversation,
      },
      dependencies,
      decide,
    );
  }
  return withConnection(dependencies, (connection) =>
    connection.db.transaction((tx) => decide(tx, now())),
  );
}

export async function claimFounderActionAuthorizationForUser(
  userId: string,
  actionId: string,
  expectedVersion: number,
  dependencies: FounderProposedActionDependencies = {},
): Promise<FounderActionExecutionClaimDto> {
  if (!isUuid(actionId) || !Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new FounderProposedActionError(
      "invalid_action",
      "A valid Proposed Action and version are required.",
    );
  }
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  return withConnection(dependencies, (connection) =>
    connection.db.transaction(async (tx) => {
      const now = dependencies.now?.() ?? new Date();
      await lockOperator(tx, operator.id);
      const [action] = await tx
        .select()
        .from(operatorProposedActions)
        .where(
          and(
            eq(operatorProposedActions.id, actionId),
            eq(operatorProposedActions.operatorId, operator.id),
          ),
        )
        .limit(1)
        .for("update");
      if (!action) {
        throw new FounderProposedActionError("action_not_found", "Proposed Action not found.", 404);
      }
      if (action.version !== expectedVersion) {
        throw new FounderProposedActionError(
          "stale_proposal",
          "This Proposed Action version is no longer current.",
          409,
        );
      }
      const [authorization] = await tx
        .select()
        .from(operatorActionAuthorizations)
        .where(eq(operatorActionAuthorizations.proposedActionId, action.id))
        .limit(1)
        .for("update");
      if (authorization?.claimedAt) {
        return {
          action: await projectProposedAction(tx, action),
          authorization: { id: authorization.id, claimedAt: authorization.claimedAt.toISOString() },
          duplicate: true,
        };
      }
      if (!authorization || action.state !== "authorized") {
        throw new FounderProposedActionError(
          "decision_conflict",
          "This Proposed Action is not authorized for execution.",
          409,
        );
      }
      if (action.validUntil <= now) {
        await tx
          .update(operatorProposedActions)
          .set({ state: "expired", updatedAt: now })
          .where(eq(operatorProposedActions.id, action.id));
        await tx
          .delete(operatorActionAuthorizations)
          .where(eq(operatorActionAuthorizations.proposedActionId, action.id));
        throw new FounderProposedActionError(
          "proposal_expired",
          "This Proposed Action expired and needs a fresh proposal.",
          409,
        );
      }

      const policy = await ensureAuthorityPolicy(tx, operator.id, now);
      const guardrails = await ensureProductGuardrails(tx, operator.id, now);
      const staleBindingReason = await validateStoredActionBindings(tx, operator.id, action);
      const evaluation = evaluateStoredState(action, policy, guardrails);
      const blockedReason =
        staleBindingReason ??
        (evaluation.blocked
          ? (evaluation.reason ?? "Product Guardrails block this Proposed Action.")
          : null);
      if (blockedReason) {
        await tx
          .update(operatorProposedActions)
          .set({ state: "blocked", updatedAt: now })
          .where(eq(operatorProposedActions.id, action.id));
        await tx
          .delete(operatorActionAuthorizations)
          .where(eq(operatorActionAuthorizations.proposedActionId, action.id));
        throw new FounderProposedActionError("proposal_blocked", blockedReason, 409);
      }
      if (startsFounderExternalEffect(action)) {
        await assertFounderExternalActionsNotPausedInTransaction(tx, operator.id, now);
      }

      const [claimed] = await tx
        .update(operatorActionAuthorizations)
        .set({ claimedAt: now })
        .where(eq(operatorActionAuthorizations.id, authorization.id))
        .returning();
      if (!claimed) {
        throw new FounderProposedActionError(
          "action_unavailable",
          "The Action Authorization could not be claimed.",
          503,
        );
      }
      const [updated] = await tx
        .update(operatorProposedActions)
        .set({ state: "executing", updatedAt: now })
        .where(eq(operatorProposedActions.id, action.id))
        .returning();
      if (!updated) {
        throw new FounderProposedActionError(
          "action_unavailable",
          "The Proposed Action could not be claimed.",
          503,
        );
      }
      return {
        action: await projectProposedAction(tx, updated),
        authorization: { id: claimed.id, claimedAt: now.toISOString() },
        duplicate: false,
      };
    }),
  );
}

async function insertActionVersion(
  tx: ProposedActionTransaction,
  operatorId: string,
  version: number,
  supersedesActionId: string,
  draft: NormalizedDraft,
  connectionAccessVersion: number | null,
  processingConsentVersion: number | null,
  policy: typeof operatorAuthorityPolicies.$inferSelect | null,
  guardrails: typeof operatorProductGuardrails.$inferSelect,
  now: Date,
  makeId: (() => string) | undefined,
) {
  const evaluation = evaluateState(draft, policy, guardrails);
  const [created] = await tx
    .insert(operatorProposedActions)
    .values({
      id: (makeId ?? randomUUID)(),
      operatorId,
      version,
      supersedesActionId,
      actionFamily: draft.actionFamily,
      actionSubtype: draft.actionSubtype,
      businessOutcome: draft.businessOutcome,
      companyConnectionId: draft.companyConnectionId,
      connectionResourceId: draft.connectionResourceId,
      connectionAccessVersion,
      processingConsentId: draft.processingConsentId,
      processingConsentVersion,
      destination: draft.destination,
      materialContent: draft.materialContent,
      sideEffects: draft.sideEffects,
      authorityPolicyId: policy?.id ?? null,
      authorityPolicyVersion: policy?.version ?? 1,
      authorityMode: evaluation.mode,
      productGuardrailsVersion: guardrails.version,
      preconditions: draft.preconditions,
      validUntil: draft.validUntil,
      executionWindowStart: draft.executionWindowStart,
      executionWindowEnd: draft.executionWindowEnd,
      idempotencyKey: draft.idempotencyKey ?? (makeId ?? randomUUID)(),
      state: evaluation.state,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!created) {
    throw new FounderProposedActionError(
      "action_unavailable",
      "The revised Proposed Action could not be saved.",
      503,
    );
  }
  if (evaluation.mode === "always" && !evaluation.blocked) {
    await tx
      .insert(operatorActionAuthorizations)
      .values({
        id: (makeId ?? randomUUID)(),
        operatorId,
        proposedActionId: created.id,
        decisionId: null,
        createdAt: now,
      })
      .onConflictDoNothing({ target: operatorActionAuthorizations.proposedActionId });
  }
  return created;
}

type NormalizedDraft = Omit<
  FounderProposedActionDraft,
  "validUntil" | "executionWindowStart" | "executionWindowEnd"
> & {
  actionSubtype: string | null;
  businessOutcome: string;
  companyConnectionId: string | null;
  connectionResourceId: string | null;
  connectionAccessVersion: number | null;
  processingConsentId: string | null;
  sideEffects: string[];
  preconditions: FounderActionPrecondition[];
  validUntil: Date;
  executionWindowStart: Date | null;
  executionWindowEnd: Date | null;
  idempotencyKey: string | null;
};

function normalizeDraft(input: FounderProposedActionDraft, now = new Date()): NormalizedDraft {
  if (!FOUNDER_ACTION_FAMILIES.includes(input.actionFamily)) {
    throw new FounderProposedActionError("invalid_action", "Choose a supported Action Family.");
  }
  const businessOutcome = normalizeText(input.businessOutcome, 2_000);
  const actionSubtype = normalizeOptionalText(input.actionSubtype, 160);
  const validUntil = parseDate(input.validUntil);
  const executionWindowStart = parseOptionalDate(input.executionWindowStart);
  const executionWindowEnd = parseOptionalDate(input.executionWindowEnd);
  if (!businessOutcome || !validUntil || validUntil <= now) {
    throw new FounderProposedActionError(
      "invalid_action",
      "Business outcome and a future validity boundary are required.",
    );
  }
  if (
    input.connectionAccessVersion != null &&
    (!Number.isInteger(input.connectionAccessVersion) || input.connectionAccessVersion < 1)
  ) {
    throw new FounderProposedActionError(
      "invalid_action",
      "Connection Access version must be a positive integer.",
    );
  }
  if (
    (executionWindowStart && executionWindowEnd && executionWindowStart >= executionWindowEnd) ||
    (executionWindowEnd && executionWindowEnd > validUntil)
  ) {
    throw new FounderProposedActionError(
      "invalid_action",
      "The execution window must be ordered and inside the validity boundary.",
    );
  }
  const sideEffects = (input.sideEffects ?? [])
    .map((value) => normalizeText(value, 500))
    .filter((value): value is string => Boolean(value))
    .slice(0, 20);
  const preconditions = (input.preconditions ?? [])
    .map((condition) => ({
      key: normalizeText(condition.key, 120),
      description: normalizeText(condition.description, 500),
    }))
    .filter((condition) => condition.key && condition.description)
    .slice(0, 30);
  if (!isJsonRecord(input.destination) || !isJsonRecord(input.materialContent)) {
    throw new FounderProposedActionError(
      "invalid_action",
      "Destination and material content must be structured objects.",
    );
  }
  return {
    actionFamily: input.actionFamily,
    actionSubtype,
    businessOutcome,
    companyConnectionId: input.companyConnectionId ?? null,
    connectionResourceId: input.connectionResourceId ?? null,
    connectionAccessVersion:
      input.connectionAccessVersion == null ? null : input.connectionAccessVersion,
    processingConsentId: input.processingConsentId ?? null,
    destination: input.destination,
    materialContent: input.materialContent,
    sideEffects,
    preconditions,
    validUntil,
    executionWindowStart,
    executionWindowEnd,
    idempotencyKey: normalizeOptionalText(input.idempotencyKey, 240),
  };
}

function evaluateState(
  draft: NormalizedDraft,
  policy: typeof operatorAuthorityPolicies.$inferSelect | null,
  guardrails: typeof operatorProductGuardrails.$inferSelect,
): {
  state: FounderProposedActionState;
  mode: FounderAuthorityMode;
  blocked: boolean;
  reason?: string;
} {
  const guardrail = guardrailReason(draft.actionFamily, draft.actionSubtype, guardrails);
  if (guardrail) return { state: "blocked", mode: "never", blocked: true, reason: guardrail };
  const mode = effectiveAuthorityMode(policy, draft.actionFamily, draft.actionSubtype);
  if (mode === "never") {
    return {
      state: "blocked",
      mode,
      blocked: true,
      reason: "The current Authority Policy does not allow this Action Family.",
    };
  }
  return { state: mode === "always" ? "authorized" : "awaiting_approval", mode, blocked: false };
}

async function validateActionBindings(
  tx: ProposedActionTransaction,
  operatorId: string,
  draft: NormalizedDraft,
): Promise<{ connectionAccessVersion: number | null; processingConsentVersion: number | null }> {
  if (draft.companyConnectionId && !isUuid(draft.companyConnectionId)) {
    throw new FounderProposedActionError("invalid_action", "Company Connection is invalid.");
  }
  if (draft.connectionResourceId && !isUuid(draft.connectionResourceId)) {
    throw new FounderProposedActionError("invalid_action", "Connection Resource is invalid.");
  }
  if (draft.processingConsentId && !isUuid(draft.processingConsentId)) {
    throw new FounderProposedActionError("invalid_action", "Processing Consent is invalid.");
  }

  let connectionAccessVersion: number | null = draft.connectionAccessVersion;
  let processingConsentVersion: number | null = null;
  let connectionId = draft.companyConnectionId;
  let connectionGeneration: number | null = null;
  if (connectionId) {
    const [calendar] = await tx
      .select({
        id: operatorCalendarConnections.id,
        generation: operatorCalendarConnections.authorizationGeneration,
      })
      .from(operatorCalendarConnections)
      .where(
        and(
          eq(operatorCalendarConnections.id, connectionId),
          eq(operatorCalendarConnections.operatorId, operatorId),
        ),
      )
      .limit(1);
    const [mail] = calendar
      ? []
      : await tx
          .select({
            id: operatorMailConnections.id,
            generation: operatorMailConnections.authorizationGeneration,
          })
          .from(operatorMailConnections)
          .where(
            and(
              eq(operatorMailConnections.id, connectionId),
              eq(operatorMailConnections.operatorId, operatorId),
            ),
          )
          .limit(1);
    const connection = calendar ?? mail;
    if (!connection) {
      throw new FounderProposedActionError(
        "invalid_action",
        "The Connection Access binding does not belong to this Founder.",
      );
    }
    connectionGeneration = connection.generation;
  }

  if (draft.connectionResourceId) {
    const [calendarResource] = await tx
      .select({ connectionId: operatorCalendarResources.connectionId })
      .from(operatorCalendarResources)
      .innerJoin(
        operatorCalendarConnections,
        eq(operatorCalendarResources.connectionId, operatorCalendarConnections.id),
      )
      .where(
        and(
          eq(operatorCalendarResources.id, draft.connectionResourceId),
          eq(operatorCalendarConnections.operatorId, operatorId),
        ),
      )
      .limit(1);
    const [mailResource] = calendarResource
      ? []
      : await tx
          .select({ connectionId: operatorMailResources.connectionId })
          .from(operatorMailResources)
          .innerJoin(
            operatorMailConnections,
            eq(operatorMailResources.connectionId, operatorMailConnections.id),
          )
          .where(
            and(
              eq(operatorMailResources.id, draft.connectionResourceId),
              eq(operatorMailConnections.operatorId, operatorId),
            ),
          )
          .limit(1);
    const resource = calendarResource ?? mailResource;
    if (!resource) {
      throw new FounderProposedActionError(
        "invalid_action",
        "The Connection Resource binding does not belong to this Founder.",
      );
    }
    if (connectionId && resource.connectionId !== connectionId) {
      throw new FounderProposedActionError(
        "invalid_action",
        "Connection Resource must belong to the bound Connection.",
      );
    }
    connectionId = resource.connectionId;
    if (!connectionGeneration) {
      const [calendar] = await tx
        .select({ generation: operatorCalendarConnections.authorizationGeneration })
        .from(operatorCalendarConnections)
        .where(
          and(
            eq(operatorCalendarConnections.id, connectionId),
            eq(operatorCalendarConnections.operatorId, operatorId),
          ),
        )
        .limit(1);
      const [mail] = calendar
        ? []
        : await tx
            .select({ generation: operatorMailConnections.authorizationGeneration })
            .from(operatorMailConnections)
            .where(
              and(
                eq(operatorMailConnections.id, connectionId),
                eq(operatorMailConnections.operatorId, operatorId),
              ),
            )
            .limit(1);
      connectionGeneration = (calendar ?? mail)?.generation ?? null;
    }
  }

  if (draft.processingConsentId) {
    const [consent] = await tx
      .select({
        id: operatorProcessingConsents.id,
        version: operatorProcessingConsents.version,
      })
      .from(operatorProcessingConsents)
      .where(
        and(
          eq(operatorProcessingConsents.id, draft.processingConsentId),
          eq(operatorProcessingConsents.operatorId, operatorId),
        ),
      )
      .limit(1);
    if (!consent) {
      throw new FounderProposedActionError(
        "invalid_action",
        "The Processing Consent binding does not belong to this Founder.",
      );
    }
    processingConsentVersion = consent.version;
  }

  if (connectionGeneration != null) {
    if (connectionAccessVersion != null && connectionAccessVersion !== connectionGeneration) {
      throw new FounderProposedActionError(
        "invalid_action",
        "Connection Access version is no longer current.",
      );
    }
    connectionAccessVersion = connectionGeneration;
  } else if (connectionAccessVersion != null) {
    throw new FounderProposedActionError(
      "invalid_action",
      "Connection Access version requires a Connection binding.",
    );
  }
  return { connectionAccessVersion, processingConsentVersion };
}

async function validateStoredActionBindings(
  tx: ProposedActionTransaction,
  operatorId: string,
  action: typeof operatorProposedActions.$inferSelect,
): Promise<string | null> {
  if (action.companyConnectionId) {
    const [calendar] = await tx
      .select({
        generation: operatorCalendarConnections.authorizationGeneration,
        status: operatorCalendarConnections.status,
        authorizationState: operatorCalendarConnections.authorizationState,
        revokedAt: operatorCalendarConnections.revokedAt,
      })
      .from(operatorCalendarConnections)
      .where(
        and(
          eq(operatorCalendarConnections.id, action.companyConnectionId),
          eq(operatorCalendarConnections.operatorId, operatorId),
        ),
      )
      .limit(1);
    const [mail] = calendar
      ? []
      : await tx
          .select({
            generation: operatorMailConnections.authorizationGeneration,
            status: operatorMailConnections.status,
            authorizationState: operatorMailConnections.authorizationState,
            revokedAt: operatorMailConnections.revokedAt,
          })
          .from(operatorMailConnections)
          .where(
            and(
              eq(operatorMailConnections.id, action.companyConnectionId),
              eq(operatorMailConnections.operatorId, operatorId),
            ),
          )
          .limit(1);
    const connection = calendar ?? mail;
    if (
      connection?.status !== "ready" ||
      connection.authorizationState !== "authorized" ||
      connection.revokedAt ||
      action.connectionAccessVersion !== connection.generation
    ) {
      return "The bound Connection Access is no longer current.";
    }
  }

  if (action.connectionResourceId) {
    const [calendar] = await tx
      .select({
        selected: operatorCalendarResources.selected,
        status: operatorCalendarResources.status,
      })
      .from(operatorCalendarResources)
      .innerJoin(
        operatorCalendarConnections,
        eq(operatorCalendarResources.connectionId, operatorCalendarConnections.id),
      )
      .where(
        and(
          eq(operatorCalendarResources.id, action.connectionResourceId),
          eq(operatorCalendarConnections.operatorId, operatorId),
        ),
      )
      .limit(1);
    const [mail] = calendar
      ? []
      : await tx
          .select({
            selected: operatorMailResources.selected,
            status: operatorMailResources.status,
          })
          .from(operatorMailResources)
          .innerJoin(
            operatorMailConnections,
            eq(operatorMailResources.connectionId, operatorMailConnections.id),
          )
          .where(
            and(
              eq(operatorMailResources.id, action.connectionResourceId),
              eq(operatorMailConnections.operatorId, operatorId),
            ),
          )
          .limit(1);
    const resource = calendar ?? mail;
    if (!resource?.selected || resource.status !== "available") {
      return "The bound Connection Resource is no longer selected and available.";
    }
  }

  if (action.processingConsentId) {
    const [consent] = await tx
      .select({
        version: operatorProcessingConsents.version,
        status: operatorProcessingConsents.status,
        operatorId: operatorProcessingConsents.operatorId,
      })
      .from(operatorProcessingConsents)
      .where(eq(operatorProcessingConsents.id, action.processingConsentId))
      .limit(1);
    if (
      !consent ||
      consent.operatorId !== operatorId ||
      consent.status !== "active" ||
      action.processingConsentVersion !== consent.version
    ) {
      return "The bound Processing Consent is no longer current.";
    }
  }
  return null;
}

function evaluateStoredState(
  action: typeof operatorProposedActions.$inferSelect,
  policy: typeof operatorAuthorityPolicies.$inferSelect | null,
  guardrails: typeof operatorProductGuardrails.$inferSelect,
): { blocked: boolean; reason?: string } {
  const reason = guardrailReason(action.actionFamily, action.actionSubtype, guardrails);
  if (reason) return { blocked: true, reason };
  if (effectiveAuthorityMode(policy, action.actionFamily, action.actionSubtype) === "never") {
    return {
      blocked: true,
      reason: "The current Authority Policy does not allow this Action Family.",
    };
  }
  return { blocked: false };
}

export function startsFounderExternalEffect(
  action: typeof operatorProposedActions.$inferSelect,
): boolean {
  return (
    action.actionFamily === "external_communication" ||
    action.actionFamily === "meeting_management" ||
    action.actionFamily === "commercial_commitment" ||
    action.actionFamily === "data_control"
  );
}

export async function recheckFounderProposedActionForExecution(
  tx: ProposedActionTransaction,
  operatorId: string,
  action: typeof operatorProposedActions.$inferSelect,
  now: Date,
): Promise<{ reason: string | null }> {
  if (action.state !== "authorized" && action.state !== "executing")
    return { reason: "This Proposed Action is not authorized for execution." };
  if (action.validUntil <= now)
    return { reason: "This Proposed Action expired and needs a fresh approval." };
  if (action.executionWindowStart && now < action.executionWindowStart)
    return { reason: "This Proposed Action is not within its execution window yet." };
  if (action.executionWindowEnd && now >= action.executionWindowEnd)
    return { reason: "This Proposed Action's execution window has closed." };
  const policy = await ensureAuthorityPolicy(tx, operatorId, now);
  const guardrails = await ensureProductGuardrails(tx, operatorId, now);
  if (action.authorityPolicyVersion !== policy?.version)
    return { reason: "The Authority Policy changed; this action needs a fresh approval." };
  const staleBindingReason = await validateStoredActionBindings(tx, operatorId, action);
  if (staleBindingReason) return { reason: staleBindingReason };
  const evaluation = evaluateStoredState(action, policy, guardrails);
  return evaluation.blocked
    ? { reason: evaluation.reason ?? "Product Guardrails block this action." }
    : { reason: null };
}

function effectiveAuthorityMode(
  policy: typeof operatorAuthorityPolicies.$inferSelect | null,
  family: FounderActionFamily,
  subtype: string | null,
): FounderAuthorityMode {
  if (
    family === "relationship_maintenance" &&
    (subtype === "merge_record" || subtype === "delete_record")
  ) {
    return "approval_required";
  }
  return policy?.actionFamilies?.[family] ?? FOUNDER_ACTION_FAMILY_DEFAULTS[family];
}

function guardrailReason(
  family: FounderActionFamily,
  subtype: string | null,
  guardrails: typeof operatorProductGuardrails.$inferSelect,
): string | null {
  if (subtype && guardrails.blockedSubtypes.includes(subtype)) {
    return "Product Guardrails block this action subtype; no approval can bypass it.";
  }
  if (guardrails.blockedActionFamilies.includes(family)) {
    return "Product Guardrails block this Action Family; no approval can bypass it.";
  }
  return null;
}

async function projectProposedAction(
  tx: ProposedActionTransaction,
  action: typeof operatorProposedActions.$inferSelect,
): Promise<FounderProposedActionDto> {
  const [decision] = await tx
    .select()
    .from(operatorActionDecisions)
    .where(eq(operatorActionDecisions.proposedActionId, action.id))
    .limit(1);
  const [authorization] = await tx
    .select()
    .from(operatorActionAuthorizations)
    .where(eq(operatorActionAuthorizations.proposedActionId, action.id))
    .limit(1);
  const guardrails = await getGuardrailsForProjection(
    tx,
    action.operatorId,
    action.productGuardrailsVersion,
  );
  const attempts = await tx
    .select({
      attemptNumber: operatorActionExecutionAttempts.attemptNumber,
      phase: operatorActionExecutionAttempts.phase,
      createdAt: operatorActionExecutionAttempts.createdAt,
    })
    .from(operatorActionExecutionAttempts)
    .where(eq(operatorActionExecutionAttempts.proposedActionId, action.id))
    .orderBy(desc(operatorActionExecutionAttempts.createdAt));
  const latestAttempt = attempts[0];
  const recovery = deriveFounderRecovery({
    capability: "external_effect",
    now: action.updatedAt,
    startedAt: latestAttempt?.createdAt ?? action.createdAt,
    attemptCount: Math.max(attempts.length, latestAttempt?.attemptNumber ?? 0),
    durableFailure: ["executing", "failed", "outcome_uncertain", "blocked"].includes(action.state),
    waitingOnProvider: action.state === "executing",
    outcomeUncertain: action.state === "outcome_uncertain" || latestAttempt?.phase === "ambiguous",
    needsFounder: action.state === "failed" || action.state === "blocked",
    safeToRetry: false,
    message:
      action.state === "outcome_uncertain"
        ? "Bruno could not prove whether this external effect was accepted. Do not retry it."
        : action.state === "executing"
          ? "Bruno is waiting for the provider result. Do not retry this effect."
          : null,
  });
  return {
    id: action.id,
    version: action.version,
    supersedesId: action.supersedesActionId,
    actionFamily: action.actionFamily,
    actionSubtype: action.actionSubtype,
    businessOutcome: action.businessOutcome,
    connection: {
      companyConnectionId: action.companyConnectionId,
      connectionResourceId: action.connectionResourceId,
      accessVersion: action.connectionAccessVersion,
      processingConsentId: action.processingConsentId,
      consentVersion: action.processingConsentVersion,
    },
    destination: action.destination,
    materialContent: action.materialContent,
    sideEffects: action.sideEffects,
    policy: {
      id: action.authorityPolicyId,
      version: action.authorityPolicyVersion,
      mode: action.authorityMode,
    },
    productGuardrails: {
      version: action.productGuardrailsVersion,
      blocked: Boolean(
        guardrails && guardrailReason(action.actionFamily, action.actionSubtype, guardrails),
      ),
      reason: guardrails
        ? guardrailReason(action.actionFamily, action.actionSubtype, guardrails)
        : null,
    },
    preconditions: action.preconditions,
    validUntil: action.validUntil.toISOString(),
    executionWindow: {
      start: action.executionWindowStart?.toISOString() ?? null,
      end: action.executionWindowEnd?.toISOString() ?? null,
    },
    idempotencyKey: action.idempotencyKey,
    state: action.state,
    decision: decision ? toDecisionDto(decision) : null,
    authorization: authorization
      ? { id: authorization.id, claimedAt: authorization.claimedAt?.toISOString() ?? null }
      : null,
    recovery,
    createdAt: action.createdAt.toISOString(),
    updatedAt: action.updatedAt.toISOString(),
  };
}

function toDecisionDto(
  decision: typeof operatorActionDecisions.$inferSelect,
): FounderProposedActionDecisionDto {
  return {
    id: decision.id,
    kind: decision.kind,
    proposedActionId: decision.proposedActionId,
    proposedActionVersion: decision.proposedActionVersion,
    createdAt: decision.createdAt.toISOString(),
  };
}

async function currentRows(tx: ProposedActionTransaction, operatorId: string) {
  const rows = await tx
    .select()
    .from(operatorProposedActions)
    .where(eq(operatorProposedActions.operatorId, operatorId))
    .orderBy(desc(operatorProposedActions.createdAt), desc(operatorProposedActions.version));
  const superseded = new Set(
    rows.flatMap((row) => (row.supersedesActionId ? [row.supersedesActionId] : [])),
  );
  return rows.filter((row) => !superseded.has(row.id));
}

async function findByIdempotency(
  tx: ProposedActionTransaction,
  operatorId: string,
  idempotencyKey: string,
) {
  const [existing] = await tx
    .select()
    .from(operatorProposedActions)
    .where(
      and(
        eq(operatorProposedActions.operatorId, operatorId),
        eq(operatorProposedActions.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);
  return existing ?? null;
}

async function ensureAuthorityPolicy(tx: ProposedActionTransaction, operatorId: string, now: Date) {
  const [existing] = await tx
    .select()
    .from(operatorAuthorityPolicies)
    .where(eq(operatorAuthorityPolicies.operatorId, operatorId))
    .orderBy(desc(operatorAuthorityPolicies.version))
    .limit(1);
  if (existing) return existing;
  const [created] = await tx
    .insert(operatorAuthorityPolicies)
    .values({
      operatorId,
      version: 1,
      actionFamilies: FOUNDER_ACTION_FAMILY_DEFAULTS,
      observation: "always",
      preparation: "always",
      externalEffects: "approval_required",
      mailIncluded: false,
      confirmedAt: now,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [afterConflict] = await tx
    .select()
    .from(operatorAuthorityPolicies)
    .where(eq(operatorAuthorityPolicies.operatorId, operatorId))
    .orderBy(desc(operatorAuthorityPolicies.version))
    .limit(1);
  return afterConflict ?? null;
}

async function ensureProductGuardrails(
  tx: ProposedActionTransaction,
  operatorId: string,
  now: Date,
) {
  const [existing] = await tx
    .select()
    .from(operatorProductGuardrails)
    .where(eq(operatorProductGuardrails.operatorId, operatorId))
    .orderBy(desc(operatorProductGuardrails.version))
    .limit(1);
  if (existing) return existing;
  const [created] = await tx
    .insert(operatorProductGuardrails)
    .values({
      operatorId,
      version: PRODUCT_GUARDRAILS_VERSION,
      blockedActionFamilies: [],
      blockedSubtypes: [...BLOCKED_ACTION_SUBTYPES],
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [afterConflict] = await tx
    .select()
    .from(operatorProductGuardrails)
    .where(eq(operatorProductGuardrails.operatorId, operatorId))
    .orderBy(desc(operatorProductGuardrails.version))
    .limit(1);
  if (!afterConflict) {
    throw new FounderProposedActionError(
      "action_unavailable",
      "Product Guardrails could not be loaded.",
      503,
    );
  }
  return afterConflict;
}

async function getGuardrailsForProjection(
  tx: ProposedActionTransaction,
  operatorId: string,
  version: number,
) {
  const [guardrails] = await tx
    .select()
    .from(operatorProductGuardrails)
    .where(
      and(
        eq(operatorProductGuardrails.operatorId, operatorId),
        eq(operatorProductGuardrails.version, version),
      ),
    )
    .limit(1);
  return guardrails ?? null;
}

function normalizeText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text.length >= 1 && text.length <= max ? text : "";
}

function normalizeOptionalText(value: unknown, max: number): string | null {
  const text = normalizeText(value, max);
  return text || null;
}

function parseDate(value: Date | string | null | undefined): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseOptionalDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  return parseDate(value);
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizeActionFamilies(
  input: Record<FounderActionFamily, FounderAuthorityMode>,
): Record<FounderActionFamily, FounderAuthorityMode> {
  const normalized = {} as Record<FounderActionFamily, FounderAuthorityMode>;
  for (const family of FOUNDER_ACTION_FAMILIES) {
    const mode = input[family];
    if (mode !== "always" && mode !== "approval_required" && mode !== "never") {
      throw new FounderProposedActionError(
        "invalid_action",
        `Choose Always, Approval required, or Never for ${family}.`,
      );
    }
    if (
      mode === "always" &&
      (family === "external_communication" ||
        family === "meeting_management" ||
        family === "commercial_commitment" ||
        family === "data_control")
    ) {
      throw new FounderProposedActionError(
        "invalid_action",
        `${family} cannot be delegated as Always; keep Founder approval required or set Never.`,
      );
    }
    normalized[family] = mode;
  }
  return normalized;
}

function policyDto(
  policy: typeof operatorAuthorityPolicies.$inferSelect,
  governanceReceiptId: string,
): FounderAuthorityPolicyDto {
  return {
    version: policy.version,
    actionFamilies: policy.actionFamilies ?? FOUNDER_ACTION_FAMILY_DEFAULTS,
    governanceReceiptId,
    createdAt: policy.createdAt.toISOString(),
  };
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

async function lockOperator(tx: ProposedActionTransaction, operatorId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`bruno:proposed-action:${operatorId}`}, 0))`,
  );
}

async function withConnection<T>(
  dependencies: FounderProposedActionDependencies,
  callback: (connection: DatabaseConnection) => Promise<T>,
): Promise<T> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    return await callback(connection);
  } finally {
    if (ownsConnection) await connection.close();
  }
}
