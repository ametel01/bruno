import "server-only";

import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createDatabaseConnection } from "@/src/server/db/client";
import type * as schema from "@/src/server/db/schema";
import {
  operatorCalendarConnections,
  operatorMailConnections,
  operatorRelationshipCandidates,
  operatorRelationshipCorrections,
  operatorRelationshipEvidence,
  operatorRelationshipRecords,
} from "@/src/server/db/schema";
import { FOUNDER_OWNER_PREVIEW_WORK_REQUIREMENTS } from "@/src/server/founder-product-contract/preview-qualification";
import type { FounderOwnerPreviewAccessRequirement } from "@/src/server/founder-product-contract/release-stage-access";
import {
  type FounderOwnerPreviewWorkAuthorityDependencies,
  withFounderOwnerPreviewWorkAuthority,
} from "@/src/server/founder-product-contract/work-authority";
import {
  ensureFounderOperatorForUser,
  getFounderOperatorForUser,
} from "@/src/server/operators/founder-operator";

type FounderRelationshipTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

const MAX_NAME_LENGTH = 240;
const MAX_TEXT_LENGTH = 2_000;
const MAX_COMMITMENTS = 32;

export type FounderRelationshipState = "lead" | "client" | "partner" | "ignored";
export type FounderRelationshipStatus = "active" | "closed" | "ignored";
export type FounderRelationshipEvidenceState = "current" | "stale" | "disconnected" | "unavailable";
export type FounderRelationshipSourceKind = "calendar" | "mail";
export type FounderRelationshipCandidateMatchKind =
  | "exact_provider_identity"
  | "exact_email"
  | "fuzzy_name"
  | "fuzzy_company"
  | "fuzzy_domain";

export type FounderRelationshipEvidenceDto = {
  id: string;
  sourceKind: FounderRelationshipSourceKind;
  provider: string;
  providerItemId: string;
  displayName: string | null;
  company: string | null;
  excerpt: string | null;
  observedAt: string;
  state: FounderRelationshipEvidenceState;
  sourceLabel: string | null;
};

export type FounderRelationshipRecordDto = {
  id: string;
  displayName: string;
  company: string | null;
  primaryEmail: string | null;
  relationshipState: FounderRelationshipState;
  status: FounderRelationshipStatus;
  nextAction: string | null;
  nextActionDueAt: string | null;
  commitments: string[];
  revision: number;
  founderConfirmedAt: string | null;
  evidenceState: FounderRelationshipEvidenceState;
  evidence: FounderRelationshipEvidenceDto[];
  corrections: FounderRelationshipCorrectionDto[];
  createdAt: string;
  updatedAt: string;
};

export type FounderRelationshipCorrectionDto = {
  revision: number;
  field: "relationship_state" | "status" | "next_action" | "next_action_due_at" | "commitments";
  previousValue: unknown;
  nextValue: unknown;
  createdAt: string;
};

