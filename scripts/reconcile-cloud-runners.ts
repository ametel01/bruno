import { reconcileExternallyDeletedDigitalOceanRunners } from "@/src/server/runners/runner-placement-verification";

const result = await reconcileExternallyDeletedDigitalOceanRunners();

console.log(
  JSON.stringify(
    {
      event: "digitalocean_runner_reconciliation_completed",
      ...result,
    },
    null,
    2,
  ),
);

if (result.providerCheckFailedRunnerIds.length > 0) {
  process.exitCode = 1;
}
