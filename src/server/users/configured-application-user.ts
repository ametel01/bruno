import "server-only";

import { auth } from "@clerk/nextjs/server";
import { headers } from "next/headers";
import { type AuthModeConfigurationErrorCode, resolveAuthMode } from "@/src/auth/server-auth-mode";
import { resolveFounderContractIdentity } from "@/src/server/founder-product-contract/deterministic-identity";
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
  getRequestHeaders?: () => Promise<Pick<Headers, "get">>;
  requireUser?: RequireUser;
};

export async function requireConfiguredApplicationUser(
  dependencies: RequireConfiguredApplicationUserDependencies = {},
): Promise<ConfiguredApplicationUserResolution> {
  const environment = dependencies.env ?? process.env;
  const authMode = resolveAuthMode(environment);

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

  if (
    authMode.mode === "development" &&
    environment.BRUNO_FOUNDER_CONTRACT_PROVIDER_MODE === "deterministic"
  ) {
    const requestHeaders = await (dependencies.getRequestHeaders ?? headers)();
    const contractIdentity = resolveFounderContractIdentity(requestHeaders, environment);
    if (contractIdentity.present) {
      if (!contractIdentity.valid) {
        return { ok: false, status: 401, code: "unauthenticated" };
      }
      resolverDependencies.getClerkUserId = async () => contractIdentity.subject;
      return await requireUser("clerk", resolverDependencies);
    }
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
