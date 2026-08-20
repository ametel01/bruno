export const TEST_GOOGLE_RELEASE_REVISION = "a".repeat(40);

export function buildTestGoogleConnectedAcceptanceRelease(
  capability: "calendar_reading" | "gmail_reading",
  now = new Date(),
  revision = TEST_GOOGLE_RELEASE_REVISION,
): string {
  return JSON.stringify({
    schemaVersion: "bruno.founder-google-connected-acceptance.v1",
    outcome: "passed",
    provider: "google",
    capability,
    accountClass: "founder_owned_google_account",
    authorizationRoute: "google_oauth_web_server",
    policyVersion: 1,
    sourceRevision: revision,
    operatorReleaseRevision: revision,
    qualifiedAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
    expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    evidenceDigest: `sha256:${"c".repeat(64)}`,
    gates: {
      returnedScopes: true,
      immutableSubjectIdentity: true,
      selectedResourceNarrowing: true,
      zeroAndPopulatedResults: true,
      refreshPersistsAfterRestart: true,
      omittedRefreshTokenPreserved: true,
      denialPartialExpiryAdminAndStale: true,
      revocationAndReauthorization: true,
      siblingRevocationIsolation: true,
      cleanup: true,
      ...(capability === "gmail_reading"
        ? {
            restrictedScopeVerification: true,
            casaDisposition: true,
            aiLimitedUse: true,
            retentionDeletionDisclosure: true,
          }
        : {}),
    },
  });
}
