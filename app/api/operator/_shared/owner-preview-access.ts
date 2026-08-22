import { resolveAuthMode } from "@/src/auth/server-auth-mode";
import {
  type FounderOwnerPreviewAccessRequirement,
  FounderReleaseStageAccessError,
  requireFounderOwnerPreviewAccessForUser,
  requiresFounderReleaseStageAuthority,
} from "@/src/server/founder-product-contract/release-stage-access";

export async function requireFounderOperatorWorkspaceAccess(
  userId: string,
  requirement: FounderOwnerPreviewAccessRequirement,
  dependencies: {
    authMode?: Parameters<typeof requiresFounderReleaseStageAuthority>[0];
    now?: () => Date;
    requireAccess?: typeof requireFounderOwnerPreviewAccessForUser;
  } = {},
): Promise<Response | null> {
  const authMode = dependencies.authMode ?? resolveAuthMode(process.env).mode;
  if (!requiresFounderReleaseStageAuthority(authMode)) return null;
  try {
    await (dependencies.requireAccess ?? requireFounderOwnerPreviewAccessForUser)(
      userId,
      dependencies.now?.() ?? new Date(),
      {},
      requirement,
    );
    return null;
  } catch (error) {
    const response = founderOperatorAccessErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

export function founderOperatorAccessErrorResponse(error: unknown): Response | null {
  if (!(error instanceof FounderReleaseStageAccessError)) return null;
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
