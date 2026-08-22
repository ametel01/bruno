import { describe, expect, it } from "vitest";
import {
  readFounderApplicationRevision,
  requireFounderApplicationRevision,
} from "@/src/server/founder-product-contract/application-revision";

describe("Founder application revision", () => {
  it("uses one exact-revision resolver for explicit and executing identities", () => {
    const executingRevision = "a".repeat(40);
    const explicitRevision = "b".repeat(40);

    expect(
      readFounderApplicationRevision({
        env: { VERCEL_GIT_COMMIT_SHA: ` ${executingRevision} ` },
      }),
    ).toBe(executingRevision);
    expect(
      readFounderApplicationRevision({
        applicationRevision: explicitRevision,
        env: { VERCEL_GIT_COMMIT_SHA: executingRevision },
      }),
    ).toBe(explicitRevision);
    expect(
      readFounderApplicationRevision({
        applicationRevision: "invalid",
        env: { VERCEL_GIT_COMMIT_SHA: executingRevision },
      }),
    ).toBeNull();
    expect(readFounderApplicationRevision({ env: {} })).toBeNull();
  });

  it("provides the shared throwing boundary only for operations that require revision authority", () => {
    expect(() =>
      requireFounderApplicationRevision(
        { env: {} },
        "Owner Preview application revision is unavailable.",
      ),
    ).toThrow("Owner Preview application revision is unavailable.");
  });
});
