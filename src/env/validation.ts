export type RequiredEnv = {
  DATABASE_URL: string;
  NEXT_PUBLIC_APP_URL: string;
  AGENTBAY_MANUAL_RUNNER_NAME?: string;
  AGENTBAY_MANUAL_RUNNER_ENDPOINT_URL?: string;
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

export function validateManualRunnerEndpointUrl(value: string): string {
  const endpointUrl = value.trim();

  if (!endpointUrl) {
    throw new EnvValidationError(["AGENTBAY_MANUAL_RUNNER_ENDPOINT_URL cannot be blank."]);
  }

  let parsedEndpointUrl: URL;

  try {
    parsedEndpointUrl = new URL(endpointUrl);
  } catch {
    throw new EnvValidationError(["AGENTBAY_MANUAL_RUNNER_ENDPOINT_URL must be a valid URL."]);
  }

  if (parsedEndpointUrl.protocol === "https:") {
    return endpointUrl;
  }

  if (parsedEndpointUrl.protocol === "http:" && isLoopbackHostname(parsedEndpointUrl.hostname)) {
    return endpointUrl;
  }

  throw new EnvValidationError([
    "AGENTBAY_MANUAL_RUNNER_ENDPOINT_URL must use https:// unless it targets a loopback host.",
  ]);
}

export function validateRequiredEnv(input: EnvInput): RequiredEnv {
  const issues: string[] = [];
  const databaseUrl = input.DATABASE_URL?.trim();
  const appUrl = input.NEXT_PUBLIC_APP_URL?.trim();
  const manualRunnerName = input.AGENTBAY_MANUAL_RUNNER_NAME?.trim();
  const manualRunnerEndpointUrl = input.AGENTBAY_MANUAL_RUNNER_ENDPOINT_URL?.trim();

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

  let validatedManualRunnerEndpointUrl: string | undefined;

  if (manualRunnerEndpointUrl !== undefined) {
    try {
      validatedManualRunnerEndpointUrl = validateManualRunnerEndpointUrl(manualRunnerEndpointUrl);
    } catch (error) {
      if (error instanceof EnvValidationError) {
        throw new EnvValidationError(error.issues);
      }

      throw error;
    }
  }

  if (manualRunnerName !== undefined && manualRunnerName.length === 0) {
    throw new EnvValidationError(["AGENTBAY_MANUAL_RUNNER_NAME cannot be blank."]);
  }

  if (!databaseUrl || !appUrl) {
    throw new EnvValidationError(["Required environment values were not resolved."]);
  }

  return {
    DATABASE_URL: databaseUrl,
    NEXT_PUBLIC_APP_URL: appUrl,
    ...(manualRunnerName ? { AGENTBAY_MANUAL_RUNNER_NAME: manualRunnerName } : {}),
    ...(validatedManualRunnerEndpointUrl
      ? { AGENTBAY_MANUAL_RUNNER_ENDPOINT_URL: validatedManualRunnerEndpointUrl }
      : {}),
  };
}

function isLoopbackHostname(hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase();

  return (
    normalizedHostname === "localhost" ||
    normalizedHostname === "127.0.0.1" ||
    normalizedHostname === "host.docker.internal" ||
    normalizedHostname === "::1" ||
    normalizedHostname.endsWith(".localhost")
  );
}
