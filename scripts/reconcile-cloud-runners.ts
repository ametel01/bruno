import { reconcileNextRunnerInfrastructure } from "@/src/server/runners/runner-infrastructure-reconciler";

const result = await reconcileNextRunnerInfrastructure();

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

if (["provider_unavailable", "ambiguous_resource"].includes(result.outcome)) {
  process.exitCode = 1;
}
