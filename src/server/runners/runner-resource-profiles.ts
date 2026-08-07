import {
  DEFAULT_HERMES_DOCKER_CPUS,
  DEFAULT_HERMES_DOCKER_MEMORY,
  DEFAULT_HERMES_DOCKER_PIDS_LIMIT,
  DEFAULT_HERMES_RUNNER_MAX_AGENTS,
} from "@/src/runner-service/constants";

export const DIGITALOCEAN_RUNNER_HOST_MEMORY_RESERVE_MIB = 384;
export const DIGITALOCEAN_LOW_MEMORY_SWAP_RESILIENCE_SIZE_SLUG = "s-1vcpu-512mb-10gb";

const DIGITALOCEAN_RUNNER_RESOURCE_PROFILES = {
  "s-1vcpu-512mb-10gb": {
    vcpus: 1,
    memoryMiB: 512,
    diskGiB: 10,
    monthlyCents: 400,
    lowMemorySwapResilience: true,
  },
  "s-1vcpu-1gb": {
    vcpus: 1,
    memoryMiB: 1024,
    diskGiB: 25,
    monthlyCents: 600,
    lowMemorySwapResilience: false,
  },
  "s-1vcpu-2gb": {
    vcpus: 1,
    memoryMiB: 2048,
    diskGiB: 50,
    monthlyCents: 1200,
    lowMemorySwapResilience: false,
  },
  "s-2vcpu-2gb": {
    vcpus: 2,
    memoryMiB: 2048,
    diskGiB: 60,
    monthlyCents: 1800,
    lowMemorySwapResilience: false,
  },
} as const satisfies Record<
  string,
  {
    vcpus: number;
    memoryMiB: number;
    diskGiB: number;
    monthlyCents: number;
    lowMemorySwapResilience: boolean;
  }
>;

export type SupportedDigitalOceanRunnerSizeSlug =
  keyof typeof DIGITALOCEAN_RUNNER_RESOURCE_PROFILES;

export type DigitalOceanRunnerResourceProfile = {
  sizeSlug: SupportedDigitalOceanRunnerSizeSlug;
  vcpus: number;
  memoryMiB: number;
  diskGiB: number;
  monthlyCents: number;
  lowMemorySwapResilience: boolean;
};

export type HermesRuntimeResourceProfile = {
  cpus: string;
  memory: string;
  pidsLimit: string;
};

export type RunnerResourceCompatibilityInput = {
  sizeSlug: string | null | undefined;
  runnerMaxAgents?: number;
  hermesDockerCpus?: string;
  hermesDockerMemory?: string;
  hermesDockerPidsLimit?: string;
};

export type RunnerResourceCompatibilityIssue = {
  field: string;
  message: string;
};

export type RunnerResourceCompatibilityResult =
  | {
      ok: true;
      profile: DigitalOceanRunnerResourceProfile;
      runnerMaxAgents: number;
      hermesRuntime: HermesRuntimeResourceProfile;
      requiredPhysicalMemoryMiB: number;
      hostMemoryReserveMiB: number;
    }
  | {
      ok: false;
      issues: RunnerResourceCompatibilityIssue[];
    };

export function listDigitalOceanRunnerResourceProfiles(): DigitalOceanRunnerResourceProfile[] {
  return (
    Object.keys(DIGITALOCEAN_RUNNER_RESOURCE_PROFILES) as SupportedDigitalOceanRunnerSizeSlug[]
  ).map((sizeSlug) => getDigitalOceanRunnerResourceProfile(sizeSlug));
}

export function getDigitalOceanRunnerResourceProfile(
  sizeSlug: SupportedDigitalOceanRunnerSizeSlug,
): DigitalOceanRunnerResourceProfile {
  return { sizeSlug, ...DIGITALOCEAN_RUNNER_RESOURCE_PROFILES[sizeSlug] };
}

export function findDigitalOceanRunnerResourceProfile(
  sizeSlug: string | null | undefined,
): DigitalOceanRunnerResourceProfile | null {
  const normalized = normalizeDigitalOceanSizeSlug(sizeSlug);
  if (!isSupportedDigitalOceanRunnerSizeSlug(normalized)) return null;
  return getDigitalOceanRunnerResourceProfile(normalized);
}

export function isSupportedDigitalOceanRunnerSizeSlug(
  sizeSlug: string | null,
): sizeSlug is SupportedDigitalOceanRunnerSizeSlug {
  return sizeSlug !== null && sizeSlug in DIGITALOCEAN_RUNNER_RESOURCE_PROFILES;
}

export function isDigitalOceanLowMemorySwapResilienceProfile(sizeSlug: string): boolean {
  return findDigitalOceanRunnerResourceProfile(sizeSlug)?.lowMemorySwapResilience === true;
}

