import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  confirmFounderTimezoneForUser,
  ensureFounderOperatorForUser,
  getFounderOperatorForUser,
} from "@/src/server/operators/founder-operator";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import { operatorPreparations, operators, users } from "@/src/server/db/schema";

const OWNER_A_ID = "00000000-0000-4000-8000-000000003371";
const OWNER_B_ID = "00000000-0000-4000-8000-000000003372";

describe("Founder Operator application seam", () => {
  let connection: DatabaseConnection;

  beforeEach(async () => {
    connection = createDatabaseConnection();
    await reset(connection);
    await connection.db.insert(users).values([{ id: OWNER_A_ID }, { id: OWNER_B_ID }]);
  });

  afterEach(async () => {
    await reset(connection);
    await connection.close();
  });

  it("creates one active Operator and one resumable preparation for the Founder", async () => {
    const operator = await ensureFounderOperatorForUser(OWNER_A_ID, {
      createConnection: () => connection,
      now: () => new Date("2026-08-18T00:00:00.000Z"),
    });

    expect(operator).toMatchObject({
      userId: OWNER_A_ID,
      status: "active",
      preparation: {
        status: "awaiting_timezone",
        timezone: null,
        timezoneConfirmedAt: null,
      },
    });

    const replay = await ensureFounderOperatorForUser(OWNER_A_ID, {
      createConnection: () => connection,
    });

    expect(replay.id).toBe(operator.id);
    expect(replay.preparation.id).toBe(operator.preparation.id);
    await expect(connection.db.select().from(operators)).resolves.toHaveLength(1);
    await expect(connection.db.select().from(operatorPreparations)).resolves.toHaveLength(1);
  });

  it("converges concurrent creation requests to the same Operator and preparation", async () => {
    const first = createDatabaseConnection();
    const second = createDatabaseConnection();

    try {
      const [left, right] = await Promise.all([
        ensureFounderOperatorForUser(OWNER_A_ID, { createConnection: () => first }),
        ensureFounderOperatorForUser(OWNER_A_ID, { createConnection: () => second }),
      ]);

      expect(left.id).toBe(right.id);
      expect(left.preparation.id).toBe(right.preparation.id);
      await expect(connection.db.select().from(operators)).resolves.toHaveLength(1);
      await expect(connection.db.select().from(operatorPreparations)).resolves.toHaveLength(1);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it("isolates Operators and preparation state by Owner", async () => {
    const ownerA = await ensureFounderOperatorForUser(OWNER_A_ID, {
      createConnection: () => connection,
      now: () => new Date("2026-08-18T00:00:00.000Z"),
    });
    const ownerB = await ensureFounderOperatorForUser(OWNER_B_ID, {
      createConnection: () => connection,
    });

    expect(ownerA.id).not.toBe(ownerB.id);
    expect(ownerA.preparation.id).not.toBe(ownerB.preparation.id);

    const confirmed = await confirmFounderTimezoneForUser(OWNER_A_ID, "Asia/Manila", {
      createConnection: () => connection,
      now: () => new Date("2026-08-18T01:00:00.000Z"),
    });

    expect(confirmed.preparation).toMatchObject({
      timezone: "Asia/Manila",
      status: "preparing",
      timezoneConfirmedAt: "2026-08-18T01:00:00.000Z",
    });
    await expect(
      getFounderOperatorForUser(OWNER_B_ID, { createConnection: () => connection }),
    ).resolves.toMatchObject({
      id: ownerB.id,
      preparation: { timezone: null, status: "awaiting_timezone" },
    });
  });

  it("rejects an invalid timezone without changing resumable state", async () => {
    await ensureFounderOperatorForUser(OWNER_A_ID, { createConnection: () => connection });

    await expect(
      confirmFounderTimezoneForUser(OWNER_A_ID, "Mars/Base", {
        createConnection: () => connection,
      }),
    ).rejects.toMatchObject({ code: "invalid_timezone" });

    await expect(
      getFounderOperatorForUser(OWNER_A_ID, { createConnection: () => connection }),
    ).resolves.toMatchObject({
      preparation: { status: "awaiting_timezone", timezone: null },
    });
  });

  it("does not expose a foreign Operator through an Owner-scoped lookup", async () => {
    const ownerA = await ensureFounderOperatorForUser(OWNER_A_ID, {
      createConnection: () => connection,
    });
    await ensureFounderOperatorForUser(OWNER_B_ID, { createConnection: () => connection });

    const serialized = JSON.stringify(
      await getFounderOperatorForUser(OWNER_A_ID, { createConnection: () => connection }),
    );

    expect(serialized).toContain(ownerA.id);
    expect(serialized).not.toContain(OWNER_B_ID);
  });
});

async function reset(connection: DatabaseConnection): Promise<void> {
  await connection.client.unsafe(
    "truncate table operator_preparations, operators, users restart identity cascade",
  );
}
