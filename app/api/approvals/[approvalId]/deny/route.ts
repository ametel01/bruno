import {
  AgentApprovalPersistenceError,
  denyApprovalForDevelopmentUser,
} from "@/src/server/approvals/agent-approvals";

type DenyApprovalRouteContext = {
  params: Promise<{
    approvalId?: string;
  }>;
};

export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: DenyApprovalRouteContext) {
  const params = await context.params;
  const approvalId = params.approvalId ?? "";
  let decodedApprovalId: string;

  try {
    decodedApprovalId = decodeURIComponent(approvalId);
  } catch (error) {
    if (error instanceof URIError) {
      return validationResponse();
    }

    throw error;
  }

  try {
    const result = await denyApprovalForDevelopmentUser(decodedApprovalId);

    if (result.ok) {
      return Response.json(result);
    }

    if (result.reason === "missing_approval_id" || result.reason === "malformed_approval_id") {
      return validationResponse();
    }

    if (result.reason === "approval_not_found") {
      return Response.json(
        {
          error: {
            code: "approval_not_found",
            message: "Approval could not be found.",
          },
        },
        {
          status: 404,
        },
      );
    }

    return Response.json(
      {
        error: {
          code: "approval_already_resolved",
          message: "Approval has already been resolved.",
          status: result.status,
        },
      },
      {
        status: 409,
      },
    );
  } catch (error) {
    if (error instanceof AgentApprovalPersistenceError) {
      return Response.json(
        {
          error: {
            code: "approval_deny_failed",
            message: "Approval could not be denied.",
          },
        },
        {
          status: 500,
        },
      );
    }

    throw error;
  }
}

function validationResponse() {
  return Response.json(
    {
      error: {
        code: "validation_failed",
        message: "Approval ID must be a valid UUID.",
      },
    },
    {
      status: 400,
    },
  );
}
