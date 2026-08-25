import type { FounderExternalBetaManifestStatus } from "@/src/server/founder-product-contract/external-beta-manifest";

export function FounderExternalBetaManifest({
  status,
}: {
  status: FounderExternalBetaManifestStatus;
}) {
  const available = status.capabilities.filter((capability) => capability.state === "available");
  const paused = status.capabilities.filter((capability) => capability.state === "paused");
  return (
    <section aria-labelledby="external-beta-capabilities-title">
      <p>{status.stage}</p>
      <h3 id="external-beta-capabilities-title">Your available capabilities</h3>
      <p>
        {status.state === "ready"
          ? "All External Beta capabilities are available."
          : status.state === "limited"
            ? "Some work is paused while its connection is checked."
            : "External Beta capabilities are still being checked."}
      </p>
      <dl>
        {status.capabilities.map((capability) => (
          <div key={capability.name}>
            <dt>{capability.name}</dt>
            <dd>{capability.state === "available" ? "Available" : "Paused"}</dd>
          </div>
        ))}
      </dl>
      <p>{status.providerChoice}. Bruno uses only the provider accounts you connect.</p>
      {available.length > 0 && paused.length > 0 ? <p>{status.workContinuity}.</p> : null}
    </section>
  );
}
