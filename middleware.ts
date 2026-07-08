import { NextResponse, type NextRequest } from "next/server";
import { evaluateOperatorAccess } from "@/src/auth/operator-access";

const AUTHENTICATE_HEADER = 'Basic realm="AgentBay"';

export function middleware(request: NextRequest) {
  const decision = evaluateOperatorAccess({
    pathname: request.nextUrl.pathname,
    authorizationHeader: request.headers.get("authorization"),
    env: process.env,
  });

  if (decision.ok) {
    return NextResponse.next();
  }

  if (request.nextUrl.pathname.startsWith("/api/")) {
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

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
