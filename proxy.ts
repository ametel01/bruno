import { type ClerkMiddlewareAuth, clerkMiddleware } from "@clerk/nextjs/server";
import type { NextFetchEvent } from "next/server";
import { type NextRequest, NextResponse } from "next/server";
import {
  isBrowserApiPath,
  isClerkAuthPagePath,
  isInternalServiceAuthPath,
  isPublicInfrastructurePath,
  isPublicMarketingPath,
  isRunnerMachineAuthPath,
} from "@/src/auth/clerk-transition";
import { evaluateLegacyFounderSurface } from "@/src/auth/legacy-founder-surface";
import { evaluateOperatorAccess, type OperatorAccessDecision } from "@/src/auth/operator-access";
import {
  type AuthModeConfigurationErrorCode,
  authModeConfigurationMessage,
  resolveAuthMode,
} from "@/src/auth/server-auth-mode";

const AUTHENTICATE_HEADER = 'Basic realm="bruno"';

const clerkSessionProxy = clerkMiddleware(handleClerkSessionRequest, {
  signInUrl: "/sign-in",
  signUpUrl: "/sign-up",
});

export async function proxy(request: NextRequest, event: NextFetchEvent): Promise<Response> {
  const pathname = request.nextUrl.pathname;
  const legacySurface = evaluateLegacyFounderSurface(pathname);

  if (legacySurface.kind === "retired_page") {
    return NextResponse.redirect(new URL(legacySurface.destination, request.url));
  }

  if (legacySurface.kind === "retired_api") {
    return NextResponse.json(
      {
        error: {
          code: "legacy_founder_surface_retired",
          message: "This legacy setup surface is no longer available. Use the Founder workspace.",
        },
      },
      { status: 410, headers: { "Cache-Control": "no-store" } },
    );
  }

  const operatorDecision = evaluateOperatorAccess({
    pathname,
    authorizationHeader: request.headers.get("authorization"),
    env: process.env,
  });

  if (!operatorDecision.ok) {
    return operatorAccessResponse(request, operatorDecision);
  }

  if (
    isRunnerMachineAuthPath(pathname) ||
    isInternalServiceAuthPath(pathname) ||
    isPublicInfrastructurePath(pathname) ||
    isPublicMarketingPath(pathname) ||
    isClerkAuthPagePath(pathname)
  ) {
    return NextResponse.next();
  }

  const authMode = resolveAuthMode(process.env);

  if (authMode.mode === "development" || authMode.mode === "operator") {
    return NextResponse.next();
  }

  if (authMode.mode === "invalid") {
    return authConfigurationResponse(request, authMode.code);
  }

  return (await clerkSessionProxy(request, event)) ?? NextResponse.next();
}

export default proxy;

export async function handleClerkSessionRequest(auth: ClerkMiddlewareAuth, request: NextRequest) {
  if (isClerkAuthPagePath(request.nextUrl.pathname)) {
    return;
  }

  const authState = await auth();

  if (authState.isAuthenticated) {
    return;
  }

  if (isBrowserApiPath(request.nextUrl.pathname)) {
    return NextResponse.json(
      {
        error: {
          code: "clerk_auth_required",
          message: "Authentication is required.",
        },
      },
      { status: 401 },
    );
  }

  return authState.redirectToSignIn({ returnBackUrl: request.url });
}

function operatorAccessResponse(
  request: NextRequest,
  decision: Exclude<OperatorAccessDecision, { ok: true }>,
) {
  if (isBrowserApiPath(request.nextUrl.pathname)) {
    const response = NextResponse.json(
      {
        error: {
          code: decision.code,
          message:
            decision.code === "operator_auth_not_configured"
              ? "Operator access is not configured."
              : "Operator credentials are required.",
        },
      },
      { status: decision.status },
    );

    if (decision.status === 401) {
      response.headers.set("WWW-Authenticate", AUTHENTICATE_HEADER);
    }

    return response;
  }

  const response = new NextResponse(
    decision.code === "operator_auth_not_configured"
      ? "Operator access is not configured."
      : "Operator credentials are required.",
    {
      status: decision.status,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
      },
    },
  );

  if (decision.status === 401) {
    response.headers.set("WWW-Authenticate", AUTHENTICATE_HEADER);
  }

  return response;
}

function authConfigurationResponse(request: NextRequest, code: AuthModeConfigurationErrorCode) {
  const message = authModeConfigurationMessage(code);

  if (isBrowserApiPath(request.nextUrl.pathname)) {
    return NextResponse.json({ error: { code, message } }, { status: 503 });
  }

  return new NextResponse(message, {
    status: 503,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
