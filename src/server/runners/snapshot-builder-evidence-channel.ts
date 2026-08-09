import "server-only";

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  DigitalOceanProviderRequestContext,
  DigitalOceanProviderResult,
  DigitalOceanReadSnapshotBuilderEvidenceInput,
  DigitalOceanSnapshotBuilderEvidence,
} from "./digitalocean-provider";

export const SNAPSHOT_BUILDER_EVIDENCE_CONTRACT_VERSION =
  "bruno.runner.snapshot-builder-evidence.v1";
export const SNAPSHOT_BUILDER_EVIDENCE_COMMENT_MARKER =
  "<!-- bruno.runner.snapshot-builder-evidence.v1 -->";

export type SnapshotBuilderEvidencePublisher = {
  token: string;
  repository: string;
  issueNumber: number;
  runId: string;
  nonce: string;
  authenticationSecret: string;
  apiUrl: string;
};

type EvidenceChannelInput = {
  token: string;
  repository: string;
  issueNumber: number;
  runId: string;
  nonce?: string;
  authenticationSecret?: string;
  apiUrl?: string;
  fetch?: typeof fetch;
};

type GitHubIssueComment = {
  id?: unknown;
  html_url?: unknown;
  body?: unknown;
  user?: { login?: unknown } | null;
};

type CompletedEvidencePayload = {
  contractVersion: string;
  repository: string;
  issueNumber: number;
  runId: string;
  nonce: string;
  stage: "complete";
  builderResourceId: string;
  bootResult: unknown;
  sanitationResult: unknown;
  authenticationTag: string;
};

export function createSnapshotBuilderEvidenceChannel(input: EvidenceChannelInput): {
  publisher: SnapshotBuilderEvidencePublisher;
  read: (
    input: DigitalOceanReadSnapshotBuilderEvidenceInput,
    context?: DigitalOceanProviderRequestContext,
  ) => Promise<DigitalOceanProviderResult<DigitalOceanSnapshotBuilderEvidence>>;
} {
  const publisher = validatePublisher({
    token: input.token,
    repository: input.repository,
    issueNumber: input.issueNumber,
    runId: input.runId,
    nonce: input.nonce ?? randomUUID(),
    authenticationSecret: input.authenticationSecret ?? randomBytes(32).toString("hex"),
    apiUrl: input.apiUrl ?? "https://api.github.com",
  });
  const fetchImpl = input.fetch ?? fetch;

  return {
    publisher,
    read: async (evidenceInput, context = { signal: new AbortController().signal }) => {
      if (context.signal.aborted) return evidenceNotReady();

      try {
        const response = await fetchImpl(
          `${publisher.apiUrl}/repos/${publisher.repository}/issues/${publisher.issueNumber}/comments?per_page=100&sort=created&direction=desc`,
          {
            method: "GET",
            headers: {
              Accept: "application/vnd.github+json",
              Authorization: `Bearer ${publisher.token}`,
              "X-GitHub-Api-Version": "2022-11-28",
            },
            signal: context.signal,
          },
        );
        if (!response.ok) return evidenceNotReady();
        const comments: unknown = await response.json();
        if (!Array.isArray(comments)) return evidenceNotReady();

        const matches = comments.flatMap((comment) => {
          const parsed = parseCompletedComment(
            comment,
            publisher,
            evidenceInput.providerResourceId,
          );
          return parsed ? [parsed] : [];
        });
        if (matches.length !== 1) return evidenceNotReady();
        const match = matches[0];
        if (!match) return evidenceNotReady();

        return {
          ok: true,
          value: {
            bootResult: match.payload.bootResult,
            sanitationResult: match.payload.sanitationResult,
            sourceUrl: match.sourceUrl,
          },
        };
      } catch {
        return evidenceNotReady();
      }
    },
  };
}

function validatePublisher(
  input: SnapshotBuilderEvidencePublisher,
): SnapshotBuilderEvidencePublisher {
  if (!input.token.trim()) throw new Error("Snapshot builder evidence token is required.");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository)) {
    throw new Error("Snapshot builder evidence repository is invalid.");
  }
  if (!Number.isSafeInteger(input.issueNumber) || input.issueNumber < 1) {
    throw new Error("Snapshot builder evidence issue number is invalid.");
  }
  if (!/^[1-9][0-9]{0,18}$/.test(input.runId)) {
    throw new Error("Snapshot builder evidence run ID is invalid.");
  }
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(input.nonce)) {
    throw new Error("Snapshot builder evidence nonce is invalid.");
  }
  if (!/^[a-f0-9]{64}$/.test(input.authenticationSecret)) {
    throw new Error("Snapshot builder evidence authentication secret is invalid.");
  }
  const apiUrl = new URL(input.apiUrl);
  if (
    apiUrl.protocol !== "https:" ||
    apiUrl.username ||
    apiUrl.password ||
    apiUrl.search ||
    apiUrl.hash
  ) {
    throw new Error("Snapshot builder evidence API URL is invalid.");
  }

  return { ...input, apiUrl: apiUrl.href.replace(/\/$/, "") };
}

function parseCompletedComment(
  value: unknown,
  expected: SnapshotBuilderEvidencePublisher,
  providerResourceId: string,
): { payload: CompletedEvidencePayload; sourceUrl: string } | null {
  const comment = value as GitHubIssueComment;
  if (
    !comment ||
    typeof comment !== "object" ||
    comment.user?.login !== "github-actions[bot]" ||
    typeof comment.body !== "string" ||
    typeof comment.html_url !== "string"
  ) {
    return null;
  }
  const prefix = `${SNAPSHOT_BUILDER_EVIDENCE_COMMENT_MARKER}\n`;
  if (!comment.body.startsWith(prefix)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(comment.body.slice(prefix.length));
  } catch {
    return null;
  }
  if (!isRecord(payload)) return null;
  if (
    payload.contractVersion !== SNAPSHOT_BUILDER_EVIDENCE_CONTRACT_VERSION ||
    payload.repository !== expected.repository ||
    payload.issueNumber !== expected.issueNumber ||
    payload.runId !== expected.runId ||
    payload.nonce !== expected.nonce ||
    payload.stage !== "complete" ||
    payload.builderResourceId !== providerResourceId ||
    !isRecord(payload.bootResult) ||
    !isRecord(payload.sanitationResult) ||
    typeof payload.authenticationTag !== "string" ||
    !authenticationTagMatches(payload, expected.authenticationSecret)
  ) {
    return null;
  }

  const expectedUrlPrefix = `https://github.com/${expected.repository}/issues/${expected.issueNumber}#issuecomment-`;
  if (!comment.html_url.startsWith(expectedUrlPrefix)) return null;

  return {
    payload: payload as CompletedEvidencePayload,
    sourceUrl: comment.html_url,
  };
}

function authenticationTagMatches(
  payload: Record<string, unknown>,
  authenticationSecret: string,
): boolean {
  const { authenticationTag, ...unsignedPayload } = payload;
  if (typeof authenticationTag !== "string" || !/^[a-f0-9]{64}$/.test(authenticationTag)) {
    return false;
  }
  const expected = createHmac("sha256", Buffer.from(authenticationSecret, "hex"))
    .update(canonicalJson(unsignedPayload))
    .digest();
  const actual = Buffer.from(authenticationTag, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined)
    throw new Error("Snapshot builder evidence was not JSON serializable.");
  return encoded;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function evidenceNotReady(): DigitalOceanProviderResult<DigitalOceanSnapshotBuilderEvidence> {
  return {
    ok: false,
    reason: "builder_evidence_not_ready",
    message: "Snapshot builder evidence is not ready yet.",
  };
}
