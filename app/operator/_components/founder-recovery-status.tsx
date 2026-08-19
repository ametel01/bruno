"use client";

import type { FounderRecoveryDto } from "@/src/server/operators/founder-recovery";

export function FounderRecoveryStatus({
  recovery,
  onAction,
}: {
  recovery?: FounderRecoveryDto | null;
  onAction?: () => void;
}) {
  if (!recovery) return null;
  const action = recovery.state === "needs_you" ? recovery.action : null;
  const automaticRecoveryHidden = recovery.state === "recovering";
  return (
    <aside
      role="status"
      aria-label={`${founderRecoveryLabel(recovery.state)} for ${recovery.capability}`}
      data-recovery-state={recovery.state}
      style={{
        display: "grid",
        gap: "0.45rem",
        marginBlock: "0.75rem",
        padding: "0.75rem 0.9rem",
        border: "1px solid color-mix(in srgb, currentColor 18%, transparent)",
        borderRadius: "0.75rem",
      }}
    >
      <strong>{founderRecoveryLabel(recovery.state)}</strong>
      {!automaticRecoveryHidden ? (
        <span>
          {recovery.message ??
            (recovery.state === "waiting_on_provider"
              ? "Bruno is waiting for the provider. No retry is needed."
              : recovery.state === "outcome_uncertain"
                ? "Bruno could not prove the external outcome. Do not retry it."
                : recovery.state === "recovery_exhausted"
                  ? "Bruno stopped recovery after the bounded safety budget was reached."
                  : recovery.state === "recovering"
                    ? "Bruno is recovering this capability automatically."
                    : "One Founder action is needed to continue.")}
        </span>
      ) : null}
      {recovery.state === "recovery_exhausted" ? (
        <small>
          {recovery.attemptCount} of {recovery.maxAttempts} attempts ·{" "}
          {formatElapsed(recovery.elapsedMs)} of {formatElapsed(recovery.maxElapsedMs)}
        </small>
      ) : null}
      {action ? (
        action.href ? (
          <a href={action.href}>{action.label}</a>
        ) : (
          <button type="button" onClick={onAction} disabled={!onAction}>
            {action.label}
          </button>
        )
      ) : null}
      {recovery.state !== "needs_you" ? (
        <a href={`/operator/troubleshooting?capability=${recovery.capability}`}>
          {recovery.state === "recovery_exhausted" ? "Open Troubleshooting" : "Open Help"}
        </a>
      ) : null}
    </aside>
  );
}

function formatElapsed(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes === 1) return "1 minute";
  return `${minutes} minutes`;
}

function founderRecoveryLabel(state: FounderRecoveryDto["state"]): string {
  return state
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
