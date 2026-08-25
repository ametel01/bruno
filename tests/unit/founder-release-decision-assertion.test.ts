import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertFounderReleaseDecisionApproved } from "@/scripts/assert-founder-release-decision";
import { buildDeterministicFounderGeneralReleaseAuthorityFixture } from "@/src/testing/founder-general-release-authority";

const directories: string[] = [];
const REVISION = "a".repeat(40);
const RUNTIME_REVISION = "runtime-387";
const NOW = new Date("2026-08-23T08:00:00.000Z");

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("Founder release decision assertion", () => {
  it("accepts only a retained approved decision", async () => {
    const path = await decisionPath(
      JSON.parse(
        buildDeterministicFounderGeneralReleaseAuthorityFixture({
          sourceRevision: REVISION,
          runtimeRevision: RUNTIME_REVISION,
          decidedAt: NOW,
        }),
      ),
    );

    await expect(
      assertFounderReleaseDecisionApproved(
        path,
        {
          VERCEL_GIT_COMMIT_SHA: REVISION,
          BRUNO_FOUNDER_RELEASE_RUNTIME_REVISION: RUNTIME_REVISION,
        },
        NOW,
      ),
    ).resolves.toBeUndefined();
  });

  it("makes denied, malformed, and absent release decisions terminal", async () => {
    const approved = JSON.parse(
      buildDeterministicFounderGeneralReleaseAuthorityFixture({
        sourceRevision: REVISION,
        runtimeRevision: RUNTIME_REVISION,
        decidedAt: NOW,
      }),
    );
    const denied = await decisionPath({ ...approved, outcome: "denied" });
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
