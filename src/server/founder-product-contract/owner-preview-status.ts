import type { FounderOwnerPreviewAccess } from "./release-stage-access";

type FounderPreviewStatusBase = {
  state: "waiting" | "active" | "limited";
  availableCapabilities: readonly string[];
  evidenceClassification: "Learning Round";
  automaticPromotion: false;
};

export type FounderOwnerPreviewStatus =
  | (FounderPreviewStatusBase & {
      stage: "Owner Preview";
      supportBoundary: "Fully attended";
    })
  | (FounderPreviewStatusBase & {
      stage: "Trusted Preview";
      supportBoundary: "Attended onboarding and observation";
      cohortSlot?: 1 | 2 | 3;
      founderAcceptanceEligible: false;
    });

export function projectFounderOwnerPreviewStatus(
  access: FounderOwnerPreviewAccess,
): FounderOwnerPreviewStatus {
  const availableCapabilities = [
    ...(access.availableCapabilities.includes("openai") ? ["OpenAI"] : []),
    ...(access.availableCapabilities.includes("calendar_reading") ? ["Calendar reading"] : []),
  ];
  if (access.stage === "trusted_preview") {
    return {
      stage: "Trusted Preview",
      state: !access.admitted
        ? "waiting"
        : availableCapabilities.length === 2
          ? "active"
          : "limited",
      availableCapabilities,
      supportBoundary: "Attended onboarding and observation",
      evidenceClassification: "Learning Round",
      automaticPromotion: false,
      ...(access.cohortSlot ? { cohortSlot: access.cohortSlot } : {}),
      founderAcceptanceEligible: false,
    };
  }
  return {
    stage: "Owner Preview",
    state: !access.admitted ? "waiting" : availableCapabilities.length === 2 ? "active" : "limited",
    availableCapabilities,
    supportBoundary: "Fully attended",
    evidenceClassification: "Learning Round",
    automaticPromotion: false,
  };
}
