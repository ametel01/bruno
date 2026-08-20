export function buildTestGoogleMailSendingAcceptanceRelease(
  now = new Date(),
  revision = "a".repeat(40),
): string {
  const identityDigest = `sha256:${"d".repeat(64)}`;
  return JSON.stringify({
    schemaVersion: "bruno.founder-google-mail-sending-connected-acceptance.v1",
    outcome: "passed",
    provider: "google",
    capability: "gmail_sending",
    accountClass: "founder_owned_google_account",
    authorizationRoute: "google_oauth_web_server",
    deliveryRoute: "gmail_users_messages_send",
    requiredScope: "https://www.googleapis.com/auth/gmail.send",
    policyVersion: 1,
    sourceRevision: revision,
    operatorReleaseRevision: revision,
    qualifiedAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
    expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    readingIdentityDigest: identityDigest,
    sendingIdentityDigest: identityDigest,
    approvedMessageDigest: `sha256:${"e".repeat(64)}`,
    providerAcknowledgementDigest: `sha256:${"f".repeat(64)}`,
    deliveryVerificationDigest: `sha256:${"1".repeat(64)}`,
    evidenceDigest: `sha256:${"2".repeat(64)}`,
    gates: {
      sameImmutableIdentity: true,
      sendScopeOnly: true,
      persistedAfterRestart: true,
      approvedControlledMessage: true,
      providerAcknowledged: true,
      independentlyDelivered: true,
      exactlyOneCopy: true,
      uncertainNoSpeculativeResend: true,
      revocationIsolationAndRecovery: true,
      cleanup: true,
    },
  });
}
