import { resolveAuthMode } from "@/src/auth/server-auth-mode";
import {
  FounderReleaseStageAccessError,
  type FounderOwnerPreviewAccessRequirement,
  requireFounderOwnerPreviewAccessForUser,
} from "@/src/server/founder-product-contract/release-stage-access";

export async function requireFounderOperatorWorkspaceAccess(
  userId: string,
  requirement: FounderOwnerPreviewAccessRequirement,
): Promise<Response | null> {
  if (resolveAuthMode(process.env).mode !== "clerk") return null;
  try {
    await requireFounderOwnerPreviewAccessForUser(userId, new Date(), {}, requirement);
    return null;
  } catch (error) {
    if (!(error instanceof FounderReleaseStageAccessError)) throw error;
    return Response.json(
      {
        error: {
          code: error.code,
          message:
            "Owner Preview is unavailable until exact-revision admission and current Recovery Archive protection are verified.",
        },
      },
      { status: error.status, headers: { "Cache-Control": "no-store" } },
    );
  }
}
