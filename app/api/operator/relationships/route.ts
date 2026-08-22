import { requireFounderOperatorWorkspaceAccess } from "@/app/api/operator/_shared/owner-preview-access";
import {
  confirmFounderRelationshipCandidateForUser,
  FounderRelationshipsError,
  getFounderRelationshipsForUser,
  ingestFounderRelationshipEvidenceForUser,
  rejectFounderRelationshipCandidateForUser,
  type FounderRelationshipObservation,
  updateFounderRelationshipRecordForUser,
} from "@/src/server/operators/founder-relationships";
import { requireConfiguredApplicationUser } from "@/src/server/users/configured-application-user";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const applicationUser = await requireConfiguredApplicationUser();
  if (!applicationUser.ok) return authenticationResponse(applicationUser.status);
  const accessFailure = await requireFounderOperatorWorkspaceAccess(applicationUser.userId);
  if (accessFailure) return accessFailure;
  try {
    const relationships = await getFounderRelationshipsForUser(applicationUser.userId);
    return Response.json({ relationships }, { headers: noStoreHeaders() });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  const applicationUser = await requireConfiguredApplicationUser();
  if (!applicationUser.ok) return authenticationResponse(applicationUser.status);
  const accessFailure = await requireFounderOperatorWorkspaceAccess(applicationUser.userId);
  if (accessFailure) return accessFailure;
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return validationResponse("Request body must be valid JSON.");
  }
  if (!isRecord(payload) || typeof payload.action !== "string") {
    return validationResponse("Choose a supported Relationship Record action.");
  }
  try {
    if (payload.action === "ingest_evidence") {
      const observations = readObservations(payload.observations);
      if (!observations.ok) return validationResponse(observations.message);
      const relationships = await ingestFounderRelationshipEvidenceForUser(
        applicationUser.userId,
        observations.value,
      );
      return Response.json({ relationships }, { headers: noStoreHeaders() });
    }
    if (payload.action === "confirm_candidate") {
      const candidateId = readId(payload.candidateId);
      if (!candidateId) return validationResponse("Relationship Candidate is required.");
      const relationships = await confirmFounderRelationshipCandidateForUser(
        applicationUser.userId,
        candidateId,
      );
      return Response.json({ relationships }, { headers: noStoreHeaders() });
    }
    if (payload.action === "reject_candidate") {
      const candidateId = readId(payload.candidateId);
      if (!candidateId) return validationResponse("Relationship Candidate is required.");
      const relationships = await rejectFounderRelationshipCandidateForUser(
        applicationUser.userId,
        candidateId,
      );
      return Response.json({ relationships }, { headers: noStoreHeaders() });
    }
    if (payload.action === "update_record") {
      const recordId = readId(payload.recordId);
      if (!recordId) return validationResponse("Relationship Record is required.");
      const patch = readRecordPatch(payload);
      if (!patch.ok) return validationResponse(patch.message);
      const relationships = await updateFounderRelationshipRecordForUser(
        applicationUser.userId,
        recordId,
        patch.value,
      );
      return Response.json({ relationships }, { headers: noStoreHeaders() });
    }
  } catch (error) {
    return errorResponse(error);
  }
  return validationResponse("Choose a supported Relationship Record action.");
}

