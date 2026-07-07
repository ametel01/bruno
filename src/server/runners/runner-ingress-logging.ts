export function logRunnerIngress(
  endpoint: "bootstrap_events" | "register" | "heartbeat",
  event: string,
  metadata: Record<string, unknown> = {},
): void {
  console.info("[agentbay] runner.ingress", { endpoint, event, ...metadata });
}

export function validationIssueSummary(issues: Array<{ field: string; message: string }>) {
  return {
    issueCount: issues.length,
    issueFields: [...new Set(issues.map((issue) => issue.field))].sort(),
  };
}

export function safeHostname(value: string): string | null {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
}

export function readPayloadRunnerId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const runnerId = (payload as Record<string, unknown>).runnerId;

  return typeof runnerId === "string" && runnerId.trim() ? runnerId.trim() : null;
}
