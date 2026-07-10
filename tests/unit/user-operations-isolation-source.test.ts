import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROUTE_FILES = [
  "app/api/approvals/[approvalId]/approve/route.ts",
  "app/api/approvals/[approvalId]/deny/route.ts",
  "app/api/agents/[agentId]/backups/route.ts",
  "app/api/agents/[agentId]/backups/[backupId]/restore/route.ts",
  "app/api/agents/[agentId]/events/route.ts",
] as const;

const OPERATIONAL_PAGE_FILES = ["app/dashboard/page.tsx", "app/agents/[agentId]/page.tsx"] as const;

describe("user operations request boundaries", () => {
  it("resolves the application user and never calls development-user services", async () => {
    for (const file of ROUTE_FILES) {
      const source = await readFile(join(process.cwd(), file), "utf8");

      expect(source).toContain("requireConfiguredApplicationUser");
      expect(source).not.toContain("getDevelopmentUserId");
      expect(source).not.toContain("ForDevelopmentUser");
    }
  });

  it("keeps every dashboard and detail operational loader on user-explicit services", async () => {
    for (const file of OPERATIONAL_PAGE_FILES) {
      const source = await readFile(join(process.cwd(), file), "utf8");

      expect(source).toContain("requireConfiguredApplicationUser");
      expect(source).not.toContain("getDevelopmentUserId");
      expect(source).not.toContain("ForDevelopmentUser");
    }

    const dashboardSource = await readFile(join(process.cwd(), "app/dashboard/page.tsx"), "utf8");
    const detailSource = await readFile(
      join(process.cwd(), "app/agents/[agentId]/page.tsx"),
      "utf8",
    );

    for (const service of [
      "listActiveAgentsForUser",
      "listLatestAgentActivityForUser",
      "listPendingApprovalsForUser",
      "listLatestActiveAgentProcessLogsForUser",
      "listManualRunnerStatusSummariesForUser",
      "listCloudRunnerProvisioningSummariesForUser",
      "getCostEstimatesForUser",
    ]) {
      expect(dashboardSource).toContain(service);
    }

    for (const service of [
      "getActiveAgentForUser",
      "listAgentEventFeedForUser",
      "listPendingApprovalsForUserAgent",
      "listAgentBackupsForUser",
      "getAssignedManualRunnerStatusForUserAgent",
      "getMonthlyRunnerCostForUserAgent",
    ]) {
      expect(detailSource).toContain(service);
    }
  });

  it("qualifies dashboard agent and process-log reads at the database operation", async () => {
    const agentSource = await readFile(
      join(process.cwd(), "src/server/agents/list-agents.ts"),
      "utf8",
    );
    const logSource = await readFile(join(process.cwd(), "src/server/logs/agent-logs.ts"), "utf8");

    expect(agentSource).toContain("eq(agents.userId, userId)");
    expect(agentSource).toContain("eq(runners.userId, userId)");
    expect(logSource).toContain("eq(agents.userId, input.userId)");
  });

  it("keeps backup storage keys under the internal user namespace", async () => {
    const createSource = await readFile(
      join(process.cwd(), "src/server/backups/create-backup.ts"),
      "utf8",
    );
    const restoreSource = await readFile(
      join(process.cwd(), "src/server/backups/restore-backup.ts"),
      "utf8",
    );

    const userScopedKey =
      "users/$" + "{input.userId}/agents/$" + "{input.agentId}/backups/$" + "{input.backupId}.json";

    expect(createSource).toContain(userScopedKey);
    expect(restoreSource).toContain(userScopedKey);
    expect(restoreSource).toContain("return key === expectedKey ? key : null");
  });
});
