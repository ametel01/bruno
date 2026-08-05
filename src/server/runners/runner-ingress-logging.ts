import { createAppLogger } from "@/src/server/logging/logger";

export const runnerIngressLogger = createAppLogger("runner.ingress");

export function logRunnerIngress(
  endpoint: "bootstrap_events" | "register" | "heartbeat",
  event: string,
  metadata: Record<string, unknown> = {},
  error?: unknown,
): void {
  if (error !== undefined) {
    runnerIngressLogger.error(event, error, { endpoint, ...metadata });
    return;
  }

  if (
    event.includes("rejected") ||
    event.includes("invalid") ||
    event === "json_parse_failed" ||
    event === "validation_failed"
  ) {
    runnerIngressLogger.warn(event, { endpoint, ...metadata });
    return;
  }

  runnerIngressLogger.info(event, { endpoint, ...metadata });
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
