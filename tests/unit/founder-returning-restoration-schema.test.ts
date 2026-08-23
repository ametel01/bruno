import { readFile } from "node:fs/promises";
import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  founderOperatorRestorationModeEnum,
  founderOperatorRestorations,
  founderOperatorRestorationStatusEnum,
} from "@/src/server/db/schema";

describe("returning Founder restoration persistence", () => {
  it("retains old and new authority as separate exact identities", () => {
    const columns = getTableColumns(founderOperatorRestorations);

    expect(getTableName(founderOperatorRestorations)).toBe("founder_operator_restorations");
    expect(founderOperatorRestorationModeEnum.enumValues).toEqual([
      "same_logical_operator",
      "new_operator_environment",
    ]);
    expect(founderOperatorRestorationStatusEnum.enumValues).toEqual([
      "in_progress",
      "provider_reauthorization_required",
      "completed",
      "refunded",
      "failed",
    ]);
    expect(Object.keys(columns)).toEqual(
      expect.arrayContaining([
        "sourceOperatorId",
        "restoredOperatorId",
        "recoveryArchiveId",
        "sourceRetirementId",
        "sourceEventId",
        "newRunnerId",
        "oldProviderResourceId",
        "oldProviderFirewallId",
        "oldRuntimeIdentity",
        "newProviderResourceId",
        "newProviderFirewallId",
        "newRuntimeIdentity",
        "archiveVerifiedAt",
        "infrastructureReadyAt",
        "providersReadyAt",
        "entitlementVerifiedAt",
        "workResumedAt",
        "refundConfirmedAt",
        "cleanupConfirmedAt",
        "attemptCount",
        "leaseToken",
        "leaseExpiresAt",
      ]),
    );
    expect(Object.keys(columns)).not.toEqual(
      expect.arrayContaining(["oldIpAddress", "newIpAddress", "providerCredential", "rawEvent"]),
    );
  });

  it("migrates to one active Operator and one active restoration per Founder", async () => {
    const lifecycle = await readFile(
      "drizzle/0104_issue_383_returning_founder_restoration.sql",
      "utf8",
    );
    const fences = await readFile("drizzle/0105_issue_383_restoration_fences.sql", "utf8");

    expect(lifecycle).toContain('DROP INDEX "operators_user_id_idx"');
    expect(lifecycle).toContain('CREATE UNIQUE INDEX "operators_active_user_id_idx"');
    expect(lifecycle).toContain('WHERE "operators"."status" = \'active\'');
    expect(fences).toContain('ADD COLUMN "retired_runtime_identity" text');
    expect(fences).toContain('CREATE UNIQUE INDEX "founder_operator_restorations_active_user_idx"');
    expect(fences).toContain("'in_progress', 'provider_reauthorization_required'");
    expect(`${lifecycle}\n${fences}`).not.toMatch(/DROP TABLE|DROP COLUMN/);
  });

  it("routes production commerce through configured restoration adapters", async () => {
    const [adapter, reconciler, route] = await Promise.all([
      readFile("src/server/commerce/founder-commerce-restoration.ts", "utf8"),
      readFile("src/server/commerce/founder-commerce-reconciler.ts", "utf8"),
      readFile("app/api/internal/operator/commerce/route.ts", "utf8"),
    ]);

    expect(adapter).toContain("createDigitalOceanRunnerForUser");
    expect(adapter).toContain("archive.verifyRecoveryArchive");
    expect(adapter).toContain("observeOwnedSet");
    expect(adapter).toContain("deleteFirewall");
    expect(adapter).toContain("deleteDroplet");
    expect(adapter).toContain('operatorAiConnectionReceipts.kind, "reauthorized"');
    expect(adapter).toContain('operatorCalendarConnectionReceipts.kind, "reauthorized"');
    expect(adapter).toContain('operatorMailConnectionReceipts.kind, "reauthorized"');
    expect(adapter).toContain("refundOrder");
    expect(reconciler).toContain("executeFounderReturningRestoration");
    expect(route).toContain("createConfiguredFounderReturningRestorationProvider");
  });
});
