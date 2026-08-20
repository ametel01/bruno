export const LEGACY_FOUNDER_PAGE_PATHS = ["/dashboard", "/agents", "/settings"] as const;

export const LEGACY_FOUNDER_API_PATHS = ["/api/agents", "/api/approvals", "/api/runners"] as const;

export type LegacyFounderSurfaceDecision =
  | { kind: "retired_page"; destination: "/operator" }
  | { kind: "retired_api" }
  | { kind: "available" };

export function evaluateLegacyFounderSurface(pathname: string): LegacyFounderSurfaceDecision {
  if (LEGACY_FOUNDER_PAGE_PATHS.some((path) => isPathOrDescendant(pathname, path))) {
    return { kind: "retired_page", destination: "/operator" };
  }

  if (LEGACY_FOUNDER_API_PATHS.some((path) => isPathOrDescendant(pathname, path))) {
    return { kind: "retired_api" };
  }

  return { kind: "available" };
}

function isPathOrDescendant(pathname: string, path: string): boolean {
  return pathname === path || pathname.startsWith(`${path}/`);
}
