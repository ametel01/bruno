import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireApplicationUser: vi.fn(),
  getTroubleshooting: vi.fn(),
  approveCase: vi.fn(),
  closeCase: vi.fn(),
  requireRecentAuth: vi.fn(),
}));

vi.mock("@/src/server/users/configured-application-user", () => ({
  requireConfiguredApplicationUser: mocks.requireApplicationUser,
}));

vi.mock("@/src/server/operators/founder-troubleshooting", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/src/server/operators/founder-troubleshooting")>()),
  getFounderTroubleshootingForUser: mocks.getTroubleshooting,
  approveFounderTroubleshootingCaseForUser: mocks.approveCase,
  closeFounderTroubleshootingCaseForUser: mocks.closeCase,
}));

const USER_ID = "00000000-0000-4000-8000-000000003591";
const INCIDENT = {
  id: "00000000-0000-4000-8000-000000003592",
  title: "AI responses troubleshooting",
  capability: "ai",
  impactSummary: "AI responses are paused.",
  affectedCapabilities: ["AI responses"],
  unaffectedCapabilities: ["Calendar evidence"],
  status: "open",
  openedAt: "2026-08-20T00:00:00.000Z",
  closedAt: null,
  evidenceExpiresAt: "2026-09-03T00:00:00.000Z",
  supportCase: "not_attached",
  evidence: [],
} as const;

describe("Founder Troubleshooting route", () => {
  beforeEach(() => {
    mocks.requireApplicationUser.mockResolvedValue({ ok: true, userId: USER_ID });
    mocks.getTroubleshooting.mockResolvedValue({
      help: {
        capability: "ai",
        state: "recovery_exhausted",
        title: "AI responses need troubleshooting",
        impact: "AI responses are paused.",
        action: { label: "Review AI access", href: "/operator#connections" },
        technicalEvidenceAvailable: true,
        incidentId: INCIDENT.id,
      },
      incidents: [INCIDENT],
    });
    mocks.approveCase.mockResolvedValue(INCIDENT);
    mocks.closeCase.mockResolvedValue({ ...INCIDENT, status: "closed" });
    mocks.requireRecentAuth.mockResolvedValue(true);
  });

  afterEach(() => vi.clearAllMocks());

  it("returns owner-scoped Help with no-store caching and a capability filter", async () => {
    const { GET } = await import("@/app/api/operator/troubleshooting/route");
    const response = await GET(
      new Request("http://localhost/api/operator/troubleshooting?capability=ai"),
      undefined,
      { getTroubleshooting: mocks.getTroubleshooting },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.getTroubleshooting).toHaveBeenCalledWith(USER_ID, "ai");
    expect(JSON.stringify(await response.json())).not.toMatch(/token|prompt|messageBody|endpoint/i);
  });

  it("requires authentication and recent reauthentication for incident controls", async () => {
    const { GET, POST } = await import("@/app/api/operator/troubleshooting/route");
    mocks.requireApplicationUser.mockResolvedValueOnce({ ok: false, status: 401 });
    expect((await GET(new Request("http://localhost/api/operator/troubleshooting"))).status).toBe(
      401,
    );

    mocks.requireRecentAuth.mockResolvedValueOnce(false);
    const denied = await POST(
      new Request("http://localhost/api/operator/troubleshooting", {
        method: "POST",
        body: JSON.stringify({ action: "approve_case", incidentId: INCIDENT.id }),
      }),
      undefined,
      { requireRecentAuth: mocks.requireRecentAuth, approveCase: mocks.approveCase },
    );
    expect(denied.status).toBe(401);
    expect(mocks.approveCase).not.toHaveBeenCalled();
  });

  it("routes approval and closure only through the owner-scoped application seam", async () => {
    const { POST } = await import("@/app/api/operator/troubleshooting/route");
    const approved = await POST(
      new Request("http://localhost/api/operator/troubleshooting", {
        method: "POST",
        body: JSON.stringify({ action: "approve_case", incidentId: INCIDENT.id }),
      }),
      undefined,
      { requireRecentAuth: mocks.requireRecentAuth, approveCase: mocks.approveCase },
    );
    expect(approved.status).toBe(200);
    expect(mocks.approveCase).toHaveBeenCalledWith(USER_ID, INCIDENT.id);

    const closed = await POST(
      new Request("http://localhost/api/operator/troubleshooting", {
        method: "POST",
        body: JSON.stringify({ action: "close_case", incidentId: INCIDENT.id }),
      }),
      undefined,
      { requireRecentAuth: mocks.requireRecentAuth, closeCase: mocks.closeCase },
    );
    expect(closed.status).toBe(200);
    expect(mocks.closeCase).toHaveBeenCalledWith(USER_ID, INCIDENT.id);
  });
});
