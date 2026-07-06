import { describe, expect, it } from "vitest";
import {
  BACKUP_STATUSES,
  type BackupManifest,
  canTransitionBackupStatus,
  isBackupStatus,
  validateBackupManifest,
} from "@/src/server/backups/backup-manifest";

describe("backup manifest contract", () => {
  it("accepts a complete manifest with safe secret references", () => {
    const manifest = validManifest({
      config: {
        ...validManifest().config,
        secretReferences: {
          openai: { kind: "env", ref: "OPENAI_API_KEY" },
          provider: { kind: "vault", ref: "vault://agentbay/agent-1/provider-token" },
        },
      },
    });

    const result = validateBackupManifest(manifest);

    expect(result).toEqual({ ok: true, manifest });
  });

  it("rejects manifests missing required agent, config, template, skills, memory, or log metadata", () => {
    const result = validateBackupManifest({
      schemaVersion: 1,
      agent: { id: "", name: "Research" },
      config: { modelProvider: "openai" },
      templateSnapshot: null,
      systemPrompt: "",
      skills: { files: [{ path: "" }] },
      memory: {},
      logs: { included: "yes", entries: [{ stream: "combined" }] },
    });

    expect(result).toMatchObject({ ok: false });

    if (result.ok) {
      throw new Error("Expected invalid manifest to fail validation.");
    }

    expect(result.errors).toEqual(
      expect.arrayContaining([
        "agent.id must be a non-empty string",
        "agent.status must be a non-empty string",
        "agent.templateKey must be a non-empty string",
        "agent.templateVersion must be a non-empty string",
        "config.modelName must be a non-empty string",
        "config.scheduleMode must be a non-empty string",
        "config.timezone must be a non-empty string",
        "config.maxDailySpendCents must be a nonnegative integer",
        "templateSnapshot must be an object",
        "systemPrompt must be a non-empty string",
        "skills.files.0.path must be a non-empty string",
        "memory.files must be an array",
        "logs.included must be a boolean",
        "logs.entries.0.stream must be stdout or stderr",
        "logs.entries.0.source must be a non-empty string",
        "logs.entries.0.level must be a non-empty string",
      ]),
    );
  });

  it("rejects raw secret keys and secret-looking values anywhere outside safe references", () => {
    const result = validateBackupManifest(
      validManifest({
        config: {
          ...validManifest().config,
          apiKey: "sk-this-should-not-be-backed-up",
        },
        templateSnapshot: {
          key: "research_agent",
          providerToken: "dop_v1_raw_provider_secret",
        },
        memory: {
          files: [
            {
              path: ".agent/memory.md",
              sha256: "a".repeat(64),
              leak: "Bearer raw-runner-token",
            },
          ],
        },
      }),
    );

    expect(result).toMatchObject({ ok: false });

    if (result.ok) {
      throw new Error("Expected raw secret manifest to fail validation.");
    }

    expect(result.errors).toEqual(
      expect.arrayContaining([
        "config.apiKey must use config.secretReferences instead of raw secrets",
        "templateSnapshot.providerToken must use config.secretReferences instead of raw secrets",
        "memory.files.0.leak must not contain a raw secret-like value",
      ]),
    );
  });

  it("rejects secret references that carry raw secret values instead of references", () => {
    const result = validateBackupManifest(
      validManifest({
        config: {
          ...validManifest().config,
          secretReferences: {
            bad: {
              kind: "external",
              ref: "sk-raw-value-in-reference",
              rawToken: "dop_v1_hidden_extra_value",
            },
          },
        },
      }),
    );

    expect(result).toMatchObject({ ok: false });

    if (result.ok) {
      throw new Error("Expected raw reference value to fail validation.");
    }

    expect(result.errors).toContain(
      "config.secretReferences.bad.ref must be a reference, not a raw secret",
    );
    expect(result.errors).toContain("config.secretReferences.bad.rawToken is not allowed");
  });

  it("defines conservative backup status vocabulary and transitions", () => {
    expect(BACKUP_STATUSES).toEqual([
      "pending",
      "uploading",
      "ready",
      "failed",
      "restoring",
      "restored",
    ]);
    expect(isBackupStatus("ready")).toBe(true);
    expect(isBackupStatus("deleted")).toBe(false);
    expect(canTransitionBackupStatus("pending", "uploading")).toBe(true);
    expect(canTransitionBackupStatus("uploading", "ready")).toBe(true);
    expect(canTransitionBackupStatus("ready", "restoring")).toBe(true);
    expect(canTransitionBackupStatus("restoring", "restored")).toBe(true);
    expect(canTransitionBackupStatus("ready", "restored")).toBe(false);
    expect(canTransitionBackupStatus("failed", "ready")).toBe(false);
    expect(canTransitionBackupStatus("restored", "failed")).toBe(false);
  });
});

function validManifest(
  overrides: Partial<Record<keyof BackupManifest, unknown>> = {},
): BackupManifest {
  return {
    schemaVersion: 1,
    agent: {
      id: "00000000-0000-4000-8000-000000000163",
      name: "Research Agent",
      status: "stopped",
      templateKey: "research_agent",
      templateVersion: "1.0.0",
      createdAt: "2026-07-06T03:00:00.000Z",
      updatedAt: "2026-07-06T03:10:00.000Z",
    },
    config: {
      modelProvider: "not_configured",
      modelName: "not_configured",
      scheduleMode: "manual",
      timezone: "UTC",
      maxDailySpendCents: 0,
      scheduleCron: null,
    },
    templateSnapshot: {
      key: "research_agent",
      version: "1.0.0",
      name: "Research Agent",
    },
    systemPrompt: "Gather relevant information and keep source notes.",
    skills: {
      folderPath: ".agent/skills",
      files: [{ path: ".agent/skills/SKILL.md", sizeBytes: 120, sha256: "b".repeat(64) }],
    },
    memory: {
      files: [{ path: ".agent/memory.md", sizeBytes: 64, sha256: "c".repeat(64) }],
    },
    logs: {
      included: false,
      entries: [{ source: "manual_runner", stream: "stdout", level: "info", entryCount: 3 }],
    },
    ...overrides,
  } as BackupManifest;
}
