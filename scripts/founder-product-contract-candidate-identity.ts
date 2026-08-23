import { createHash } from "node:crypto";

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
