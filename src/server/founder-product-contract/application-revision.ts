import "server-only";

export function readExecutingFounderApplicationRevision(
  environment: Record<string, string | undefined> = process.env,
): string | null {
  const applicationRevision = environment.VERCEL_GIT_COMMIT_SHA?.trim() ?? "";
  return /^[a-f0-9]{40}$/.test(applicationRevision) ? applicationRevision : null;
}

export function requireExecutingFounderApplicationRevision(
  environment: Record<string, string | undefined> = process.env,
): string {
  const applicationRevision = readExecutingFounderApplicationRevision(environment);
  if (!applicationRevision) {
    throw new Error("Executing Founder application revision is unavailable.");
  }
  return applicationRevision;
}
