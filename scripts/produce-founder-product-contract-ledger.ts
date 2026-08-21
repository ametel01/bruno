/**
 * Boundary for the persisted Founder lifecycle producer.
 *
 * This command deliberately does not synthesize lifecycle results. The production
 * application/API producer must be implemented by the lifecycle vertical slices and
 * write the exact-run ledger to BRUNO_FOUNDER_CONTRACT_SCENARIO_LEDGER_PATH after
 * the workflow has bound its run identity and observation instant.
 */

const outputPath = requiredEnvironment("BRUNO_FOUNDER_CONTRACT_SCENARIO_LEDGER_PATH");
requiredEnvironment("BRUNO_FOUNDER_CONTRACT_SOURCE_REVISION");
requiredEnvironment("BRUNO_FOUNDER_CONTRACT_RUN_ID");
requiredEnvironment("BRUNO_FOUNDER_CONTRACT_OBSERVED_AT");
requiredEnvironment("BRUNO_FOUNDER_CONTRACT_SCENARIO_SIGNING_SECRET");

throw new Error(
  `The persisted Founder lifecycle producer is not implemented; no lifecycle evidence was written to ${outputPath}.`,
);

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
