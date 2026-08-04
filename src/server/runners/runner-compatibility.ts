import { and, eq, inArray, isNotNull, or, sql, type SQL } from "drizzle-orm";
import { RUNNER_BOOT_CONTRACT_VERSION } from "@/src/runner-service/constants";
import {
  parseImmutableRunnerImageReference,
  type RunnerReleaseIdentity,
} from "@/src/runner-service/release-identity";
import { runners } from "@/src/server/db/schema";
import {
  DIGITALOCEAN_PROVIDER,
  DIGITALOCEAN_RUNNER_KIND,
} from "@/src/server/runners/digitalocean-provider";

export const RUNNER_COMPATIBILITY_STATES = [
  "compatible",
  "unknown",
  "outdated",
  "invalid",
] as const;

export type RunnerCompatibilityState = (typeof RUNNER_COMPATIBILITY_STATES)[number];

export type RunnerCompatibilityReason =
  | "compatible"
  | "release_evidence_missing"
  | "required_release_unavailable"
  | "required_release_changed"
  | "image_digest_mismatch"
  | "release_version_mismatch"
  | "boot_contract_mismatch";

export type RunnerCompatibilityRequirement =
  | {
      mode: "hosted";
      release: RunnerReleaseIdentity;
    }
  | {
      mode: "local_docker";
      release: null;
    }
  | {
      mode: "unavailable";
      release: null;
    };

export type RunnerCompatibilityAssessment = {
  state: RunnerCompatibilityState;
  reason: RunnerCompatibilityReason;
  requiredImageDigest: string | null;
  observedRelease: RunnerReleaseIdentity | null;
  verifiedAt: Date;
};

type PersistedRunnerCompatibility = {
  kind: string;
  provider: string | null;
  requiredRunnerImageDigest: string | null;
  observedRunnerImageDigest: string | null;
  observedRunnerReleaseVersion: string | null;
  observedRunnerBootContractVersion: string | null;
  compatibilityState: string;
  compatibilityVerifiedAt: Date | null;
};

export function readRunnerCompatibilityRequirement(
  env: Record<string, string | undefined> = process.env,
): RunnerCompatibilityRequirement {
  if (env.AGENTBAY_DIGITALOCEAN_PROVIDER_MODE?.trim() === "local_docker") {
    return { mode: "local_docker", release: null };
  }

  const image = env.AGENTBAY_RUNNER_IMAGE;
  const parsed = image ? parseImmutableRunnerImageReference(image) : null;

  if (!parsed) {
    return { mode: "unavailable", release: null };
  }

  return {
    mode: "hosted",
    release: {
      version: parsed.version,
      imageDigest: parsed.imageDigest,
      bootContractVersion: RUNNER_BOOT_CONTRACT_VERSION,
    },
  };
}

export function requiredRunnerImageDigestForProvider(input: {
  providerMode?: "digitalocean" | "local_docker";
  runnerImage: string;
}): string | null {
  if (input.providerMode === "local_docker") {
    return null;
  }

  return parseImmutableRunnerImageReference(input.runnerImage)?.imageDigest ?? null;
}

export function assessRunnerCompatibility(input: {
  kind: string;
  provider: string | null;
  requiredImageDigest: string | null;
  observedRelease: RunnerReleaseIdentity | null;
  requirement: RunnerCompatibilityRequirement;
  now: Date;
}): RunnerCompatibilityAssessment {
  const managed = isManagedRunner(input.kind, input.provider);

  if (!managed) {
    return assessManualRunnerCompatibility(input.observedRelease, input.now);
  }

  if (input.requirement.mode === "unavailable") {
    return assessment(
      "invalid",
      "required_release_unavailable",
      input.requiredImageDigest,
      input.observedRelease,
      input.now,
    );
  }

  if (input.requirement.mode === "local_docker") {
    if (!input.observedRelease) {
      return assessment(
        "unknown",
        "release_evidence_missing",
        input.requiredImageDigest,
        null,
        input.now,
      );
    }

    if (input.observedRelease.bootContractVersion !== RUNNER_BOOT_CONTRACT_VERSION) {
      return assessment(
        "outdated",
        "boot_contract_mismatch",
        input.requiredImageDigest ?? input.observedRelease.imageDigest,
        input.observedRelease,
        input.now,
      );
    }

    return assessment(
      "compatible",
      "compatible",
      input.requiredImageDigest ?? input.observedRelease.imageDigest,
      input.observedRelease,
      input.now,
    );
  }

  const expected = input.requirement.release;
  const requiredImageDigest = input.requiredImageDigest ?? expected.imageDigest;

  if (requiredImageDigest !== expected.imageDigest) {
    return assessment(
      "outdated",
      "required_release_changed",
      requiredImageDigest,
      input.observedRelease,
      input.now,
    );
  }

  if (!input.observedRelease) {
    return assessment("unknown", "release_evidence_missing", requiredImageDigest, null, input.now);
  }

  if (input.observedRelease.imageDigest !== expected.imageDigest) {
    return assessment(
      "outdated",
      "image_digest_mismatch",
      requiredImageDigest,
      input.observedRelease,
      input.now,
    );
  }

  if (input.observedRelease.version !== expected.version) {
    return assessment(
      "outdated",
      "release_version_mismatch",
      requiredImageDigest,
      input.observedRelease,
      input.now,
    );
  }

  if (input.observedRelease.bootContractVersion !== expected.bootContractVersion) {
    return assessment(
      "outdated",
      "boot_contract_mismatch",
      requiredImageDigest,
      input.observedRelease,
      input.now,
    );
  }

  return assessment(
    "compatible",
    "compatible",
    requiredImageDigest,
    input.observedRelease,
    input.now,
  );
}

