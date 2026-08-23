import {
  FOUNDER_RELEASE_CANDIDATE_CONTROL_NAME_PREFIX,
  founderReleaseCandidateControlKey,
  founderReleaseCandidateControlName,
} from "@/scripts/founder-product-contract-candidate-identity";

const GITHUB_API_ORIGIN = "https://api.github.com";
const MAX_COLLECTION_PAGES = 100;
const MAX_HISTORY_REQUESTS = 1_000;

type CandidateControl = {
  id: number;
  externalId: string | null;
  name: string;
  appSlug: string;
  detailsUrl: string | null;
  status: string;
  conclusion: string | null;
};

export async function verifyFounderProductContractCandidateHistory(input: {
  repository: string;
  sourceRevision: string;
  runtimeRevision: string;
  mode: "ci" | "release";
  token: string;
  request?: typeof fetch;
}): Promise<{ priorSuccessfulRuns: number; priorBlockingRuns: 0 }> {
  assertInput(input);
  if (input.mode === "ci") return { priorSuccessfulRuns: 0, priorBlockingRuns: 0 };
  const request = input.request ?? fetch;
  const exactControlKey = founderReleaseCandidateControlKey(
    input.sourceRevision,
    input.runtimeRevision,
  );
  const exactCandidateControls: CandidateControl[] = [];
  let historyRequests = 0;
  const requestHistoryPage = async (url: URL): Promise<unknown> => {
    historyRequests += 1;
    if (historyRequests > MAX_HISTORY_REQUESTS) {
      throw new Error("Founder Product Contract candidate history exceeded its bounded scan.");
    }
    const response = await request(url, { headers: githubHeaders(input.token) });
    if (!response.ok) {
      throw new Error("Founder Product Contract candidate history could not be verified.");
    }
    return response.json();
  };
  const suiteIds: number[] = [];
  const seenSuiteIds = new Set<number>();
  let expectedSuiteCount: number | undefined;

  for (let page = 1; page <= MAX_COLLECTION_PAGES; page += 1) {
    const url = new URL(
      `/repos/${input.repository}/commits/${input.sourceRevision}/check-suites`,
      GITHUB_API_ORIGIN,
    );
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const suitePage = parseCheckSuitePage(await requestHistoryPage(url));
    expectedSuiteCount ??= suitePage.totalCount;
    if (suitePage.totalCount !== expectedSuiteCount) {
      throw new Error("Founder Product Contract candidate history response is invalid.");
    }
    for (const suiteId of suitePage.suiteIds) {
      if (seenSuiteIds.has(suiteId)) {
        throw new Error("Founder Product Contract candidate history response is invalid.");
      }
      seenSuiteIds.add(suiteId);
    }
    suiteIds.push(...suitePage.suiteIds);
    if (suiteIds.length === expectedSuiteCount) break;
    if (suiteIds.length > expectedSuiteCount || suitePage.suiteIds.length === 0) {
      throw new Error("Founder Product Contract candidate history response is invalid.");
    }
    if (page === MAX_COLLECTION_PAGES) {
      throw new Error("Founder Product Contract candidate history exceeded its bounded scan.");
    }
  }

  const seenControlIds = new Set<number>();
  for (const suiteId of suiteIds) {
    let expectedControlCount: number | undefined;
    let scannedControlCount = 0;
    for (let page = 1; page <= MAX_COLLECTION_PAGES; page += 1) {
      const url = new URL(
        `/repos/${input.repository}/check-suites/${suiteId}/check-runs`,
        GITHUB_API_ORIGIN,
      );
      url.searchParams.set("per_page", "100");
      url.searchParams.set("page", String(page));
      url.searchParams.set("filter", "all");
      const controlPage = parseCandidateControlPage(await requestHistoryPage(url));
      expectedControlCount ??= controlPage.totalCount;
      if (controlPage.totalCount !== expectedControlCount) {
        throw new Error("Founder Product Contract candidate history response is invalid.");
      }
      for (const control of controlPage.controls) {
        if (seenControlIds.has(control.id)) {
          throw new Error("Founder Product Contract candidate history response is invalid.");
        }
        seenControlIds.add(control.id);
      }
      exactCandidateControls.push(
        ...controlPage.controls.filter(
          ({ externalId, name, appSlug }) =>
            externalId === exactControlKey &&
            name.startsWith(FOUNDER_RELEASE_CANDIDATE_CONTROL_NAME_PREFIX) &&
            appSlug === "github-actions",
        ),
      );
      scannedControlCount += controlPage.controls.length;
      if (scannedControlCount === expectedControlCount) break;
      if (scannedControlCount > expectedControlCount || controlPage.controls.length === 0) {
        throw new Error("Founder Product Contract candidate history response is invalid.");
      }
      if (page === MAX_COLLECTION_PAGES) {
        throw new Error("Founder Product Contract candidate history exceeded its bounded scan.");
      }
    }
  }

  const blockingRuns = exactCandidateControls.filter(
    (control) => control.status !== "completed" || control.conclusion !== "success",
  );
  if (blockingRuns.length > 0) {
    throw new Error(
      "Exact source and runtime candidate has a prior unsuccessful Founder Product Contract release run.",
    );
  }
  for (const control of exactCandidateControls) {
    const runId = parseOriginatingRunId(control.detailsUrl, input.repository);
    if (control.name !== founderReleaseCandidateControlName(runId)) {
      throw new Error("Founder Product Contract candidate history response is invalid.");
    }
    const run = parseOriginatingRun(
      await requestHistoryPage(
        new URL(`/repos/${input.repository}/actions/runs/${runId}`, GITHUB_API_ORIGIN),
      ),
    );
    if (
      run.id !== runId ||
      run.headSha !== input.sourceRevision ||
      !isFounderProductContractWorkflowPath(run.path) ||
      run.event !== "workflow_dispatch" ||
      run.status !== "completed" ||
      run.conclusion !== "success"
    ) {
      throw new Error(
        "Exact source and runtime candidate has a prior unsuccessful Founder Product Contract release run.",
      );
    }
  }
  return { priorSuccessfulRuns: exactCandidateControls.length, priorBlockingRuns: 0 };
}

