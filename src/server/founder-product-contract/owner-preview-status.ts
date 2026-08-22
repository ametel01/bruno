import type { FounderOwnerPreviewAccess } from "./release-stage-access";

export type FounderOwnerPreviewStatus = {
  stage: "Owner Preview";
  state: "waiting" | "active" | "limited";
  availableCapabilities: readonly string[];
  supportBoundary: "Fully attended";
  evidenceClassification: "Learning Round";
  automaticPromotion: false;
};

export function projectFounderOwnerPreviewStatus(
  access: FounderOwnerPreviewAccess,
): FounderOwnerPreviewStatus {
  const availableCapabilities = [
    ...(access.availableCapabilities.includes("openai") ? ["OpenAI"] : []),
    ...(access.availableCapabilities.includes("calendar_reading") ? ["Calendar reading"] : []),
  ];
  return {
    stage: "Owner Preview",
    state: !access.admitted ? "waiting" : availableCapabilities.length === 2 ? "active" : "limited",
    availableCapabilities,
    supportBoundary: "Fully attended",
    evidenceClassification: "Learning Round",
    automaticPromotion: false,
  };
}
