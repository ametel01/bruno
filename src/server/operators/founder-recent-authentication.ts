import { auth } from "@clerk/nextjs/server";
import { resolveAuthMode } from "@/src/auth/auth-mode";
import { evaluateOperatorAccess } from "@/src/auth/operator-access";

/**
 * Sensitive Founder controls use the same recent-authentication boundary in
 * every route. Development and operator modes represent an authenticated
 * local/operator request; Clerk requests must satisfy Clerk's strict
 * reverification policy. A freshly rotated session token is not proof that the
 * Founder verified a credential again.
 */
export async function requireRecentFounderAuthentication(
  request: Request,
  pathname: string,
): Promise<boolean> {
  const env = process.env;
  const mode = resolveAuthMode(env);
  if (mode.mode === "development") {
    // Local development is already restricted to loopback/verified preview by
    // resolveAuthMode. Never treat an explicitly public production
    // development deployment as recently reauthenticated: its controls must
    // fail closed until a real Clerk session is configured.
    return !(env.BRUNO_ALLOW_PUBLIC_DEVELOPMENT === "true" && env.VERCEL_ENV === "production");
  }
  if (mode.mode === "operator") {
    return evaluateOperatorAccess({
      pathname,
      authorizationHeader: request.headers.get("authorization"),
      env,
    }).ok;
  }
  if (mode.mode !== "clerk") return false;

  const { userId, has } = await auth();
  return userId !== null && has({ reverification: "strict" });
}
