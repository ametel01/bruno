import "server-only";

import type { DatabaseConnection } from "@/src/server/db/client";
import { createDatabaseConnection } from "@/src/server/db/client";
import { readFounderApplicationRevision } from "./application-revision";
import {
  type FounderProductContractTransaction,
  lockFounderProductContractLifecycleInTransaction,
} from "./operator-authority";
import type { FounderOwnerPreviewCapabilityRequirement } from "./preview-qualification";
import {
  founderGeneralReleaseAuthorizesWorkAuthorityInTransaction,
  founderGeneralReleaseSetupAuthorizesInTransaction,
} from "./initial-general-release";
import {
  FounderReleaseStageAccessError,
  reconcileFounderPreviewQualificationExpiryInTransaction,
  requireFounderOwnerPreviewAccessForUser,
  requireFounderOwnerPreviewAccessInTransaction,
} from "./release-stage-access";

export type FounderOwnerPreviewWorkAuthorityDependencies = {
  applicationRevision?: string;
  createConnection?: () => DatabaseConnection;
  env?: Record<string, string | undefined>;
  requireReleaseStageAccess?: typeof requireFounderOwnerPreviewAccessInTransaction;
  requireReleaseStageAccessForUser?: typeof requireFounderOwnerPreviewAccessForUser;
  generalReleaseAuthority?: "setup" | "work";
};

async function preflightFounderOwnerPreviewWorkAuthority(
  userId: string,
  now: Date,
  requiredCapabilities: FounderOwnerPreviewCapabilityRequirement,
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

/**
 * Runs state-creating Owner Preview work behind the same lifecycle lock as Release Holds.
 * A newly discovered expiry is committed as a Hold before the access error is returned.
 */
export async function withFounderOwnerPreviewWorkAuthority<T>(
  input: {
    userId: string;
    now: () => Date;
    requiredCapabilities: FounderOwnerPreviewCapabilityRequirement;
  },
  dependencies: FounderOwnerPreviewWorkAuthorityDependencies,
  work: (tx: FounderProductContractTransaction, now: Date) => Promise<T>,
): Promise<T> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  const applicationRevision = readFounderApplicationRevision(dependencies) ?? "";

  try {
    try {
      await preflightFounderOwnerPreviewWorkAuthority(
        input.userId,
        input.now(),
        input.requiredCapabilities,
        {
          ...dependencies,
          createConnection: () => connection,
        },
      );
    } catch (error) {
      if (
        !(error instanceof FounderReleaseStageAccessError) ||
        !dependencies.generalReleaseAuthority
      ) {
        throw error;
      }
    }

    const outcome = await connection.db.transaction(async (tx) => {
      const now = input.now();
      if (!dependencies.requireReleaseStageAccess) {
        await reconcileFounderPreviewQualificationExpiryInTransaction(tx, {
          userId: input.userId,
          now,
          applicationRevision,
        });
      }
      await lockFounderProductContractLifecycleInTransaction(tx, input.userId);
      try {
        await (
          dependencies.requireReleaseStageAccess ?? requireFounderOwnerPreviewAccessInTransaction
        )(tx, {
          userId: input.userId,
          now,
          requiredCapabilities: input.requiredCapabilities,
          applicationRevision,
        });
      } catch (error) {
        if (error instanceof FounderReleaseStageAccessError) {
          const generalReleaseAuthorized =
            dependencies.generalReleaseAuthority === "setup"
              ? await founderGeneralReleaseSetupAuthorizesInTransaction(
                  tx,
                  input.userId,
                  now,
                  input.requiredCapabilities,
                  dependencies.env ?? process.env,
                )
              : dependencies.generalReleaseAuthority === "work"
                ? await founderGeneralReleaseAuthorizesWorkAuthorityInTransaction(
                    tx,
                    input.userId,
                    now,
                    input.requiredCapabilities,
                    dependencies.env ?? process.env,
                  )
                : false;
          if (!generalReleaseAuthorized) return { ok: false as const, error };
        } else {
          throw error;
        }
      }
      return { ok: true as const, value: await work(tx, now) };
    });

    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  } finally {
    if (ownsConnection) await connection.close();
  }
}
