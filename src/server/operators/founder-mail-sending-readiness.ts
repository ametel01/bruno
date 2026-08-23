import "server-only";

import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "@/src/server/db/schema";
import {
  operatorMailConnections,
  operatorMailSendingConnections,
  operatorPrimaryCommunicationsSuites,
} from "@/src/server/db/schema";

type FounderMailSendingReadinessTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

export const GOOGLE_MAIL_SENDING_PROVIDER = "google_gmail_sending" as const;
export const REQUIRED_MAIL_SENDING_SCOPE = "https://www.googleapis.com/auth/gmail.send" as const;

export async function selectUsableFounderMailSendingConnectionInTransaction(
  tx: FounderMailSendingReadinessTransaction,
  operatorId: string,
  at: Date,
) {
  const [sending] = await tx
    .select()
    .from(operatorMailSendingConnections)
    .where(
      and(
        eq(operatorMailSendingConnections.operatorId, operatorId),
        eq(operatorMailSendingConnections.provider, GOOGLE_MAIL_SENDING_PROVIDER),
        eq(operatorMailSendingConnections.status, "ready"),
        eq(operatorMailSendingConnections.authorizationState, "authorized"),
      ),
    )
    .limit(1);
  if (
    !sending?.accessTokenCiphertext ||
    !sending.refreshTokenCiphertext ||
    !sending.grantedScopes.includes(REQUIRED_MAIL_SENDING_SCOPE) ||
    sending.disconnectedAt ||
    sending.revokedAt ||
    !sending.tokenExpiresAt ||
    sending.tokenExpiresAt <= at
  ) {
    return null;
  }
  const [[mail], [suite]] = await Promise.all([
    tx
      .select()
      .from(operatorMailConnections)
      .where(eq(operatorMailConnections.operatorId, operatorId))
      .limit(1),
    tx
      .select()
      .from(operatorPrimaryCommunicationsSuites)
      .where(eq(operatorPrimaryCommunicationsSuites.operatorId, operatorId))
      .limit(1),
  ]);
  if (
    mail?.status !== "ready" ||
    mail.authorizationState !== "authorized" ||
    mail.revokedAt ||
    mail.providerSubjectId !== sending.providerSubjectId ||
    suite?.status !== "active" ||
    suite.mailConnectionId !== mail.id ||
    sending.mailConnectionId !== mail.id
  ) {
    return null;
  }
  return sending;
}
