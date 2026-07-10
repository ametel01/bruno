import "server-only";

import { auth } from "@clerk/nextjs/server";
import {
  type ApplicationUserResolution,
  type RequireApplicationUserDependencies,
  requireApplicationUser,
} from "@/src/server/users/application-user";

export type RequireClerkApplicationUserDependencies = Omit<
  RequireApplicationUserDependencies,
  "getClerkUserId"
>;

export async function requireClerkApplicationUser(
  dependencies: RequireClerkApplicationUserDependencies = {},
): Promise<ApplicationUserResolution> {
  return await requireApplicationUser("clerk", {
    ...dependencies,
    getClerkUserId: getClerkRequestUserId,
  });
}

async function getClerkRequestUserId(): Promise<string | null> {
  const { userId } = await auth();
  return userId;
}
