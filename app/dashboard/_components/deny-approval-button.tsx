"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type DenyApprovalButtonProps = {
  approvalId: string;
};

type DenyState =
  | { status: "idle" }
  | { status: "requesting" }
  | { status: "completed"; message: string }
  | { status: "error"; message: string };

export function DenyApprovalButton({ approvalId }: DenyApprovalButtonProps) {
  const router = useRouter();
  const [state, setState] = useState<DenyState>({ status: "idle" });

  async function handleDeny() {
    setState({ status: "requesting" });

    try {
      const response = await fetch(`/api/approvals/${approvalId}/deny`, {
        method: "POST",
      });

      if (!response.ok) {
        setState({ status: "error", message: await safeFailureMessage(response) });
        return;
      }

      setState({ status: "completed", message: "Approval denied." });
      router.refresh();
    } catch {
      setState({ status: "error", message: "Approval could not be denied." });
    }
  }

  return (
    <div className="approval-decision-action">
      <button
        className="secondary-button danger-button"
        type="button"
        disabled={state.status === "requesting" || state.status === "completed"}
        onClick={handleDeny}
      >
        {state.status === "requesting" ? "Denying" : "Deny"}
      </button>
      {state.status === "completed" || state.status === "error" ? (
        <span className={`action-message ${state.status}`} role="status">
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

    if (body.error?.code === "approval_already_resolved") {
      return "Approval has already been resolved.";
    }

    if (body.error?.code === "approval_not_found") {
      return "Approval could not be found.";
    }
  } catch {
    // Keep user-facing failures generic when the response is not safe JSON.
  }

  return "Approval could not be denied.";
}
