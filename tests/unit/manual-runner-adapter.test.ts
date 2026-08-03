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
      state: "ready",
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
      state: "ready",
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

  it("maps 202 launch acceptance responses without requiring a legacy running container", async () => {
    const created = await createAgentForDevelopmentUser(
      { name: "Manual Accepted Agent", templateKey: "research_agent" },
      { createConnection: () => connection },
    );
    const runner = await createAssignedRunner(created.agent.id, "http://127.0.0.1:9080");
    const launchSpec = sampleLaunchSpec({
      agent: { ...sampleLaunchSpec().agent, id: created.agent.id },
    });
    const operationId = "11111111-1111-4111-8111-111111111111";
    const acceptedAt = "2026-08-03T04:30:00.000Z";
    const target = {
      image: launchSpec.image.ref,
      launchSpecVersion: launchSpec.version,
      configRevision: launchSpec.agent.configRevision,
    };
    const adapter = new ManualRunnerAdapter(runner, {
      createConnection: () => connection,
      env: { [RUNNER_BEARER_TOKEN_ENV]: "contract-token" },
      fetch: async () =>
        Response.json(
          {
            ok: true,
            contractVersion: "agentbay.runner.launch.v2",
            agentId: created.agent.id,
            action: "start",
            operation: {
              id: operationId,
              state: "accepted",
              disposition: "created",
              target,
              acceptedAt,
            },
            snapshot: {
              phase: "accepted",
              operation: {
                id: operationId,
                action: "start",
                target,
                acceptedAt,
              },
              container: {
                id: "manual-container-accepted",
                name: "agentbay-runner",
                image: launchSpec.image.ref,
                state: "running",
                startedAt: acceptedAt,
                finishedAt: null,
                observedAt: acceptedAt,
              },
              revision: {
                state: "match",
                requested: launchSpec.agent.configRevision,
                containerLabel: launchSpec.agent.configRevision,
                projectionMarker: launchSpec.agent.configRevision,
                observedAt: acceptedAt,
              },
              gateway: { state: "unknown", observedAt: null },
              apiServer: { required: true, state: "unknown", observedAt: null },
              telegram: { required: true, state: "unknown", observedAt: null },
              readinessReason: "launch_accepted",
              observedAt: acceptedAt,
            },
          },
          { status: 202 },
        ),
      timeoutMs: 250,
    });

    await expect(adapter.start(created.agent.id, launchSpec)).resolves.toMatchObject({
      ok: true,
      state: "accepted",
      operation: { id: operationId, target },
      snapshot: {
        phase: "accepted",
        readinessReason: "launch_accepted",
        container: { id: "manual-container-accepted" },
      },
    });
  });

  it.each([
    {
      name: "a 200 accepted response",
      status: 200,
      response: acceptedLaunchResponse("00000000-0000-4000-8000-000000000123", "start"),
    },
    {
      name: "a 202 legacy-ready response",
      status: 202,
      response: {
        ok: true,
        agentId: "00000000-0000-4000-8000-000000000123",
        action: "start",
        container: { id: "legacy-container", status: "running" },
      },
    },
    {
      name: "an accepted response for another action",
      status: 202,
      response: acceptedLaunchResponse("00000000-0000-4000-8000-000000000123", "restart"),
    },
    {
      name: "an accepted response for another agent",
      status: 202,
      response: acceptedLaunchResponse("00000000-0000-4000-8000-000000000999", "start"),
    },
    {
      name: "inconsistent operation evidence",
      status: 202,
      response: {
        ...acceptedLaunchResponse("00000000-0000-4000-8000-000000000123", "start"),
        snapshot: {
          ...acceptedLaunchResponse("00000000-0000-4000-8000-000000000123", "start").snapshot,
          operation: {
            ...acceptedLaunchResponse("00000000-0000-4000-8000-000000000123", "start").snapshot
              .operation,
            id: "22222222-2222-4222-8222-222222222222",
          },
        },
      },
    },
    {
      name: "ready platform evidence disguised as acceptance",
      status: 202,
      response: {
        ...acceptedLaunchResponse("00000000-0000-4000-8000-000000000123", "start"),
        snapshot: {
          ...acceptedLaunchResponse("00000000-0000-4000-8000-000000000123", "start").snapshot,
          gateway: { state: "running", observedAt: "2026-08-03T04:30:00.000Z" },
        },
      },
    },
  ])("rejects $name", async ({ response, status }) => {
    const adapter = new ManualRunnerAdapter(manualRunner("https://runner.example.com"), {
      env: { [RUNNER_BEARER_TOKEN_ENV]: "contract-token" },
      fetch: async () => Response.json(response, { status }),
      timeoutMs: 250,
    });

    await expect(adapter.start("00000000-0000-4000-8000-000000000123")).resolves.toEqual({
      ok: false,
      reason: "runner_response_invalid",
    });
  });

  it("rejects accepted target evidence that differs from the requested launch spec", async () => {
    const agentId = "00000000-0000-4000-8000-000000000123";
    const launchSpec = sampleLaunchSpec({
      agent: { ...sampleLaunchSpec().agent, id: agentId },
    });
    const adapter = new ManualRunnerAdapter(manualRunner("https://runner.example.com"), {
      env: { [RUNNER_BEARER_TOKEN_ENV]: "contract-token" },
      fetch: async () => Response.json(acceptedLaunchResponse(agentId, "start"), { status: 202 }),
      timeoutMs: 250,
    });

    await expect(adapter.start(agentId, launchSpec)).resolves.toEqual({
      ok: false,
      reason: "runner_response_invalid",
    });
  });

  it("returns only a strict typed status snapshot", async () => {
    const agentId = "00000000-0000-4000-8000-000000000123";
    const accepted = acceptedLaunchResponse(agentId, "start");
    const adapter = new ManualRunnerAdapter(manualRunner("https://runner.example.com"), {
      env: { [RUNNER_BEARER_TOKEN_ENV]: "contract-token" },
      fetch: async () =>
        Response.json({
          ok: true,
          contractVersion: "agentbay.runner.status.v2",
          agentId,
          action: "status",
          snapshot: accepted.snapshot,
        }),
      timeoutMs: 250,
    });

    await expect(adapter.status(agentId)).resolves.toEqual({
      ok: true,
      runner: manualRunner("https://runner.example.com"),
      snapshot: accepted.snapshot,
    });
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

  it("allowlists thrown error names and never logs hostile transport details", async () => {
    const hostile = "filesystem /private/agent OPENROUTER_API_KEY=sk-hostile";
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const adapter = new ManualRunnerAdapter(manualRunner("https://runner.example.com"), {
      env: { [RUNNER_BEARER_TOKEN_ENV]: "contract-token" },
      fetch: async () => {
        const error = new Error(hostile);
        error.name = hostile;
        throw error;
      },
      timeoutMs: 250,
    });

    await expect(adapter.start("00000000-0000-4000-8000-000000000123")).resolves.toEqual({
      ok: false,
      reason: "runner_request_failed",
    });
    expect(info).toHaveBeenCalledWith(
      "[agentbay] manual_runner.request",
      expect.objectContaining({
        event: "request_error",
        errorName: "Error",
        timedOut: false,
      }),
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain(hostile);
    info.mockRestore();
  });

  it("maps Hermes readiness failures to stable reasons without exposing upstream details", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const adapter = new ManualRunnerAdapter(manualRunner("https://runner.example.com"), {
      env: { [RUNNER_BEARER_TOKEN_ENV]: "contract-token" },
      fetch: async () =>
        Response.json(
          {
            ok: false,
            error: {
              code: "hermes_readiness_failed",
              message: "Hermes readiness failed.",
              reason: "telegram_not_connected",
              raw: "telegram token 123456:abcdefghijklmnopqrstuvwxyz",
            },
          },
          { status: 502 },
        ),
      timeoutMs: 250,
    });

    await expect(adapter.start("00000000-0000-4000-8000-000000000123")).resolves.toEqual({
      ok: false,
      reason: "runner_readiness_failed",
      readinessReason: "telegram_not_connected",
    });
    expect(info).toHaveBeenCalledWith(
      "[agentbay] manual_runner.request",
      expect.objectContaining({
        event: "request_failed",
        responseErrorCode: "hermes_readiness_failed",
        responseErrorReason: "telegram_not_connected",
      }),
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain("123456:abcdefghijklmnopqrstuvwxyz");
    info.mockRestore();
  });

  it("drops unknown Hermes readiness failure reasons from dashboard metadata", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const adapter = new ManualRunnerAdapter(manualRunner("https://runner.example.com"), {
      env: { [RUNNER_BEARER_TOKEN_ENV]: "contract-token" },
      fetch: async () =>
        Response.json(
          {
            ok: false,
            error: {
              code: "hermes_readiness_failed",
              message: "Hermes readiness failed.",
              reason: "telegram token 123456:abcdefghijklmnopqrstuvwxyz",
            },
          },
          { status: 502 },
        ),
      timeoutMs: 250,
    });

    await expect(adapter.restart("00000000-0000-4000-8000-000000000123")).resolves.toEqual({
      ok: false,
      reason: "runner_readiness_failed",
    });
    expect(info).toHaveBeenCalledWith(
      "[agentbay] manual_runner.request",
      expect.objectContaining({
        event: "request_failed",
        responseErrorCode: "hermes_readiness_failed",
      }),
    );
    expect(info.mock.calls[0]?.[1]).toEqual(
      expect.not.objectContaining({
        responseErrorReason: expect.anything(),
      }),
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain("123456:abcdefghijklmnopqrstuvwxyz");
    info.mockRestore();
  });

  it("distinguishes exact canary 409 no-dispatch proof from ambiguous transport failure", async () => {
    const request = {
      operationId: "11111111-1111-4111-8111-111111111111",
      configRevision: "cfg-canary",
      model: "openai/gpt-4.1-mini",
    };
    const noDispatch = new ManualRunnerAdapter(manualRunner("https://runner.example.com"), {
      env: { [RUNNER_BEARER_TOKEN_ENV]: "contract-token" },
      fetch: async () =>
        Response.json(
          { ok: false, error: { code: "canary_not_ready", message: "Canary is not ready." } },
          { status: 409 },
        ),
      timeoutMs: 250,
    });
    const ambiguous = new ManualRunnerAdapter(manualRunner("https://runner.example.com"), {
      env: { [RUNNER_BEARER_TOKEN_ENV]: "contract-token" },
      fetch: async () => {
        throw new TypeError("ambiguous network failure");
      },
      timeoutMs: 250,
    });

    await expect(
      noDispatch.canary("00000000-0000-4000-8000-000000000123", request),
    ).resolves.toEqual({
      ok: false,
      reason: "canary_not_dispatched",
    });
    await expect(
      ambiguous.canary("00000000-0000-4000-8000-000000000123", request),
    ).resolves.toEqual({
      ok: false,
      reason: "runner_request_failed",
    });
  });

  it("propagates a parent abort signal into the active runner fetch", async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | null = null;
    const adapter = new ManualRunnerAdapter(manualRunner("https://runner.example.com"), {
      env: { [RUNNER_BEARER_TOKEN_ENV]: "contract-token" },
      signal: controller.signal,
      fetch: async (_input, init) => {
        observedSignal = init?.signal ?? null;
        return await new Promise<Response>((_resolve, reject) => {
          observedSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      },
      timeoutMs: 10_000,
    });
    const status = adapter.status("00000000-0000-4000-8000-000000000123");
    await vi.waitFor(() => expect(observedSignal).not.toBeNull());
    controller.abort();

    await expect(status).resolves.toEqual({ ok: false, reason: "runner_request_failed" });
    expect(controller.signal.aborted).toBe(true);
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

function acceptedLaunchResponse(agentId: string, action: "start" | "restart") {
  const acceptedAt = "2026-08-03T04:30:00.000Z";
  const operationId = "11111111-1111-4111-8111-111111111111";
  const target = {
    image: "nousresearch/hermes-agent:test@sha256:abc",
    launchSpecVersion: "agentbay.hermes.launch.v3",
    configRevision: "cfg-accepted",
  };

  return {
    ok: true,
    contractVersion: "agentbay.runner.launch.v2",
    agentId,
    action,
    operation: {
      id: operationId,
      state: "accepted",
      disposition: "created",
      target,
      acceptedAt,
    },
    snapshot: {
      phase: "accepted",
      operation: { id: operationId, action, target, acceptedAt },
      container: {
        id: "manual-container-accepted",
        name: "agentbay-runner",
        image: target.image,
        state: "running",
        startedAt: acceptedAt,
        finishedAt: null,
        observedAt: acceptedAt,
      },
      revision: {
        state: "match",
        requested: target.configRevision,
        containerLabel: target.configRevision,
        projectionMarker: target.configRevision,
        observedAt: acceptedAt,
      },
      gateway: { state: "unknown", observedAt: null },
      apiServer: { required: true, state: "unknown", observedAt: null },
      telegram: { required: true, state: "unknown", observedAt: null },
      readinessReason: "launch_accepted",
      observedAt: acceptedAt,
    },
  };
}

async function resetTables(connection: DatabaseConnection): Promise<void> {
  await connection.client`truncate table agent_approvals, agent_configs, agent_logs, docker_runner_containers, local_runner_processes, agent_events, agents, runners, app_metadata, users restart identity cascade`;
}
