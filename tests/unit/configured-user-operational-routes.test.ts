import { describe, expect, it, vi } from "vitest";
import { POST as createBackupRoute } from "@/app/api/agents/[agentId]/backups/route";
import { POST as restoreBackupRoute } from "@/app/api/agents/[agentId]/backups/[backupId]/restore/route";
import { GET as agentEventsRoute } from "@/app/api/agents/[agentId]/events/route";
import { POST as approveApprovalRoute } from "@/app/api/approvals/[approvalId]/approve/route";
import { POST as denyApprovalRoute } from "@/app/api/approvals/[approvalId]/deny/route";

const AGENT_ID = "00000000-0000-4000-8000-000000000201";
const APPROVAL_ID = "00000000-0000-4000-8000-000000000511";
const BACKUP_ID = "00000000-0000-4000-8000-000000000611";

const ROUTES = [
  {
    name: "approve approval",
    invoke: (requireApplicationUser: RequireApplicationUser) =>
      approveApprovalRoute(
        new Request(`http://localhost/api/approvals/${APPROVAL_ID}/approve`),
        { params: Promise.resolve({ approvalId: APPROVAL_ID }) },
        { requireApplicationUser },
      ),
  },
  {
    name: "deny approval",
    invoke: (requireApplicationUser: RequireApplicationUser) =>
      denyApprovalRoute(
        new Request(`http://localhost/api/approvals/${APPROVAL_ID}/deny`),
        { params: Promise.resolve({ approvalId: APPROVAL_ID }) },
        { requireApplicationUser },
      ),
  },
  {
    name: "create backup",
    invoke: (requireApplicationUser: RequireApplicationUser) =>
      createBackupRoute(
        new Request(`http://localhost/api/agents/${AGENT_ID}/backups`),
        { params: Promise.resolve({ agentId: AGENT_ID }) },
        { requireApplicationUser },
      ),
  },
  {
    name: "restore backup",
    invoke: (requireApplicationUser: RequireApplicationUser) =>
      restoreBackupRoute(
        new Request(`http://localhost/api/agents/${AGENT_ID}/backups/${BACKUP_ID}/restore`),
        { params: Promise.resolve({ agentId: AGENT_ID, backupId: BACKUP_ID }) },
        { requireApplicationUser },
      ),
  },
  {
    name: "list agent events",
    invoke: (requireApplicationUser: RequireApplicationUser) =>
      agentEventsRoute(
        new Request(`http://localhost/api/agents/${AGENT_ID}/events`),
        { params: Promise.resolve({ agentId: AGENT_ID }) },
        { requireApplicationUser },
      ),
  },
] as const;

const AUTH_FAILURES = [
  {
    result: { ok: false, status: 401, code: "unauthenticated" } as const,
    message: "Authentication is required.",
  },
  {
    result: { ok: false, status: 503, code: "development_auth_not_allowed" } as const,
    message: "Authentication is not configured safely.",
  },
] as const;

type RequireApplicationUser = () => Promise<(typeof AUTH_FAILURES)[number]["result"]>;

describe("configured user operational route boundaries", () => {
  for (const route of ROUTES) {
    it.each(
      AUTH_FAILURES,
    )(`${route.name} maps configured-user $result.status without entering the operation`, async ({
      result,
      message,
    }) => {
      const requireApplicationUser = vi.fn(async () => result);

      const response = await route.invoke(requireApplicationUser);

      expect(response.status).toBe(result.status);
      expect(await response.json()).toEqual({
        error: {
          code: result.code,
          message,
        },
      });
      expect(requireApplicationUser).toHaveBeenCalledOnce();
    });
  }
});
