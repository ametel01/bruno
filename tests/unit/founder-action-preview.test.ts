import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  operatorActionPreviewRevisions,
  operatorActionPreviews,
  users,
} from "@/src/server/db/schema";
import {
  editFounderActionPreviewForUser,
  getFounderActionPreviewForUser,
} from "@/src/server/operators/founder-action-previews";

const OWNER_ID = "00000000-0000-4000-8000-000000003461";
const OTHER_OWNER_ID = "00000000-0000-4000-8000-000000003462";

describe("Founder Action Preview application seam", () => {
  let connection: DatabaseConnection;
  const now = new Date("2026-08-19T02:00:00.000Z");

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await reset(connection);
    await connection.db.insert(users).values([{ id: OWNER_ID }, { id: OTHER_OWNER_ID }]);
  });

  afterEach(async () => {
    await reset(connection);
    await connection.close();
  });

  it("keeps one identity, appends a new draft revision, and never exposes authority", async () => {
    await expect(
      getFounderActionPreviewForUser(OWNER_ID, { createConnection: () => connection }),
    ).resolves.toBeNull();
    await expect(connection.db.select().from(operatorActionPreviews)).resolves.toHaveLength(0);
    await expect(connection.db.select().from(operatorActionPreviewRevisions)).resolves.toHaveLength(
      0,
    );

    const edited = await editFounderActionPreviewForUser(
      OWNER_ID,
      {
        recipientName: "Ada Lovelace",
        recipientAddress: "ada@example.com",
        content: "Following up on our next step.",
        supportingEvidence: [{ label: "Calendar", detail: "Planning call on 19 August." }],
        expectedExternalEffect: "A message would be prepared for review; nothing is sent.",
      },
      { createConnection: () => connection, now: () => now },
    );

    expect(edited.authority).toBe("none");
    expect(edited.executable).toBe(false);
    expect(edited.current).toMatchObject({
      revision: 2,
      state: "draft",
      recipient: { name: "Ada Lovelace", address: "ada@example.com" },
    });
    expect(edited.history.map((revision) => revision.revision)).toEqual([2, 1]);
    await expect(
      getFounderActionPreviewForUser(OWNER_ID, { createConnection: () => connection }),
    ).resolves.toEqual(edited);
  });

  it("isolates the canonical preview identity by Founder owner", async () => {
    const draft = {
      recipientName: "Ada Lovelace",
      recipientAddress: "ada@example.com",
      content: "Following up.",
      supportingEvidence: [{ label: "Calendar", detail: "Planning call." }],
      expectedExternalEffect: "Nothing is sent.",
    };
    const first = await editFounderActionPreviewForUser(OWNER_ID, draft, {
      createConnection: () => connection,
      now: () => now,
    });
    const second = await editFounderActionPreviewForUser(OTHER_OWNER_ID, draft, {
      createConnection: () => connection,
      now: () => now,
    });
    expect(second.id).not.toBe(first.id);
  });
});

async function reset(connection: DatabaseConnection): Promise<void> {
  await connection.client.unsafe(
    "truncate table operator_action_preview_revisions, operator_action_previews, operators, users restart identity cascade",
  );
}
