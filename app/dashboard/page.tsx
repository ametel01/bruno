import { EmptyState, PlaceholderPanel, ProductShell } from "@/app/_components/product-shell";

type DashboardContentProps = {
  routeLabel?: string;
};

export default function DashboardPage() {
  return <DashboardContent />;
}

export function DashboardContent({ routeLabel = "Dashboard" }: DashboardContentProps) {
  return (
    <ProductShell
      active="dashboard"
      eyebrow={routeLabel}
      title="Operational dashboard"
      description="A Milestone 0 control surface for viewing AgentBay readiness without agent records or lifecycle actions."
    >
      <div className="content-grid">
        <EmptyState
          title="No agents configured"
          description="Agent inventory, run state, activity, approvals, and logs are intentionally absent until later milestones add the backing domain model."
        />
        <PlaceholderPanel title="Readiness">
          <dl className="definition-list">
            <div>
              <dt>Product routes</dt>
              <dd>Dashboard, agents, settings, and health skeletons are present.</dd>
            </div>
            <div>
              <dt>Database check</dt>
              <dd>The `/health` endpoint remains the operator source for database reachability.</dd>
            </div>
            <div>
              <dt>Agent data</dt>
              <dd>No persisted agent table or records are queried in this milestone.</dd>
            </div>
          </dl>
        </PlaceholderPanel>
        <PlaceholderPanel title="Upcoming surfaces">
          <ul className="plain-list">
            <li>Agent creation and templates wait for Milestone 1.</li>
            <li>Lifecycle controls, approvals, and logs wait for the domain model.</li>
            <li>Runner provisioning and external integrations are placeholders only.</li>
          </ul>
        </PlaceholderPanel>
      </div>
    </ProductShell>
  );
}
