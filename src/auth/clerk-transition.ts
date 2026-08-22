const STATIC_ASSET_EXTENSION_PATTERN =
  /\.(?:avif|css|gif|ico|jpeg|jpg|js|json|map|png|svg|txt|webmanifest|webp|woff|woff2)$/i;

const RUNNER_MACHINE_AUTH_PATHS = new Set([
  "/runner/v1/register",
  "/runner/v1/heartbeat",
  "/runner/v1/bootstrap-events",
]);

const INTERNAL_SERVICE_AUTH_PATHS = new Set([
  "/api/internal/agent-deployments/reconcile",
  "/api/internal/agent-deployments/wakeup",
  "/api/internal/agent-runtime/reconcile",
  "/api/internal/cold-deployment-slo/evaluate",
  "/api/internal/hermes-staging/acceptance",
  "/api/internal/hermes-staging/reconcile",
  "/api/internal/operator/commerce",
  "/api/internal/production-rollout/status",
  "/api/internal/runner-infrastructure/reconcile",
  "/api/internal/runner-release/required",
  "/api/internal/runner-replacements/reconcile",
  "/api/webhooks/lemon-squeezy",
]);

export function isClerkAuthPagePath(pathname: string): boolean {
  return isPathOrDescendant(pathname, "/sign-in") || isPathOrDescendant(pathname, "/sign-up");
}

export function isPublicMarketingPath(pathname: string): boolean {
  return pathname === "/";
}

export function isRunnerMachineAuthPath(pathname: string): boolean {
  return RUNNER_MACHINE_AUTH_PATHS.has(pathname);
}

export function isInternalServiceAuthPath(pathname: string): boolean {
  return INTERNAL_SERVICE_AUTH_PATHS.has(pathname);
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
