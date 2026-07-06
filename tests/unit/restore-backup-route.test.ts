import { afterEach, describe, expect, it, vi } from "vitest";

const AGENT_ID = "00000000-0000-4000-8000-000000000166";
const BACKUP_ID = "00000000-0000-4000-8000-000000000266";

const mocks = vi.hoisted(() => ({
  restoreBackupForDevelopmentUser: vi.fn(),
}));

vi.mock("@/src/server/backups/restore-backup", () => ({
  BACKUP_RESTORED_EVENT_TYPE: "backup.restored",
  RestoreBackupPersistenceError: class RestoreBackupPersistenceError extends Error {
    constructor() {
      super("Backup restore failed.");
      this.name = "RestoreBackupPersistenceError";
    }
  },
  restoreBackupForDevelopmentUser: mocks.restoreBackupForDevelopmentUser,
}));

describe("POST /api/agents/[agentId]/backups/[backupId]/restore route", () => {
  afterEach(() => {
    mocks.restoreBackupForDevelopmentUser.mockReset();
  });

  it("restores a backup for valid agent and backup ids", async () => {
    mocks.restoreBackupForDevelopmentUser.mockResolvedValue({
      ok: true,
      backup: backupDto("restored"),
      restoredAgent: restoredAgentDto(),
      event: { type: "backup.restored" },
    });
    const { POST } = await import("@/app/api/agents/[agentId]/backups/[backupId]/restore/route");

    const response = await POST(
      new Request(`http://localhost/api/agents/${AGENT_ID}/backups/${BACKUP_ID}/restore`),
      {
        params: Promise.resolve({
          agentId: encodeURIComponent(AGENT_ID),
          backupId: encodeURIComponent(BACKUP_ID),
        }),
      },
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toEqual({
      ok: true,
      backup: backupDto("restored"),
      restoredAgent: restoredAgentDto(),
      event: { type: "backup.restored" },
    });
    expect(mocks.restoreBackupForDevelopmentUser).toHaveBeenCalledWith({
      agentId: AGENT_ID,
      backupId: BACKUP_ID,
    });
  });

  it("rejects malformed ids before invoking the restore service", async () => {
    const { POST } = await import("@/app/api/agents/[agentId]/backups/[backupId]/restore/route");

    const response = await POST(new Request("http://localhost/api/agents/no/backups/no/restore"), {
      params: Promise.resolve({ agentId: "not-a-uuid", backupId: BACKUP_ID }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: {
        code: "validation_failed",
        message: "Agent ID must be a valid UUID.",
      },
    });
    expect(mocks.restoreBackupForDevelopmentUser).not.toHaveBeenCalled();
  });

  it("maps non-restorable backups to a safe conflict response", async () => {
    mocks.restoreBackupForDevelopmentUser.mockResolvedValue({
      ok: false,
      reason: "backup_not_restorable",
      message: "Backup is not ready to restore.",
      backup: backupDto("failed"),
    });
    const { POST } = await import("@/app/api/agents/[agentId]/backups/[backupId]/restore/route");

    const response = await POST(
      new Request(`http://localhost/api/agents/${AGENT_ID}/backups/${BACKUP_ID}/restore`),
      {
        params: Promise.resolve({ agentId: AGENT_ID, backupId: BACKUP_ID }),
      },
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body).toEqual({
      error: {
        code: "backup_not_restorable",
        message: "Backup is not ready to restore.",
      },
      backup: backupDto("failed"),
    });
  });
});

function backupDto(status: "failed" | "restored") {
  return {
    id: BACKUP_ID,
    agentId: AGENT_ID,
    runnerId: null,
    status,
    storageUri:
      status === "restored"
        ? `s3://agentbay-backups/agents/${AGENT_ID}/backups/${BACKUP_ID}.json`
        : null,
    createdAt: "2026-07-06T04:30:00.000Z",
    restoredAt: status === "restored" ? "2026-07-06T05:00:00.000Z" : null,
  };
}

function restoredAgentDto() {
  return {
    id: "00000000-0000-4000-8000-000000000366",
    userId: "00000000-0000-4000-8000-000000000466",
    name: "Restored Research (restored)",
    templateKey: "research_agent",
    templateVersion: "1.0.0",
    templateSnapshotJson: {
      key: "research_agent",
      version: "1.0.0",
      name: "Research Agent",
      description: "Research template",
      defaultTools: [],
      defaultSchedule: "Manual",
      defaultSystemPrompt: "Gather notes.",
      requiredIntegrations: [],
    },
    status: "stopped",
    statusReason: null,
    createdAt: "2026-07-06T05:00:00.000Z",
    updatedAt: "2026-07-06T05:00:00.000Z",
    deletedAt: null,
  };
}
