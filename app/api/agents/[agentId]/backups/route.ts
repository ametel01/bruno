import { isValidAgentId } from "@/src/server/agents/agent-id";
import {
  createManualBackupForDevelopmentUser,
  type ManualBackupResponse,
  ManualBackupPersistenceError,
} from "@/src/server/backups/create-backup";

type ClientBackupResponse = Omit<ManualBackupResponse["backup"], "storageUri">;

type AgentBackupsRouteContext = {
  params: Promise<{
    agentId?: string;
  }>;
};

export const dynamic = "force-dynamic";

export async function POST(_request: Request, context: AgentBackupsRouteContext) {
  const params = await context.params;
  const decodedAgentId = decodeAgentId(params.agentId ?? "");

  if (!decodedAgentId.ok) {
    return validationResponse("Agent ID must be a valid UUID.");
  }

  try {
    const result = await createManualBackupForDevelopmentUser({
      agentId: decodedAgentId.value,
    });

    if (result.ok) {
      return Response.json(
        {
          ...result,
          backup: toClientBackupResponse(result.backup),
        },
        { status: 201 },
      );
    }

    if (result.reason === "agent_not_found") {
      return Response.json(
        {
          error: {
            code: "agent_not_found",
            message: "Agent could not be found.",
          },
        },
        { status: 404 },
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
    if (error instanceof ManualBackupPersistenceError) {
      return Response.json(
        {
          error: {
            code: "backup_create_failed",
            message: "Manual backup could not be created.",
          },
        },
        { status: 500 },
      );
    }

    throw error;
  }
}

function toClientBackupResponse(backup: ManualBackupResponse["backup"]): ClientBackupResponse {
  return {
    id: backup.id,
    agentId: backup.agentId,
    runnerId: backup.runnerId,
    status: backup.status,
    createdAt: backup.createdAt,
    restoredAt: backup.restoredAt,
  };
}

function decodeAgentId(agentId: string):
  | {
      ok: true;
      value: string;
    }
  | {
      ok: false;
    } {
  let decodedAgentId: string;

  try {
    decodedAgentId = decodeURIComponent(agentId).trim();
  } catch (error) {
    if (error instanceof URIError) {
      return { ok: false };
    }

    throw error;
  }

  if (!isValidAgentId(decodedAgentId)) {
    return { ok: false };
  }

  return {
    ok: true,
    value: decodedAgentId,
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
