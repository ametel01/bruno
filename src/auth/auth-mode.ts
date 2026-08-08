const PRODUCTION_HOSTNAME = "getbruno.xyz";

export type AuthMode = "clerk" | "development" | "operator";

export type AuthModeConfigurationErrorCode =
  | "clerk_auth_not_configured"
  | "development_auth_not_allowed"
  | "invalid_auth_mode"
  | "operator_auth_not_configured"
  | "preview_protection_not_verified";

export type AuthModeDecision =
  | { mode: "clerk"; publishableKey: string }
  | { mode: "development" }
  | { mode: "operator" }
  | { mode: "invalid"; code: AuthModeConfigurationErrorCode };

type AuthEnvironment = Record<string, string | undefined>;

export function resolveAuthMode(env: AuthEnvironment): AuthModeDecision {
  const configuredMode = env.BRUNO_AUTH_MODE;
  const isPreview = env.VERCEL_ENV === "preview";
  const resolvedMode = configuredMode ?? (isPreview ? "clerk" : undefined);

  if (
    configuredMode !== undefined &&
    configuredMode !== "development" &&
    configuredMode !== "clerk" &&
    configuredMode !== "operator"
  ) {
    return { mode: "invalid", code: "invalid_auth_mode" };
  }

  if (resolvedMode === "clerk") {
    const publishableKey = configuredValue(env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
    const secretKey = configuredValue(env.CLERK_SECRET_KEY);

    if (!publishableKey || !secretKey) {
      return { mode: "invalid", code: "clerk_auth_not_configured" };
    }

    return { mode: "clerk", publishableKey };
  }

  if (resolvedMode === "operator") {
    if (!configuredValue(env.BRUNO_OPERATOR_PASSWORD)) {
      return { mode: "invalid", code: "operator_auth_not_configured" };
    }

    return { mode: "operator" };
  }

  const appHostname = readUrlHostname(env.NEXT_PUBLIC_APP_URL);
  const currentVercelHostname = readHostname(env.VERCEL_URL);
  const productionVercelHostname = readHostname(env.VERCEL_PROJECT_PRODUCTION_URL);
  const currentPreviewHostname =
    isPreview && isVercelPreviewHostname(currentVercelHostname) ? currentVercelHostname : null;

  if (
    configuredMode === "development" &&
    env.BRUNO_ALLOW_PUBLIC_DEVELOPMENT === "true" &&
    env.VERCEL_ENV === "production" &&
    appHostname !== null
  ) {
    return { mode: "development" };
  }

  if (
    env.VERCEL_ENV === "production" ||
    isProductionHostname(appHostname, productionVercelHostname) ||
    isCustomHostname(appHostname, currentPreviewHostname)
  ) {
    return { mode: "invalid", code: "development_auth_not_allowed" };
  }

  if (isPreview) {
    if (
      configuredMode !== "development" ||
      appHostname === null ||
      currentPreviewHostname === null ||
      appHostname !== currentPreviewHostname
    ) {
      return { mode: "invalid", code: "development_auth_not_allowed" };
    }

    if (env.BRUNO_PREVIEW_PROTECTION_VERIFIED !== "true") {
      return { mode: "invalid", code: "preview_protection_not_verified" };
    }

    return { mode: "development" };
  }

  if (isVercelEnvironment(env) || !isLoopbackHostname(appHostname)) {
    return { mode: "invalid", code: "development_auth_not_allowed" };
  }

  return { mode: "development" };
}

export function requireValidAuthMode(
  env: AuthEnvironment,
): Exclude<AuthModeDecision, { mode: "invalid" }> {
  const decision = resolveAuthMode(env);

  if (decision.mode === "invalid") {
    throw new AuthModeConfigurationError(decision.code);
  }

  return decision;
}

export class AuthModeConfigurationError extends Error {
  readonly code: AuthModeConfigurationErrorCode;

  constructor(code: AuthModeConfigurationErrorCode) {
    super(authModeConfigurationMessage(code));
    this.name = "AuthModeConfigurationError";
    this.code = code;
  }
}

export function authModeConfigurationMessage(code: AuthModeConfigurationErrorCode): string {
  switch (code) {
    case "clerk_auth_not_configured":
      return "Clerk authentication is not configured.";
    case "development_auth_not_allowed":
      return "Development authentication is not allowed in this environment.";
    case "invalid_auth_mode":
      return "Authentication mode must be development, operator, or clerk.";
    case "operator_auth_not_configured":
      return "Operator authentication is not configured.";
    case "preview_protection_not_verified":
      return "Preview development authentication requires verified deployment protection.";
  }
}

function isVercelEnvironment(env: AuthEnvironment): boolean {
  return (
    env.VERCEL === "1" ||
    env.VERCEL_ENV !== undefined ||
    env.VERCEL_URL !== undefined ||
    env.VERCEL_PROJECT_PRODUCTION_URL !== undefined
  );
}

function isProductionHostname(
  appHostname: string | null,
  productionVercelHostname: string | null,
): boolean {
  if (!appHostname) {
    return false;
  }

  return (
    appHostname === PRODUCTION_HOSTNAME ||
    appHostname.endsWith(`.${PRODUCTION_HOSTNAME}`) ||
    (productionVercelHostname !== null && appHostname === productionVercelHostname)
  );
}

function isCustomHostname(
  appHostname: string | null,
  currentPreviewHostname: string | null,
): boolean {
  return (
    appHostname !== null &&
    !isLoopbackHostname(appHostname) &&
    (currentPreviewHostname === null || appHostname !== currentPreviewHostname)
  );
}

function isVercelPreviewHostname(hostname: string | null): boolean {
  return hostname?.endsWith(".vercel.app") === true;
}

function isLoopbackHostname(hostname: string | null): boolean {
  if (!hostname) {
    return false;
  }

  if (
    hostname === "localhost" ||
    hostname === "host.docker.internal" ||
    hostname.endsWith(".localhost") ||
    hostname === "::1" ||
    hostname === "[::1]"
  ) {
    return true;
  }

  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^(0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255)
  );
}

function readUrlHostname(value: string | undefined): string | null {
  const normalizedValue = configuredValue(value);

  if (!normalizedValue) {
    return null;
  }

  try {
    return new URL(normalizedValue).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function readHostname(value: string | undefined): string | null {
  const normalizedValue = configuredValue(value);

  if (!normalizedValue) {
    return null;
  }

  try {
    return new URL(
      normalizedValue.includes("://") ? normalizedValue : `https://${normalizedValue}`,
    ).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function configuredValue(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") {
    return null;
  }

  return value.trim();
}
