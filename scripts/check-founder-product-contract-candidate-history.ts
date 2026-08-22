const GITHUB_API_ORIGIN = "https://api.github.com";
const WORKFLOW_FILE = "founder-product-contract.yml";
const MAX_PAGES = 100;

type WorkflowRun = {
  id: number;
  headSha: string;
  status: string;
  conclusion: string | null;
};

export async function verifyFounderProductContractCandidateHistory(input: {
  repository: string;
  sourceRevision: string;
  currentRunId: number;
  token: string;
  request?: typeof fetch;
}): Promise<{ priorSuccessfulRuns: number; priorBlockingRuns: 0 }> {
  assertInput(input);
  const request = input.request ?? fetch;
  const priorRuns: WorkflowRun[] = [];

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = new URL(
      `/repos/${input.repository}/actions/workflows/${WORKFLOW_FILE}/runs`,
      GITHUB_API_ORIGIN,
    );
    url.searchParams.set("head_sha", input.sourceRevision);
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const response = await request(url, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${input.token}`,
        "x-github-api-version": "2022-11-28",
      },
    });
    if (!response.ok) {
      throw new Error("Founder Product Contract candidate history could not be verified.");
    }
    const runs = parseWorkflowRuns(await response.json());
    priorRuns.push(...runs.filter((run) => run.id !== input.currentRunId));
    if (runs.length < 100) break;
    if (page === MAX_PAGES) {
      throw new Error("Founder Product Contract candidate history exceeded its bounded scan.");
    }
  }

  const exactRevisionRuns = priorRuns.filter((run) => run.headSha === input.sourceRevision);
  const blockingRuns = exactRevisionRuns.filter(
    (run) => run.status !== "completed" || run.conclusion !== "success",
  );
  if (blockingRuns.length > 0) {
    throw new Error(
      "Exact source revision has a prior unsuccessful Founder Product Contract workflow run.",
    );
  }
  return { priorSuccessfulRuns: exactRevisionRuns.length, priorBlockingRuns: 0 };
}

function assertInput(input: {
  repository: string;
  sourceRevision: string;
  currentRunId: number;
  token: string;
}): void {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository) ||
    !/^[a-f0-9]{40}$/.test(input.sourceRevision) ||
    !Number.isSafeInteger(input.currentRunId) ||
    input.currentRunId < 1 ||
    !input.token
  ) {
    throw new Error("Founder Product Contract candidate history identity is invalid.");
  }
}

function parseWorkflowRuns(value: unknown): WorkflowRun[] {
  if (!isRecord(value) || !Array.isArray(value.workflow_runs)) {
    throw new Error("Founder Product Contract candidate history response is invalid.");
  }
  return value.workflow_runs.map((run) => {
    if (
      !isRecord(run) ||
      !Number.isSafeInteger(run.id) ||
      typeof run.head_sha !== "string" ||
      typeof run.status !== "string" ||
      (run.conclusion !== null && typeof run.conclusion !== "string")
    ) {
      throw new Error("Founder Product Contract candidate history response is invalid.");
    }
    return {
      id: run.id as number,
      headSha: run.head_sha,
      status: run.status,
      conclusion: run.conclusion as string | null,
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.main) {
  const currentRunId = Number(requiredEnvironment("GITHUB_RUN_ID"));
  const result = await verifyFounderProductContractCandidateHistory({
    repository: requiredEnvironment("GITHUB_REPOSITORY"),
    sourceRevision: requiredEnvironment("BRUNO_FOUNDER_CONTRACT_SOURCE_REVISION"),
    currentRunId,
    token: requiredEnvironment("BRUNO_FOUNDER_CONTRACT_GITHUB_TOKEN"),
  });
  console.info(
    `Founder Product Contract candidate history verified (${result.priorSuccessfulRuns} prior successful run(s)).`,
  );
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
