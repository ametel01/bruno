import { readFile } from "node:fs/promises";
import { persistProtectedFounderGeneralReleaseDecisionForOwner } from "@/src/server/founder-product-contract/general-release-authority";

export async function importFounderGeneralReleaseDecision(
  artifactPath = "founder-contract-artifacts/founder-initial-general-release-decision.json",
  dependencies: {
    env?: Record<string, string | undefined>;
    now?: () => Date;
    readArtifact?: typeof readFile;
    persistDecision?: typeof persistProtectedFounderGeneralReleaseDecisionForOwner;
  } = {},
): Promise<string> {
  const env = dependencies.env ?? process.env;
  const ownerUserId = requiredEnvironment("BRUNO_FOUNDER_RELEASE_DECISION_OWNER_USER_ID", env);
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(ownerUserId)
  ) {
    throw new Error("BRUNO_FOUNDER_RELEASE_DECISION_OWNER_USER_ID must be a UUID.");
  }
  const rawDecision = await (dependencies.readArtifact ?? readFile)(artifactPath, "utf8");
  return (dependencies.persistDecision ?? persistProtectedFounderGeneralReleaseDecisionForOwner)(
    ownerUserId,
    rawDecision,
    { env, now: dependencies.now?.() ?? new Date() },
  );
}

if (import.meta.main) {
  const artifactPath =
    process.argv[2] ?? "founder-contract-artifacts/founder-initial-general-release-decision.json";
  const decisionId = await importFounderGeneralReleaseDecision(artifactPath);
  console.info(JSON.stringify({ imported: true, decisionId }));
}

function requiredEnvironment(name: string, env: Record<string, string | undefined>): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