function assertInput(input: {
  repository: string;
  sourceRevision: string;
  runtimeRevision: string;
  mode: "ci" | "release";
  token: string;
}): void {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository) ||
    !/^[a-f0-9]{40}$/.test(input.sourceRevision) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$/.test(input.runtimeRevision) ||
    (input.mode !== "ci" && input.mode !== "release") ||
    !input.token
  ) {
    throw new Error("Founder Product Contract candidate history identity is invalid.");
  }
}

function parseCheckSuitePage(value: unknown): { totalCount: number; suiteIds: number[] } {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.total_count) ||
    (value.total_count as number) < 0 ||
    !Array.isArray(value.check_suites) ||
    value.check_suites.length > 100
  ) {
    throw new Error("Founder Product Contract candidate history response is invalid.");
  }
  return {
    totalCount: value.total_count as number,
    suiteIds: value.check_suites.map((suite) => {
      if (!isRecord(suite) || !Number.isSafeInteger(suite.id) || (suite.id as number) < 1) {
        throw new Error("Founder Product Contract candidate history response is invalid.");
      }
      return suite.id as number;
    }),
  };
}

function parseCandidateControlPage(value: unknown): {
  totalCount: number;
  controls: CandidateControl[];
} {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.total_count) ||
    (value.total_count as number) < 0 ||
    !Array.isArray(value.check_runs) ||
    value.check_runs.length > 100
  ) {
    throw new Error("Founder Product Contract candidate history response is invalid.");
  }
  return {
    totalCount: value.total_count as number,
    controls: value.check_runs.map((control) => {
      if (
        !isRecord(control) ||
        !Number.isSafeInteger(control.id) ||
        (control.id as number) < 1 ||
        (control.external_id !== null && typeof control.external_id !== "string") ||
        typeof control.name !== "string" ||
        !isRecord(control.app) ||
        typeof control.app.slug !== "string" ||
        (control.details_url !== null && typeof control.details_url !== "string") ||
        typeof control.status !== "string" ||
        (control.conclusion !== null && typeof control.conclusion !== "string")
      ) {
        throw new Error("Founder Product Contract candidate history response is invalid.");
      }
      return {
        id: control.id as number,
        externalId: control.external_id as string | null,
        name: control.name,
        appSlug: control.app.slug,
        detailsUrl: control.details_url as string | null,
        status: control.status,
        conclusion: control.conclusion as string | null,
      };
    }),
  };
}

function parseOriginatingRunId(detailsUrl: string | null, repository: string): number {
  if (detailsUrl === null) {
    throw new Error("Founder Product Contract candidate history response is invalid.");
  }
  const match = detailsUrl.match(
    new RegExp(`^https://github\\.com/${escapeRegExp(repository)}/actions/runs/([1-9][0-9]*)$`),
  );
  const runId = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(runId)) {
    throw new Error("Founder Product Contract candidate history response is invalid.");
  }
  return runId;
}

function parseOriginatingRun(value: unknown): {
  id: number;
  headSha: string;
  path: string;
  event: string;
  status: string;
  conclusion: string | null;
} {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.id) ||
    typeof value.head_sha !== "string" ||
    typeof value.path !== "string" ||
    typeof value.event !== "string" ||
    typeof value.status !== "string" ||
    (value.conclusion !== null && typeof value.conclusion !== "string")
  ) {
    throw new Error("Founder Product Contract candidate history response is invalid.");
  }
  return {
    id: value.id as number,
    headSha: value.head_sha,
    path: value.path,
    event: value.event,
    status: value.status,
    conclusion: value.conclusion as string | null,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isFounderProductContractWorkflowPath(value: string): boolean {
  const canonicalPath = ".github/workflows/founder-product-contract.yml";
  const qualifiedPathPrefix = `${canonicalPath}@`;
  return (
    value === canonicalPath ||
    (value.startsWith(qualifiedPathPrefix) &&
      value.length > qualifiedPathPrefix.length &&
      !/\s/.test(value.slice(qualifiedPathPrefix.length)))
  );
}

function githubHeaders(token: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "x-github-api-version": "2022-11-28",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.main) {
  const result = await verifyFounderProductContractCandidateHistory({
    repository: requiredEnvironment("GITHUB_REPOSITORY"),
    sourceRevision: requiredEnvironment("BRUNO_FOUNDER_CONTRACT_SOURCE_REVISION"),
    runtimeRevision: requiredEnvironment("BRUNO_FOUNDER_CONTRACT_RUNTIME_REVISION"),
    mode: requiredModeEnvironment("BRUNO_FOUNDER_CONTRACT_MODE"),
    token: requiredEnvironment("BRUNO_FOUNDER_CONTRACT_GITHUB_TOKEN"),
  });
  console.info(
    `Founder Product Contract candidate history verified (${result.priorSuccessfulRuns} prior successful run(s)).`,
  );
}

function requiredModeEnvironment(name: string): "ci" | "release" {
  const value = requiredEnvironment(name);
  if (value !== "ci" && value !== "release") throw new Error(`${name} is invalid.`);
  return value;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
