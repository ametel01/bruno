import "server-only";

import { and, desc, eq, lte } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import type * as schema from "@/src/server/db/schema";
import { founderPreviewQualifications, operatorRuntimes, operators } from "@/src/server/db/schema";
import { readFounderApplicationRevision } from "./application-revision";
import {
  FOUNDER_EXTERNAL_BETA_CAPABILITIES,
  FOUNDER_EXTERNAL_BETA_QUALIFICATION_MAX_AGE_MS,
  type FounderExternalBetaCapability,
  type FounderExternalBetaQualification,
  founderExternalBetaCapabilityLabel,
  requireFounderExternalBetaQualifications,
} from "./external-beta-qualification";

type FounderExternalBetaManifestTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

export type FounderExternalBetaManifest = {
  stage: "external_beta";
  cohort: string;
  applicationRevision: string;
  runtimeRevision: string;
  complete: boolean;
  qualifiedCapabilities: readonly FounderExternalBetaCapability[];
  unavailableCapabilities: readonly FounderExternalBetaCapability[];
  safeWorkCheckpointsPreserved: true;
};

export type FounderExternalBetaManifestStatus = {
  stage: "External Beta";
  state: "waiting" | "ready" | "limited";
  capabilities: readonly {
    name: string;
    state: "available" | "paused";
  }[];
  providerChoice: "Connect OpenAI, Anthropic, or both";
  capacityBoundary: "Uses only your connected provider accounts";
  workContinuity: "Unaffected work stays available from a safe checkpoint";
};

