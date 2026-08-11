import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  retireSupersededRunnerSnapshot,
  type RunnerSnapshotRetirementProvider,
} from "@/scripts/retire-runner-snapshot";

const SNAPSHOT_ID = "240613994";
const SNAPSHOT_NAME = "bruno-snapshot-builder-5dff85af0e8e-31419544982";
const REGION = "sfo3";

describe("runner snapshot retirement", () => {
  it("deletes only the exact available snapshot and verifies authoritative absence", async () => {
    const calls: string[] = [];
    const provider = providerWith(calls);

    await expect(
      retireSupersededRunnerSnapshot(
        { snapshotId: SNAPSHOT_ID, expectedName: SNAPSHOT_NAME, expectedRegion: REGION },
        { provider, now: () => new Date("2026-08-11T01:00:00.000Z") },
      ),
    ).resolves.toEqual({
      schemaVersion: "bruno.runner.snapshot.retirement.v1",
      snapshotId: SNAPSHOT_ID,
      snapshotName: SNAPSHOT_NAME,
      region: REGION,
      retiredAt: "2026-08-11T01:00:00.000Z",
      absenceVerified: true,
    });
    expect(calls).toEqual(["read", "delete", "verify"]);
  });

  it("rejects an identity mismatch before deletion", async () => {
    const calls: string[] = [];
    const provider = providerWith(calls, { name: "different-snapshot" });

    await expect(
      retireSupersededRunnerSnapshot(
        { snapshotId: SNAPSHOT_ID, expectedName: SNAPSHOT_NAME, expectedRegion: REGION },
        { provider },
      ),
    ).rejects.toThrow("Superseded snapshot identity did not match the authorized target.");
    expect(calls).toEqual(["read"]);
  });

  it("fails closed unless post-delete absence is authoritative", async () => {
    const calls: string[] = [];
    const provider = providerWith(calls);
    provider.verifyImageAbsent = vi.fn(async () => {
      calls.push("verify");
      return { ok: false as const, reason: "cleanup_failed" as const, message: "closed" };
    });

    await expect(
      retireSupersededRunnerSnapshot(
        { snapshotId: SNAPSHOT_ID, expectedName: SNAPSHOT_NAME, expectedRegion: REGION },
        { provider },
      ),
    ).rejects.toThrow("Superseded snapshot absence could not be verified.");
    expect(calls).toEqual(["read", "delete", "verify"]);
  });
});

describe("runner snapshot retirement workflow", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/retire-runner-snapshot.yml", import.meta.url),
    "utf8",
  );

  it("keeps the exact destructive target behind protected authorization", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("snapshot_id:");
    expect(workflow).toContain("expected_snapshot_name:");
    expect(workflow).toContain("cost_authorization:");
    expect(workflow).toContain("environment: snapshot-build");
    expect(workflow).toContain("I_UNDERSTAND_THIS_DELETES_THE_SUPERSEDED_SNAPSHOT");
    expect(workflow).toContain(
      "BRUNO_DIGITALOCEAN_TOKEN: $" + "{{ secrets.BRUNO_DIGITALOCEAN_TOKEN }}",
    );
    expect(workflow).toContain("bun run runner:snapshot:retire");
    expect(workflow).toContain("runner-snapshot-retirement-$" + "{{ github.run_id }}");
    expect(workflow).toContain("if-no-files-found: error");
    expect(workflow).toContain("SNAPSHOT_ID: $" + "{{ inputs.snapshot_id }}");
    expect(workflow).toContain('--snapshot-id "$' + '{SNAPSHOT_ID}"');
    expect(workflow).not.toContain('--snapshot-id "${{' + ' inputs.snapshot_id }}"');
    expect(workflow).not.toContain("packages: write");
    expect(workflow).not.toContain("id-token: write");
  });
});

function providerWith(
  calls: string[],
  overrides: { name?: string; regions?: string[]; status?: "available" | "pending" } = {},
): RunnerSnapshotRetirementProvider {
  return {
    readImageAvailability: async () => {
      calls.push("read");
      return {
        ok: true,
        value: {
          id: SNAPSHOT_ID,
          name: overrides.name ?? SNAPSHOT_NAME,
          regions: overrides.regions ?? [REGION],
          minDiskSizeGb: 50,
          architecture: "amd64",
          status: overrides.status ?? "available",
        },
      };
    },
    deleteImage: async () => {
      calls.push("delete");
      return { ok: true, value: { deleted: true } };
    },
    verifyImageAbsent: async () => {
      calls.push("verify");
      return { ok: true, value: { absent: true } };
    },
  };
}
