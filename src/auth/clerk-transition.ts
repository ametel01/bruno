const STATIC_ASSET_EXTENSION_PATTERN =
  /\.(?:avif|css|gif|ico|jpeg|jpg|js|json|map|png|svg|txt|webmanifest|webp|woff|woff2)$/i;

const RUNNER_MACHINE_AUTH_PATHS = new Set([
  "/runner/v1/register",
  "/runner/v1/heartbeat",
  "/runner/v1/bootstrap-events",
]);

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