export function validateDigitalOceanRunnerResourceCompatibility(
  input: RunnerResourceCompatibilityInput,
): RunnerResourceCompatibilityResult {
  const issues: RunnerResourceCompatibilityIssue[] = [];
  const profile = findDigitalOceanRunnerResourceProfile(input.sizeSlug);
  const runnerMaxAgents = input.runnerMaxAgents ?? DEFAULT_HERMES_RUNNER_MAX_AGENTS;
  const cpus = input.hermesDockerCpus ?? DEFAULT_HERMES_DOCKER_CPUS;
  const memory = input.hermesDockerMemory ?? DEFAULT_HERMES_DOCKER_MEMORY;
  const pidsLimit = input.hermesDockerPidsLimit ?? DEFAULT_HERMES_DOCKER_PIDS_LIMIT;
  const parsedCpus = parseHermesDockerCpus(cpus);
  const parsedMemoryMiB = parseHermesDockerMemoryMiB(memory);
  const parsedPidsLimit = parseHermesDockerPidsLimit(pidsLimit);

  if (!profile) {
    issues.push({
      field: "AGENTBAY_DIGITALOCEAN_SIZE_SLUG",
      message:
        "AGENTBAY_DIGITALOCEAN_SIZE_SLUG must be one of the supported managed-runner resource profiles.",
    });
  }

  if (!Number.isInteger(runnerMaxAgents) || runnerMaxAgents <= 0) {
    issues.push({
      field: "AGENTBAY_RUNNER_MAX_AGENTS",
      message: "AGENTBAY_RUNNER_MAX_AGENTS must be a positive integer.",
    });
  }

  if (parsedCpus === null) {
    issues.push({
      field: "AGENTBAY_HERMES_DOCKER_CPUS",
      message: "AGENTBAY_HERMES_DOCKER_CPUS must be a positive Docker CPU value.",
    });
  }

  if (parsedMemoryMiB === null) {
    issues.push({
      field: "AGENTBAY_HERMES_DOCKER_MEMORY",
      message: "AGENTBAY_HERMES_DOCKER_MEMORY must be a positive whole-MiB Docker memory value.",
    });
  }

  if (parsedPidsLimit === null) {
    issues.push({
      field: "AGENTBAY_HERMES_DOCKER_PIDS_LIMIT",
      message: "AGENTBAY_HERMES_DOCKER_PIDS_LIMIT must be a positive integer.",
    });
  }

  if (issues.length > 0 || !profile || parsedCpus === null || parsedMemoryMiB === null) {
    return { ok: false, issues };
  }

  const totalHermesCpus = parsedCpus * runnerMaxAgents;
  if (totalHermesCpus > profile.vcpus) {
    issues.push({
      field: "AGENTBAY_HERMES_DOCKER_CPUS",
      message: `Hermes CPU capacity (${totalHermesCpus}) exceeds ${profile.sizeSlug}'s ${profile.vcpus} vCPU profile.`,
    });
  }

  const requiredPhysicalMemoryMiB =
    parsedMemoryMiB * runnerMaxAgents + DIGITALOCEAN_RUNNER_HOST_MEMORY_RESERVE_MIB;
  if (requiredPhysicalMemoryMiB > profile.memoryMiB) {
    issues.push({
      field: "AGENTBAY_DIGITALOCEAN_SIZE_SLUG",
      message: `${profile.sizeSlug} has ${profile.memoryMiB} MiB physical RAM, but ${runnerMaxAgents} Hermes agent(s) require ${requiredPhysicalMemoryMiB} MiB including the ${DIGITALOCEAN_RUNNER_HOST_MEMORY_RESERVE_MIB} MiB runner/OS reserve. Swap is not counted as compatible memory.`,
    });
  }

  if (runnerMaxAgents > 1) {
    issues.push({
      field: "AGENTBAY_RUNNER_MAX_AGENTS",
      message:
        "AGENTBAY_RUNNER_MAX_AGENTS above 1 is blocked until the capacity-reuse issue proves a higher limit.",
    });
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    profile,
    runnerMaxAgents,
    hermesRuntime: { cpus, memory, pidsLimit },
    requiredPhysicalMemoryMiB,
    hostMemoryReserveMiB: DIGITALOCEAN_RUNNER_HOST_MEMORY_RESERVE_MIB,
  };
}

export function parseHermesDockerMemoryMiB(value: string): number | null {
  const match = /^([1-9][0-9]*)([bkmg])?$/i.exec(value.trim());
  if (!match?.[1]) return null;
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount)) return null;

  const unit = match[2]?.toLowerCase() ?? "b";
  const bytes =
    unit === "g"
      ? amount * 1024 * 1024 * 1024
      : unit === "m"
        ? amount * 1024 * 1024
        : unit === "k"
          ? amount * 1024
          : amount;

  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes % (1024 * 1024) !== 0) {
    return null;
  }

  return bytes / (1024 * 1024);
}

export function parseHermesDockerCpus(value: string): number | null {
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(value.trim())) return null;
  const cpus = Number(value);
  if (!Number.isFinite(cpus) || cpus <= 0) return null;
  return cpus;
}

export function parseHermesDockerPidsLimit(value: string): number | null {
  if (!/^[1-9][0-9]*$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function normalizeDigitalOceanSizeSlug(sizeSlug: string | null | undefined): string | null {
  const normalizedSizeSlug = sizeSlug?.trim();
  if (!normalizedSizeSlug) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(normalizedSizeSlug)) return null;
  return normalizedSizeSlug;
}
