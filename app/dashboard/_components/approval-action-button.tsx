"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type ApprovalActionButtonProps = {
  approvalId: string;
};

type ApprovalActionState =
  | { status: "idle" }
  | { status: "requesting" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export function ApprovalActionButton({ approvalId }: ApprovalActionButtonProps) {
  const router = useRouter();
  const [state, setState] = useState<ApprovalActionState>({ status: "idle" });
  const requesting = state.status === "requesting";

  async function handleApprove() {
    setState({ status: "requesting" });

    try {
      const response = await fetch(`/api/approvals/${approvalId}/approve`, {
        method: "POST",
      });

      if (!response.ok) {
        setState({ status: "error", message: await safeFailureMessage(response) });
        return;
      }

      setState({ status: "success", message: "Approval approved." });
      router.refresh();
    } catch {
      setState({ status: "error", message: "Approval could not be approved." });
    }
  }

  return (
    <div className="approval-actions">
      <button
        className="primary-button"
        type="button"
        disabled={requesting}
        onClick={handleApprove}
      >
        {requesting ? "Approving" : "Approve"}
      </button>
      {state.status === "success" || state.status === "error" ? (
        <span
          className={state.status === "error" ? "action-message error" : "action-message"}
          role="status"
        >
          {state.message}
        </span>
      ) : null}
    </div>
  );
}

async function safeFailureMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as {
      error?: {
        code?: unknown;
      };
    };

    if (body.error?.code === "approval_not_found") {
      return "Approval could not be found.";
    }

    if (body.error?.code === "approval_already_resolved") {
      return "Approval has already been resolved.";
    }
  } catch {
    // Keep user-facing failures generic when the response is not safe JSON.
  }

  return "Approval could not be approved.";
}
