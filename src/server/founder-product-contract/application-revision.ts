import "server-only";

export type FounderApplicationRevisionDependencies = {
  applicationRevision?: string | null | undefined;
  env?: Record<string, string | undefined> | undefined;
};

export function readFounderApplicationRevision(
  dependencies: FounderApplicationRevisionDependencies = {},
): string | null {
  const environment = dependencies.env ?? process.env;
  const applicationRevision =
    dependencies.applicationRevision?.trim() ?? environment.VERCEL_GIT_COMMIT_SHA?.trim() ?? "";
  return /^[a-f0-9]{40}$/.test(applicationRevision) ? applicationRevision : null;
}

export function requireFounderApplicationRevision(
  dependencies: FounderApplicationRevisionDependencies = {},
  message = "Founder application revision is unavailable.",
): string {
  const applicationRevision = readFounderApplicationRevision(dependencies);
  if (!applicationRevision) {
    throw new Error(message);
  }
  return applicationRevision;
}
