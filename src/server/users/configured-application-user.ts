import "server-only";

import { auth } from "@clerk/nextjs/server";
import { type AuthModeConfigurationErrorCode, resolveAuthMode } from "@/src/auth/server-auth-mode";
import {
  type ApplicationUserResolution,
  type RequireApplicationUserDependencies,
  requireApplicationUser,
} from "@/src/server/users/application-user";

export type ConfiguredApplicationUserResolution =
  | ApplicationUserResolution
  | {
      ok: false;
      status: 503;
      code: AuthModeConfigurationErrorCode;
    };

type RequireUser = typeof requireApplicationUser;

export type RequireConfiguredApplicationUserDependencies = {
  env?: Record<string, string | undefined>;
  createConnection?: RequireApplicationUserDependencies["createConnection"];
  getClerkUserId?: RequireApplicationUserDependencies["getClerkUserId"];
  requireUser?: RequireUser;
};

export async function requireConfiguredApplicationUser(
  dependencies: RequireConfiguredApplicationUserDependencies = {},
): Promise<ConfiguredApplicationUserResolution> {
  const authMode = resolveAuthMode(dependencies.env ?? process.env);

  if (authMode.mode === "invalid") {
    return {
      ok: false,
      status: 503,
      code: authMode.code,
    };
  }

  const requireUser = dependencies.requireUser ?? requireApplicationUser;
  const resolverDependencies: RequireApplicationUserDependencies = {};

  if (dependencies.createConnection) {
    resolverDependencies.createConnection = dependencies.createConnection;
  }

  if (authMode.mode === "clerk") {
    resolverDependencies.getClerkUserId = dependencies.getClerkUserId ?? getClerkRequestUserId;
  }

  return await requireUser(authMode.mode, resolverDependencies);
}

async function getClerkRequestUserId(): Promise<string | null> {
  const { userId } = await auth();
  return userId;
}
