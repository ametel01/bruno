import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invokeTool: vi.fn(),
  proposeRepair: vi.fn(),
}));

vi.mock("@/src/server/operators/founder-support", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/server/operators/founder-support")>()),
  invokeFounderSupportTool: mocks.invokeTool,
  createFounderRepairProposalForSupport: mocks.proposeRepair,
}));

describe("Support troubleshooting route", () => {
  afterEach(() => vi.clearAllMocks());

  it("requires the one-time grant token and named actor before dispatch", async () => {
    const { POST } = await import("@/app/api/support/troubleshooting/route");
    const denied = await POST(
      new Request("http://localhost/api/support/troubleshooting", {
        method: "POST",
        body: JSON.stringify({
          action: "invoke_tool",
          grantId: "grant-1",
          incidentId: "incident-1",
          supportActorIdentity: "support-ada",
        }),
      }),
    );
    expect(denied.status).toBe(400);
    expect(mocks.invokeTool).not.toHaveBeenCalled();

    mocks.invokeTool.mockResolvedValue({ incidentId: "incident-1", evidence: [] });
    const allowed = await POST(
      new Request("http://localhost/api/support/troubleshooting", {
        method: "POST",
        body: JSON.stringify({
          action: "invoke_tool",
          grantId: "grant-1",
          incidentId: "incident-1",
          supportActorIdentity: "support-ada",
          supportAccessToken: "one-time-token",
          tool: "read_troubleshooting_evidence",
        }),
      }),
    );
    expect(allowed.status).toBe(200);
    expect(mocks.invokeTool).toHaveBeenCalledWith(
      "grant-1",
      expect.objectContaining({ supportAccessToken: "one-time-token" }),
    );
  });

  it("keeps typed proposal creation separate from Founder approval", async () => {
    const { POST } = await import("@/app/api/support/troubleshooting/route");
    mocks.proposeRepair.mockResolvedValue({ id: "proposal-1", state: "proposed" });
    const response = await POST(
      new Request("http://localhost/api/support/troubleshooting", {
        method: "POST",
        body: JSON.stringify({
          action: "propose_repair",
          grantId: "grant-1",
          incidentId: "incident-1",
          supportActorIdentity: "support-ada",
          supportAccessToken: "one-time-token",
          kind: "restart_from_checkpoint",
          target: { checkpointId: "checkpoint-1" },
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).proposal.state).toBe("proposed");
  });
});
