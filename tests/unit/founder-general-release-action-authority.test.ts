import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { users } from "@/src/server/db/schema";

const authority = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  error: new Error("general-release-authority-observed"),
}));

vi.mock("@/src/server/founder-product-contract/work-authority", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/src/server/founder-product-contract/work-authority")
  >()),
  withFounderOwnerPreviewWorkAuthority: vi.fn(
    async (_input: unknown, dependencies: Record<string, unknown>) => {
      authority.calls.push(dependencies);
      throw authority.error;
    },
  ),
}));

import {
  dismissFounderMailSendingOfferForUser,
  editFounderActionPreviewForUser,
} from "@/src/server/operators/founder-action-previews";
import {
  createFounderProposedActionForUser,
  decideFounderProposedActionForUser,
  reviseFounderProposedActionForUser,
} from "@/src/server/operators/founder-proposed-actions";
import {
  confirmFounderRelationshipCandidateForUser,
  ingestFounderRelationshipEvidenceForUser,
  rejectFounderRelationshipCandidateForUser,
  updateFounderRelationshipRecordForUser,
} from "@/src/server/operators/founder-relationships";
import { updateFounderMorningBriefPreferencesForUser } from "@/src/server/operators/founder-morning-brief";

const USER_ID = "00000000-0000-4000-8000-000000003487";
const ACTION_ID = "00000000-0000-4000-8000-000000003488";
const NOW = new Date("2026-08-23T12:00:00.000Z");

describe("General Release action work authority", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    authority.calls.length = 0;
    connection = createDatabaseConnection();
    await connection.client.unsafe("truncate table operators, users restart identity cascade");
    await connection.db.insert(users).values({ id: USER_ID });
  });

  afterEach(async () => {
    await connection.client.unsafe("truncate table operators, users restart identity cascade");
    await connection.close();
  });

  it("binds every Action Preview mutation to General Release work authority", async () => {
    const dependencies = { createConnection: () => connection, now: () => NOW };
    await expect(
      editFounderActionPreviewForUser(USER_ID, previewDraft(), dependencies),
    ).rejects.toBe(authority.error);
    await expect(dismissFounderMailSendingOfferForUser(USER_ID, dependencies)).rejects.toBe(
      authority.error,
    );

    expect(authority.calls).toHaveLength(2);
    for (const call of authority.calls) expect(call.generalReleaseAuthority).toBe("work");
  });

  it("binds create, revise, and Request changes to General Release work authority", async () => {
    const dependencies = { createConnection: () => connection, now: () => NOW };
    await expect(
      createFounderProposedActionForUser(USER_ID, actionDraft(), dependencies),
    ).rejects.toBe(authority.error);
    await expect(
      reviseFounderProposedActionForUser(USER_ID, ACTION_ID, 1, actionDraft(), dependencies),
    ).rejects.toBe(authority.error);
    await expect(
      decideFounderProposedActionForUser(
        USER_ID,
        ACTION_ID,
        "request_changes",
        1,
        actionDraft(),
        dependencies,
      ),
    ).rejects.toBe(authority.error);

    expect(authority.calls).toHaveLength(3);
    for (const call of authority.calls) expect(call.generalReleaseAuthority).toBe("work");
  });

  it("binds every Relationship Record mutation to General Release work authority", async () => {
    const dependencies = { createConnection: () => connection, now: () => NOW };
    await expect(ingestFounderRelationshipEvidenceForUser(USER_ID, [], dependencies)).rejects.toBe(
      authority.error,
    );
    await expect(
      updateFounderRelationshipRecordForUser(
        USER_ID,
        "00000000-0000-4000-8000-000000003489",
        { status: "active" },
        dependencies,
      ),
    ).rejects.toBe(authority.error);
    await expect(
      confirmFounderRelationshipCandidateForUser(
        USER_ID,
        "00000000-0000-4000-8000-000000003490",
        dependencies,
      ),
    ).rejects.toBe(authority.error);
    await expect(
      rejectFounderRelationshipCandidateForUser(
        USER_ID,
        "00000000-0000-4000-8000-000000003491",
        dependencies,
      ),
    ).rejects.toBe(authority.error);

    expect(authority.calls).toHaveLength(4);
    for (const call of authority.calls) expect(call.generalReleaseAuthority).toBe("work");
  });

  it("binds Morning Brief settings updates to General Release work authority", async () => {
    const dependencies = { createConnection: () => connection, now: () => NOW };
    await expect(
      updateFounderMorningBriefPreferencesForUser(USER_ID, "07:30", dependencies),
    ).rejects.toBe(authority.error);

    expect(authority.calls).toHaveLength(1);
    expect(authority.calls[0]?.generalReleaseAuthority).toBe("work");
  });
});

function previewDraft() {
  return {
    recipientName: "Ada Lovelace",
    recipientAddress: "ada@example.com",
    content: "Following up.",
    supportingEvidence: [{ label: "Calendar", detail: "Planning call." }],
    expectedExternalEffect: "Nothing is sent.",
  };
}

function actionDraft() {
  return {
    actionFamily: "external_communication" as const,
    businessOutcome: "Send a precise follow-up",
    destination: { recipient: "ada@example.com" },
    materialContent: { subject: "A precise follow-up", body: "Hello Ada" },
    validUntil: "2026-08-24T12:00:00.000Z",
  };
}
