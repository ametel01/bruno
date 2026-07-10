import "server-only";

import { auth } from "@clerk/nextjs/server";
import { resolveClerkTransition } from "@/src/auth/clerk-transition";
import {
  type ApplicationUserResolution,
  type RequireApplicationUserDependencies,
  requireApplicationUser,
} from "@/src/server/users/application-user";

export type OperationalApplicationUserResolution =
  | ApplicationUserResolution
  | {
      ok: false;
      status: 503;
      code: "clerk_auth_not_configured" | "invalid_auth_transition_mode";
    };

type RequireUser = typeof requireApplicationUser;

export type RequireOperationalApplicationUserDependencies = {
  env?: Record<string, string | undefined>;
  createConnection?: RequireApplicationUserDependencies["createConnection"];
  getClerkUserId?: RequireApplicationUserDependencies["getClerkUserId"];
  requireUser?: RequireUser;
};

export async function requireOperationalApplicationUser(
  dependencies: RequireOperationalApplicationUserDependencies = {},
): Promise<OperationalApplicationUserResolution> {
  const transition = resolveClerkTransition(dependencies.env ?? process.env);

  if (transition.mode === "invalid") {
    return { ok: false, status: 503, code: transition.code };
  }

  const requireUser = dependencies.requireUser ?? requireApplicationUser;
  const resolverDependencies: RequireApplicationUserDependencies = {};

  if (dependencies.createConnection) {
    resolverDependencies.createConnection = dependencies.createConnection;
  }

  if (transition.mode === "clerk") {
    resolverDependencies.getClerkUserId = dependencies.getClerkUserId ?? getClerkRequestUserId;
  }

  return await requireUser(
    transition.mode === "operator" ? "development" : "clerk",
    resolverDependencies,
  );
}

async function getClerkRequestUserId(): Promise<string | null> {
  const { userId } = await auth();
  return userId;
}
