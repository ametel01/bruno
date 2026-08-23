import { readFile } from "node:fs/promises";
import {
  FOUNDER_GENERAL_RELEASE_DECISION_ENV,
  readFounderGeneralReleaseDecisionAuthority,
} from "@/scripts/founder-general-release-decision-authority";

export async function assertFounderReleaseDecisionApproved(
  path: string,
  env: Record<string, string | undefined> = process.env,
  now = new Date(),
): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new Error("Founder Initial General Release decision artifact is unavailable.");
  }
  const authority = readFounderGeneralReleaseDecisionAuthority(
    { ...env, [FOUNDER_GENERAL_RELEASE_DECISION_ENV]: raw },
    now,
  );
  if (!authority.approved) {
    throw new Error("Founder Initial General Release decision denied this exact candidate.");
  }
}

if (import.meta.main) {
  await assertFounderReleaseDecisionApproved(
    process.argv[2] ?? "founder-contract-artifacts/founder-initial-general-release-decision.json",
  );
}
