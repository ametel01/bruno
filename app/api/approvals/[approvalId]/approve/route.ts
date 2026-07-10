import {
  AgentApprovalPersistenceError,
  approvePendingApprovalForUser,
} from "@/src/server/approvals/agent-approvals";
import {
  type ConfiguredApplicationUserResolution,
  requireConfiguredApplicationUser,
} from "@/src/server/users/configured-application-user";

type ApproveApprovalRouteContext = {
  params: Promise<{
    approvalId?: string;
  }>;
};

type ApproveApprovalRouteDependencies = {
  requireApplicationUser?: typeof requireConfiguredApplicationUser;
};

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: ApproveApprovalRouteContext,
  dependencies: ApproveApprovalRouteDependencies = {},
) {
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
    const applicationUser = await (
      dependencies.requireApplicationUser ?? requireConfiguredApplicationUser
    )();

    if (!applicationUser.ok) {
      return authenticationResponse(applicationUser);
    }

    const result = await approvePendingApprovalForUser(applicationUser.userId, decodedApprovalId);

    if (result.ok) {
      const { resolvedBy: _resolvedBy, ...approval } = result.approval;
      return Response.json({ ...result, approval });
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
            code: "approval_approve_failed",
            message: "Approval could not be approved.",
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

function authenticationResponse(
  result: Exclude<ConfiguredApplicationUserResolution, { ok: true }>,
) {
  return Response.json(
    {
      error: {
        code: result.code,
        message:
          result.status === 401
            ? "Authentication is required."
            : "Authentication is not configured safely.",
      },
    },
    { status: result.status },
  );
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
