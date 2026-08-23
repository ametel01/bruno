import { readFile } from "node:fs/promises";

const DECISION_SCHEMA = "bruno.founder-initial-general-release-decision.v1";

export async function assertFounderReleaseDecisionApproved(path: string): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new Error("Founder Initial General Release decision artifact is unavailable.");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !("schemaVersion" in parsed) ||
    parsed.schemaVersion !== DECISION_SCHEMA ||
    !("outcome" in parsed) ||
    parsed.outcome !== "approved"
  ) {
    throw new Error("Founder Initial General Release decision denied this exact candidate.");
  }
}

if (import.meta.main) {
  await assertFounderReleaseDecisionApproved(
    process.argv[2] ?? "founder-contract-artifacts/founder-initial-general-release-decision.json",
  );
}
