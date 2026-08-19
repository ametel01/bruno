import { auth } from "@clerk/nextjs/server";
import { evaluateOperatorAccess } from "@/src/auth/operator-access";
import { resolveAuthMode } from "@/src/auth/auth-mode";

/**
 * Sensitive Founder controls use the same recent-authentication boundary in
 * every route. Development and operator modes represent an authenticated
 * local/operator request; Clerk requests must carry a session issued within
 * the last fifteen minutes.
 */
export async function requireRecentFounderAuthentication(
  request: Request,
  pathname: string,
): Promise<boolean> {
  const env = process.env;
  const mode = resolveAuthMode(env);
  if (mode.mode === "development") return true;
  if (mode.mode === "operator") {
    return evaluateOperatorAccess({
      pathname,
      authorizationHeader: request.headers.get("authorization"),
      env,
    }).ok;
  }
  if (mode.mode !== "clerk") return false;

  const { sessionClaims } = await auth();
  const issuedAt = (sessionClaims as unknown as { iat?: unknown } | null)?.iat;
  if (typeof issuedAt !== "number") return false;
  return Date.now() - issuedAt * 1000 <= 15 * 60 * 1000;
}
