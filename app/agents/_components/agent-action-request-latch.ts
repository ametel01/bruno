export type AgentActionRequestLatch = {
  current: boolean;
};

export function acquireAgentActionRequestLatch(latch: AgentActionRequestLatch): boolean {
  if (latch.current) {
    return false;
  }

  latch.current = true;
  return true;
}

export function releaseAgentActionRequestLatch(latch: AgentActionRequestLatch): void {
  latch.current = false;
}