export function runnerCompatibilityPredicate(
  requirement: RunnerCompatibilityRequirement = readRunnerCompatibilityRequirement(),
): SQL {
  const manualEligible = and(
    eq(runners.kind, "manual_vps"),
    inArray(runners.compatibilityState, ["unknown", "compatible"]),
  );
  let managedEligible: SQL = sql`false`;

  if (requirement.mode === "hosted") {
    managedEligible = and(
      eq(runners.kind, DIGITALOCEAN_RUNNER_KIND),
      eq(runners.provider, DIGITALOCEAN_PROVIDER),
      eq(runners.compatibilityState, "compatible"),
      eq(runners.requiredRunnerImageDigest, requirement.release.imageDigest),
      eq(runners.observedRunnerImageDigest, requirement.release.imageDigest),
      eq(runners.observedRunnerReleaseVersion, requirement.release.version),
      eq(runners.observedRunnerBootContractVersion, requirement.release.bootContractVersion),
      isNotNull(runners.compatibilityVerifiedAt),
    ) as SQL;
  } else if (requirement.mode === "local_docker") {
    managedEligible = and(
      eq(runners.kind, DIGITALOCEAN_RUNNER_KIND),
      eq(runners.provider, DIGITALOCEAN_PROVIDER),
      eq(runners.compatibilityState, "compatible"),
      sql`${runners.requiredRunnerImageDigest} = ${runners.observedRunnerImageDigest}`,
      eq(runners.observedRunnerBootContractVersion, RUNNER_BOOT_CONTRACT_VERSION),
      isNotNull(runners.observedRunnerReleaseVersion),
      isNotNull(runners.compatibilityVerifiedAt),
    ) as SQL;
  }

  return or(manualEligible, managedEligible) as SQL;
}

export function isPersistedRunnerCompatible(
  runner: PersistedRunnerCompatibility,
  requirement: RunnerCompatibilityRequirement = readRunnerCompatibilityRequirement(),
): boolean {
  if (!isManagedRunner(runner.kind, runner.provider)) {
    return runner.compatibilityState === "unknown" || runner.compatibilityState === "compatible";
  }

  if (runner.compatibilityState !== "compatible" || !runner.compatibilityVerifiedAt) {
    return false;
  }

  if (requirement.mode === "hosted") {
    return (
      runner.requiredRunnerImageDigest === requirement.release.imageDigest &&
      runner.observedRunnerImageDigest === requirement.release.imageDigest &&
      runner.observedRunnerReleaseVersion === requirement.release.version &&
      runner.observedRunnerBootContractVersion === requirement.release.bootContractVersion
    );
  }

  return (
    requirement.mode === "local_docker" &&
    runner.requiredRunnerImageDigest !== null &&
    runner.requiredRunnerImageDigest === runner.observedRunnerImageDigest &&
    runner.observedRunnerReleaseVersion !== null &&
    runner.observedRunnerBootContractVersion === RUNNER_BOOT_CONTRACT_VERSION
  );
}

export function isManagedRunner(kind: string, provider: string | null): boolean {
  return kind === DIGITALOCEAN_RUNNER_KIND && provider === DIGITALOCEAN_PROVIDER;
}

function assessManualRunnerCompatibility(
  observedRelease: RunnerReleaseIdentity | null,
  now: Date,
): RunnerCompatibilityAssessment {
  if (!observedRelease) {
    return assessment("unknown", "release_evidence_missing", null, null, now);
  }

  if (observedRelease.bootContractVersion !== RUNNER_BOOT_CONTRACT_VERSION) {
    return assessment(
      "outdated",
      "boot_contract_mismatch",
      observedRelease.imageDigest,
      observedRelease,
      now,
    );
  }

  return assessment("compatible", "compatible", observedRelease.imageDigest, observedRelease, now);
}

function assessment(
  state: RunnerCompatibilityState,
  reason: RunnerCompatibilityReason,
  requiredImageDigest: string | null,
  observedRelease: RunnerReleaseIdentity | null,
  verifiedAt: Date,
): RunnerCompatibilityAssessment {
  return { state, reason, requiredImageDigest, observedRelease, verifiedAt };
}
