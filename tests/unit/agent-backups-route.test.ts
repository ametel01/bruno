import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ACTIVE_AGENT_ID = "00000000-0000-4000-8000-000000000165";
const USER_ID = "00000000-0000-4000-8000-000000000101";

const mocks = vi.hoisted(() => ({
  createManualBackupForUser: vi.fn(),
  requireConfiguredApplicationUser: vi.fn(),
}));

vi.mock("@/src/server/backups/create-backup", () => ({
  BACKUP_CREATED_EVENT_TYPE: "backup.created",
  ManualBackupPersistenceError: class ManualBackupPersistenceError extends Error {
    constructor() {
      super("Manual backup creation failed.");
      this.name = "ManualBackupPersistenceError";
    }
  },
  createManualBackupForUser: mocks.createManualBackupForUser,
}));

vi.mock("@/src/server/users/configured-application-user", () => ({
  requireConfiguredApplicationUser: mocks.requireConfiguredApplicationUser,
}));

describe("POST /api/agents/[agentId]/backups route", () => {
  beforeEach(() => {
    mocks.requireConfiguredApplicationUser.mockResolvedValue({ ok: true, userId: USER_ID });
  });

  afterEach(() => {
    mocks.createManualBackupForUser.mockReset();
    mocks.requireConfiguredApplicationUser.mockReset();
  });

  it("creates a manual backup for a valid agent id", async () => {
    mocks.createManualBackupForUser.mockResolvedValue({
      ok: true,
      backup: backupDto("ready"),
      event: { type: "backup.created" },
    });
    const { POST } = await import("@/app/api/agents/[agentId]/backups/route");

    const response = await POST(
      new Request(`http://localhost/api/agents/${ACTIVE_AGENT_ID}/backups`),
      {
        params: Promise.resolve({ agentId: encodeURIComponent(ACTIVE_AGENT_ID) }),
      },
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toEqual({
      ok: true,
      backup: clientBackupDto("ready"),
      event: { type: "backup.created" },
    });
    expect(JSON.stringify(body)).not.toContain("storageUri");
    expect(JSON.stringify(body)).not.toContain("s3://");
    expect(JSON.stringify(body)).not.toContain("bruno-backups");
    expect(JSON.stringify(body)).not.toContain("manifestJson");
    expect(mocks.createManualBackupForUser).toHaveBeenCalledWith({
      agentId: ACTIVE_AGENT_ID,
      userId: USER_ID,
    });
  });

  it("rejects malformed agent ids before invoking the service", async () => {
    const { POST } = await import("@/app/api/agents/[agentId]/backups/route");

    const response = await POST(new Request("http://localhost/api/agents/not-a-uuid/backups"), {
      params: Promise.resolve({ agentId: "not-a-uuid" }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      error: {
        code: "validation_failed",
        message: "Agent ID must be a valid UUID.",
      },
    });
    expect(mocks.createManualBackupForUser).not.toHaveBeenCalled();
  });

  it("maps service failures to safe route errors with the failed backup payload", async () => {
    mocks.createManualBackupForUser.mockResolvedValue({
      ok: false,
      reason: "backup_storage_failed",
      message: "Backup artifact upload failed. Check object storage configuration.",
      backup: backupDto("failed"),
    });
    const { POST } = await import("@/app/api/agents/[agentId]/backups/route");

    const response = await POST(
      new Request(`http://localhost/api/agents/${ACTIVE_AGENT_ID}/backups`),
      {
        params: Promise.resolve({ agentId: ACTIVE_AGENT_ID }),
      },
    );
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: {
        code: "backup_storage_failed",
        message: "Backup artifact upload failed. Check object storage configuration.",
      },
      backup: clientBackupDto("failed"),
    });
    expect(JSON.stringify(body)).not.toContain("storageUri");
    expect(JSON.stringify(body)).not.toContain("s3://");
    expect(JSON.stringify(body)).not.toContain("bruno-backups");
  });
});

function backupDto(status: "ready" | "failed") {
  return {
    id: "00000000-0000-4000-8000-000000000265",
    agentId: ACTIVE_AGENT_ID,
    runnerId: null,
    status,
    storageUri:
      status === "ready"
        ? "s3://bruno-backups/agents/00000000-0000-4000-8000-000000000165/backups/00000000-0000-4000-8000-000000000265.json"
        : null,
    createdAt: "2026-07-06T04:30:00.000Z",
    restoredAt: null,
  };
}

function clientBackupDto(status: "ready" | "failed") {
  return {
    id: "00000000-0000-4000-8000-000000000265",
    agentId: ACTIVE_AGENT_ID,
    runnerId: null,
    status,
    createdAt: "2026-07-06T04:30:00.000Z",
    restoredAt: null,
  };
}
