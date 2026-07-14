import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAgentForDevelopmentUser } from "@/src/server/agents/create-agent";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { agentLogs } from "@/src/server/db/schema";
import {
  DEFAULT_MANUAL_RUNNER_TIMEOUT_MS,
  ManualRunnerAdapter,
  RUNNER_BEARER_TOKEN_ENV,
} from "@/src/server/runners/manual-runner-adapter";
import { sampleLaunchSpec } from "@/tests/helpers/agent-launch-spec";
import { DOCKER_CLI_TIMEOUT_MS } from "@/src/runner-service/constants";
import {
  assignRunnerToActiveAgentForDevelopmentUser,
  bootstrapManualRunnerForDevelopmentUser,
  type ManualRunnerRecord,
} from "@/src/server/runners/manual-runner-persistence";
import { fingerprintRunnerSecret } from "@/src/server/runners/runner-auth-secrets";

describe("ManualRunnerAdapter dashboard HTTP contract", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await resetTables(connection);
  });

  afterEach(async () => {
    await resetTables(connection);
    await connection.close();
  });

  it("calls start, logs, stop, and restart with bearer auth and persists safe manual logs", async () => {
    const created = await createAgentForDevelopmentUser(
      { name: "Manual Contract Agent", templateKey: "research_agent" },
      { createConnection: () => connection },
    );
    const runner = await createAssignedRunner(created.agent.id, "http://127.0.0.1:9080");
    const launchSpec = sampleLaunchSpec({
      agent: { ...sampleLaunchSpec().agent, id: created.agent.id },
    });
    const requests: Array<{
      authorization: string | null;
      body: string | null;
      contentType: string | null;
      method: string;
      pathname: string;
    }> = [];
    const adapter = new ManualRunnerAdapter(runner, {
      createConnection: () => connection,
      env: { [RUNNER_BEARER_TOKEN_ENV]: "contract-token" },
      fetch: async (input, init) => {
        const url = new URL(String(input));
        requests.push({
          authorization: new Headers(init?.headers).get("authorization"),
          body: typeof init?.body === "string" ? init.body : null,
          contentType: new Headers(init?.headers).get("content-type"),
          method: init?.method ?? "GET",
          pathname: url.pathname,
        });

        if (url.pathname.endsWith("/logs")) {
          return Response.json({
            ok: true,
            agentId: created.agent.id,
            action: "logs",
            container: {
              id: "manual-container-001",
              status: "running",
            },
            logs: [
              {
                source: "hermes_gateway",
                stream: "stdout",
                message: "contract ready OPENROUTER_API_KEY=sk-or-v1-contract",
                createdAt: "2026-07-05T04:00:01.000Z",
                metadata: { logSource: "hermes_gateway" },
              },
              {
                source: "container_bootstrap",
                stream: "stderr",
                message: "contract warn 123456:abcdefghijklmnopqrstuvwxyz",
                createdAt: "2026-07-05T04:00:02.000Z",
                metadata: { logSource: "container_bootstrap" },
              },
            ],
          });
        }

        if (url.pathname.endsWith("/stop")) {
          return Response.json({
            ok: true,
            agentId: created.agent.id,
            action: "stop",
            containers: [{ id: "manual-container-001", status: "exited" }],
          });
        }

        return Response.json({
          ok: true,
          agentId: created.agent.id,
          action: url.pathname.split("/").at(-1),
          container: {
            id: "manual-container-001",
            status: "running",
          },
        });
      },
      now: () => new Date("2026-07-05T04:00:03.000Z"),
      timeoutMs: 250,
    });

    await expect(adapter.start(created.agent.id, launchSpec)).resolves.toMatchObject({
      ok: true,
      container: { id: "manual-container-001", status: "running" },
    });
    await expect(adapter.streamLogs({ agentId: created.agent.id })).resolves.toMatchObject({
      logs: [
        expect.objectContaining({
          source: "hermes_gateway",
          stream: "stdout",
          message: "contract ready OPENROUTER_API_KEY=[redacted-env-value]",
        }),
        expect.objectContaining({
          source: "manual_runner_bootstrap",
          stream: "stderr",
          level: "error",
          message: "contract warn [redacted-telegram-token]",
        }),
      ],
      nextAfter: 2,
    });
    await expect(adapter.stop(created.agent.id)).resolves.toMatchObject({
      ok: true,
      containers: [{ id: "manual-container-001", status: "exited" }],
    });
    await expect(adapter.restart(created.agent.id, launchSpec)).resolves.toMatchObject({
      ok: true,
      container: { id: "manual-container-001", status: "running" },
    });

    expect(requests).toEqual([
      {
        authorization: "Bearer contract-token",
        body: JSON.stringify(launchSpec),
        contentType: "application/json",
        method: "POST",
        pathname: `/runner/v1/agents/${created.agent.id}/start`,
      },
      {
        authorization: "Bearer contract-token",
        body: null,
        contentType: null,
        method: "GET",
        pathname: `/runner/v1/agents/${created.agent.id}/logs`,
      },
      {
        authorization: "Bearer contract-token",
        body: null,
        contentType: null,
        method: "POST",
        pathname: `/runner/v1/agents/${created.agent.id}/stop`,
      },
      {
        authorization: "Bearer contract-token",
        body: JSON.stringify(launchSpec),
        contentType: "application/json",
        method: "POST",
        pathname: `/runner/v1/agents/${created.agent.id}/restart`,
      },
    ]);
    const persistedLogs = await connection.db
      .select()
      .from(agentLogs)
      .where(eq(agentLogs.agentId, created.agent.id))
      .orderBy(agentLogs.sequence);

    expect(persistedLogs).toEqual([
      expect.objectContaining({
        runnerId: runner.id,
        source: "hermes_gateway",
        stream: "stdout",
        message: "contract ready OPENROUTER_API_KEY=[redacted-env-value]",
        sequence: 1,
      }),
      expect.objectContaining({
        runnerId: runner.id,
        source: "manual_runner_bootstrap",
        stream: "stderr",
        level: "error",
        message: "contract warn [redacted-telegram-token]",
        sequence: 2,
      }),
    ]);
    expect(JSON.stringify(persistedLogs)).not.toContain("contract-token");
    expect(JSON.stringify(persistedLogs)).not.toContain("sk-or-v1-contract");
    expect(JSON.stringify(persistedLogs)).not.toContain("123456:abcdefghijklmnopqrstuvwxyz");
  });

  it("requires HTTPS for non-loopback endpoints and fails safely without sending a request", async () => {
    const fetch = vi.fn();
    const adapter = new ManualRunnerAdapter(manualRunner("http://runner.example.com"), {
      env: { [RUNNER_BEARER_TOKEN_ENV]: "contract-token" },
      fetch,
    });

    await expect(adapter.start("00000000-0000-4000-8000-000000000123")).resolves.toEqual({
      ok: false,
      reason: "runner_endpoint_invalid",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails safely when the temporary bearer token is missing", async () => {
    const fetch = vi.fn();
    const adapter = new ManualRunnerAdapter(manualRunner("https://runner.example.com"), {
      env: {},
      fetch,
    });

    await expect(adapter.start("00000000-0000-4000-8000-000000000123")).resolves.toEqual({
      ok: false,
      reason: "runner_token_not_configured",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the dashboard timeout longer than the runner Docker command timeout", () => {
    expect(DEFAULT_MANUAL_RUNNER_TIMEOUT_MS).toBeGreaterThan(DOCKER_CLI_TIMEOUT_MS);
  });

  it("logs safe runner request failure metadata without bearer credentials", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const adapter = new ManualRunnerAdapter(manualRunner("https://runner.example.com"), {
      env: { [RUNNER_BEARER_TOKEN_ENV]: "contract-token" },
      fetch: async () =>
        Response.json(
          {
            ok: false,
            error: {
              code: "docker_command_failed",
              message: "Runner Docker command failed.",
            },
          },
          { status: 502 },
        ),
      timeoutMs: 250,
    });

    await expect(adapter.start("00000000-0000-4000-8000-000000000123")).resolves.toEqual({
      ok: false,
      reason: "runner_request_failed",
    });

    expect(info).toHaveBeenCalledWith(
      "[agentbay] manual_runner.request",
      expect.objectContaining({
        event: "request_failed",
        action: "start",
        agentId: "00000000-0000-4000-8000-000000000123",
        endpointHost: "runner.example.com",
        responseStatus: 502,
        responseErrorCode: "docker_command_failed",
        runnerBearerTokenFingerprint: fingerprintRunnerSecret("contract-token"),
      }),
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain("contract-token");
    info.mockRestore();
  });

  async function createAssignedRunner(agentId: string, endpointUrl: string) {
    const runner = await bootstrapManualRunnerForDevelopmentUser({
      createConnection: () => connection,
      env: {
        AGENTBAY_MANUAL_RUNNER_ENDPOINT_URL: endpointUrl,
      },
    });

    expect(runner).not.toBeNull();
    await assignRunnerToActiveAgentForDevelopmentUser(
      {
        agentId,
        runnerId: runner?.id ?? "",
      },
      {
        createConnection: () => connection,
      },
    );

    return runner as ManualRunnerRecord;
  }
});

function manualRunner(endpointUrl: string): ManualRunnerRecord {
  return {
    id: "00000000-0000-4000-8000-000000000777",
    userId: "00000000-0000-4000-8000-000000000778",
    name: "Manual Runner",
    kind: "manual_vps",
    endpointUrl,
    status: "active",
    createdAt: "2026-07-05T04:00:00.000Z",
    updatedAt: "2026-07-05T04:00:00.000Z",
    deletedAt: null,
  };
}

async function resetTables(connection: DatabaseConnection): Promise<void> {
  await connection.client`truncate table agent_approvals, agent_configs, agent_logs, docker_runner_containers, local_runner_processes, agent_events, agents, runners, app_metadata, users restart identity cascade`;
}
