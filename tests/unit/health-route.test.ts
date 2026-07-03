import { describe, expect, it } from "vitest";
import { GET } from "@/app/health/route";

describe("health route", () => {
  it("returns non-2xx JSON when required database env is invalid", async () => {
    const originalDatabaseUrl = process.env.DATABASE_URL;
    const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL;

    process.env.DATABASE_URL = "not-a-url";
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";

    try {
      const response = await GET();
      const body = await response.json();

      expect(response.status).toBe(503);
      expect(body).toMatchObject({
        status: "error",
        database: "unreachable",
        message: "DATABASE_URL must be a valid URL.",
      });
      expect(Date.parse(body.timestamp)).not.toBeNaN();
      expect(JSON.stringify(body)).not.toContain("postgres://");
    } finally {
      process.env.DATABASE_URL = originalDatabaseUrl;
      process.env.NEXT_PUBLIC_APP_URL = originalAppUrl;
    }
  });
});
