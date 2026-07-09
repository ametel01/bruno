type AgentWithAssignedRunnerStatus = {
  assignedRunnerKind?: string | null;
  assignedRunnerStatus?: string | null;
  assignedRunnerProvisioningStatus?: string | null;
};

export function listedAgentStartDisabledReason(
  agent: AgentWithAssignedRunnerStatus,
): string | null {
  if (!agent.assignedRunnerStatus) {
    return null;
  }

  if (
    agent.assignedRunnerStatus === "online" &&
    (agent.assignedRunnerKind !== "digitalocean" ||
      agent.assignedRunnerProvisioningStatus === "ready")
  ) {
    return null;
  }

  return "Assigned runner is not fully ready yet.";
}
