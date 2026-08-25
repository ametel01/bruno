import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { verifyFounderProductContractCandidateHistory } from "@/scripts/check-founder-product-contract-candidate-history";
import {
  founderReleaseCandidateControlKey,
  founderReleaseCandidateControlName,
} from "@/scripts/founder-product-contract-candidate-control";

const REVISION = "a".repeat(40);
const RUNTIME_REVISION = "runtime-release-v1";

describe("Founder Product Contract candidate history", () => {
  it("runs the exact CI history command under plain Bun", () => {
    const result = spawnSync(
      "bun",
      ["scripts/check-founder-product-contract-candidate-history.ts"],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          NODE_ENV: "test",
          PATH: process.env.PATH ?? "",
          GITHUB_REPOSITORY: "ametel01/bruno",
          BRUNO_FOUNDER_CONTRACT_SOURCE_REVISION: REVISION,
          BRUNO_FOUNDER_CONTRACT_RUNTIME_REVISION: RUNTIME_REVISION,
          BRUNO_FOUNDER_CONTRACT_MODE: "ci",
          BRUNO_FOUNDER_CONTRACT_GITHUB_TOKEN: "github-test-token",
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "Founder Product Contract candidate history verified (0 prior successful run(s)).",
    );
    expect(result.stderr).not.toContain("server-only");
  });

  it("allows the first run and a release dispatch after a successful CI run", async () => {
    const request = requestReturning([unrelatedControl()]);

    await expect(
      verifyFounderProductContractCandidateHistory(validInput(request)),
    ).resolves.toEqual({ priorSuccessfulRuns: 0, priorBlockingRuns: 0 });
  });

  it("recognizes a successful release only for the exact source and protected runtime", async () => {
    const request = requestReturning([candidateControl("completed", "success")], {
      100: originatingRun("completed", "success"),
    });

    await expect(
      verifyFounderProductContractCandidateHistory(validInput(request)),
    ).resolves.toEqual({ priorSuccessfulRuns: 1, priorBlockingRuns: 0 });
  });

  it.each([
    ["completed", "failure"],
    ["completed", "cancelled"],
    ["in_progress", null],
  ] as const)("rejects a fresh dispatch after a prior %s/%s run for the exact revision", async (status, conclusion) => {
    const request = requestReturning([candidateControl(status, conclusion)]);

    await expect(verifyFounderProductContractCandidateHistory(validInput(request))).rejects.toThrow(
      "Exact source and runtime candidate has a prior unsuccessful Founder Product Contract release run.",
    );
  });

  it("rejects a candidate control whose run-unique name was replaced", async () => {
    const request = requestReturning([
      {
        ...candidateControl("completed", "success"),
        name: founderReleaseCandidateControlName(101),
      },
    ]);

    await expect(verifyFounderProductContractCandidateHistory(validInput(request))).rejects.toThrow(
      "Founder Product Contract candidate history response is invalid.",
    );
  });

  it("rejects an unsuccessful exact control even when another exact control succeeded", async () => {
    const request = requestReturning([
      candidateControl("completed", "success"),
      candidateControl("completed", "failure", RUNTIME_REVISION, 501),
    ]);

    await expect(verifyFounderProductContractCandidateHistory(validInput(request))).rejects.toThrow(
      "Exact source and runtime candidate has a prior unsuccessful Founder Product Contract release run.",
    );
  });

  it("rejects an ambiguously committed success whose originating workflow failed", async () => {
    const request = requestReturning([candidateControl("completed", "success")], {
      100: originatingRun("completed", "failure"),
    });

    await expect(verifyFounderProductContractCandidateHistory(validInput(request))).rejects.toThrow(
      "Exact source and runtime candidate has a prior unsuccessful Founder Product Contract release run.",
    );
  });

  it.each([
    "https://github.com/another/repository/actions/runs/100",
    "https://github.com/ametel01/bruno/actions/jobs/100",
    "https://github.com/ametel01/bruno/actions/runs/100?attempt=1",
  ])("rejects a successful control with a non-canonical originating run URL %s", async (detailsUrl) => {
    const request = requestReturning([
      { ...candidateControl("completed", "success"), details_url: detailsUrl },
    ]);

    await expect(verifyFounderProductContractCandidateHistory(validInput(request))).rejects.toThrow(
      "Founder Product Contract candidate history response is invalid.",
    );
  });

  it.each([
    ["different id", { id: 101 }],
    ["different source", { head_sha: "b".repeat(40) }],
    ["different workflow", { path: ".github/workflows/verify.yml" }],
    ["different event", { event: "push" }],
    ["unresolved run", { status: "in_progress", conclusion: null }],
  ])("rejects a successful control bound to a %s", async (_label, override) => {
    const request = requestReturning([candidateControl("completed", "success")], {
      100: { ...originatingRun("completed", "success"), ...override },
    });

    await expect(verifyFounderProductContractCandidateHistory(validInput(request))).rejects.toThrow(
      "Exact source and runtime candidate has a prior unsuccessful Founder Product Contract release run.",
    );
  });

  it("fails closed when authoritative originating-run read-back is unavailable", async () => {
    const historyRequest = requestReturning([candidateControl("completed", "success")]);
    const request: typeof fetch = async (input) => {
      const url = new URL(String(input));
      return url.pathname.endsWith("/actions/runs/100")
        ? new Response("unavailable", { status: 503 })
        : historyRequest(input);
    };

    await expect(verifyFounderProductContractCandidateHistory(validInput(request))).rejects.toThrow(
      "Founder Product Contract candidate history could not be verified.",
    );
  });

  it("does not let a different protected runtime poison this candidate", async () => {
    const request = requestReturning([
      candidateControl("completed", "failure", "runtime-release-v2"),
    ]);

    await expect(
      verifyFounderProductContractCandidateHistory(validInput(request)),
    ).resolves.toEqual({ priorSuccessfulRuns: 0, priorBlockingRuns: 0 });
  });

  it.each([
    ["wrong name", { name: "Untrusted candidate control" }],
    ["wrong app", { app: { slug: "third-party" } }],
  ])("does not trust a matching external id from the %s", async (_label, override) => {
    const request = requestReturning([
      { ...candidateControl("completed", "failure"), ...override },
    ]);

    await expect(
      verifyFounderProductContractCandidateHistory(validInput(request)),
    ).resolves.toEqual({ priorSuccessfulRuns: 0, priorBlockingRuns: 0 });
  });

  it("does not treat ordinary CI fixture runs as release candidates", async () => {
    let requested = false;
    await expect(
      verifyFounderProductContractCandidateHistory({
        ...validInput(async () => {
          requested = true;
          return new Response(null, { status: 500 });
        }),
        mode: "ci",
      }),
    ).resolves.toEqual({ priorSuccessfulRuns: 0, priorBlockingRuns: 0 });
    expect(requested).toBe(false);
  });

  it("fails closed when GitHub candidate history is unavailable", async () => {
    await expect(
      verifyFounderProductContractCandidateHistory(
        validInput(async () => new Response("unavailable", { status: 503 })),
      ),
    ).rejects.toThrow("Founder Product Contract candidate history could not be verified.");
  });

  it("fails closed when GitHub returns malformed control authority", async () => {
    await expect(
      verifyFounderProductContractCandidateHistory(
        validInput(async () =>
          jsonResponse({ total_count: 1, check_suites: [{ status: "completed" }] }),
        ),
      ),
    ).rejects.toThrow("Founder Product Contract candidate history response is invalid.");
  });

  it("finds an older failed candidate control beyond the first suite page", async () => {
    const request: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith(`/commits/${REVISION}/check-suites`)) {
        const page = Number(url.searchParams.get("page"));
        return jsonResponse({
          total_count: 101,
          check_suites:
            page === 1
              ? Array.from({ length: 100 }, (_, index) => ({ id: index + 1 }))
              : [{ id: 101 }],
        });
      }
      const suiteMatch = url.pathname.match(/\/check-suites\/([1-9][0-9]*)\/check-runs$/);
      if (suiteMatch) {
        const controls =
          Number(suiteMatch[1]) === 101 ? [candidateControl("completed", "failure")] : [];
        return jsonResponse({ total_count: controls.length, check_runs: controls });
      }
      return new Response("unexpected", { status: 404 });
    };

    await expect(verifyFounderProductContractCandidateHistory(validInput(request))).rejects.toThrow(
      "Exact source and runtime candidate has a prior unsuccessful Founder Product Contract release run.",
    );
  });

  it("fails closed instead of truncating more than 1,000 noisy check suites", async () => {
    const request: typeof fetch = async (input) => {
      const url = new URL(String(input));
      const suiteList = url.pathname.endsWith(`/commits/${REVISION}/check-suites`);
      if (suiteList) {
        const page = Number(url.searchParams.get("page"));
        const start = (page - 1) * 100;
        const remaining = Math.max(0, 1_001 - start);
        return jsonResponse({
          total_count: 1_001,
          check_suites: Array.from({ length: Math.min(100, remaining) }, (_, index) => ({
            id: start + index + 1,
          })),
        });
      }
      if (/\/check-suites\/[1-9][0-9]*\/check-runs$/.test(url.pathname)) {
        return jsonResponse({ total_count: 0, check_runs: [] });
      }
      return new Response("unexpected", { status: 404 });
    };

    await expect(verifyFounderProductContractCandidateHistory(validInput(request))).rejects.toThrow(
      "Founder Product Contract candidate history exceeded its bounded scan.",
    );
  });

  it("counts originating-run read-backs in the global history request limit", async () => {
    const suiteCount = 499;
    const request: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith(`/commits/${REVISION}/check-suites`)) {
        const page = Number(url.searchParams.get("page"));
        const start = (page - 1) * 100;
        const remaining = Math.max(0, suiteCount - start);
        return jsonResponse({
          total_count: suiteCount,
          check_suites: Array.from({ length: Math.min(100, remaining) }, (_, index) => ({
            id: start + index + 1,
          })),
        });
      }
      const suiteMatch = url.pathname.match(/\/check-suites\/([1-9][0-9]*)\/check-runs$/);
      if (suiteMatch) {
        const runId = Number(suiteMatch[1]);
        return jsonResponse({
          total_count: 1,
          check_runs: [
            {
              ...candidateControl("completed", "success", RUNTIME_REVISION, 1_000 + runId),
              name: founderReleaseCandidateControlName(runId),
              details_url: `https://github.com/ametel01/bruno/actions/runs/${runId}`,
            },
          ],
        });
      }
      const runMatch = url.pathname.match(/\/actions\/runs\/([1-9][0-9]*)$/);
      if (runMatch) {
        const runId = Number(runMatch[1]);
        return jsonResponse({ ...originatingRun("completed", "success"), id: runId });
      }
      return new Response("unexpected", { status: 404 });
    };

    await expect(verifyFounderProductContractCandidateHistory(validInput(request))).rejects.toThrow(
      "Founder Product Contract candidate history exceeded its bounded scan.",
    );
  });
});

