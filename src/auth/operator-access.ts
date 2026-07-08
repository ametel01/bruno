const DEFAULT_OPERATOR_USERNAME = "agentbay";

const STATIC_ASSET_EXTENSION_PATTERN =
  /\.(?:avif|css|gif|ico|jpeg|jpg|js|json|map|png|svg|txt|webmanifest|webp|woff|woff2)$/i;

export type OperatorAccessDecision =
  | { ok: true }
  | {
      ok: false;
      status: 401 | 503;
      code: "operator_auth_required" | "operator_auth_not_configured";
    };

export function evaluateOperatorAccess(input: {
  pathname: string;
  authorizationHeader: string | null;
  env: Record<string, string | undefined>;
}): OperatorAccessDecision {
  if (!isOperatorProtectedPath(input.pathname)) {
    return { ok: true };
  }

  const password = configuredValue(input.env.AGENTBAY_OPERATOR_PASSWORD);

  if (!password) {
    if (isProductionLikeEnvironment(input.env)) {
      return {
        ok: false,
        status: 503,
        code: "operator_auth_not_configured",
      };
    }

    return { ok: true };
  }

  const credentials = parseBasicAuthorization(input.authorizationHeader);
  const username =
    configuredValue(input.env.AGENTBAY_OPERATOR_USERNAME) ?? DEFAULT_OPERATOR_USERNAME;

  if (
    credentials &&
    constantTimeEqual(credentials.username, username) &&
    constantTimeEqual(credentials.password, password)
  ) {
    return { ok: true };
  }

  return {
    ok: false,
    status: 401,
    code: "operator_auth_required",
  };
}

export function isOperatorProtectedPath(pathname: string): boolean {
  if (isOperatorPublicPath(pathname)) {
    return false;
  }

  return (
    pathname === "/" ||
    isPathOrDescendant(pathname, "/dashboard") ||
    isPathOrDescendant(pathname, "/agents") ||
    isPathOrDescendant(pathname, "/settings") ||
    isPathOrDescendant(pathname, "/api")
  );
}

function isOperatorPublicPath(pathname: string): boolean {
  if (
    isPathOrDescendant(pathname, "/_next") ||
    isPathOrDescendant(pathname, "/runner/v1") ||
    pathname === "/favicon.ico" ||
    pathname === "/health"
  ) {
    return true;
  }

  return !isPathOrDescendant(pathname, "/api") && STATIC_ASSET_EXTENSION_PATTERN.test(pathname);
}

function isPathOrDescendant(pathname: string, path: string): boolean {
  return pathname === path || pathname.startsWith(`${path}/`);
}

function configuredValue(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") {
    return null;
  }

  return value;
}

function isProductionLikeEnvironment(env: Record<string, string | undefined>): boolean {
  return env.VERCEL === "1" || env.VERCEL_ENV === "production" || env.NODE_ENV === "production";
}

function parseBasicAuthorization(
  authorizationHeader: string | null,
): { username: string; password: string } | null {
  if (!authorizationHeader) {
    return null;
  }

  const match = /^Basic\s+(.+)$/i.exec(authorizationHeader.trim());

  if (!match) {
    return null;
  }

  const encodedCredentials = match[1];

  if (!encodedCredentials) {
    return null;
  }

  try {
    const decoded = globalThis.atob(encodedCredentials);
    const separatorIndex = decoded.indexOf(":");

    if (separatorIndex < 0) {
      return null;
    }

    return {
      username: decoded.slice(0, separatorIndex),
      password: decoded.slice(separatorIndex + 1),
    };
  } catch {
    return null;
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const maxLength = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;

  for (let index = 0; index < maxLength; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }

  return difference === 0;
}
