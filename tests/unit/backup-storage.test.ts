import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EnvValidationError } from "@/src/env/validation";
import {
  FakeBackupObjectStorage,
  S3CompatibleBackupObjectStorage,
  backupStorageFailure,
  buildBackupStorageUri,
  createBackupObjectStorage,
  readBackupStorageConfig,
} from "@/src/server/backups/backup-storage";

const COMPLETE_ENV = {
  AGENTBAY_BACKUP_STORAGE_ENDPOINT_URL: " https://nyc3.digitaloceanspaces.com ",
  AGENTBAY_BACKUP_STORAGE_BUCKET: " agentbay-backups ",
  AGENTBAY_BACKUP_STORAGE_REGION: " us-east-1 ",
  AGENTBAY_BACKUP_STORAGE_ACCESS_KEY_ID: " backup-access-key ",
  AGENTBAY_BACKUP_STORAGE_SECRET_ACCESS_KEY: " backup-secret-key ",
};

describe("backup object storage boundary", () => {
  it("uploads and downloads backup artifacts through the deterministic fake storage", async () => {
    const storage = new FakeBackupObjectStorage("agentbay-backups");
    const body = new TextEncoder().encode("backup artifact");

    await expect(
      storage.upload({
        key: "agents/agent-1/backup.json",
        body,
        contentType: "application/json",
      }),
    ).resolves.toEqual({
      ok: true,
      storageUri: "s3://agentbay-backups/agents/agent-1/backup.json",
      byteLength: body.byteLength,
    });

    const downloaded = await storage.download({ key: "agents/agent-1/backup.json" });

    expect(downloaded).toMatchObject({
      ok: true,
      storageUri: "s3://agentbay-backups/agents/agent-1/backup.json",
      contentType: "application/json",
    });

    if (!downloaded.ok) {
      throw new Error("Expected fake storage download to succeed.");
    }

    expect(new TextDecoder().decode(downloaded.body)).toBe("backup artifact");
    downloaded.body[0] = 120;

    const downloadedAgain = await storage.download({ key: "agents/agent-1/backup.json" });
    expect(downloadedAgain).toMatchObject({ ok: true });

    if (!downloadedAgain.ok) {
      throw new Error("Expected fake storage second download to succeed.");
    }

    expect(new TextDecoder().decode(downloadedAgain.body)).toBe("backup artifact");
  });

  it("maps missing artifacts and invalid keys to safe backup failures", async () => {
    const storage = new FakeBackupObjectStorage("agentbay-backups");

    await expect(storage.download({ key: "missing.json" })).resolves.toEqual(
      backupStorageFailure("download"),
    );
    await expect(
      storage.upload({ key: "../unsafe.json", body: new Uint8Array([1]) }),
    ).resolves.toEqual(backupStorageFailure("upload"));
  });

  it("validates complete S3-compatible config only on the server path", () => {
    expect(readBackupStorageConfig({})).toBeNull();
    expect(readBackupStorageConfig(COMPLETE_ENV)).toEqual({
      endpointUrl: "https://nyc3.digitaloceanspaces.com",
      bucket: "agentbay-backups",
      region: "us-east-1",
      accessKeyId: "backup-access-key",
      secretAccessKey: "backup-secret-key",
    });
    expect(createBackupObjectStorage(COMPLETE_ENV_CONFIG)).toBeInstanceOf(
      S3CompatibleBackupObjectStorage,
    );
  });

  it("rejects partial, blank, malformed, or credential-bearing storage configuration safely", () => {
    expect(() =>
      readBackupStorageConfig({
        AGENTBAY_BACKUP_STORAGE_ENDPOINT_URL: "https://nyc3.digitaloceanspaces.com",
      }),
    ).toThrowError(EnvValidationError);
    expect(() =>
      readBackupStorageConfig({
        ...COMPLETE_ENV,
        AGENTBAY_BACKUP_STORAGE_SECRET_ACCESS_KEY: " ",
      }),
    ).toThrow("AGENTBAY_BACKUP_STORAGE_SECRET_ACCESS_KEY is required");
    expect(() =>
      readBackupStorageConfig({
        ...COMPLETE_ENV,
        AGENTBAY_BACKUP_STORAGE_ENDPOINT_URL: "http://spaces.example.com",
      }),
    ).toThrow("must use HTTPS");
    expect(() =>
      readBackupStorageConfig({
        ...COMPLETE_ENV,
        AGENTBAY_BACKUP_STORAGE_ENDPOINT_URL: "https://user:secret@spaces.example.com?token=x",
      }),
    ).toThrow("must not include credentials");
    expect(() =>
      readBackupStorageConfig({
        ...COMPLETE_ENV,
        AGENTBAY_BACKUP_STORAGE_BUCKET: "Invalid_Bucket",
      }),
    ).toThrow("valid S3-compatible bucket name");
    expect(() =>
      readBackupStorageConfig({
        ...COMPLETE_ENV,
        AGENTBAY_BACKUP_STORAGE_REGION: "us_east_1",
      }),
    ).toThrow("lowercase letters, numbers, and hyphens");
  });

  it("allows loopback HTTP endpoints only for local storage tests", () => {
    expect(
      readBackupStorageConfig({
        ...COMPLETE_ENV,
        AGENTBAY_BACKUP_STORAGE_ENDPOINT_URL: "http://127.0.0.1:9000",
      }),
    ).toMatchObject({
      endpointUrl: "http://127.0.0.1:9000",
    });
  });

  it("uploads and downloads through the S3-compatible adapter without leaking credentials", async () => {
    const requests: Request[] = [];
    const storage = new S3CompatibleBackupObjectStorage(COMPLETE_ENV_CONFIG, {
      fetchImplementation: async (input) => {
        const request = input instanceof Request ? input : new Request(input);

        requests.push(request);

        if (request.method === "PUT") {
          return new Response(null, { status: 200 });
        }

        return new Response("stored artifact", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await expect(
      storage.upload({
        key: "agents/agent-1/backup.json",
        body: new TextEncoder().encode("stored artifact"),
        contentType: "application/json",
      }),
    ).resolves.toEqual({
      ok: true,
      storageUri: "s3://agentbay-backups/agents/agent-1/backup.json",
      byteLength: 15,
    });

    const downloaded = await storage.download({ key: "agents/agent-1/backup.json" });

    expect(downloaded).toMatchObject({
      ok: true,
      storageUri: "s3://agentbay-backups/agents/agent-1/backup.json",
      contentType: "application/json",
    });

    if (!downloaded.ok) {
      throw new Error("Expected S3-compatible download to succeed.");
    }

    expect(new TextDecoder().decode(downloaded.body)).toBe("stored artifact");
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ["PUT", "https://nyc3.digitaloceanspaces.com/agentbay-backups/agents/agent-1/backup.json"],
      ["GET", "https://nyc3.digitaloceanspaces.com/agentbay-backups/agents/agent-1/backup.json"],
    ]);

    const serializedRequests = JSON.stringify(
      requests.map((request) => ({
        url: request.url,
        authorization: request.headers.get("authorization"),
        date: request.headers.get("x-amz-date"),
        hash: request.headers.get("x-amz-content-sha256"),
      })),
    );

    expect(serializedRequests).toContain("backup-access-key");
    expect(serializedRequests).not.toContain("backup-secret-key");
    expect(JSON.stringify([downloaded])).not.toContain("backup-access-key");
    expect(JSON.stringify([downloaded])).not.toContain("backup-secret-key");
  });

  it("maps thrown S3-compatible storage failures to safe statuses and messages", async () => {
    const storage = new S3CompatibleBackupObjectStorage(COMPLETE_ENV_CONFIG, {
      fetchImplementation: async () => {
        throw new Error(
          "network failed for backup-secret-key at https://nyc3.digitaloceanspaces.com",
        );
      },
    });

    const result = await storage.upload({
      key: "agents/agent-1/backup.json",
      body: new TextEncoder().encode("stored artifact"),
    });

    expect(result).toEqual(backupStorageFailure("upload"));
    expect(JSON.stringify(result)).not.toContain("backup-secret-key");
    expect(JSON.stringify(result)).not.toContain("nyc3.digitaloceanspaces.com");
  });

  it("keeps backup object storage credentials out of shared validation and client components", async () => {
    await expect(readFile("src/env/validation.ts", "utf8")).resolves.not.toContain(
      "AGENTBAY_BACKUP_STORAGE",
    );
    await expect(readFile("src/server/backups/backup-storage.ts", "utf8")).resolves.toContain(
      'import "server-only";',
    );

    for (const filePath of await listSourceFiles("app")) {
      const source = await readFile(filePath, "utf8");

      if (!source.startsWith('"use client";')) {
        continue;
      }

      expect(source).not.toContain("AGENTBAY_BACKUP_STORAGE");
      expect(source).not.toContain("@/src/server/backups/backup-storage");
    }
  });

  it("builds safe storage URIs without accepting traversal keys", () => {
    expect(buildBackupStorageUri("agentbay-backups", "agents/agent-1/backup.json")).toBe(
      "s3://agentbay-backups/agents/agent-1/backup.json",
    );
    expect(() => buildBackupStorageUri("agentbay-backups", "/agents/backup.json")).toThrow(
      "Backup storage key is invalid.",
    );
  });
});

const COMPLETE_ENV_CONFIG = {
  endpointUrl: "https://nyc3.digitaloceanspaces.com",
  bucket: "agentbay-backups",
  region: "us-east-1",
  accessKeyId: "backup-access-key",
  secretAccessKey: "backup-secret-key",
};

async function listSourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const filePath = join(root, entry.name);

      if (entry.isDirectory()) {
        return listSourceFiles(filePath);
      }

      return /\.(ts|tsx)$/.test(entry.name) ? [filePath] : [];
    }),
  );

  return files.flat();
}
