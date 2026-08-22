import "server-only";

import type { DatabaseConnection } from "@/src/server/db/client";
import type { FounderProductContractTransaction } from "./operator-authority";
import type { FounderOwnerPreviewCapability } from "./preview-qualification";
import {
  requireFounderOwnerPreviewAccessForUser,
  requireFounderOwnerPreviewAccessInTransaction,
} from "./release-stage-access";

export type FounderOwnerPreviewWorkAuthorityDependencies = {
  applicationRevision?: string;
  createConnection?: () => DatabaseConnection;
  env?: Record<string, string | undefined>;
  requireReleaseStageAccess?: typeof requireFounderOwnerPreviewAccessInTransaction;
  requireReleaseStageAccessForUser?: typeof requireFounderOwnerPreviewAccessForUser;
};

export async function preflightFounderOwnerPreviewWorkAuthority(
  userId: string,
  now: Date,
  requiredCapabilities: readonly FounderOwnerPreviewCapability[],
  dependencies: FounderOwnerPreviewWorkAuthorityDependencies,
): Promise<void> {
  const accessDependencies = {
    ...(dependencies.applicationRevision
      ? { applicationRevision: dependencies.applicationRevision }
      : {}),
    ...(dependencies.createConnection ? { createConnection: dependencies.createConnection } : {}),
    ...(dependencies.env ? { env: dependencies.env } : {}),
  };
  if (dependencies.requireReleaseStageAccessForUser) {
    await dependencies.requireReleaseStageAccessForUser(
      userId,
      now,
      accessDependencies,
      requiredCapabilities,
    );
  } else if (!dependencies.requireReleaseStageAccess) {
    await requireFounderOwnerPreviewAccessForUser(
      userId,
      now,
      accessDependencies,
      requiredCapabilities,
    );
  }
}

export async function requireFounderOwnerPreviewWorkAuthorityInTransaction(
  tx: FounderProductContractTransaction,
  input: {
    userId: string;
    now: Date;
    requiredCapabilities: readonly FounderOwnerPreviewCapability[];
  },
  dependencies: FounderOwnerPreviewWorkAuthorityDependencies,
): Promise<void> {
  await (dependencies.requireReleaseStageAccess ?? requireFounderOwnerPreviewAccessInTransaction)(
    tx,
    {
      ...input,
      applicationRevision:
        dependencies.applicationRevision ??
        dependencies.env?.VERCEL_GIT_COMMIT_SHA?.trim() ??
        process.env.VERCEL_GIT_COMMIT_SHA?.trim() ??
        "",
    },
  );
}
