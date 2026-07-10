import { clerkMiddleware, type ClerkMiddlewareAuth } from "@clerk/nextjs/server";
import type { NextFetchEvent } from "next/server";
import { NextResponse, type NextRequest } from "next/server";
import {
  isBrowserApiPath,
  isClerkAuthPagePath,
  isPublicInfrastructurePath,
  isRunnerMachineAuthPath,
  resolveClerkTransition,
} from "@/src/auth/clerk-transition";
import { evaluateOperatorAccess, type OperatorAccessDecision } from "@/src/auth/operator-access";

const AUTHENTICATE_HEADER = 'Basic realm="AgentBay"';

const clerkSessionProxy = clerkMiddleware(handleClerkSessionRequest, {
  signInUrl: "/sign-in",
  signUpUrl: "/sign-up",
});

export async function proxy(request: NextRequest, event: NextFetchEvent): Promise<Response> {
  const pathname = request.nextUrl.pathname;
  const operatorDecision = evaluateOperatorAccess({
    pathname,
    authorizationHeader: request.headers.get("authorization"),
    env: process.env,
  });

  if (!operatorDecision.ok) {
    return operatorAccessResponse(request, operatorDecision);
  }

  if (isRunnerMachineAuthPath(pathname) || isPublicInfrastructurePath(pathname)) {
    return NextResponse.next();
  }

  const transition = resolveClerkTransition(process.env);

  if (transition.mode === "operator") {
    return NextResponse.next();
  }

  if (transition.mode === "invalid") {
    return authConfigurationResponse(request, transition.code);
  }

  return (await clerkSessionProxy(request, event)) ?? NextResponse.next();
}

export default proxy;

export async function handleClerkSessionRequest(auth: ClerkMiddlewareAuth, request: NextRequest) {
  if (isClerkAuthPagePath(request.nextUrl.pathname)) {
    return NextResponse.next();
  }

  const authState = await auth();

  if (authState.isAuthenticated) {
    return NextResponse.next();
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

function authConfigurationResponse(
  request: NextRequest,
  code: "invalid_auth_transition_mode" | "clerk_auth_not_configured",
) {
  const message =
    code === "clerk_auth_not_configured"
      ? "Authentication is not configured."
      : "Authentication mode is not configured safely.";

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
