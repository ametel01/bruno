import "server-only";

import { desc, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type * as schema from "@/src/server/db/schema";
import { createDatabaseConnection, type DatabaseConnection } from "@/src/server/db/client";
import {
  operatorAiConnections,
  operatorCalendarConnections,
  operatorFounderActivations,
  operatorLimitedOperations,
  operatorMailConnections,
  operatorPreparations,
  operatorPrimaryCommunicationsSuites,
  operatorRuntimes,
  operators,
} from "@/src/server/db/schema";
import { ensureFounderOperatorForUser } from "@/src/server/operators/founder-operator";
import { isFounderGoogleMailReadingReleased } from "@/src/server/operators/founder-mail-connection";

type OnboardingTransaction = Parameters<
  Parameters<PostgresJsDatabase<typeof schema>["transaction"]>[0]
>[0];

export type FounderOnboardingStep =
  | "timezone"
  | "runtime"
  | "ai"
  | "calendar"
  | "mail"
  | "consent"
  | "brief"
  | "activation"
  | "conversation";

export type FounderCapabilityState =
  | "ready"
  | "missing"
  | "authorizing"
  | "stale"
  | "mismatch"
  | "deferred"
  | "not_offered";

export type FounderOnboardingDto = {
  nextStep: FounderOnboardingStep;
  defaultRoute: string;
  activated: boolean;
  operation: "none" | "calendar_limited" | "core";
  capabilities: {
    ai: FounderCapabilityState;
    calendar: FounderCapabilityState;
    mail: FounderCapabilityState;
    core: FounderCapabilityState;
  };
  facts: {
    timezoneConfirmed: boolean;
    runtimeReady: boolean;
    processingConsent: boolean;
    firstBriefReady: boolean;
    primarySuiteIdentity: string | null;
  };
};

export type FounderOnboardingDependencies = {
  createConnection?: () => DatabaseConnection;
  now?: () => Date;
  env?: Record<string, string | undefined>;
};

export async function getFounderOnboardingForUser(
  userId: string,
  dependencies: FounderOnboardingDependencies = {},
): Promise<FounderOnboardingDto> {
  const operator = await ensureFounderOperatorForUser(userId, dependencies);
  return withConnection(dependencies, async (connection) =>
    connection.db.transaction(async (tx) => {
      const [preparation] = await tx
        .select()
        .from(operatorPreparations)
        .where(eq(operatorPreparations.operatorId, operator.id))
        .limit(1);
      const [runtime] = await tx
        .select()
        .from(operatorRuntimes)
        .where(eq(operatorRuntimes.operatorId, operator.id))
        .limit(1);
      const [ai] = await tx
        .select()
        .from(operatorAiConnections)
        .where(eq(operatorAiConnections.operatorId, operator.id))
        .orderBy(desc(operatorAiConnections.updatedAt))
        .limit(1);
      const [calendar] = await tx
        .select()
        .from(operatorCalendarConnections)
        .where(eq(operatorCalendarConnections.operatorId, operator.id))
        .orderBy(desc(operatorCalendarConnections.updatedAt))
        .limit(1);
      const [mail] = await tx
        .select()
        .from(operatorMailConnections)
        .where(eq(operatorMailConnections.operatorId, operator.id))
        .orderBy(desc(operatorMailConnections.updatedAt))
        .limit(1);
      const [suite] = await tx
        .select()
        .from(operatorPrimaryCommunicationsSuites)
        .where(eq(operatorPrimaryCommunicationsSuites.operatorId, operator.id))
        .limit(1);
      const [operation] = await tx
        .select()
        .from(operatorLimitedOperations)
        .where(eq(operatorLimitedOperations.operatorId, operator.id))
        .limit(1);
      const [activation] = await tx
        .select()
        .from(operatorFounderActivations)
        .where(eq(operatorFounderActivations.operatorId, operator.id))
        .limit(1);
      const mailReleased = isFounderGoogleMailReadingReleased(dependencies.env);

      const timezoneConfirmed = Boolean(preparation?.timezone && preparation.timezoneConfirmedAt);
      const runtimeReady = runtime?.status === "ready";
      const aiState: FounderCapabilityState = !ai
        ? "missing"
        : ai.status === "ready"
          ? "ready"
          : ai.status === "authorizing" || ai.status === "verifying"
            ? "authorizing"
            : "missing";
      const calendarState: FounderCapabilityState = !calendar
        ? "missing"
        : calendar.status !== "ready"
          ? calendar.status === "authorizing" ||
            calendar.status === "selecting" ||
            calendar.status === "verifying"
            ? "authorizing"
            : "missing"
          : calendar.evidenceState === "current"
            ? "ready"
            : "stale";
      const mailState: FounderCapabilityState = !mailReleased
        ? "not_offered"
        : !mail
          ? "missing"
          : mail.status !== "ready"
            ? mail.status === "authorizing" ||
              mail.status === "selecting" ||
              mail.status === "verifying"
              ? "authorizing"
              : "missing"
            : mail.evidenceState !== "current"
              ? "stale"
              : mail.suiteStatus !== "matched"
                ? "mismatch"
                : "ready";
      const mailDeferred =
        !mail && Boolean((await selectMailDisposition(tx, operator.id)) === "dismissed");
      const effectiveMailState = mailDeferred ? "deferred" : mailState;
      const suiteActive = suite?.status === "active" && suite.providerSubjectId != null;
      const sameSuiteIdentity = Boolean(
        suiteActive &&
          aiState === "ready" &&
          calendarState === "ready" &&
          effectiveMailState === "ready" &&
          calendar?.providerSubjectId &&
          mail?.providerSubjectId &&
          calendar.providerSubjectId === mail.providerSubjectId,
      );
      const coreState: FounderCapabilityState = sameSuiteIdentity
        ? operation?.status === "core"
          ? "ready"
          : "missing"
        : calendarState === "stale" || effectiveMailState === "stale"
          ? "stale"
          : effectiveMailState === "mismatch"
            ? "mismatch"
            : "missing";

      let nextStep: FounderOnboardingStep;
      if (!timezoneConfirmed) nextStep = "timezone";
      else if (!runtimeReady) nextStep = "runtime";
      else if (aiState !== "ready") nextStep = "ai";
      else if (calendarState !== "ready") nextStep = "calendar";
      else if (!mailDeferred && mailReleased && effectiveMailState !== "ready") nextStep = "mail";
      else if (sameSuiteIdentity && operation?.status !== "core" && !operation?.processingConsentId)
        nextStep = "consent";
      else if (operation?.status === "core" && !operation.firstBriefId) nextStep = "brief";
      else if (operation?.status === "limited" && !operation.firstBriefId && !mailDeferred)
        nextStep = "brief";
      else if (!operation?.processingConsentId) nextStep = "consent";
      else if (!operation?.firstBriefId) nextStep = "brief";
      else if (!activation) nextStep = "activation";
      else nextStep = "conversation";

      const operationKind = operation?.mailConnectionId
        ? "core"
        : operation?.status === "limited"
          ? "calendar_limited"
          : "none";
      return {
        nextStep,
        defaultRoute:
          nextStep === "conversation"
            ? "/operator#conversation"
            : `/operator#onboarding-${nextStep}`,
        activated: Boolean(activation),
        operation: operationKind,
        capabilities: {
          ai: aiState,
          calendar: calendarState,
          mail: effectiveMailState,
          core: coreState,
        },
        facts: {
          timezoneConfirmed,
          runtimeReady,
          processingConsent: Boolean(operation?.processingConsentId),
          firstBriefReady: Boolean(operation?.firstBriefId),
          primarySuiteIdentity: suite?.providerSubjectId ?? null,
        },
      };
    }),
  );
}

async function selectMailDisposition(tx: OnboardingTransaction, operatorId: string) {
  const [operator] = await tx
    .select({ disposition: operators.mailOfferDisposition })
    .from(operators)
    .where(eq(operators.id, operatorId))
    .limit(1);
  return operator?.disposition ?? null;
}

async function withConnection<T>(
  dependencies: FounderOnboardingDependencies,
  callback: (connection: DatabaseConnection) => Promise<T>,
): Promise<T> {
  const connection = dependencies.createConnection?.() ?? createDatabaseConnection();
  const ownsConnection = !dependencies.createConnection;
  try {
    return await callback(connection);
  } finally {
    if (ownsConnection) await connection.close();
  }
}
