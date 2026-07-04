"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type ApprovalUiStatus = "pending" | "approved" | "denied";
type ApprovalDecision = Exclude<ApprovalUiStatus, "pending">;

type ApprovalDecisionControlsProps = {
  approvalId: string;
  initialStatus: ApprovalUiStatus;
};

type DecisionState =
  | { status: "idle" }
  | { status: "requesting"; decision: ApprovalDecision }
  | { status: "success"; decision: ApprovalDecision; message: string }
  | { status: "error"; message: string };

type DecisionFailure = {
  message: string;
  resolvedStatus?: ApprovalDecision;
};

export function ApprovalDecisionControls({
  approvalId,
  initialStatus,
}: ApprovalDecisionControlsProps) {
  const router = useRouter();
  const [currentStatus, setCurrentStatus] = useState<ApprovalUiStatus>(initialStatus);
  const [state, setState] = useState<DecisionState>({ status: "idle" });
  const pending = currentStatus === "pending";
  const requestingDecision = state.status === "requesting" ? state.decision : null;

  async function handleDecision(decision: ApprovalDecision) {
    if (!pending) {
      return;
    }

    if (decision === "denied" && shouldConfirmMobileDeny()) {
      const confirmed = window.confirm("Deny this approval? This cannot be undone.");

      if (!confirmed) {
        return;
      }
    }

    setState({ status: "requesting", decision });

    try {
      const response = await fetch(`/api/approvals/${approvalId}/${decisionRoute(decision)}`, {
        method: "POST",
      });

      if (!response.ok) {
        const failure = await safeFailureMessage(response, decision);

        if (failure.resolvedStatus) {
          setCurrentStatus(failure.resolvedStatus);
          setState({
            status: "success",
            decision: failure.resolvedStatus,
            message: failure.message,
          });
          return;
        }

        setState({ status: "error", message: failure.message });
        return;
      }

      setCurrentStatus(decision);
      setState({ status: "success", decision, message: successMessage(decision) });

      if (!isMobileApprovalViewport()) {
        router.refresh();
      }
    } catch {
      setState({ status: "error", message: genericFailureMessage(decision) });
    }
  }

  return (
    <div className="approval-decision-controls" data-approval-status={currentStatus}>
      <span className="status-pill">{currentStatus}</span>
      {pending ? (
        <div className="approval-actions">
          <button
            className="primary-button"
            type="button"
            disabled={requestingDecision !== null}
            onClick={() => void handleDecision("approved")}
          >
            {requestingDecision === "approved" ? "Approving" : "Approve"}
          </button>
          <button
            className="secondary-button danger-button"
            type="button"
            disabled={requestingDecision !== null}
            onClick={() => void handleDecision("denied")}
          >
            {requestingDecision === "denied" ? "Denying" : "Deny"}
          </button>
        </div>
      ) : (
        <span className="approval-resolved-state" role="status">
          Resolved {currentStatus}. {state.status === "success" ? state.message : ""}
        </span>
      )}
      {state.status === "error" ? (
        <span className="action-message error" role="status">
          {state.message}
        </span>
      ) : null}
    </div>
  );
}

function decisionRoute(decision: ApprovalDecision): "approve" | "deny" {
  return decision === "approved" ? "approve" : "deny";
}

function successMessage(decision: ApprovalDecision): string {
  return decision === "approved" ? "Approval approved." : "Approval denied.";
}

function genericFailureMessage(decision: ApprovalDecision): string {
  return decision === "approved"
    ? "Approval could not be approved."
    : "Approval could not be denied.";
}

async function safeFailureMessage(
  response: Response,
  decision: ApprovalDecision,
): Promise<DecisionFailure> {
  try {
    const body: unknown = await response.json();

    if (isErrorBody(body)) {
      if (body.error?.code === "approval_not_found") {
        return { message: "Approval could not be found." };
      }

      if (body.error?.code === "approval_already_resolved") {
        const resolvedStatus = normalizeResolvedStatus(body.error.status);

        return {
          message: "Approval has already been resolved.",
          ...(resolvedStatus ? { resolvedStatus } : {}),
        };
      }
    }
  } catch {
    // Keep user-facing failures generic when the response is not safe JSON.
  }

  return { message: genericFailureMessage(decision) };
}

function isErrorBody(value: unknown): value is { error?: { code?: unknown; status?: unknown } } {
  return typeof value === "object" && value !== null && "error" in value;
}

function normalizeResolvedStatus(status: unknown): ApprovalDecision | null {
  return status === "approved" || status === "denied" ? status : null;
}

function shouldConfirmMobileDeny(): boolean {
  return isMobileApprovalViewport();
}

function isMobileApprovalViewport(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  return window.matchMedia("(max-width: 720px), (pointer: coarse)").matches;
}