export async function qualifyFounderExternalBetaManifest(
  input: {
    cohort: string;
    applicationRevision: string;
    runtimeRevision: string;
    now: Date;
  },
  dependencies: {
    createConnection?: () => DatabaseConnection;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<FounderExternalBetaManifest> {
  const qualifications = requireFounderExternalBetaQualifications(
    input,
    dependencies.env ?? process.env,
  );
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    await connection.db.transaction((tx) =>
      persistFounderExternalBetaQualificationsInTransaction(tx, qualifications, input.now),
    );
    return manifestFromQualifications(input, qualifications);
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function qualifyFounderExternalBetaManifestForUser(
  userId: string,
  now: Date,
  dependencies: {
    applicationRevision?: string;
    cohort?: string;
    createConnection?: () => DatabaseConnection;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<FounderExternalBetaManifest> {
  const environment = dependencies.env ?? process.env;
  const applicationRevision =
    dependencies.applicationRevision ?? readFounderApplicationRevision({ env: environment });
  const cohort = dependencies.cohort ?? environment.BRUNO_EXTERNAL_BETA_COHORT?.trim();
  if (!applicationRevision || !cohort) {
    throw new Error("External Beta candidate configuration is unavailable.");
  }
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    const candidate = await readReadyCandidate(connection, userId);
    const qualifications = requireFounderExternalBetaQualifications(
      { cohort, applicationRevision, runtimeRevision: candidate.runtimeRevision, now },
      environment,
    );
    await connection.db.transaction((tx) =>
      persistFounderExternalBetaQualificationsInTransaction(tx, qualifications, now),
    );
    return manifestFromQualifications(
      { cohort, applicationRevision, runtimeRevision: candidate.runtimeRevision, now },
      qualifications,
    );
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function persistFounderExternalBetaQualificationsInTransaction(
  tx: FounderExternalBetaManifestTransaction,
  qualifications: readonly FounderExternalBetaQualification[],
  now: Date,
): Promise<void> {
  const first = qualifications[0];
  if (
    !first ||
    qualifications.length !== FOUNDER_EXTERNAL_BETA_CAPABILITIES.length ||
    FOUNDER_EXTERNAL_BETA_CAPABILITIES.some(
      (capability) =>
        qualifications.filter((qualification) => qualification.capability === capability).length !==
        1,
    ) ||
    new Set(qualifications.map((qualification) => qualification.evidenceDigest)).size !==
      qualifications.length ||
    Number.isNaN(now.valueOf()) ||
    qualifications.some(
      (qualification) =>
        qualification.stage !== "external_beta" ||
        qualification.cohort !== first.cohort ||
        qualification.applicationRevision !== first.applicationRevision ||
        qualification.runtimeRevision !== first.runtimeRevision ||
        !hasCurrentQualificationWindow(qualification, now),
    )
  ) {
    throw new Error("External Beta qualification manifest is incomplete or inconsistent.");
  }

  await tx
    .insert(founderPreviewQualifications)
    .values(
      qualifications.map((qualification) => ({
        stage: qualification.stage,
        cohort: qualification.cohort,
        capability: qualification.capability,
        applicationRevision: qualification.applicationRevision,
        runtimeRevision: qualification.runtimeRevision,
        evidenceDigest: qualification.evidenceDigest,
        observedAt: new Date(qualification.observedAt),
        expiresAt: new Date(qualification.expiresAt),
        createdAt: new Date(qualification.observedAt),
      })),
    )
    .onConflictDoNothing();
}

export async function getFounderExternalBetaManifest(
  input: {
    cohort: string;
    applicationRevision: string;
    runtimeRevision: string;
    now: Date;
  },
  dependencies: { createConnection?: () => DatabaseConnection } = {},
): Promise<FounderExternalBetaManifest> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    const rows = await connection.db
      .select({
        capability: founderPreviewQualifications.capability,
        observedAt: founderPreviewQualifications.observedAt,
        expiresAt: founderPreviewQualifications.expiresAt,
      })
      .from(founderPreviewQualifications)
      .where(
        and(
          eq(founderPreviewQualifications.stage, "external_beta"),
          eq(founderPreviewQualifications.cohort, input.cohort),
          eq(founderPreviewQualifications.applicationRevision, input.applicationRevision),
          eq(founderPreviewQualifications.runtimeRevision, input.runtimeRevision),
          lte(founderPreviewQualifications.observedAt, input.now),
        ),
      )
      .orderBy(desc(founderPreviewQualifications.observedAt));

    const current = new Set<FounderExternalBetaCapability>();
    const seen = new Set<FounderExternalBetaCapability>();
    for (const row of rows) {
      if (!isFounderExternalBetaCapability(row.capability) || seen.has(row.capability)) continue;
      seen.add(row.capability);
      if (
        row.expiresAt > input.now &&
        row.expiresAt.valueOf() - row.observedAt.valueOf() <=
          FOUNDER_EXTERNAL_BETA_QUALIFICATION_MAX_AGE_MS
      ) {
        current.add(row.capability);
      }
    }
    const qualifiedCapabilities = FOUNDER_EXTERNAL_BETA_CAPABILITIES.filter((capability) =>
      current.has(capability),
    );
    const unavailableCapabilities = FOUNDER_EXTERNAL_BETA_CAPABILITIES.filter(
      (capability) => !current.has(capability),
    );
    return {
      stage: "external_beta",
      cohort: input.cohort,
      applicationRevision: input.applicationRevision,
      runtimeRevision: input.runtimeRevision,
      complete: unavailableCapabilities.length === 0,
      qualifiedCapabilities,
      unavailableCapabilities,
      safeWorkCheckpointsPreserved: true,
    };
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function getFounderExternalBetaManifestForUser(
  userId: string,
  now: Date,
  dependencies: {
    applicationRevision?: string;
    cohort?: string;
    createConnection?: () => DatabaseConnection;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<FounderExternalBetaManifest> {
  const environment = dependencies.env ?? process.env;
  const applicationRevision =
    dependencies.applicationRevision ?? readFounderApplicationRevision({ env: environment });
  const cohort = dependencies.cohort ?? environment.BRUNO_EXTERNAL_BETA_COHORT?.trim();
  if (!applicationRevision || !cohort) {
    throw new Error("External Beta candidate configuration is unavailable.");
  }
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    const candidate = await readReadyCandidate(connection, userId);
    return await getFounderExternalBetaManifest(
      { cohort, applicationRevision, runtimeRevision: candidate.runtimeRevision, now },
      { createConnection: () => connection },
    );
  } finally {
    if (ownsConnection) await connection.close();
  }
}

export async function getFounderExternalBetaManifestStatusForUser(
  userId: string,
  now: Date,
  dependencies: {
    applicationRevision?: string;
    cohort?: string;
    createConnection?: () => DatabaseConnection;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<FounderExternalBetaManifestStatus> {
  try {
    return projectFounderExternalBetaManifestStatus(
      await getFounderExternalBetaManifestForUser(userId, now, dependencies),
    );
  } catch {
    return unavailableFounderExternalBetaManifestStatus();
  }
}

export function unavailableFounderExternalBetaManifestStatus(): FounderExternalBetaManifestStatus {
  return projectFounderExternalBetaManifestStatus({
    complete: false,
    qualifiedCapabilities: [],
    unavailableCapabilities: FOUNDER_EXTERNAL_BETA_CAPABILITIES,
  });
}

export function projectFounderExternalBetaManifestStatus(
  manifest: Pick<
    FounderExternalBetaManifest,
    "complete" | "qualifiedCapabilities" | "unavailableCapabilities"
  >,
): FounderExternalBetaManifestStatus {
  const capabilities = FOUNDER_EXTERNAL_BETA_CAPABILITIES.map((capability) => ({
    name: founderExternalBetaCapabilityLabel(capability),
    state: manifest.qualifiedCapabilities.includes(capability)
      ? ("available" as const)
      : ("paused" as const),
  }));
  return {
    stage: "External Beta",
    state: manifest.complete
      ? "ready"
      : manifest.qualifiedCapabilities.length > 0
        ? "limited"
        : "waiting",
    capabilities,
    providerChoice: "Connect OpenAI, Anthropic, or both",
    capacityBoundary: "Uses only your connected provider accounts",
    workContinuity: "Unaffected work stays available from a safe checkpoint",
  };
}

function manifestFromQualifications(
  input: {
    cohort: string;
    applicationRevision: string;
    runtimeRevision: string;
    now: Date;
  },
  qualifications: readonly FounderExternalBetaQualification[],
): FounderExternalBetaManifest {
  const qualifiedCapabilities = FOUNDER_EXTERNAL_BETA_CAPABILITIES.filter((capability) =>
    qualifications.some(
      (qualification) =>
        qualification.capability === capability && new Date(qualification.expiresAt) > input.now,
    ),
  );
  const unavailableCapabilities = FOUNDER_EXTERNAL_BETA_CAPABILITIES.filter(
    (capability) => !qualifiedCapabilities.includes(capability),
  );
  return {
    stage: "external_beta",
    cohort: input.cohort,
    applicationRevision: input.applicationRevision,
    runtimeRevision: input.runtimeRevision,
    complete: unavailableCapabilities.length === 0,
    qualifiedCapabilities,
    unavailableCapabilities,
    safeWorkCheckpointsPreserved: true,
  };
}

function isFounderExternalBetaCapability(value: string): value is FounderExternalBetaCapability {
  return FOUNDER_EXTERNAL_BETA_CAPABILITIES.some((capability) => capability === value);
}

function hasCurrentQualificationWindow(
  qualification: FounderExternalBetaQualification,
  now: Date,
): boolean {
  const observedAt = readCanonicalDate(qualification.observedAt);
  const expiresAt = readCanonicalDate(qualification.expiresAt);
  return Boolean(
    observedAt &&
      expiresAt &&
      observedAt <= now &&
      expiresAt > now &&
      observedAt < expiresAt &&
      expiresAt.valueOf() - observedAt.valueOf() <= FOUNDER_EXTERNAL_BETA_QUALIFICATION_MAX_AGE_MS,
  );
}

function readCanonicalDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) || date.toISOString() !== value ? null : date;
}

async function readReadyCandidate(
  connection: DatabaseConnection,
  userId: string,
): Promise<{ operatorId: string; runtimeRevision: string }> {
  const [candidate] = await connection.db
    .select({ operatorId: operators.id, runtimeRevision: operatorRuntimes.configRevision })
    .from(operators)
    .innerJoin(operatorRuntimes, eq(operatorRuntimes.operatorId, operators.id))
    .where(
      and(
        eq(operators.userId, userId),
        eq(operators.status, "active"),
        eq(operatorRuntimes.status, "ready"),
      ),
    )
    .limit(1);
  if (!candidate?.runtimeRevision) {
    throw new Error("A ready exact-revision Operator is required for External Beta qualification.");
  }
  return { operatorId: candidate.operatorId, runtimeRevision: candidate.runtimeRevision };
}
