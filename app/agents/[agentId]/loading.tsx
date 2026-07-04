import { ProductShell } from "@/app/_components/product-shell";

export default function AgentDetailLoading() {
  return (
    <ProductShell
      active="agents"
      eyebrow="Agent detail"
      title="Loading agent"
      description="Loading the persisted agent record and activity feed."
    >
      <section
        className="activity-feed-panel activity-loading-state"
        aria-labelledby="agent-activity-loading-title"
      >
        <div className="section-heading">
          <h2 id="agent-activity-loading-title">Activity</h2>
          <span>Loading</span>
        </div>
        <p>Loading activity.</p>
      </section>
    </ProductShell>
  );
}
