import { EnvValidationError, validateRequiredEnv } from "@/src/env/validation";
import { createDatabaseConnection } from "./client";

export type DatabaseHealth = {
  ok: boolean;
  database: "reachable" | "unreachable";
  message?: string;
};

export async function checkDatabaseHealth(
  input: Record<string, string | undefined> = process.env,
): Promise<DatabaseHealth> {
  let databaseUrl: string;

  try {
    databaseUrl = validateRequiredEnv(input).DATABASE_URL;
  } catch (error) {
    if (error instanceof EnvValidationError) {
      return {
        ok: false,
        database: "unreachable",
        message: error.issues.join(" "),
      };
    }

    throw error;
  }

  const connection = createDatabaseConnection(databaseUrl);

  try {
    await connection.client`select 1`;

    return {
      ok: true,
      database: "reachable",
    };
  } catch {
    return {
      ok: false,
      database: "unreachable",
      message: "Database connection failed.",
    };
  } finally {
    await connection.close();
  }
}
