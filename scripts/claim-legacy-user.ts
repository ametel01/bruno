import { claimLegacyUser, type LegacyUserClaimResult } from "@/src/server/users/legacy-user-claim";

export type LegacyUserClaimCliOptions = {
  clerkUserId: string;
  apply: boolean;
};

export function parseLegacyUserClaimArgs(args: string[]): LegacyUserClaimCliOptions {
  let clerkUserId: string | undefined;
  let executionMode: "apply" | "dry-run" | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--clerk-user-id") {
      if (clerkUserId !== undefined) {
        throw new Error("--clerk-user-id may only be provided once.");
      }

      const value = args[index + 1];
      if (!value) {
        throw new Error("--clerk-user-id requires a value.");
      }
      if (value.startsWith("-")) {
        throw new Error("--clerk-user-id requires a non-option value.");
      }
      clerkUserId = value;
      index += 1;
      continue;
    }

    if (arg === "--apply" || arg === "--dry-run") {
      if (executionMode !== undefined) {
        throw new Error("Execution mode may only be specified once.");
      }

      executionMode = arg === "--apply" ? "apply" : "dry-run";
      continue;
    }

    throw new Error("Unknown argument.");
  }

  if (!clerkUserId) {
    throw new Error("--clerk-user-id is required.");
  }

  return { clerkUserId, apply: executionMode === "apply" };
}

export async function runLegacyUserClaimCli(
  args: string[],
  dependencies: {
    claim?: typeof claimLegacyUser;
    write?: (value: string) => void;
  } = {},
): Promise<LegacyUserClaimResult> {
  const options = parseLegacyUserClaimArgs(args);
  const result = await (dependencies.claim ?? claimLegacyUser)({
    clerkUserId: options.clerkUserId,
    apply: options.apply,
  });
  (dependencies.write ?? console.log)(JSON.stringify(result));
  return result;
}

if (import.meta.main) {
  await runLegacyUserClaimCli(process.argv.slice(2));
}
