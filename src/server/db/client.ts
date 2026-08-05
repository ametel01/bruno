import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import { getServerEnv } from "@/src/server/env";
import * as schema from "./schema";

export type DatabaseConnection = {
  client: Sql;
  db: PostgresJsDatabase<typeof schema>;
  close: () => Promise<void>;
};

export function normalizePostgresConnectionString(databaseUrl: string): string {
  let parsed: URL;

  try {
    parsed = new URL(databaseUrl);
  } catch {
    return databaseUrl;
  }

  if (
    (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
    parsed.searchParams.get("sslrootcert") !== "system"
  ) {
    return databaseUrl;
  }

  parsed.searchParams.delete("sslrootcert");
  return parsed.toString();
}

export function createDatabaseConnection(
  databaseUrl = getServerEnv().DATABASE_URL,
): DatabaseConnection {
  const client = postgres(normalizePostgresConnectionString(databaseUrl), {
    connect_timeout: 5,
    idle_timeout: 5,
    max: 1,
  });

  return {
    client,
    db: drizzle(client, { schema }),
    close: () => client.end({ timeout: 5 }),
  };
}
