import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { assertFounderReleaseDecisionApproved } from "@/scripts/assert-founder-release-decision";

const GITHUB_API_ORIGIN = "https://api.github.com";
export const FOUNDER_RELEASE_CANDIDATE_CONTROL_NAME_PREFIX =
  "Founder protected release candidate run " as const;

export function founderReleaseCandidateControlName(runId: number): string {
  if (!Number.isSafeInteger(runId) || runId < 1) {
    throw new Error("Founder release candidate control identity is invalid.");
  }
  return `${FOUNDER_RELEASE_CANDIDATE_CONTROL_NAME_PREFIX}${runId}`;
}

export function founderReleaseCandidateControlKey(
  sourceRevision: string,
  runtimeRevision: string,
): string {
  const runtimeDigest = createHash("sha256").update(runtimeRevision).digest("hex");
  return `bruno-founder-release:${sourceRevision}:${runtimeDigest}`;
}

export async function createFounderReleaseCandidateControl(input: {
  repository: string;
  sourceRevision: string;
  runtimeRevision: string;
  runId: number;
  token: string;
  request?: typeof fetch;
}): Promise<{ checkRunId: number; externalId: string }> {
  assertCandidateInput(input);
  const externalId = founderReleaseCandidateControlKey(input.sourceRevision, input.runtimeRevision);
  const name = founderReleaseCandidateControlName(input.runId);
  const response = await (input.request ?? fetch)(
    new URL(`/repos/${input.repository}/check-runs`, GITHUB_API_ORIGIN),
    {
      method: "POST",
      headers: githubHeaders(input.token),
      body: JSON.stringify({
        name,
        head_sha: input.sourceRevision,
        status: "in_progress",
        external_id: externalId,
        details_url: `https://github.com/${input.repository}/actions/runs/${input.runId}`,
        output: {
          title: name,
          summary:
            "Durable source and protected-runtime control record. It contains no provider or Founder evidence.",
        },
      }),
    },
  );
  if (!response.ok) throw new Error("Founder release candidate control could not be created.");
  const value = (await response.json()) as unknown;
  if (!isRecord(value) || !Number.isSafeInteger(value.id)) {
    throw new Error("Founder release candidate control response is invalid.");
  }
  return { checkRunId: value.id as number, externalId };
}

export async function finalizeFounderReleaseCandidateControl(input: {
  repository: string;
  checkRunId: number;
  decisionPath: string;
  priorJobStatus: string;
  token: string;
  request?: typeof fetch;
  env?: Record<string, string | undefined>;
  now?: Date;
}): Promise<void> {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository) ||
    !Number.isSafeInteger(input.checkRunId) ||
    input.checkRunId < 1 ||
    !input.decisionPath ||
    !input.priorJobStatus ||
    !input.token
  ) {
    throw new Error("Founder release candidate control identity is invalid.");
  }
  let decisionApproved = false;
  try {
    await assertFounderReleaseDecisionApproved(
      input.decisionPath,
      input.env ?? process.env,
      input.now ?? new Date(),
    );
    decisionApproved = true;
  } catch {
    decisionApproved = false;
  }
  const qualified = decisionApproved && input.priorJobStatus === "success";
  const response = await (input.request ?? fetch)(
    new URL(`/repos/${input.repository}/check-runs/${input.checkRunId}`, GITHUB_API_ORIGIN),
    {
      method: "PATCH",
      headers: githubHeaders(input.token),
      body: JSON.stringify({
        status: "completed",
        conclusion: qualified ? "success" : "failure",
        completed_at: (input.now ?? new Date()).toISOString(),
        output: {
          title: qualified
            ? "Founder release candidate approved"
            : "Founder release candidate blocked",
          summary: qualified
            ? "The retained Initial General Release decision approved this exact candidate."
            : "This exact source and protected-runtime candidate is terminally blocked.",
        },
      }),
    },
  );
  if (!response.ok) throw new Error("Founder release candidate control could not be finalized.");
  if (!qualified) {
    throw new Error("Founder Initial General Release decision denied this exact candidate.");
  }
}

function assertCandidateInput(input: {
  repository: string;
  sourceRevision: string;
  runtimeRevision: string;
  runId: number;
  token: string;
}): void {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository) ||
    !/^[a-f0-9]{40}$/.test(input.sourceRevision) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$/.test(input.runtimeRevision) ||
    !Number.isSafeInteger(input.runId) ||
    input.runId < 1 ||
    !input.token
  ) {
    throw new Error("Founder release candidate control identity is invalid.");
  }
}

function githubHeaders(token: string): Record<string, string> {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.main) {
  const operation = process.argv[2];
  const repository = requiredEnvironment("GITHUB_REPOSITORY");
  const token = requiredEnvironment("BRUNO_FOUNDER_CONTRACT_GITHUB_TOKEN");
  if (operation === "create") {
    const result = await createFounderReleaseCandidateControl({
      repository,
      sourceRevision: requiredEnvironment("BRUNO_FOUNDER_CONTRACT_SOURCE_REVISION"),
      runtimeRevision: requiredEnvironment("BRUNO_FOUNDER_CONTRACT_RUNTIME_REVISION"),
      runId: Number(requiredEnvironment("GITHUB_RUN_ID")),
      token,
    });
    await appendFile(requiredEnvironment("GITHUB_OUTPUT"), `check_run_id=${result.checkRunId}\n`);
  } else if (operation === "finalize") {
    await finalizeFounderReleaseCandidateControl({
      repository,
      checkRunId: Number(requiredEnvironment("BRUNO_FOUNDER_CANDIDATE_CHECK_RUN_ID")),
      decisionPath:
        process.env.BRUNO_FOUNDER_RELEASE_DECISION_PATH ??
        "founder-contract-artifacts/founder-initial-general-release-decision.json",
      priorJobStatus: requiredEnvironment("BRUNO_FOUNDER_PRIOR_JOB_STATUS"),
      token,
    });
  } else {
    throw new Error("Founder release candidate control operation is invalid.");
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