export type FounderRelationshipCandidateDto = {
  id: string;
  matchKind: FounderRelationshipCandidateMatchKind;
  status: "pending" | "confirmed" | "rejected";
  displayName: string;
  company: string | null;
  primaryEmail: string | null;
  domain: string | null;
  evidenceState: FounderRelationshipEvidenceState;
  evidence: FounderRelationshipEvidenceDto[];
  proposedRecordId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type FounderRelationshipsDto = {
  records: FounderRelationshipRecordDto[];
  candidates: FounderRelationshipCandidateDto[];
  generatedAt: string;
};

export type FounderRelationshipObservation = {
  sourceKind: FounderRelationshipSourceKind;
  connectionId: string;
  provider: string;
  providerItemId: string;
  providerIdentity?: string | null;
  email?: string | null;
  displayName?: string | null;
  company?: string | null;
  domain?: string | null;
  excerpt?: string | null;
  sourceMetadata?: Record<string, unknown>;
  observedAt: Date;
};

export type FounderRelationshipsDependencies = FounderOwnerPreviewWorkAuthorityDependencies & {
  now?: () => Date;
  randomUUID?: () => string;
};

export class FounderRelationshipsError extends Error {
  readonly code:
    | "relationship_unavailable"
    | "invalid_observation"
    | "invalid_update"
    | "relationship_not_found"
    | "candidate_not_found"
    | "candidate_already_resolved";
  readonly status: 400 | 404 | 409 | 503;

  constructor(
    code: FounderRelationshipsError["code"],
    message: string,
    status: FounderRelationshipsError["status"] = 409,
  ) {
    super(message);
    this.name = "FounderRelationshipsError";
    this.code = code;
    this.status = status;
  }
}

export async function getFounderRelationshipsForUser(
  userId: string,
  dependencies: Pick<FounderRelationshipsDependencies, "createConnection" | "now"> = {},
): Promise<FounderRelationshipsDto> {
  const now = dependencies.now ?? (() => new Date());
  const operator = await getFounderOperatorForUser(userId, dependencies);
  if (!operator) return { records: [], candidates: [], generatedAt: now().toISOString() };
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    return await connection.db.transaction((tx) => projectRelationships(tx, operator.id, now()));
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function ingestFounderRelationshipEvidenceForUser(
  userId: string,
  observations: FounderRelationshipObservation[],
  dependencies: FounderRelationshipsDependencies = {},
): Promise<FounderRelationshipsDto> {
  if (!Array.isArray(observations) || observations.length > 100) {
    throw new FounderRelationshipsError(
      "invalid_observation",
      "Relationship evidence must contain at most 100 observations.",
      400,
    );
  }
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  const makeId = dependencies.randomUUID ?? randomUUID;
  try {
    await withFounderOwnerPreviewWorkAuthority(
      {
        userId,
        now,
        requiredCapabilities: founderRelationshipEvidenceRequirement(observations),
      },
      { ...dependencies, createConnection: () => connection },
      async (tx, checkedAt) => {
        await lockOperator(tx, operator.id);
        for (const rawObservation of observations) {
          const observation = normalizeObservation(rawObservation);
          const source = await verifySourceConnection(tx, operator.id, observation);
          const sourceFingerprint = `${observation.sourceKind}:${observation.connectionId}:${observation.providerItemId}`;
          const exact = await findExactRecord(tx, operator.id, observation);
          const fuzzy = exact ? null : await findFuzzyCandidate(tx, operator.id, observation);
          // Once the Founder confirms a fuzzy candidate, keep future observations on
          // that confirmed record. Pending and rejected candidates remain candidates
          // until the Founder makes an explicit decision.
          const recordId =
            exact?.id ?? (fuzzy?.status === "confirmed" ? fuzzy.proposedRecordId : null);
          let candidateId = recordId ? null : (fuzzy?.id ?? null);
          if (!recordId && !candidateId) {
            const candidate = await createOrGetCandidate(
              tx,
              operator.id,
              observation,
              makeId,
              checkedAt,
            );
            candidateId = candidate.id;
          }

          const values = {
            operatorId: operator.id,
            recordId,
            candidateId,
            sourceKind: observation.sourceKind,
            calendarConnectionId:
              observation.sourceKind === "calendar" ? observation.connectionId : null,
            mailConnectionId: observation.sourceKind === "mail" ? observation.connectionId : null,
            provider: observation.provider,
            providerItemId: observation.providerItemId,
            providerIdentity: observation.providerIdentity,
            email: observation.email,
            displayName: observation.displayName,
            company: observation.company,
            domain: observation.domain,
            excerpt: observation.excerpt,
            sourceMetadata: observation.sourceMetadata ?? {},
            evidenceState: source.evidenceState,
            observedAt: observation.observedAt,
            sourceFingerprint,
            updatedAt: checkedAt,
          };
          await tx
            .insert(operatorRelationshipEvidence)
            .values({ ...values, id: makeId(), createdAt: checkedAt })
            .onConflictDoUpdate({
              target: [
                operatorRelationshipEvidence.operatorId,
                operatorRelationshipEvidence.sourceFingerprint,
              ],
              set: values,
            });
        }
      },
    );
    return await getFounderRelationshipsForUser(userId, {
      createConnection: () => connection,
      now,
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export function founderRelationshipEvidenceRequirement(
  observations: readonly Pick<FounderRelationshipObservation, "sourceKind">[],
): Exclude<FounderOwnerPreviewAccessRequirement, "workspace"> {
  return observations.some((observation) => observation.sourceKind === "mail")
    ? FOUNDER_OWNER_PREVIEW_WORK_REQUIREMENTS.forbidden
    : FOUNDER_OWNER_PREVIEW_WORK_REQUIREMENTS.calendarRelationshipEvidence;
}

export async function updateFounderRelationshipRecordForUser(
  userId: string,
  recordId: string,
  patch: {
    relationshipState?: FounderRelationshipState;
    status?: FounderRelationshipStatus;
    nextAction?: string | null;
    nextActionDueAt?: string | null;
    commitments?: string[];
  },
  dependencies: FounderRelationshipsDependencies = {},
): Promise<FounderRelationshipsDto> {
  const normalized = normalizeRecordPatch(patch);
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  try {
    await connection.db.transaction(async (tx) => {
      await lockOperator(tx, operator.id);
      const [record] = await tx
        .select()
        .from(operatorRelationshipRecords)
        .where(
          and(
            eq(operatorRelationshipRecords.id, recordId),
            eq(operatorRelationshipRecords.operatorId, operator.id),
          ),
        )
        .limit(1);
      if (!record)
        throw new FounderRelationshipsError(
          "relationship_not_found",
          "That Relationship Record is not available in this Founder workspace.",
          404,
        );

      const changed = changedFields(record, normalized);
      if (changed.length === 0) return;
      const revision = record.revision + 1;
      const at = now();
      const nextStatus = normalized.status ?? record.status;
      const [updated] = await tx
        .update(operatorRelationshipRecords)
        .set({
          ...normalized,
          closedAt: nextStatus === "active" ? null : (record.closedAt ?? at),
          revision,
          updatedAt: at,
        })
        .where(
          and(
            eq(operatorRelationshipRecords.id, record.id),
            eq(operatorRelationshipRecords.operatorId, operator.id),
          ),
        )
        .returning();
      if (!updated)
        throw new FounderRelationshipsError(
          "relationship_unavailable",
          "Relationship Record could not be saved.",
          503,
        );
      await tx.insert(operatorRelationshipCorrections).values(
        changed.map((field) => ({
          id: randomUUID(),
          operatorId: operator.id,
          recordId: record.id,
          revision,
          field,
          previousValue: correctionValue(record, field),
          nextValue: correctionValue(updated, field),
          createdAt: at,
        })),
      );
    });
    return await getFounderRelationshipsForUser(userId, {
      createConnection: () => connection,
      now,
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function confirmFounderRelationshipCandidateForUser(
  userId: string,
  candidateId: string,
  dependencies: FounderRelationshipsDependencies = {},
): Promise<FounderRelationshipsDto> {
  return resolveCandidate(userId, candidateId, "confirmed", dependencies);
}

export async function rejectFounderRelationshipCandidateForUser(
  userId: string,
  candidateId: string,
  dependencies: FounderRelationshipsDependencies = {},
): Promise<FounderRelationshipsDto> {
  return resolveCandidate(userId, candidateId, "rejected", dependencies);
}

async function resolveCandidate(
  userId: string,
  candidateId: string,
  resolution: "confirmed" | "rejected",
  dependencies: FounderRelationshipsDependencies,
): Promise<FounderRelationshipsDto> {
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const now = dependencies.now ?? (() => new Date());
  const makeId = dependencies.randomUUID ?? randomUUID;
  try {
    await connection.db.transaction(async (tx) => {
      await lockOperator(tx, operator.id);
      const [candidate] = await tx
        .select()
        .from(operatorRelationshipCandidates)
        .where(
          and(
            eq(operatorRelationshipCandidates.id, candidateId),
            eq(operatorRelationshipCandidates.operatorId, operator.id),
          ),
        )
        .limit(1);
      if (!candidate)
        throw new FounderRelationshipsError(
          "candidate_not_found",
          "That Relationship Candidate is not available.",
          404,
        );
      if (candidate.status !== "pending")
        throw new FounderRelationshipsError(
          "candidate_already_resolved",
          "That Relationship Candidate has already been resolved.",
        );
      const at = now();
      if (resolution === "rejected") {
        await tx
          .update(operatorRelationshipCandidates)
          .set({ status: "rejected", resolvedAt: at, updatedAt: at })
          .where(eq(operatorRelationshipCandidates.id, candidate.id));
        return;
      }

      const existing = await findExactRecord(tx, operator.id, {
        provider: candidate.provider ?? "",
        providerIdentity: candidate.providerIdentity,
        email: candidate.primaryEmail,
      });
      const record =
        existing ??
        (
          await tx
            .insert(operatorRelationshipRecords)
            .values({
              id: makeId(),
              operatorId: operator.id,
              displayName: candidate.displayName,
              company: candidate.company,
              primaryEmail: candidate.primaryEmail,
              provider: candidate.provider,
              providerIdentity: candidate.providerIdentity,
              founderConfirmedAt: at,
              createdAt: at,
              updatedAt: at,
            })
            .returning()
        )[0];
      if (!record)
        throw new FounderRelationshipsError(
          "relationship_unavailable",
          "Relationship Record could not be created.",
          503,
        );
      await tx
        .update(operatorRelationshipCandidates)
        .set({ status: "confirmed", proposedRecordId: record.id, resolvedAt: at, updatedAt: at })
        .where(eq(operatorRelationshipCandidates.id, candidate.id));
      await tx
        .update(operatorRelationshipEvidence)
        .set({ recordId: record.id, candidateId: null, updatedAt: at })
        .where(
          and(
            eq(operatorRelationshipEvidence.operatorId, operator.id),
            eq(operatorRelationshipEvidence.candidateId, candidate.id),
          ),
        );
    });
    return await getFounderRelationshipsForUser(userId, {
      createConnection: () => connection,
      now,
    });
  } finally {
    if (ownsConnection) await connection.close();
  }
}

async function projectRelationships(
  tx: FounderRelationshipTransaction,
  operatorId: string,
  now: Date,
): Promise<FounderRelationshipsDto> {
  const [records, candidates, evidence, corrections, calendarConnections, mailConnections] =
    await Promise.all([
      tx
        .select()
        .from(operatorRelationshipRecords)
        .where(eq(operatorRelationshipRecords.operatorId, operatorId))
        .orderBy(desc(operatorRelationshipRecords.updatedAt)),
      tx
        .select()
        .from(operatorRelationshipCandidates)
        .where(eq(operatorRelationshipCandidates.operatorId, operatorId))
        .orderBy(desc(operatorRelationshipCandidates.updatedAt)),
      tx
        .select()
        .from(operatorRelationshipEvidence)
        .where(eq(operatorRelationshipEvidence.operatorId, operatorId))
        .orderBy(desc(operatorRelationshipEvidence.observedAt)),
      tx
        .select()
        .from(operatorRelationshipCorrections)
        .where(eq(operatorRelationshipCorrections.operatorId, operatorId))
        .orderBy(desc(operatorRelationshipCorrections.createdAt)),
      tx
        .select()
        .from(operatorCalendarConnections)
        .where(eq(operatorCalendarConnections.operatorId, operatorId)),
      tx
        .select()
        .from(operatorMailConnections)
        .where(eq(operatorMailConnections.operatorId, operatorId)),
    ]);
  const sourceLabels = new Map<string, string | null>();
  const sourceStates = new Map<string, FounderRelationshipEvidenceState>();
  for (const connection of calendarConnections) {
    sourceLabels.set(`calendar:${connection.id}`, connection.accountLabel);
    sourceStates.set(
      `calendar:${connection.id}`,
      effectiveSourceState(connection.status, connection.evidenceState),
    );
  }
  for (const connection of mailConnections) {
    sourceLabels.set(`mail:${connection.id}`, connection.accountLabel);
    sourceStates.set(
      `mail:${connection.id}`,
      effectiveSourceState(connection.status, connection.evidenceState),
    );
  }
  const projectedEvidence = evidence.map((item) => toEvidenceDto(item, sourceStates, sourceLabels));
  const evidenceByRecord = groupEvidence(projectedEvidence, evidence, "recordId");
  const evidenceByCandidate = groupEvidence(projectedEvidence, evidence, "candidateId");
  const correctionsByRecord = new Map<string, FounderRelationshipCorrectionDto[]>();
  for (const correction of corrections) {
    const values = correctionsByRecord.get(correction.recordId) ?? [];
    values.push({
      revision: correction.revision,
      field: correction.field as FounderRelationshipCorrectionDto["field"],
      previousValue: correction.previousValue,
      nextValue: correction.nextValue,
      createdAt: correction.createdAt.toISOString(),
    });
    correctionsByRecord.set(correction.recordId, values);
  }
  return {
    records: records.map((record) => ({
      id: record.id,
      displayName: record.displayName,
      company: record.company,
      primaryEmail: record.primaryEmail,
      relationshipState: record.relationshipState,
      status: record.status,
      nextAction: record.nextAction,
      nextActionDueAt: record.nextActionDueAt?.toISOString() ?? null,
      commitments: record.commitments,
      revision: record.revision,
      founderConfirmedAt: record.founderConfirmedAt?.toISOString() ?? null,
      evidenceState: aggregateEvidenceState(evidenceByRecord.get(record.id) ?? []),
      evidence: evidenceByRecord.get(record.id) ?? [],
      corrections: correctionsByRecord.get(record.id) ?? [],
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    })),
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      matchKind: candidate.matchKind,
      status: candidate.status,
      displayName: candidate.displayName,
      company: candidate.company,
      primaryEmail: candidate.primaryEmail,
      domain: candidate.domain,
      evidenceState: aggregateEvidenceState(evidenceByCandidate.get(candidate.id) ?? []),
      evidence: evidenceByCandidate.get(candidate.id) ?? [],
      proposedRecordId: candidate.proposedRecordId,
      createdAt: candidate.createdAt.toISOString(),
      updatedAt: candidate.updatedAt.toISOString(),
    })),
    generatedAt: now.toISOString(),
  };
}

function normalizeObservation(raw: FounderRelationshipObservation): FounderRelationshipObservation {
  if (!raw || (raw.sourceKind !== "calendar" && raw.sourceKind !== "mail")) {
    throw new FounderRelationshipsError(
      "invalid_observation",
      "Relationship evidence source is invalid.",
      400,
    );
  }
  const providerItemId = normalizeText(raw.providerItemId, 500);
  const provider = normalizeText(raw.provider, 120);
  const connectionId = normalizeText(raw.connectionId, 80);
  const displayName = normalizeOptionalText(raw.displayName, MAX_NAME_LENGTH);
  const company = normalizeOptionalText(raw.company, MAX_NAME_LENGTH);
  const email = normalizeEmail(raw.email);
  const providerIdentity = normalizeOptionalText(raw.providerIdentity, 240);
  const domain = normalizeDomain(raw.domain ?? email?.split("@")[1] ?? null);
  const excerpt = normalizeOptionalText(raw.excerpt, MAX_TEXT_LENGTH);
  const sourceMetadata = isJsonRecord(raw.sourceMetadata) ? raw.sourceMetadata : {};
  if (
    !providerItemId ||
    !provider ||
    !connectionId ||
    (!displayName && !email && !providerIdentity)
  ) {
    throw new FounderRelationshipsError(
      "invalid_observation",
      "Relationship evidence needs a source and identity.",
      400,
    );
  }
  if (!(raw.observedAt instanceof Date) || Number.isNaN(raw.observedAt.getTime())) {
    throw new FounderRelationshipsError(
      "invalid_observation",
      "Relationship evidence timestamp is invalid.",
      400,
    );
  }
  return {
    sourceKind: raw.sourceKind,
    connectionId,
    provider,
    providerItemId,
    providerIdentity,
    email,
    displayName,
    company,
    domain,
    excerpt,
    sourceMetadata,
    observedAt: raw.observedAt,
  };
}

async function verifySourceConnection(
  tx: FounderRelationshipTransaction,
  operatorId: string,
  observation: FounderRelationshipObservation,
): Promise<{ evidenceState: FounderRelationshipEvidenceState }> {
  if (observation.sourceKind === "calendar") {
    const [connection] = await tx
      .select()
      .from(operatorCalendarConnections)
      .where(
        and(
          eq(operatorCalendarConnections.id, observation.connectionId),
          eq(operatorCalendarConnections.operatorId, operatorId),
        ),
      )
      .limit(1);
    if (!connection)
      throw new FounderRelationshipsError(
        "invalid_observation",
        "Calendar evidence does not belong to this Founder workspace.",
        400,
      );
    return { evidenceState: effectiveSourceState(connection.status, connection.evidenceState) };
  }
  const [connection] = await tx
    .select()
    .from(operatorMailConnections)
    .where(
      and(
        eq(operatorMailConnections.id, observation.connectionId),
        eq(operatorMailConnections.operatorId, operatorId),
      ),
    )
    .limit(1);
  if (!connection)
    throw new FounderRelationshipsError(
      "invalid_observation",
      "Mail evidence does not belong to this Founder workspace.",
      400,
    );
  return { evidenceState: effectiveSourceState(connection.status, connection.evidenceState) };
}

async function findExactRecord(
  tx: FounderRelationshipTransaction,
  operatorId: string,
  observation: Pick<FounderRelationshipObservation, "provider" | "providerIdentity" | "email">,
) {
  const clauses = [];
  if (observation.providerIdentity && observation.provider) {
    clauses.push(
      and(
        eq(operatorRelationshipRecords.provider, observation.provider),
        eq(operatorRelationshipRecords.providerIdentity, observation.providerIdentity),
      ),
    );
  }
  if (observation.email)
    clauses.push(eq(operatorRelationshipRecords.primaryEmail, observation.email));
  if (clauses.length === 0) return null;
  const [record] = await tx
    .select()
    .from(operatorRelationshipRecords)
    .where(and(eq(operatorRelationshipRecords.operatorId, operatorId), or(...clauses)))
    .orderBy(asc(operatorRelationshipRecords.createdAt))
    .limit(1);
  return record ?? null;
}

async function findFuzzyCandidate(
  tx: FounderRelationshipTransaction,
  operatorId: string,
  observation: FounderRelationshipObservation,
) {
  const key = candidateKey(observation);
  if (!key) return null;
  const [candidate] = await tx
    .select()
    .from(operatorRelationshipCandidates)
    .where(
      and(
        eq(operatorRelationshipCandidates.operatorId, operatorId),
        eq(operatorRelationshipCandidates.candidateKey, key),
      ),
    )
    .limit(1);
  return candidate ?? null;
}

async function createOrGetCandidate(
  tx: FounderRelationshipTransaction,
  operatorId: string,
  observation: FounderRelationshipObservation,
  makeId: () => string,
  now: Date,
) {
  const key = candidateKey(observation);
  if (!key)
    throw new FounderRelationshipsError(
      "invalid_observation",
      "Evidence needs a name, company, domain, email, or provider identity.",
      400,
    );
  const matchKind = candidateMatchKind(observation);
  const [candidate] = await tx
    .insert(operatorRelationshipCandidates)
    .values({
      id: makeId(),
      operatorId,
      matchKind,
      displayName:
        observation.displayName ??
        observation.email ??
        observation.providerIdentity ??
        "Relationship candidate",
      company: observation.company,
      primaryEmail: observation.email,
      provider: observation.providerIdentity ? observation.provider : null,
      providerIdentity: observation.providerIdentity,
      domain: observation.domain,
      candidateKey: key,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({
      target: [
        operatorRelationshipCandidates.operatorId,
        operatorRelationshipCandidates.candidateKey,
      ],
    })
    .returning();
  if (candidate) return candidate;
  const [existing] = await tx
    .select()
    .from(operatorRelationshipCandidates)
    .where(
      and(
        eq(operatorRelationshipCandidates.operatorId, operatorId),
        eq(operatorRelationshipCandidates.candidateKey, key),
      ),
    )
    .limit(1);
  if (!existing)
    throw new FounderRelationshipsError(
      "relationship_unavailable",
      "Relationship Candidate could not be saved.",
      503,
    );
  return existing;
}

function candidateKey(
  observation: Pick<
    FounderRelationshipObservation,
    "displayName" | "company" | "domain" | "email" | "providerIdentity" | "provider"
  >,
): string | null {
  if (observation.providerIdentity && observation.provider)
    return `provider:${observation.provider}:${normalizeKey(observation.providerIdentity)}`;
  if (observation.email) return `email:${normalizeKey(observation.email)}`;
  const name = normalizeKey(observation.displayName);
  const company = normalizeKey(observation.company);
  const domain = normalizeKey(observation.domain);
  if (!name && !company && !domain) return null;
  return `fuzzy:${name}|${company}|${domain}`;
}

function candidateMatchKind(
  observation: FounderRelationshipObservation,
): FounderRelationshipCandidateMatchKind {
  if (observation.providerIdentity && observation.provider) return "exact_provider_identity";
  if (observation.email) return "exact_email";
  if (observation.domain) return "fuzzy_domain";
  if (observation.company) return "fuzzy_company";
  return "fuzzy_name";
}

function normalizeRecordPatch(patch: {
  relationshipState?: FounderRelationshipState;
  status?: FounderRelationshipStatus;
  nextAction?: string | null;
  nextActionDueAt?: string | null;
  commitments?: string[];
}): {
  relationshipState?: FounderRelationshipState;
  status?: FounderRelationshipStatus;
  nextAction?: string | null;
  nextActionDueAt?: Date | null;
  commitments?: string[];
} {
  if (
    patch.relationshipState &&
    !["lead", "client", "partner", "ignored"].includes(patch.relationshipState)
  )
    throw new FounderRelationshipsError(
      "invalid_update",
      "Choose a supported relationship state.",
      400,
    );
  if (patch.status && !["active", "closed", "ignored"].includes(patch.status))
    throw new FounderRelationshipsError(
      "invalid_update",
      "Choose a supported Relationship Record status.",
      400,
    );
  const nextAction =
    patch.nextAction === undefined
      ? undefined
      : normalizeOptionalText(patch.nextAction, MAX_TEXT_LENGTH);
  let nextActionDueAt: Date | null | undefined;
  if (patch.nextActionDueAt === undefined) nextActionDueAt = undefined;
  else if (patch.nextActionDueAt === null || patch.nextActionDueAt === "") nextActionDueAt = null;
  else {
    nextActionDueAt = new Date(patch.nextActionDueAt);
    if (Number.isNaN(nextActionDueAt.getTime()))
      throw new FounderRelationshipsError("invalid_update", "Next action date is invalid.", 400);
  }
  let commitments: string[] | undefined;
  if (patch.commitments !== undefined) {
    if (!Array.isArray(patch.commitments) || patch.commitments.length > MAX_COMMITMENTS)
      throw new FounderRelationshipsError(
        "invalid_update",
        "Add no more than 32 commitments.",
        400,
      );
    commitments = patch.commitments
      .map((value) => normalizeText(value, MAX_TEXT_LENGTH))
      .filter(Boolean) as string[];
    if (commitments.length !== patch.commitments.length)
      throw new FounderRelationshipsError(
        "invalid_update",
        "Commitments must be non-empty text.",
        400,
      );
  }
  const normalized: ReturnType<typeof normalizeRecordPatch> = {};
  if (patch.relationshipState !== undefined) normalized.relationshipState = patch.relationshipState;
  if (patch.status !== undefined) normalized.status = patch.status;
  if (nextAction !== undefined) normalized.nextAction = nextAction;
  if (nextActionDueAt !== undefined) normalized.nextActionDueAt = nextActionDueAt;
  if (commitments !== undefined) normalized.commitments = commitments;
  return normalized;
}

function changedFields(
  record: typeof operatorRelationshipRecords.$inferSelect,
  patch: ReturnType<typeof normalizeRecordPatch>,
): string[] {
  const changed: string[] = [];
  if (patch.relationshipState !== undefined && patch.relationshipState !== record.relationshipState)
    changed.push("relationship_state");
  if (patch.status !== undefined && patch.status !== record.status) changed.push("status");
  if (patch.nextAction !== undefined && patch.nextAction !== record.nextAction)
    changed.push("next_action");
  if (
    patch.nextActionDueAt !== undefined &&
    (patch.nextActionDueAt?.getTime() ?? null) !== (record.nextActionDueAt?.getTime() ?? null)
  )
    changed.push("next_action_due_at");
  if (
    patch.commitments !== undefined &&
    JSON.stringify(patch.commitments) !== JSON.stringify(record.commitments)
  )
    changed.push("commitments");
  return changed;
}

function correctionValue(
  record: typeof operatorRelationshipRecords.$inferSelect,
  field: string,
): unknown {
  switch (field) {
    case "relationship_state":
      return record.relationshipState;
    case "status":
      return record.status;
    case "next_action":
      return record.nextAction;
    case "next_action_due_at":
      return record.nextActionDueAt?.toISOString() ?? null;
    case "commitments":
      return record.commitments;
    default:
      return null;
  }
}

function effectiveSourceState(
  status: string,
  evidenceState: string,
): FounderRelationshipEvidenceState {
  if (status === "disconnected") return "disconnected";
  if (evidenceState === "unavailable") return "unavailable";
  if (status === "ready" && evidenceState === "current") return "current";
  return "stale";
}

function toEvidenceDto(
  evidence: typeof operatorRelationshipEvidence.$inferSelect,
  sourceStates: Map<string, FounderRelationshipEvidenceState>,
  sourceLabels: Map<string, string | null>,
): FounderRelationshipEvidenceDto {
  const sourceKey = `${evidence.sourceKind}:${evidence.sourceKind === "calendar" ? evidence.calendarConnectionId : evidence.mailConnectionId}`;
  return {
    id: evidence.id,
    sourceKind: evidence.sourceKind,
    provider: evidence.provider,
    providerItemId: evidence.providerItemId,
    displayName: evidence.displayName,
    company: evidence.company,
    excerpt: evidence.excerpt,
    observedAt: evidence.observedAt.toISOString(),
    state: sourceStates.get(sourceKey) ?? "disconnected",
    sourceLabel: sourceLabels.get(sourceKey) ?? null,
  };
}

function groupEvidence(
  projected: FounderRelationshipEvidenceDto[],
  raw: Array<typeof operatorRelationshipEvidence.$inferSelect>,
  key: "recordId" | "candidateId",
): Map<string, FounderRelationshipEvidenceDto[]> {
  const grouped = new Map<string, FounderRelationshipEvidenceDto[]>();
  raw.forEach((item, index) => {
    const id = item[key];
    if (!id) return;
    const values = grouped.get(id) ?? [];
    const value = projected[index];
    if (value) values.push(value);
    grouped.set(id, values);
  });
  return grouped;
}

function aggregateEvidenceState(
  evidence: FounderRelationshipEvidenceDto[],
): FounderRelationshipEvidenceState {
  if (evidence.some((item) => item.state === "current")) return "current";
  if (evidence.some((item) => item.state === "stale")) return "stale";
  if (evidence.some((item) => item.state === "unavailable")) return "unavailable";
  return "disconnected";
}

function normalizeText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function normalizeOptionalText(value: unknown, maxLength: number): string | null {
  const normalized = normalizeText(value, maxLength);
  return normalized || null;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeEmail(value: unknown): string | null {
  const normalized = normalizeOptionalText(value, 320)?.toLowerCase() ?? null;
  return normalized && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : null;
}

function normalizeDomain(value: unknown): string | null {
  const normalized =
    normalizeOptionalText(value, 240)
      ?.toLowerCase()
      .replace(/^www\./, "") ?? null;
  return normalized && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(normalized) ? normalized : null;
}

function normalizeKey(value: unknown): string {
  return normalizeText(value, 240).toLowerCase().replace(/\s+/g, " ");
}

async function lockOperator(tx: FounderRelationshipTransaction, operatorId: string): Promise<void> {
  await tx.execute(sql`SELECT id FROM operators WHERE id = ${operatorId} FOR UPDATE`);
}
