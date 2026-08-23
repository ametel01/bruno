import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertFounderReleaseDecisionApproved } from "@/scripts/assert-founder-release-decision";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("Founder release decision assertion", () => {
  it("accepts only a retained approved decision", async () => {
    const path = await decisionPath({
      schemaVersion: "bruno.founder-initial-general-release-decision.v1",
      outcome: "approved",
    });

    await expect(assertFounderReleaseDecisionApproved(path)).resolves.toBeUndefined();
  });

  it("makes denied, malformed, and absent release decisions terminal", async () => {
    const denied = await decisionPath({
      schemaVersion: "bruno.founder-initial-general-release-decision.v1",
      outcome: "denied",
    });
    const malformed = await decisionPath({ outcome: "approved" });

    await expect(assertFounderReleaseDecisionApproved(denied)).rejects.toThrow(
      "decision denied this exact candidate",
    );
    await expect(assertFounderReleaseDecisionApproved(malformed)).rejects.toThrow(
      "decision denied this exact candidate",
    );
    await expect(assertFounderReleaseDecisionApproved(`${malformed}.missing`)).rejects.toThrow(
      "decision artifact is unavailable",
    );
  });
});

async function decisionPath(value: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "founder-release-decision-"));
  directories.push(directory);
  const path = join(directory, "decision.json");
  await writeFile(path, JSON.stringify(value));
  return path;
}
