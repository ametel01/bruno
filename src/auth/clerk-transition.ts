const STATIC_ASSET_EXTENSION_PATTERN =
  /\.(?:avif|css|gif|ico|jpeg|jpg|js|json|map|png|svg|txt|webmanifest|webp|woff|woff2)$/i;

const RUNNER_MACHINE_AUTH_PATHS = new Set([
  "/runner/v1/register",
  "/runner/v1/heartbeat",
  "/runner/v1/bootstrap-events",
]);

export type ClerkTransitionDecision =
  | { mode: "operator" }
  | { mode: "clerk"; publishableKey: string }
  | {
      mode: "invalid";
      code: "invalid_auth_transition_mode" | "clerk_auth_not_configured";
    };

export function resolveClerkTransition(
  env: Record<string, string | undefined>,
): ClerkTransitionDecision {
  const configuredMode = env.AGENTBAY_AUTH_TRANSITION_MODE;

  if (configuredMode === undefined || configuredMode === "operator") {
    return { mode: "operator" };
  }

  if (configuredMode !== "clerk") {
    return { mode: "invalid", code: "invalid_auth_transition_mode" };
  }

  const publishableKey = configuredValue(env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
  const secretKey = configuredValue(env.CLERK_SECRET_KEY);

  if (!publishableKey || !secretKey) {
    return { mode: "invalid", code: "clerk_auth_not_configured" };
  }

  return { mode: "clerk", publishableKey };
}

export function isClerkAuthPagePath(pathname: string): boolean {
  return isPathOrDescendant(pathname, "/sign-in") || isPathOrDescendant(pathname, "/sign-up");
}

export function isRunnerMachineAuthPath(pathname: string): boolean {
  return RUNNER_MACHINE_AUTH_PATHS.has(pathname);
}

export function isPublicInfrastructurePath(pathname: string): boolean {
  if (
    isPathOrDescendant(pathname, "/_next") ||
    pathname === "/favicon.ico" ||
    pathname === "/health"
  ) {
    return true;
  }

  return !isPathOrDescendant(pathname, "/api") && STATIC_ASSET_EXTENSION_PATTERN.test(pathname);
}

export function isBrowserApiPath(pathname: string): boolean {
  return isPathOrDescendant(pathname, "/api");
}

function isPathOrDescendant(pathname: string, path: string): boolean {
  return pathname === path || pathname.startsWith(`${path}/`);
}

function configuredValue(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") {
    return null;
  }

  return value.trim();
}
