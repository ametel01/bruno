import { PlaceholderPanel, ProductShell } from "@/app/_components/product-shell";

type AgentDetailPageProps = {
  params: Promise<{
    agentId: string;
  }>;
};

export default async function AgentDetailPage({ params }: AgentDetailPageProps) {
  const { agentId } = await params;
  const decodedAgentId = decodeURIComponent(agentId);

  return (
    <ProductShell
      active="agents"
      eyebrow="Agent placeholder"
      title={decodedAgentId}
      description="This detail route accepts arbitrary IDs for routing validation without reading from an agents database table."
    >
      <div className="content-grid">
        <PlaceholderPanel title="Placeholder detail">
          <p>
            No record lookup is performed for this ID. Lifecycle state, logs, approvals, secrets,
            runner assignment, and provisioning controls are intentionally unavailable.
          </p>
        </PlaceholderPanel>
        <PlaceholderPanel title="Route contract">
          <dl className="definition-list">
            <div>
              <dt>Requested ID</dt>
              <dd>{decodedAgentId}</dd>
            </div>
            <div>
              <dt>Data source</dt>
              <dd>None in Milestone 0.</dd>
            </div>
          </dl>
        </PlaceholderPanel>
      </div>
    </ProductShell>
  );
}
