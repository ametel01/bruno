export const FOUNDER_PRODUCT_CONTRACT_SCHEMA_VERSION = "bruno.founder-product-contract.v1" as const;

export const FOUNDER_PRODUCT_CONTRACT_INVARIANTS = [
  {
    id: "one_operator_resumable",
    kind: "automated",
    evidence: ["tests/unit/founder-operator.test.ts", "tests/e2e/founder-product-contract.spec.ts"],
  },
  {
    id: "limited_core_transitions",
    kind: "automated",
    evidence: [
      "tests/unit/founder-limited-operation.test.ts",
      "tests/unit/founder-core-operation.test.ts",
    ],
  },
  {
    id: "independent_capability_degradation",
    kind: "automated",
    evidence: [
      "tests/unit/founder-external-beta-qualification.test.ts",
      "tests/unit/founder-operator-page.test.tsx",
      "tests/unit/founder-ai-routing.test.ts",
      "tests/unit/founder-calendar-connection.test.ts",
      "tests/unit/founder-mail-connection.test.ts",
    ],
  },
  {
    id: "canonical_cross_device_decisions",
    kind: "automated",
    evidence: [
      "tests/unit/founder-proposed-actions.test.ts",
      "tests/unit/founder-commerce-db.test.ts",
      "tests/unit/founder-commerce-routes.test.ts",
    ],
  },
  {
    id: "exact_and_uncertain_effects",
    kind: "automated",
    evidence: [
      "tests/unit/founder-mail-execution.test.ts",
      "tests/unit/lemon-squeezy-commerce.test.ts",
      "tests/unit/founder-commerce-db.test.ts",
    ],
  },
  {
    id: "subscription_lifecycle",
    kind: "automated",
    evidence: [
      "tests/e2e/founder-product-contract-lifecycle.spec.ts",
      "tests/unit/founder-commerce-db.test.ts",
      "tests/unit/founder-product-entitlement-policy.test.ts",
      "tests/unit/founder-payment-status.test.tsx",
    ],
  },
  {
    id: "privacy_lifecycle",
    kind: "automated",
    evidence: [
      "tests/unit/founder-data-export.test.ts",
      "tests/unit/founder-deletion-db.test.ts",
      "tests/unit/founder-retention-db.test.ts",
    ],
  },
  {
    id: "recovery_and_support",
    kind: "automated",
    evidence: [
      "tests/unit/founder-recovery.test.ts",
      "tests/unit/founder-recovery-archive-crypto.test.ts",
      "tests/unit/founder-recovery-archive-lifecycle.test.ts",
      "tests/unit/founder-owner-preview-promotion.test.ts",
      "tests/unit/founder-trusted-preview-admission.test.ts",
      "tests/unit/founder-trusted-preview-promotion.test.ts",
      "tests/unit/founder-external-beta-admission.test.ts",
      "tests/unit/founder-external-beta-promotion.test.ts",
      "tests/unit/founder-external-beta-ui.test.tsx",
      "tests/unit/founder-external-beta-route.test.ts",
      "tests/unit/founder-support.test.ts",
    ],
  },
  {
    id: "forbidden_technical_surfaces",
    kind: "automated",
    evidence: ["tests/e2e/founder-product-contract.spec.ts"],
  },
  {
    id: "automated_accessibility_and_keyboard",
    kind: "automated",
    evidence: ["tests/e2e/founder-product-contract.spec.ts"],
  },
  {
    id: "voiceover_safari",
    kind: "attended",
    evidence: [],
  },
  {
    id: "talkback_chrome",
    kind: "attended",
    evidence: [],
  },
] as const;

export const FOUNDER_PRODUCT_CONTRACT_UNIT_FILES = [
  "tests/unit/founder-operator.test.ts",
  "tests/unit/founder-limited-operation.test.ts",
  "tests/unit/founder-core-operation.test.ts",
  "tests/unit/founder-ai-routing.test.ts",
  "tests/unit/founder-external-beta-qualification.test.ts",
  "tests/unit/founder-external-beta-manifest-route.test.ts",
  "tests/unit/founder-external-beta-manifest-ui.test.tsx",
  "tests/unit/founder-operator-page.test.tsx",
  "tests/unit/founder-calendar-connection.test.ts",
  "tests/unit/founder-mail-connection.test.ts",
  "tests/unit/founder-proposed-actions.test.ts",
  "tests/unit/founder-mail-execution.test.ts",
  "tests/unit/founder-data-export.test.ts",
  "tests/unit/founder-deletion-db.test.ts",
  "tests/unit/founder-retention-db.test.ts",
  "tests/unit/founder-recovery-archive-provider.test.ts",
  "tests/unit/founder-recovery-archive-crypto.test.ts",
  "tests/unit/founder-recovery-archive-lifecycle.test.ts",
  "tests/unit/founder-owner-preview-promotion.test.ts",
  "tests/unit/founder-trusted-preview-admission.test.ts",
  "tests/unit/founder-trusted-preview-promotion.test.ts",
  "tests/unit/founder-external-beta-admission.test.ts",
  "tests/unit/founder-external-beta-promotion.test.ts",
  "tests/unit/founder-external-beta-ui.test.tsx",
  "tests/unit/founder-external-beta-route.test.ts",
  "tests/unit/founder-recovery-archive-route.test.ts",
  "tests/unit/founder-product-entitlement-policy-db.test.ts",
  "tests/unit/founder-product-entitlement-policy.test.ts",
  "tests/unit/lemon-squeezy-commerce.test.ts",
  "tests/unit/founder-commerce-routes.test.ts",
  "tests/unit/founder-commerce-db.test.ts",
  "tests/unit/founder-payment-status.test.tsx",
  "tests/unit/founder-infrastructure-retirement.test.ts",
  "tests/unit/founder-recovery.test.ts",
  "tests/unit/founder-support.test.ts",
  "tests/unit/operator-access.test.ts",
  "tests/unit/founder-product-contract-application-evidence.test.ts",
  "tests/unit/founder-product-contract-candidate-history.test.ts",
  "tests/unit/founder-product-contract-runner.test.ts",
  "tests/unit/founder-product-contract-evidence.test.ts",
  "tests/unit/founder-product-contract-workflow.test.ts",
  "tests/unit/founder-general-release-decision.test.ts",
  "tests/unit/founder-product-contract-harness.test.ts",
  "tests/unit/backup-storage.test.ts",
] as const;

export const FOUNDER_PRODUCT_CONTRACT_LIFECYCLE_SCENARIOS = [
  "release_stage_admission",
  "external_beta_cohort_lifecycle",
  "product_entitlement_lifecycle",
  "subscription_lifecycle",
  "recovery_archive_lifecycle",
  "infrastructure_retirement",
] as const;

export const FOUNDER_PRODUCT_CONTRACT_ATTENDED_TASKS = [
  "resume_operator",
  "review_proposed_action",
  "approve_proposed_action",
  "deny_proposed_action",
] as const;

export const FOUNDER_PRODUCT_CONTRACT_BROWSER_PROJECTS = [
  "desktop-chrome",
  "desktop-firefox",
  "desktop-safari",
  "ios-safari",
  "android-chrome",
] as const;
