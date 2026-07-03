import { EmptyState, PlaceholderPanel, ProductShell } from "@/app/_components/product-shell";

export default function AgentsPage() {
  return (
    <ProductShell
      active="agents"
      eyebrow="Agents"
      title="Agent inventory"
      description="This route establishes the inventory surface without creating, listing, or persisting agent records."
    >
      <div className="content-grid">
        <EmptyState
          title="No agent records"
          description="The list is empty because AgentBay has not introduced agent persistence, template selection, lifecycle actions, or runner assignment."
          actionLabel="Create agent in Milestone 1"
        />
        <PlaceholderPanel title="Inventory model">
          <p>
            Future rows will appear here after the product adds an agent table and the workflows
            that create records. Milestone 0 keeps this route read-only and data-free.
          </p>
        </PlaceholderPanel>
      </div>
    </ProductShell>
  );
}