function readObservations(
  value: unknown,
): { ok: true; value: FounderRelationshipObservation[] } | { ok: false; message: string } {
  if (!Array.isArray(value) || value.length > 100)
    return { ok: false, message: "Evidence must be a list of at most 100 observations." };
  const observations: FounderRelationshipObservation[] = [];
  for (const item of value) {
    if (!isRecord(item))
      return { ok: false, message: "Each evidence observation must be an object." };
    const sourceKind =
      item.sourceKind === "calendar" || item.sourceKind === "mail" ? item.sourceKind : null;
    const connectionId = readId(item.connectionId);
    const provider = readId(item.provider);
    const providerItemId = readId(item.providerItemId);
    const observedAt = typeof item.observedAt === "string" ? new Date(item.observedAt) : null;
    if (
      !sourceKind ||
      !connectionId ||
      !provider ||
      !providerItemId ||
      !observedAt ||
      Number.isNaN(observedAt.getTime())
    )
      return { ok: false, message: "Evidence needs a source, item identity, and valid timestamp." };
    for (const field of [
      "providerIdentity",
      "email",
      "displayName",
      "company",
      "domain",
      "excerpt",
    ] as const) {
      if (item[field] !== undefined && item[field] !== null && typeof item[field] !== "string")
        return { ok: false, message: `Evidence ${field} must be text.` };
    }
    observations.push({
      sourceKind,
      connectionId,
      provider,
      providerItemId,
      providerIdentity: readNullableText(item.providerIdentity) ?? null,
      email: readNullableText(item.email) ?? null,
      displayName: readNullableText(item.displayName) ?? null,
      company: readNullableText(item.company) ?? null,
      domain: readNullableText(item.domain) ?? null,
      excerpt: readNullableText(item.excerpt) ?? null,
      observedAt,
    });
  }
  return { ok: true, value: observations };
}

function readNullableText(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" || value === null ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readOptionalText(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === "string" ? value : null;
}

function readOptionalEnum<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
): T[number] | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" && allowed.includes(value) ? (value as T[number]) : undefined;
}

function readOptionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function readRecordPatch(
  payload: Record<string, unknown>,
):
  | { ok: true; value: Parameters<typeof updateFounderRelationshipRecordForUser>[2] }
  | { ok: false; message: string } {
  const value: Parameters<typeof updateFounderRelationshipRecordForUser>[2] = {};
  if (payload.relationshipState !== undefined) {
    const state = readOptionalEnum(payload.relationshipState, [
      "lead",
      "client",
      "partner",
      "ignored",
    ] as const);
    if (!state) return { ok: false, message: "Choose a supported relationship state." };
    value.relationshipState = state;
  }
  if (payload.status !== undefined) {
    const status = readOptionalEnum(payload.status, ["active", "closed", "ignored"] as const);
    if (!status) return { ok: false, message: "Choose a supported Relationship Record status." };
    value.status = status;
  }
  if (payload.nextAction !== undefined) {
    const nextAction = readOptionalText(payload.nextAction);
    if (payload.nextAction !== null && typeof payload.nextAction !== "string")
      return { ok: false, message: "Next action must be text." };
    value.nextAction = nextAction ?? null;
  }
  if (payload.nextActionDueAt !== undefined) {
    const nextActionDueAt = readOptionalText(payload.nextActionDueAt);
    if (payload.nextActionDueAt !== null && typeof payload.nextActionDueAt !== "string")
      return { ok: false, message: "Next action date must be text." };
    value.nextActionDueAt = nextActionDueAt ?? null;
  }
  if (payload.commitments !== undefined) {
    const commitments = readOptionalStringArray(payload.commitments);
    if (!commitments) return { ok: false, message: "Commitments must be a list of text." };
    value.commitments = commitments;
  }
  return { ok: true, value };
}

function authenticationResponse(status: 401 | 503): Response {
  return Response.json(
    {
      error: {
        code: status === 401 ? "unauthenticated" : "auth_configuration_unavailable",
        message:
          status === 401
            ? "Authentication is required."
            : "Authentication is not configured safely.",
      },
    },
    { status, headers: noStoreHeaders() },
  );
}

function validationResponse(message: string): Response {
  return Response.json(
    { error: { code: "validation_failed", message } },
    { status: 400, headers: noStoreHeaders() },
  );
}

function errorResponse(error: unknown): Response {
  if (error instanceof FounderRelationshipsError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status, headers: noStoreHeaders() },
    );
  }
  throw error;
}

function noStoreHeaders(): HeadersInit {
  return { "Cache-Control": "no-store" };
}