function validInput(request: typeof fetch) {
  return {
    repository: "ametel01/bruno",
    sourceRevision: REVISION,
    runtimeRevision: RUNTIME_REVISION,
    mode: "release" as const,
    token: "github-test-token",
    request,
  };
}

function requestReturning(
  controls: unknown[],
  runsById: Record<number, unknown> = {},
): typeof fetch {
  return async (input) => {
    const pathname = new URL(String(input)).pathname;
    const runMatch = pathname.match(/\/actions\/runs\/([1-9][0-9]*)$/);
    if (runMatch) return jsonResponse(runsById[Number(runMatch[1])]);
    if (pathname.endsWith(`/commits/${REVISION}/check-suites`)) {
      return jsonResponse({ total_count: 1, check_suites: [{ id: 10 }] });
    }
    if (pathname.endsWith("/check-suites/10/check-runs")) {
      return jsonResponse({ total_count: controls.length, check_runs: controls });
    }
    return new Response("unexpected", { status: 404 });
  };
}

function candidateControl(
  status: string,
  conclusion: string | null,
  runtimeRevision = RUNTIME_REVISION,
  checkRunId = 500,
) {
  return {
    id: checkRunId,
    external_id: founderReleaseCandidateControlKey(REVISION, runtimeRevision),
    name: founderReleaseCandidateControlName(100),
    app: { slug: "github-actions" },
    details_url: "https://github.com/ametel01/bruno/actions/runs/100",
    status,
    conclusion,
  };
}

function unrelatedControl() {
  return {
    id: 501,
    external_id: null,
    name: "Unit tests",
    app: { slug: "github-actions" },
    details_url: null,
    status: "completed",
    conclusion: "success",
  };
}

function originatingRun(status: string, conclusion: string | null) {
  return {
    id: 100,
    head_sha: REVISION,
    path: ".github/workflows/founder-product-contract.yml@release-candidate",
    event: "workflow_dispatch",
    status,
    conclusion,
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
