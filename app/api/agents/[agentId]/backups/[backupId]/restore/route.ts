import { isValidAgentId } from "@/src/server/agents/agent-id";
import {
  restoreBackupForDevelopmentUser,
  type RestoredBackupResponse,
  RestoreBackupPersistenceError,
} from "@/src/server/backups/restore-backup";

type ClientBackupResponse = Omit<RestoredBackupResponse["backup"], "storageUri">;
type ClientRestoredAgentResponse = Pick<
  RestoredBackupResponse["restoredAgent"],
  "id" | "name" | "templateKey" | "templateVersion" | "status" | "createdAt" | "updatedAt"
>;

type RestoreBackupRouteContext = {
  params: Promise<{
    agentId?: string;
    backupId?: string;
  }>;
};

export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: RestoreBackupRouteContext) {
  const params = await context.params;
  const decodedAgentId = decodeUuid(params.agentId ?? "");
  const decodedBackupId = decodeUuid(params.backupId ?? "");

  if (!decodedAgentId.ok) {
    return validationResponse("Agent ID must be a valid UUID.");
  }

  if (!decodedBackupId.ok) {
    return validationResponse("Backup ID must be a valid UUID.");
  }

  try {
    const result = await restoreBackupForDevelopmentUser({
      agentId: decodedAgentId.value,
      backupId: decodedBackupId.value,
    });

    if (result.ok) {
      return Response.json(
        {
          ...result,
          backup: toClientBackupResponse(result.backup),
          restoredAgent: toClientRestoredAgentResponse(result.restoredAgent),
        },
        { status: 201 },
      );
    }

    if (result.reason === "backup_not_found") {
      return Response.json(
        {
          error: {
            code: "backup_not_found",
            message: "Backup could not be found.",
          },
        },
        { status: 404 },
      );
    }

    if (result.reason === "backup_not_restorable") {
      return Response.json(
        {
          error: {
            code: result.reason,
            message: result.message,
          },
          ...(result.backup ? { backup: toClientBackupResponse(result.backup) } : {}),
        },
        { status: 409 },
      );
    }

    return Response.json(
      {
        error: {
          code: result.reason,
          message: result.message,
        },
        ...(result.backup ? { backup: toClientBackupResponse(result.backup) } : {}),
      },
      { status: 500 },
    );
  } catch (error) {
    if (error instanceof RestoreBackupPersistenceError) {
      return Response.json(
        {
          error: {
            code: "backup_restore_failed",
            message: "Backup could not be restored.",
          },
        },
        { status: 500 },
      );
    }

    throw error;
  }
}

function toClientBackupResponse(backup: RestoredBackupResponse["backup"]): ClientBackupResponse {
  return {
    id: backup.id,
    agentId: backup.agentId,
    runnerId: backup.runnerId,
    status: backup.status,
    createdAt: backup.createdAt,
    restoredAt: backup.restoredAt,
  };
}

function toClientRestoredAgentResponse(
  restoredAgent: RestoredBackupResponse["restoredAgent"],
): ClientRestoredAgentResponse {
  return {
    id: restoredAgent.id,
    name: restoredAgent.name,
    templateKey: restoredAgent.templateKey,
    templateVersion: restoredAgent.templateVersion,
    status: restoredAgent.status,
    createdAt: restoredAgent.createdAt,
    updatedAt: restoredAgent.updatedAt,
  };
}

function decodeUuid(value: string):
  | {
      ok: true;
      value: string;
    }
  | {
      ok: false;
    } {
  let decodedValue: string;

  try {
    decodedValue = decodeURIComponent(value).trim();
  } catch (error) {
    if (error instanceof URIError) {
      return { ok: false };
    }

    throw error;
  }

  if (!isValidAgentId(decodedValue)) {
    return { ok: false };
  }

  return {
    ok: true,
    value: decodedValue,
  };
}

function validationResponse(message: string) {
  return Response.json(
    {
      error: {
        code: "validation_failed",
        message,
      },
    },
    {
      status: 400,
    },
  );
}
