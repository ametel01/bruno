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

describe("user operations request boundaries", () => {
  it("resolves the application user and never calls development-user services", async () => {
    for (const file of ROUTE_FILES) {
      const source = await readFile(join(process.cwd(), file), "utf8");

      expect(source).toContain("requireOperationalApplicationUser");
      expect(source).not.toContain("getDevelopmentUserId");
      expect(source).not.toContain("ForDevelopmentUser");
    }
  });

  it("passes the resolved user to dashboard activity and approval loaders", async () => {
    const source = await readFile(join(process.cwd(), "app/dashboard/page.tsx"), "utf8");

    expect(source).toContain("requireOperationalApplicationUser");
    expect(source).toContain("listLatestAgentActivityForUser");
    expect(source).toContain("listPendingApprovalsForUser");
    expect(source).not.toContain("listPendingApprovalsForDevelopmentUser");
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
