import { describe, expect, it } from "vitest";
import { normalizePostgresConnectionString } from "@/src/server/db/client";

describe("database client connection strings", () => {
  it("removes PlanetScale's unsupported system root certificate parameter", () => {
    const normalized = normalizePostgresConnectionString(
      "postgresql://release:secret@database.example:5432/postgres?sslmode=verify-full&sslrootcert=system&application_name=plingpling",
    );
    const parsed = new URL(normalized);

    expect(parsed.searchParams.get("sslmode")).toBe("verify-full");
    expect(parsed.searchParams.has("sslrootcert")).toBe(false);
    expect(parsed.searchParams.get("application_name")).toBe("plingpling");
    expect(parsed.username).toBe("release");
    expect(parsed.password).toBe("secret");
  });

  it("preserves explicit non-system root certificate settings", () => {
    const connectionString =
      "postgresql://release:secret@database.example:5432/postgres?sslmode=verify-full&sslrootcert=%2Fetc%2Fssl%2Fcustom.pem";

    expect(normalizePostgresConnectionString(connectionString)).toBe(connectionString);
  });
});
