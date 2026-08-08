import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const AGENT_ID = "00000000-0000-4000-8000-000000000166";
const BACKUP_ID = "00000000-0000-4000-8000-000000000266";
const USER_ID = "00000000-0000-4000-8000-000000000466";

const mocks = vi.hoisted(() => ({
  restoreBackupForUser: vi.fn(),
  requireConfiguredApplicationUser: vi.fn(),
}));

vi.mock("@/src/server/backups/restore-backup", () => ({
  BACKUP_RESTORED_EVENT_TYPE: "backup.restored",
  RestoreBackupPersistenceError: class RestoreBackupPersistenceError extends Error {
    constructor() {
      super("Backup restore failed.");
      this.name = "RestoreBackupPersistenceError";
    }
  },
  restoreBackupForUser: mocks.restoreBackupForUser,
}));

vi.mock("@/src/server/users/configured-application-user", () => ({
  requireConfiguredApplicationUser: mocks.requireConfiguredApplicationUser,
}));

describe("POST /api/agents/[agentId]/backups/[backupId]/restore route", () => {
  beforeEach(() => {
    mocks.requireConfiguredApplicationUser.mockResolvedValue({ ok: true, userId: USER_ID });
  });

  afterEach(() => {
    mocks.restoreBackupForUser.mockReset();
    mocks.requireConfiguredApplicationUser.mockReset();
  });

  it("restores a backup for valid agent and backup ids", async () => {
    mocks.restoreBackupForUser.mockResolvedValue({
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
      backup: clientBackupDto("restored"),
      restoredAgent: clientRestoredAgentDto(),
      event: { type: "backup.restored" },
    });
    expect(JSON.stringify(body)).not.toContain("storageUri");
    expect(JSON.stringify(body)).not.toContain("s3://");
    expect(JSON.stringify(body)).not.toContain("bruno-backups");
    expect(JSON.stringify(body)).not.toContain("templateSnapshotJson");
    expect(JSON.stringify(body)).not.toContain("userId");
    expect(mocks.restoreBackupForUser).toHaveBeenCalledWith({
      agentId: AGENT_ID,
      backupId: BACKUP_ID,
      userId: USER_ID,
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
    expect(mocks.restoreBackupForUser).not.toHaveBeenCalled();
  });

  it("maps non-restorable backups to a safe conflict response", async () => {
    mocks.restoreBackupForUser.mockResolvedValue({
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
      backup: clientBackupDto("failed"),
    });
    expect(JSON.stringify(body)).not.toContain("storageUri");
    expect(JSON.stringify(body)).not.toContain("s3://");
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
        ? `s3://bruno-backups/agents/${AGENT_ID}/backups/${BACKUP_ID}.json`
        : null,
    createdAt: "2026-07-06T04:30:00.000Z",
    restoredAt: status === "restored" ? "2026-07-06T05:00:00.000Z" : null,
  };
}

function clientBackupDto(status: "failed" | "restored") {
  return {
    id: BACKUP_ID,
    agentId: AGENT_ID,
    runnerId: null,
    status,
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

function clientRestoredAgentDto() {
  return {
    id: "00000000-0000-4000-8000-000000000366",
    name: "Restored Research (restored)",
    templateKey: "research_agent",
    templateVersion: "1.0.0",
    status: "stopped",
    createdAt: "2026-07-06T05:00:00.000Z",
    updatedAt: "2026-07-06T05:00:00.000Z",
  };
}
