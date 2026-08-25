import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EnvValidationError } from "@/src/env/validation";
import {
  assertIndependentRecoveryArchiveStorage,
  backupStorageFailure,
  buildBackupStorageUri,
  createBackupObjectStorage,
  FakeBackupObjectStorage,
  readBackupStorageConfig,
  S3CompatibleBackupObjectStorage,
} from "@/src/server/backups/backup-storage";

const COMPLETE_ENV = {
  BRUNO_BACKUP_STORAGE_ENDPOINT_URL: " https://nyc3.digitaloceanspaces.com ",
  BRUNO_BACKUP_STORAGE_BUCKET: " bruno-backups ",
  BRUNO_BACKUP_STORAGE_REGION: " us-east-1 ",
  BRUNO_BACKUP_STORAGE_ACCESS_KEY_ID: " backup-access-key ",
  BRUNO_BACKUP_STORAGE_SECRET_ACCESS_KEY: " backup-secret-key ",
};

describe("backup object storage boundary", () => {
  it("uploads and downloads backup artifacts through the deterministic fake storage", async () => {
    const storage = new FakeBackupObjectStorage("bruno-backups");
    const body = new TextEncoder().encode("backup artifact");

    await expect(
      storage.upload({
        key: "agents/agent-1/backup.json",
        body,
        contentType: "application/json",
      }),
    ).resolves.toEqual({
      ok: true,
      storageUri: "s3://bruno-backups/agents/agent-1/backup.json",
      byteLength: body.byteLength,
      versionId: "null",
    });

    const downloaded = await storage.download({ key: "agents/agent-1/backup.json" });

    expect(downloaded).toMatchObject({
      ok: true,
      storageUri: "s3://bruno-backups/agents/agent-1/backup.json",
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
    await expect(storage.exists({ key: "agents/agent-1/backup.json" })).resolves.toEqual({
      ok: true,
      exists: true,
    });
    await expect(storage.delete({ key: "agents/agent-1/backup.json" })).resolves.toEqual({
      ok: true,
    });
    await expect(storage.exists({ key: "agents/agent-1/backup.json" })).resolves.toEqual({
      ok: true,
      exists: false,
    });
    await expect(storage.verifyDeletionSafety()).resolves.toEqual({
      ok: true,
      versioning: "disabled",
    });
  });

  it("maps missing artifacts and invalid keys to safe backup failures", async () => {
    const storage = new FakeBackupObjectStorage("bruno-backups");

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
      bucket: "bruno-backups",
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
        BRUNO_BACKUP_STORAGE_ENDPOINT_URL: "https://nyc3.digitaloceanspaces.com",
      }),
    ).toThrowError(EnvValidationError);
    expect(() =>
      readBackupStorageConfig({
        ...COMPLETE_ENV,
        BRUNO_BACKUP_STORAGE_SECRET_ACCESS_KEY: " ",
      }),
    ).toThrow("BRUNO_BACKUP_STORAGE_SECRET_ACCESS_KEY is required");
    expect(() =>
      readBackupStorageConfig({
        ...COMPLETE_ENV,
        BRUNO_BACKUP_STORAGE_ENDPOINT_URL: "http://spaces.example.com",
      }),
    ).toThrow("must use HTTPS");
    expect(() =>
      readBackupStorageConfig({
        ...COMPLETE_ENV,
        BRUNO_BACKUP_STORAGE_ENDPOINT_URL: "https://user:secret@spaces.example.com?token=x",
      }),
    ).toThrow("must not include credentials");
    expect(() =>
      readBackupStorageConfig({
        ...COMPLETE_ENV,
        BRUNO_BACKUP_STORAGE_BUCKET: "Invalid_Bucket",
      }),
    ).toThrow("valid S3-compatible bucket name");
    expect(() =>
      readBackupStorageConfig({
        ...COMPLETE_ENV,
        BRUNO_BACKUP_STORAGE_REGION: "us_east_1",
      }),
    ).toThrow("lowercase letters, numbers, and hyphens");
  });

  it("allows loopback HTTP endpoints only for local storage tests", () => {
    expect(
      readBackupStorageConfig({
        ...COMPLETE_ENV,
        BRUNO_BACKUP_STORAGE_ENDPOINT_URL: "http://127.0.0.1:9000",
      }),
    ).toMatchObject({
      endpointUrl: "http://127.0.0.1:9000",
    });
  });

  it("rejects Recovery Archive storage that is not independently managed", () => {
    const minio = readBackupStorageConfig({
      ...COMPLETE_ENV,
      BRUNO_BACKUP_STORAGE_ENDPOINT_URL: "https://operator-droplet.example.com",
    });
    if (!minio) throw new Error("Expected storage configuration.");
    expect(() => assertIndependentRecoveryArchiveStorage(minio)).toThrow(
      "managed object storage independent from the Operator Droplet",
    );
    const ec2 = readBackupStorageConfig({
      ...COMPLETE_ENV,
      BRUNO_BACKUP_STORAGE_ENDPOINT_URL: "https://ec2-203-0-113-10.compute-1.amazonaws.com",
    });
    if (!ec2) throw new Error("Expected storage configuration.");
    expect(() => assertIndependentRecoveryArchiveStorage(ec2)).toThrow(
      "managed object storage independent from the Operator Droplet",
    );
    const spaces = readBackupStorageConfig(COMPLETE_ENV);
    if (!spaces) throw new Error("Expected storage configuration.");
    expect(() => assertIndependentRecoveryArchiveStorage(spaces)).not.toThrow();
  });

  it("uploads and downloads through the S3-compatible adapter without leaking credentials", async () => {
    const requests: Request[] = [];
    const storage = new S3CompatibleBackupObjectStorage(COMPLETE_ENV_CONFIG, {
      fetchImplementation: async (input) => {
        const request = input instanceof Request ? input : new Request(input);

        requests.push(request);

        if (new URL(request.url).searchParams.has("versioning")) {
          return new Response("<VersioningConfiguration />", { status: 200 });
        }

        if (request.method === "PUT") {
          return new Response(null, { status: 200 });
        }

        if (request.method === "HEAD") {
          return new Response(null, { status: 200 });
        }

        if (request.method === "DELETE") {
          return new Response(null, { status: 204 });
        }

        return new Response("stored artifact", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await expect(storage.verifyDeletionSafety()).resolves.toEqual({
      ok: true,
      versioning: "disabled",
    });

    await expect(
      storage.upload({
        key: "agents/agent-1/backup.json",
        body: new TextEncoder().encode("stored artifact"),
        contentType: "application/json",
      }),
    ).resolves.toEqual({
      ok: true,
      storageUri: "s3://bruno-backups/agents/agent-1/backup.json",
      byteLength: 15,
      versionId: "null",
    });

    const downloaded = await storage.download({ key: "agents/agent-1/backup.json" });

    expect(downloaded).toMatchObject({
      ok: true,
      storageUri: "s3://bruno-backups/agents/agent-1/backup.json",
      contentType: "application/json",
    });

    if (!downloaded.ok) {
      throw new Error("Expected S3-compatible download to succeed.");
    }

    expect(new TextDecoder().decode(downloaded.body)).toBe("stored artifact");
    await expect(storage.exists({ key: "agents/agent-1/backup.json" })).resolves.toEqual({
      ok: true,
      exists: true,
    });
    await expect(storage.delete({ key: "agents/agent-1/backup.json" })).resolves.toEqual({
      ok: true,
    });
    expect(requests).toHaveLength(5);
    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ["GET", "https://nyc3.digitaloceanspaces.com/bruno-backups/?versioning="],
      ["PUT", "https://nyc3.digitaloceanspaces.com/bruno-backups/agents/agent-1/backup.json"],
      ["GET", "https://nyc3.digitaloceanspaces.com/bruno-backups/agents/agent-1/backup.json"],
      ["HEAD", "https://nyc3.digitaloceanspaces.com/bruno-backups/agents/agent-1/backup.json"],
      ["DELETE", "https://nyc3.digitaloceanspaces.com/bruno-backups/agents/agent-1/backup.json"],
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

  it("captures and permanently deletes the exact S3 object version", async () => {
    const requests: Request[] = [];
    const versionId = "3/L 4+published=version";
    const storage = new S3CompatibleBackupObjectStorage(COMPLETE_ENV_CONFIG, {
      fetchImplementation: async (input) => {
        const request = input instanceof Request ? input : new Request(input);
        requests.push(request);
        return request.method === "PUT"
          ? new Response(null, { status: 200, headers: { "x-amz-version-id": versionId } })
          : new Response(null, { status: 204 });
      },
    });

    const uploaded = await storage.upload({
      key: "founder-recovery/user/archive.age",
      body: new Uint8Array([1]),
    });
    expect(uploaded).toMatchObject({ ok: true, versionId });
    await expect(
      storage.deleteVersion({ key: "founder-recovery/user/archive.age", versionId }),
    ).resolves.toEqual({ ok: true });

    expect(requests).toHaveLength(2);
    const deletionUrl = new URL(requests[1]?.url ?? "");
    expect(deletionUrl.searchParams.get("versionId")).toBe(versionId);
    expect(requests[1]?.headers.get("authorization")).toContain("backup-access-key");
  });

  it("rejects versioned buckets because object DELETE cannot prove permanent absence", async () => {
    for (const unsafeResponse of [
      "<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>",
      "<VersioningConfiguration><Status>Suspended</Status></VersioningConfiguration>",
      "",
      "<html>unexpected provider response</html>",
      "<VersioningConfiguration>",
      "<s3:VersioningConfiguration><s3:Status>Enabled</s3:Status></s3:VersioningConfiguration>",
    ]) {
      const storage = new S3CompatibleBackupObjectStorage(COMPLETE_ENV_CONFIG, {
        fetchImplementation: async () => new Response(unsafeResponse, { status: 200 }),
      });

      await expect(storage.verifyDeletionSafety()).resolves.toEqual(
        backupStorageFailure("deletion_safety"),
      );
    }
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

  it("bounds every S3-compatible request with an abort deadline", async () => {
    const requests: Request[] = [];
    const storage = new S3CompatibleBackupObjectStorage(COMPLETE_ENV_CONFIG, {
      requestTimeoutMs: 5,
      fetchImplementation: async (input) => {
        const request = input instanceof Request ? input : new Request(input);
        requests.push(request);
        return new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(request.signal.reason), {
            once: true,
          });
        });
      },
    });

    const bounded = Promise.all([
      storage.upload({ key: "agents/agent-1/backup.json", body: new Uint8Array([1]) }),
      storage.download({ key: "agents/agent-1/backup.json" }),
      storage.delete({ key: "agents/agent-1/backup.json" }),
      storage.deleteVersion({ key: "agents/agent-1/backup.json", versionId: "version/1" }),
      storage.exists({ key: "agents/agent-1/backup.json" }),
      storage.verifyDeletionSafety(),
    ]);
    const result = await Promise.race([
      bounded,
      new Promise<"unbounded">((resolve) => setTimeout(() => resolve("unbounded"), 100)),
    ]);

    expect(result).not.toBe("unbounded");
    expect(requests).toHaveLength(6);
    expect(requests.every((request) => request.signal.aborted)).toBe(true);
  });

  it("keeps backup object storage credentials out of shared validation and client components", async () => {
    await expect(readFile("src/env/validation.ts", "utf8")).resolves.not.toContain(
      "BRUNO_BACKUP_STORAGE",
    );
    await expect(readFile("src/server/backups/backup-storage.ts", "utf8")).resolves.toContain(
      'import "server-only";',
    );

    for (const filePath of await listSourceFiles("app")) {
      const source = await readFile(filePath, "utf8");

      if (!source.startsWith('"use client";')) {
        continue;
      }

      expect(source).not.toContain("BRUNO_BACKUP_STORAGE");
      expect(source).not.toContain("@/src/server/backups/backup-storage");
    }
  });

  it("builds safe storage URIs without accepting traversal keys", () => {
    expect(buildBackupStorageUri("bruno-backups", "agents/agent-1/backup.json")).toBe(
      "s3://bruno-backups/agents/agent-1/backup.json",
    );
    expect(() => buildBackupStorageUri("bruno-backups", "/agents/backup.json")).toThrow(
      "Backup storage key is invalid.",
    );
  });
});

const COMPLETE_ENV_CONFIG = {
  endpointUrl: "https://nyc3.digitaloceanspaces.com",
  bucket: "bruno-backups",
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
