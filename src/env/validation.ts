export type RequiredEnv = {
  DATABASE_URL: string;
  NEXT_PUBLIC_APP_URL: string;
};

export class EnvValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Environment validation failed: ${issues.join(" ")}`);
    this.name = "EnvValidationError";
    this.issues = issues;
  }
}

type EnvInput = Record<string, string | undefined>;

export function validateRequiredEnv(input: EnvInput): RequiredEnv {
  const issues: string[] = [];
  const databaseUrl = input.DATABASE_URL?.trim();
  const appUrl = input.NEXT_PUBLIC_APP_URL?.trim();

  if (!databaseUrl) {
    issues.push("DATABASE_URL is required.");
  } else {
    try {
      const parsedDatabaseUrl = new URL(databaseUrl);
      if (!["postgres:", "postgresql:"].includes(parsedDatabaseUrl.protocol)) {
        issues.push("DATABASE_URL must use the postgres:// or postgresql:// protocol.");
      }
    } catch {
      issues.push("DATABASE_URL must be a valid URL.");
    }
  }

  if (!appUrl) {
    issues.push("NEXT_PUBLIC_APP_URL is required.");
  } else {
    try {
      const parsedAppUrl = new URL(appUrl);
      if (!["http:", "https:"].includes(parsedAppUrl.protocol)) {
        issues.push("NEXT_PUBLIC_APP_URL must use the http:// or https:// protocol.");
      }
    } catch {
      issues.push("NEXT_PUBLIC_APP_URL must be a valid URL.");
    }
  }

  if (issues.length > 0) {
    throw new EnvValidationError(issues);
  }

  if (!databaseUrl || !appUrl) {
    throw new EnvValidationError(["Required environment values were not resolved."]);
  }

  return {
    DATABASE_URL: databaseUrl,
    NEXT_PUBLIC_APP_URL: appUrl,
  };
}
