import { describe, expect, it } from "vitest";
import { verifyFounderProductContractCandidateHistory } from "@/scripts/check-founder-product-contract-candidate-history";

const REVISION = "a".repeat(40);

describe("Founder Product Contract candidate history", () => {
  it("allows the first run and a release dispatch after a successful CI run", async () => {
    const request = requestReturning([
      workflowRun(200, "in_progress", null),
      workflowRun(100, "completed", "success"),
    ]);

    await expect(
      verifyFounderProductContractCandidateHistory(validInput(request)),
    ).resolves.toEqual({ priorSuccessfulRuns: 1, priorBlockingRuns: 0 });
  });

  it.each([
    ["completed", "failure"],
    ["completed", "cancelled"],
    ["in_progress", null],
  ] as const)("rejects a fresh dispatch after a prior %s/%s run for the exact revision", async (status, conclusion) => {
    const request = requestReturning([
      workflowRun(200, "in_progress", null),
      workflowRun(100, status, conclusion),
    ]);

    await expect(verifyFounderProductContractCandidateHistory(validInput(request))).rejects.toThrow(
      "Exact source revision has a prior unsuccessful Founder Product Contract workflow run.",
    );
  });

  it("fails closed when GitHub candidate history is unavailable", async () => {
    await expect(
      verifyFounderProductContractCandidateHistory(
        validInput(async () => new Response("unavailable", { status: 503 })),
      ),
    ).rejects.toThrow("Founder Product Contract candidate history could not be verified.");
  });
});

function validInput(request: typeof fetch) {
  return {
    repository: "ametel01/bruno",
    sourceRevision: REVISION,
    currentRunId: 200,
    token: "github-test-token",
    request,
  };
}

function requestReturning(runs: unknown[]): typeof fetch {
  return async () =>
    new Response(JSON.stringify({ total_count: runs.length, workflow_runs: runs }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
}

function workflowRun(id: number, status: string, conclusion: string | null) {
  return { id, head_sha: REVISION, status, conclusion };
}
